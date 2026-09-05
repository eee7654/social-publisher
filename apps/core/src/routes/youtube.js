import { createRouter } from 'next-connect';
import { auth } from '../config/auth.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { checkPermission } from '../middlewares/checkPermission.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import IntegrationConnectionIntent from '../db/models/core/IntegrationConnectionIntent.js';
import { decryptConfigValue, encryptConfigValue } from '../integrations/secrets.js';
import {
  createYouTubeOAuthClient,
} from '../publisher/platforms/youtube/oauth.js';
import { getTelegramClient } from '../publisher/telegram/api.js';
import {
  activateVerifiedYouTubeConnection,
  assertUserOrganizationMembership,
  createWebYouTubeConnectionIntent,
  disconnectYouTubeConnection,
  getYouTubeProvider,
  intentSource,
  isExpired,
  reserveYouTubeCallbackIntent,
  startYouTubeOAuthFromTelegramTicket,
  YOUTUBE_CALLBACK_STAGE,
  YOUTUBE_CONNECTION_SOURCE,
  YOUTUBE_INTENT_STATUS,
} from '../publisher/platforms/youtube/connections.js';
import { notifyTelegramYouTubeVerified } from '../publisher/telegram/connections.js';

const COOKIE = 'youtube_connection_intent';

async function defaultYouTubeApiFactory(client) {
  const { google } = await import('googleapis');
  return google.youtube({ version: 'v3', auth: client });
}

function readCookie(req) {
  const match = (req.headers?.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

function parseOrganizationId(value) {
  const orgId = Number(value);
  return Number.isSafeInteger(orgId) && orgId > 0 ? orgId : null;
}

function normalizeGrantedScopes(scope) {
  if (!scope) return [];
  const raw = Array.isArray(scope) ? scope : String(scope).split(/\s+/);
  return [...new Set(raw.map(v => String(v).trim()).filter(Boolean))].sort();
}

function redactSecretLikeText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(access_token|refresh_token|code|code_verifier)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9._~+/-]{32,}\b/g, '[redacted]');
}

function limitSafeText(value, max = 512) {
  if (value == null) return null;
  const text = redactSecretLikeText(value).replace(/[\r\n\t]+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function safeGoogleError(error) {
  const response = error?.response || error?.res;
  const data = response?.data;
  const googleError = data?.error;
  const firstDetail = Array.isArray(googleError?.errors) ? googleError.errors[0] : null;
  return {
    failure_http_status: Number.isInteger(response?.status) ? response.status : (Number.isInteger(error?.code) ? error.code : null),
    failure_error_code: limitSafeText(typeof googleError === 'string' ? googleError : googleError?.code || error?.code || error?.name, 120),
    failure_error_reason: limitSafeText(firstDetail?.reason || data?.error_subtype || null, 120),
    failure_message: limitSafeText(googleError?.message || data?.error_description || error?.message, 512),
  };
}

async function patchIntentDiagnostics(intentId, patch) {
  await IntegrationConnectionIntent.query().findById(intentId).patch(patch);
}

function setIntentCookie(res, intentId, secure, maxAge = 900) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(intentId || '')}; HttpOnly; SameSite=Lax; Path=/api/youtube; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

async function getSession(req) {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    return session?.user ? session : null;
  } catch {
    return null;
  }
}

/**
 * The production router and the Pack A integration tests share this factory.
 * Tests replace only Google-bound clients; authorization, models, encryption,
 * transactions, and route middleware remain the real application path.
 */
