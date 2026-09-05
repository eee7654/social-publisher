import { randomUUID } from 'node:crypto';
import getDb from '../../../config/database.js';
import IntegrationProvider from '../../../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../../../db/models/core/IntegrationConfig.js';
import IntegrationConnectionIntent from '../../../db/models/core/IntegrationConnectionIntent.js';
import UserOrganizationRole from '../../../db/models/core/UserOrganizationRole.js';
import { buildProviderConfig } from '../../../integrations/configSerializer.js';
import { decryptConfigValue, encryptConfigValue } from '../../../integrations/secrets.js';
import {
  LINKEDIN_ADAPTER_KEY,
  LINKEDIN_CALLBACK_STAGE,
  LINKEDIN_CONNECTION_PURPOSE,
  LINKEDIN_CONNECTION_SOURCE,
  LINKEDIN_CONNECTION_TTL_MS,
  LINKEDIN_INTENT_STATUS,
  LINKEDIN_PROVIDER_CODE,
} from './constants.js';

export {
  LINKEDIN_ADAPTER_KEY,
  LINKEDIN_CALLBACK_STAGE,
  LINKEDIN_CONNECTION_PURPOSE,
  LINKEDIN_CONNECTION_SOURCE,
  LINKEDIN_CONNECTION_TTL_MS,
  LINKEDIN_INTENT_STATUS,
  LINKEDIN_PROVIDER_CODE,
};
import {
  buildLinkedInAuthorizationUrl,
  buildLinkedInTicketUrl,
  createOpaqueState,
  getLinkedInOAuthConfig,
  hashState,
} from './oauth.js';

const db = getDb();

export function dbTimestamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function isExpired(intent) {
  if (!intent?.expires_at) return true;
  const raw = String(intent.expires_at);
  const timestamp = /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? new Date(raw) : new Date(`${raw.replace(' ', 'T')}Z`);
  return timestamp.getTime() <= Date.now();
}

export function intentSource(intent) {
  return intent?.source || LINKEDIN_CONNECTION_SOURCE.WEB;
}

export async function getLinkedInProvider(trx) {
  const provider = await IntegrationProvider.query(trx)
    .where({ domain: 'publishing', code: LINKEDIN_PROVIDER_CODE, adapter_key: LINKEDIN_ADAPTER_KEY, is_enabled: true })
    .first();
  if (!provider) throw new Error('LinkedIn publishing provider is unavailable');
  return provider;
}

export async function assertUserOrganizationMembership({ userId, organizationId }) {
  const membership = await UserOrganizationRole.query()
    .where({ user_id: userId, organization_id: organizationId })
    .first();
  if (!membership) throw new Error('User is not authorized for the requested organization');
  return membership;
}

export async function createWebLinkedInConnectionIntent({ userId, organizationId, oauthConfig = getLinkedInOAuthConfig() }) {
  const state = createOpaqueState();
  const provider = await getLinkedInProvider();
  const intent = await IntegrationConnectionIntent.query().insert({
    id: randomUUID(),
    nonce_hash: hashState(state),
    user_id: userId,
    organization_id: organizationId,
    provider_id: provider.id,
    purpose: LINKEDIN_CONNECTION_PURPOSE,
    source: LINKEDIN_CONNECTION_SOURCE.WEB,
    status: LINKEDIN_INTENT_STATUS.PENDING,
    expires_at: dbTimestamp(new Date(Date.now() + LINKEDIN_CONNECTION_TTL_MS)),
  });

  return {
    intent,
    authorizationUrl: buildLinkedInAuthorizationUrl({
      clientId: oauthConfig.clientId,
      redirectUri: oauthConfig.redirectUri,
      state,
    }),
  };
}

