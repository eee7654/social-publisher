import { createRouter } from 'next-connect';
import { auth } from '../config/auth.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import IntegrationConnectionIntent from '../db/models/core/IntegrationConnectionIntent.js';
import { encryptConfigValue } from '../integrations/secrets.js';
import {
  exchangeLinkedInCodeForToken,
  getLinkedInOAuthConfig,
} from '../publisher/platforms/linkedin/oauth.js';
import {
  checkOrganizationAuthorization,
  getOrganization,
  getOrganizationAcls,
} from '../publisher/platforms/linkedin/api.js';
import { getTelegramClient } from '../publisher/telegram/api.js';
import {
  activateVerifiedLinkedInConnection,
  assertUserOrganizationMembership,
  createWebLinkedInConnectionIntent,
  dbTimestamp,
  disconnectLinkedInConnection,
  getLinkedInProvider,
  intentSource,
  isExpired,
  reserveLinkedInCallbackIntent,
  startLinkedInOAuthFromTelegramTicket,
  LINKEDIN_CALLBACK_STAGE,
  LINKEDIN_CONNECTION_SOURCE,
  LINKEDIN_INTENT_STATUS,
} from '../publisher/platforms/linkedin/connections.js';
import { notifyTelegramLinkedInVerified } from '../publisher/telegram/connections.js';

const COOKIE = 'linkedin_connection_intent';