export function createYouTubeRouter({ oauthClientFactory = createYouTubeOAuthClient, youtubeApiFactory = defaultYouTubeApiFactory, telegramClientFactory = getTelegramClient } = {}) {
const router = createRouter();

router.post('/connect', requireAuth, checkPermission('create', 'IntegrationConfig'), async (req, res) => {
  const requestedOrgId = parseOrganizationId(req.body?.organization_id ?? req.body?.organizationId);
  if (!requestedOrgId) return res.status(400).json({ error: 'Explicit organization_id is required' });
  if (!req.orgId || Number(req.orgId) !== requestedOrgId) return res.status(403).json({ error: 'User is not authorized for the requested organization' });
  await assertUserOrganizationMembership({ userId: req.user.id, organizationId: requestedOrgId });
  const { intent, authorizationUrl } = await createWebYouTubeConnectionIntent({ userId: req.user.id, organizationId: requestedOrgId, oauthClientFactory });
  return res.status(200).json({
    authorizationUrl,
    expiresAt: intent.expires_at,
  });
});

router.get('/connect', async (req, res) => {
  const ticket = typeof req.query.t === 'string' ? req.query.t : null;
  if (!ticket) return res.status(400).json({ error: 'Connection ticket is required' });
  const started = await startYouTubeOAuthFromTelegramTicket({ ticket, oauthClientFactory });
  if (!started.ok) return res.status(400).json({ error: 'Invalid or expired YouTube connection ticket' });
  return res.redirect(302, started.authorizationUrl);
});

router.get('/oauth/callback', async (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const session = await getSession(req);
  if (!state || !code) {
    return res.status(400).json({ error: 'Unable to validate YouTube callback. Sign in and start again.' });
  }

  let reserved;
  try {
    reserved = await reserveYouTubeCallbackIntent({ state, sessionUserId: session?.user?.id || null });
  } catch {
    return res.status(400).json({ error: 'Unable to reserve YouTube connection' });
  }
  if (!reserved.ok) {
    return res.status(400).json({ error: 'Unable to reserve YouTube connection' });
  }
  let { intent } = reserved;

  let failureStage = 'TOKEN_EXCHANGE_FAILED';
  try {
    const client = oauthClientFactory();
    const verifier = decryptConfigValue(intent.pkce_verifier_encrypted);
    await patchIntentDiagnostics(intent.id, { callback_stage: YOUTUBE_CALLBACK_STAGE.TOKEN_EXCHANGE_STARTED, failure_stage: null, failure_http_status: null, failure_error_code: null, failure_error_reason: null, failure_message: null });
    const { tokens = {} } = await client.getToken({ code, codeVerifier: verifier });
    const grantedScopes = normalizeGrantedScopes(tokens.scope);
    await patchIntentDiagnostics(intent.id, {
      callback_stage: YOUTUBE_CALLBACK_STAGE.TOKEN_EXCHANGE_SUCCEEDED,
      token_access_present: !!tokens.access_token,
      token_refresh_present: !!tokens.refresh_token,
      token_expiry_present: !!tokens.expiry_date,
      granted_scopes_json: grantedScopes,
    });
    if (!tokens.access_token) throw new Error('Google did not return an access token');

    client.setCredentials({ access_token: tokens.access_token });
    const youtube = await youtubeApiFactory(client);
    failureStage = 'CHANNEL_VERIFICATION_FAILED';
    await patchIntentDiagnostics(intent.id, { callback_stage: YOUTUBE_CALLBACK_STAGE.CHANNEL_VERIFY_STARTED });
    const result = await youtube.channels.list({ mine: true, part: 'id,snippet' });
    const channels = result.data.items || [];
    await patchIntentDiagnostics(intent.id, { callback_stage: YOUTUBE_CALLBACK_STAGE.CHANNEL_VERIFY_SUCCEEDED, failure_http_status: result.status || null, channel_items_count: channels.length });
    // This flow has no channel-picker. Refuse an ambiguous authorization
    // instead of silently binding the first returned channel.
    if (channels.length !== 1) throw new Error('Exactly one channel must be available for this authorization');
    const channel = channels[0];
    if (!channel?.id || !channel.snippet?.title) throw new Error('No channel is available for this authorization');

    const existing = await IntegrationConfig.query()
      .where({ organization_id: intent.organization_id, provider_id: intent.provider_id }).whereNull('deleted_at').first();
    if (!tokens.refresh_token && existing?.config_json?.refresh_token && existing.external_account_id && existing.external_account_id !== channel.id) {
      failureStage = 'REFRESH_TOKEN_MISSING';
      throw new Error('Google did not issue a refresh token for the verified channel');
    }
    if (!tokens.refresh_token && !existing?.config_json?.refresh_token) {
      failureStage = 'REFRESH_TOKEN_MISSING';
      throw new Error('Google did not issue a refresh token');
    }
    await patchIntentDiagnostics(intent.id, { callback_stage: YOUTUBE_CALLBACK_STAGE.REFRESH_TOKEN_VALIDATED });
    intent = await IntegrationConnectionIntent.query().patchAndFetchById(intent.id, {
      status: YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION, callback_stage: YOUTUBE_CALLBACK_STAGE.PENDING_CONFIRMATION_CREATED, pkce_verifier_encrypted: null,
      pending_secret_json: tokens.refresh_token ? { refresh_token: encryptConfigValue(tokens.refresh_token) } : null,
      verified_channel_id: channel.id, verified_channel_title: channel.snippet.title,
    });

    if (intentSource(intent) === YOUTUBE_CONNECTION_SOURCE.TELEGRAM) {
      try {
        await notifyTelegramYouTubeVerified({ intent, telegramClient: telegramClientFactory() });
      } catch (notifyError) {
        await patchIntentDiagnostics(intent.id, {
          failure_stage: 'TELEGRAM_NOTIFICATION_FAILED',
          failure_message: limitSafeText(notifyError?.message || 'Telegram notification failed'),
        });
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).end('<!doctype html><html><body><h1>YouTube verification completed.</h1><p>Return to Telegram to confirm the channel.</p></body></html>');
    }

    const secure = oauthClientFactory().redirectUri.startsWith('https://');
    setIntentCookie(res, intent.id, secure);
    return res.redirect(302, `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/publisher/integrations/youtube/confirm`);
  } catch (error) {
    await IntegrationConnectionIntent.query().findById(intent.id).patch({
      status: YOUTUBE_INTENT_STATUS.CANCELLED,
      pkce_verifier_encrypted: null,
      pending_secret_json: null,
      browser_ticket_hash: null,
      failure_stage: failureStage,
      ...safeGoogleError(error),
    });
    return res.status(400).json({ error: 'YouTube authorization could not be verified. No connection was activated.' });
  }
});

router.get('/pending', requireAuth, async (req, res) => {
  const intentId = readCookie(req);
  const intent = intentId && await IntegrationConnectionIntent.query().findById(intentId);
  if (!intent || intent.user_id !== req.user.id || intent.organization_id !== req.orgId || intentSource(intent) !== YOUTUBE_CONNECTION_SOURCE.WEB || intent.status !== YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION || isExpired(intent)) {
    return res.status(404).json({ error: 'No pending YouTube connection confirmation' });
  }
  return res.status(200).json({
    organizationId: intent.organization_id, channelId: intent.verified_channel_id,
    channelTitle: intent.verified_channel_title, expiresAt: intent.expires_at,
  });
});

router.post('/confirm', requireAuth, checkPermission('create', 'IntegrationConfig'), async (req, res) => {
  const intentId = readCookie(req);
  const { confirm, channelId } = req.body || {};
  if (confirm !== true || !intentId || !req.orgId) return res.status(400).json({ error: 'Explicit channel confirmation is required' });

  try {
    const result = await activateVerifiedYouTubeConnection({
      intentId,
      userId: req.user.id,
      organizationId: req.orgId,
      channelId,
      source: YOUTUBE_CONNECTION_SOURCE.WEB,
    });
    if (!result.ok) return res.status(400).json({ error: 'Invalid or expired YouTube confirmation' });
    setIntentCookie(res, null, oauthClientFactory().redirectUri.startsWith('https://'), 0);
    const { config } = result;
    return res.status(200).json({ config: { id: config.id, status: config.status, external_account_id: config.external_account_id, external_account_name: config.external_account_name } });
  } catch {
    return res.status(400).json({ error: 'YouTube connection could not be confirmed' });
  }
});

router.post('/disconnect', requireAuth, checkPermission('update', 'IntegrationConfig'), async (req, res) => {
  if (!req.orgId) return res.status(400).json({ error: 'Organization context is required' });
  const provider = await getYouTubeProvider();
  const config = await IntegrationConfig.query().where({ organization_id: req.orgId, provider_id: provider.id }).whereNull('deleted_at').first();
  if (!config) return res.status(404).json({ error: 'YouTube publishing connection not found' });
  await disconnectYouTubeConnection({ userId: req.user.id, organizationId: req.orgId });
  return res.status(204).end();
});

return router;
}

export default createYouTubeRouter();