export async function createTelegramLinkedInConnectionIntent({
  telegramUserId,
  telegramChatId,
  userId,
  organizationId,
}) {
  await assertUserOrganizationMembership({ userId, organizationId });
  const browserTicket = createOpaqueState();
  const provider = await getLinkedInProvider();
  const intent = await IntegrationConnectionIntent.query().insert({
    id: randomUUID(),
    nonce_hash: hashState(createOpaqueState()),
    browser_ticket_hash: hashState(browserTicket),
    user_id: userId,
    organization_id: organizationId,
    provider_id: provider.id,
    purpose: LINKEDIN_CONNECTION_PURPOSE,
    source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
    telegram_user_id: String(telegramUserId),
    telegram_chat_id: String(telegramChatId),
    status: LINKEDIN_INTENT_STATUS.PENDING,
    expires_at: dbTimestamp(new Date(Date.now() + LINKEDIN_CONNECTION_TTL_MS)),
  });

  return {
    intent,
    browserTicket,
    browserUrl: buildLinkedInTicketUrl(browserTicket),
  };
}

export async function startLinkedInOAuthFromTelegramTicket({ ticket, oauthConfig = getLinkedInOAuthConfig() }) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx)
      .where({ browser_ticket_hash: hashState(ticket) })
      .forUpdate()
      .first();

    if (
      !intent ||
      intentSource(intent) !== LINKEDIN_CONNECTION_SOURCE.TELEGRAM ||
      intent.purpose !== LINKEDIN_CONNECTION_PURPOSE ||
      intent.status !== LINKEDIN_INTENT_STATUS.PENDING ||
      intent.browser_ticket_reserved_at ||
      isExpired(intent)
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_TICKET' };
    }

    const state = createOpaqueState();
    await intent.$query(trx).patch({
      nonce_hash: hashState(state),
      browser_ticket_hash: null,
      browser_ticket_reserved_at: dbTimestamp(),
      callback_stage: LINKEDIN_CALLBACK_STAGE.BROWSER_TICKET_RESERVED,
    });
    await trx.commit();

    return {
      ok: true,
      intent,
      authorizationUrl: buildLinkedInAuthorizationUrl({
        clientId: oauthConfig.clientId,
        redirectUri: oauthConfig.redirectUri,
        state,
      }),
    };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function reserveLinkedInCallbackIntent({ state, sessionUserId = null }) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx)
      .where({ nonce_hash: hashState(state) })
      .forUpdate()
      .first();

    const source = intentSource(intent);
    const sessionMatches = source === LINKEDIN_CONNECTION_SOURCE.TELEGRAM || (sessionUserId && intent?.user_id === sessionUserId);
    if (
      !intent ||
      intent.purpose !== LINKEDIN_CONNECTION_PURPOSE ||
      intent.status !== LINKEDIN_INTENT_STATUS.PENDING ||
      isExpired(intent) ||
      !sessionMatches
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_CALLBACK' };
    }

    await intent.$query(trx).patch({
      status: LINKEDIN_INTENT_STATUS.RESERVED,
      reserved_at: dbTimestamp(),
      callback_stage: LINKEDIN_CALLBACK_STAGE.INTENT_RESERVED,
    });
    await trx.commit();
    return { ok: true, intent };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function activateVerifiedLinkedInConnection({
  intentId,
  userId,
  organizationId,
  organizationUrn,
  source = null,
}) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx).findById(intentId).forUpdate();
    const expectedSource = source || intentSource(intent);

    if (
      !intent ||
      intent.user_id !== userId ||
      Number(intent.organization_id) !== Number(organizationId) ||
      intent.status !== LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION ||
      intentSource(intent) !== expectedSource ||
      isExpired(intent) ||
      organizationUrn !== intent.verified_channel_id
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_CONFIRMATION' };
    }

    const provider = await getLinkedInProvider(trx);
    if (Number(intent.provider_id) !== Number(provider.id)) {
      await trx.rollback();
      return { ok: false, reason: 'PROVIDER_MISMATCH' };
    }

    const existing = await IntegrationConfig.query(trx)
      .where({ organization_id: organizationId, provider_id: provider.id })
      .whereNull('deleted_at')
      .first();

    const pendingSecrets = intent.pending_secret_json || {};
    const accessToken = pendingSecrets.access_token ? decryptConfigValue(pendingSecrets.access_token) : null;
    const refreshToken = pendingSecrets.refresh_token ? decryptConfigValue(pendingSecrets.refresh_token) : null;

    if (!accessToken) {
      throw new Error('Access token is missing from pending connection intent');
    }

    const cleanOrgId = String(intent.verified_channel_id).replace(/^urn:li:organization:/, '');
    const vanityName = pendingSecrets.vanity_name || null;

    const submitted = {
      access_token: accessToken,
      expires_at: pendingSecrets.expires_at || null,
      organization_urn: intent.verified_channel_id,
      organization_id: cleanOrgId,
      organization_name: intent.verified_channel_title || `LinkedIn Page ${cleanOrgId}`,
      vanity_name: vanityName,
    };
    if (refreshToken) {
      submitted.refresh_token = refreshToken;
      submitted.refresh_token_expires_at = pendingSecrets.refresh_token_expires_at || null;
    }

    const configJson = buildProviderConfig({
      adapterKey: provider.adapter_key,
      submitted,
      stored: existing?.config_json || {},
      isCreate: !existing,
    });

    const patch = {
      name: `${provider.display_name} - ${intent.verified_channel_title || cleanOrgId}`,
      config_json: configJson,
      status: 'active',
      external_account_id: intent.verified_channel_id,
      external_account_name: intent.verified_channel_title,
      metadata_json: {
        organization_id: cleanOrgId,
        organization_urn: intent.verified_channel_id,
        organization_name: intent.verified_channel_title,
        vanity_name: vanityName,
      },
      expires_at: pendingSecrets.expires_at ? dbTimestamp(new Date(pendingSecrets.expires_at)) : null,
      deleted_at: null,
      updated_at: dbTimestamp(),
    };

    let config;
    if (existing) {
      config = await existing.$query(trx).patchAndFetch(patch);
    } else {
      config = await IntegrationConfig.query(trx).insertAndFetch({
        organization_id: organizationId,
        provider_id: provider.id,
        created_by: userId,
        is_default: true,
        ...patch,
      });
    }

    await intent.$query(trx).patch({
      status: LINKEDIN_INTENT_STATUS.CONSUMED,
      consumed_at: dbTimestamp(),
      pending_secret_json: null,
      callback_stage: null,
    });

    await trx.commit();
    return { ok: true, config };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function cancelVerifiedLinkedInConnection({ intentId, userId, organizationId, source = null }) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx).findById(intentId).forUpdate();
    const expectedSource = source || intentSource(intent);
    if (
      !intent ||
      intent.user_id !== userId ||
      Number(intent.organization_id) !== Number(organizationId) ||
      intentSource(intent) !== expectedSource
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INTENT_NOT_FOUND' };
    }

    await intent.$query(trx).patch({
      status: LINKEDIN_INTENT_STATUS.CANCELLED,
      pending_secret_json: null,
      updated_at: dbTimestamp(),
    });
    await trx.commit();
    return { ok: true };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function disconnectLinkedInConnection({ organizationId, userId }) {
  const provider = await getLinkedInProvider();
  const config = await IntegrationConfig.query()
    .where({ organization_id: organizationId, provider_id: provider.id })
    .whereNull('deleted_at')
    .first();

  if (!config) return { ok: false, reason: 'NOT_CONNECTED' };

  await config.$query().patch({
    status: 'inactive',
    deleted_at: dbTimestamp(),
    updated_at: dbTimestamp(),
  });

  return { ok: true };
}

export async function getLinkedInConnectionState(organizationId) {
  const provider = await getLinkedInProvider();
  const config = await IntegrationConfig.query()
    .where({ organization_id: organizationId, provider_id: provider.id, status: 'active' })
    .whereNull('deleted_at')
    .first();

  if (!config) {
    return { connected: false, config: null, isExpired: false };
  }

  const expiresAt = config.expires_at ? new Date(config.expires_at).getTime() : null;
  const expired = expiresAt ? expiresAt <= Date.now() : false;

  return {
    connected: !expired,
    config,
    isExpired: expired,
  };
}