function readCookie(req) {
  const match = (req.headers?.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

function parseOrganizationId(value) {
  const orgId = Number(value);
  return Number.isSafeInteger(orgId) && orgId > 0 ? orgId : null;
}

function limitSafeText(value, max = 512) {
  if (value == null) return null;
  const text = String(value).replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').replace(/[\r\n\t]+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function setIntentCookie(res, intentId, secure, maxAge = 900) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(intentId || '')}; HttpOnly; SameSite=Lax; Path=/api/linkedin; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

async function getSession(req) {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    return session?.user ? session : null;
  } catch {
    return null;
  }
}

export function createLinkedInRouter({
  oauthConfigFactory = getLinkedInOAuthConfig,
  tokenExchangeFactory = exchangeLinkedInCodeForToken,
  apiFactory = {
    getOrganizationAcls,
    getOrganization,
    checkOrganizationAuthorization,
  },
  telegramClientFactory = getTelegramClient,
} = {}) {
  const router = createRouter();

  // Telegram ticket exchange -> redirect to LinkedIn OAuth
  router.get('/connect', async (req, res) => {
    const ticket = req.query?.t || req.query?.ticket;
    if (!ticket) return res.status(400).send('Missing connection ticket');

    let oauthConfig;
    try {
      oauthConfig = oauthConfigFactory();
    } catch (err) {
      return res.status(500).send(`LinkedIn OAuth configuration error: ${err.message}`);
    }

    const started = await startLinkedInOAuthFromTelegramTicket({ ticket, oauthConfig });
    if (!started.ok) return res.status(400).send('This LinkedIn authorization link has expired or has already been used.');

    const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    setIntentCookie(res, started.intent.id, isSecure);
    return res.redirect(started.authorizationUrl);
  });

  // Web flow start
  router.get('/oauth/start', requireAuth, checkPermission('integrations', 'create'), async (req, res) => {
    const organizationId = parseOrganizationId(req.query?.organization_id || req.query?.organizationId);
    if (!organizationId) return res.status(400).json({ error: 'Valid organization_id query parameter is required' });

    try {
      await assertUserOrganizationMembership({ userId: req.user.id, organizationId });
    } catch {
      return res.status(403).json({ error: 'User is not authorized for the requested organization' });
    }

    let oauthConfig;
    try {
      oauthConfig = oauthConfigFactory();
    } catch (err) {
      return res.status(500).json({ error: `LinkedIn OAuth configuration error: ${err.message}` });
    }

    const { intent, authorizationUrl } = await createWebLinkedInConnectionIntent({
      userId: req.user.id,
      organizationId,
      oauthConfig,
    });

    const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    setIntentCookie(res, intent.id, isSecure);
    return res.redirect(authorizationUrl);
  });

  // OAuth callback
  router.get('/oauth/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query || {};
    if (error) {
      return res.status(400).send(`LinkedIn authorization was denied: ${escapeHtml(error_description || error)}`);
    }
    if (!code || !state) {
      return res.status(400).send('Missing authorization code or state parameter.');
    }

    const session = await getSession(req);
    const reservation = await reserveLinkedInCallbackIntent({
      state,
      sessionUserId: session?.user?.id || null,
    });

    if (!reservation.ok) {
      return res.status(400).send('LinkedIn authorization state is invalid, already used, or has expired.');
    }

    const intent = reservation.intent;
    const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    setIntentCookie(res, intent.id, isSecure);

    let oauthConfig;
    try {
      oauthConfig = oauthConfigFactory();
    } catch (err) {
      await intent.$query().patch({
        status: LINKEDIN_INTENT_STATUS.CANCELLED,
        failure_message: limitSafeText(err.message, 512),
      });
      return res.status(500).send('LinkedIn OAuth configuration error');
    }

    // Step 1: Exchange code for tokens
    let tokens;
    try {
      await intent.$query().patch({ callback_stage: LINKEDIN_CALLBACK_STAGE.TOKEN_EXCHANGE_STARTED });
      tokens = await tokenExchangeFactory({
        code,
        clientId: oauthConfig.clientId,
        clientSecret: oauthConfig.clientSecret,
        redirectUri: oauthConfig.redirectUri,
      });
      await intent.$query().patch({ callback_stage: LINKEDIN_CALLBACK_STAGE.TOKEN_EXCHANGE_SUCCEEDED });
    } catch (exchangeError) {
      await intent.$query().patch({
        status: LINKEDIN_INTENT_STATUS.CANCELLED,
        failure_http_status: exchangeError.status || 500,
        failure_error_code: limitSafeText(exchangeError.code || 'TOKEN_EXCHANGE_FAILED', 120),
        failure_message: limitSafeText(exchangeError.message, 512),
      });
      return res.status(502).send(`Failed to exchange LinkedIn authorization code: ${escapeHtml(exchangeError.message)}`);
    }

    // Step 2: Page discovery & permission check
    try {
      await intent.$query().patch({ callback_stage: LINKEDIN_CALLBACK_STAGE.PAGE_VERIFY_STARTED });
      const acls = await apiFactory.getOrganizationAcls(tokens.accessToken);
      if (!acls || acls.length === 0) {
        throw new Error('No organizations found where the authenticated member has administration permissions.');
      }

      // Filter to approved organizations with publisher/admin capabilities
      let targetOrgAcl = null;
      let targetOrgInfo = null;

      for (const acl of acls) {
        const orgUrn = acl.organization;
        const orgId = String(orgUrn).replace(/^urn:li:organization:/, '');
        const authResult = await apiFactory.checkOrganizationAuthorization(tokens.accessToken, orgUrn).catch(() => ({ authorized: false }));
        if (authResult.authorized) {
          const orgDetails = await apiFactory.getOrganization(tokens.accessToken, orgId).catch(() => null);
          if (orgDetails) {
            targetOrgAcl = acl;
            targetOrgInfo = orgDetails;
            break; // Found primary authorized page (e.g. ElecIO)
          }
        }
      }

      if (!targetOrgInfo) {
        throw new Error('The authenticated LinkedIn account does not have post-publishing permissions for any manageable Organization Page.');
      }

      await intent.$query().patch({ callback_stage: LINKEDIN_CALLBACK_STAGE.PAGE_VERIFY_SUCCEEDED });

      // Store pending encrypted credentials
      const pendingSecrets = {
        access_token: encryptConfigValue(tokens.accessToken),
        expires_at: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : null,
        organization_id: targetOrgInfo.id,
        vanity_name: targetOrgInfo.vanityName,
      };
      if (tokens.refreshToken) {
        pendingSecrets.refresh_token = encryptConfigValue(tokens.refreshToken);
        pendingSecrets.refresh_token_expires_at = tokens.refreshTokenExpiresIn ? new Date(Date.now() + tokens.refreshTokenExpiresIn * 1000).toISOString() : null;
      }

      await intent.$query().patch({
        status: LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
        verified_channel_id: targetOrgInfo.urn,
        verified_channel_title: targetOrgInfo.localizedName,
        pending_secret_json: pendingSecrets,
        callback_stage: LINKEDIN_CALLBACK_STAGE.PENDING_CONFIRMATION_CREATED,
      });

      if (intentSource(intent) === LINKEDIN_CONNECTION_SOURCE.TELEGRAM) {
        const telegramClient = telegramClientFactory();
        await notifyTelegramLinkedInVerified({
          intent: await IntegrationConnectionIntent.query().findById(intent.id).withGraphFetched('organization'),
          telegramClient,
        }).catch(err => {
          console.error('[LinkedIn OAuth] Failed to notify Telegram:', err);
        });

        return res.status(200).send(`
          <!DOCTYPE html>
          <html>
            <head><meta charset="utf-8"><title>LinkedIn Verified</title><style>body{font-family:sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;} .card{background:#161b22;padding:2rem;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.5);text-align:center;max-width:400px;} h2{color:#58a6ff;margin-top:0;} p{line-height:1.6;}</style></head>
            <body>
              <div class="card">
                <h2>Page Verified</h2>
                <p>LinkedIn Company Page <b>${escapeHtml(targetOrgInfo.localizedName)}</b> has been successfully verified.</p>
                <p>Please return to your <b>Telegram bot</b> to confirm and activate this connection.</p>
              </div>
            </body>
          </html>
        `);
      }

      // Web flow redirect
      return res.redirect(`/panel/connections?provider=linkedin&intent_id=${intent.id}&status=verified`);
    } catch (verifyError) {
      await intent.$query().patch({
        status: LINKEDIN_INTENT_STATUS.CANCELLED,
        failure_error_code: 'PAGE_VERIFICATION_FAILED',
        failure_message: limitSafeText(verifyError.message, 512),
      });
      return res.status(400).send(`LinkedIn page verification failed: ${escapeHtml(verifyError.message)}`);
    }
  });

  // Web confirmation route
  router.post('/confirm', requireAuth, checkPermission('integrations', 'create'), async (req, res) => {
    const { intent_id, organization_id, organization_urn } = req.body || {};
    if (!intent_id || !organization_id || !organization_urn) {
      return res.status(400).json({ error: 'Missing required parameters: intent_id, organization_id, organization_urn' });
    }

    try {
      const activated = await activateVerifiedLinkedInConnection({
        intentId: intent_id,
        userId: req.user.id,
        organizationId: Number(organization_id),
        organizationUrn,
        source: LINKEDIN_CONNECTION_SOURCE.WEB,
      });

      if (!activated.ok) {
        return res.status(400).json({ error: activated.reason || 'Failed to activate connection' });
      }

      return res.json({ ok: true, config_id: activated.config.id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Disconnect route
  router.post('/disconnect', requireAuth, checkPermission('integrations', 'delete'), async (req, res) => {
    const { organization_id } = req.body || {};
    if (!organization_id) return res.status(400).json({ error: 'Missing organization_id' });

    try {
      const result = await disconnectLinkedInConnection({
        organizationId: Number(organization_id),
        userId: req.user.id,
      });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const linkedinRoutes = createLinkedInRouter();
export default linkedinRoutes;
