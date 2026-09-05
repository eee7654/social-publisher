import { randomUUID } from 'node:crypto';
import getDb from '../../../config/database.js';
import IntegrationProvider from '../../../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../../../db/models/core/IntegrationConfig.js';
import IntegrationConnectionIntent from '../../../db/models/core/IntegrationConnectionIntent.js';
import UserOrganizationRole from '../../../db/models/core/UserOrganizationRole.js';
import { buildProviderConfig } from '../../../integrations/configSerializer.js';
import { decryptConfigValue, encryptConfigValue } from '../../../integrations/secrets.js';
import {
  buildYouTubeAuthorizationUrl,
  buildYouTubeTicketUrl,
  createOpaqueState,
  createPkcePair,
  hashState,
} from './oauth.js';

const db = getDb();

export const YOUTUBE_CONNECTION_PURPOSE = 'publishing_connection';
export const YOUTUBE_CONNECTION_TTL_MS = 15 * 60 * 1000;

export const YOUTUBE_CONNECTION_SOURCE = Object.freeze({
  WEB: 'web',
  TELEGRAM: 'telegram',
});

export const YOUTUBE_INTENT_STATUS = Object.freeze({
  PENDING: 'pending',
  RESERVED: 'reserved',
  VERIFIED_PENDING_CONFIRMATION: 'verified_pending_confirmation',
  CONSUMED: 'consumed',
  CANCELLED: 'cancelled',
});

export const YOUTUBE_CALLBACK_STAGE = Object.freeze({
  BROWSER_TICKET_RESERVED: 'BROWSER_TICKET_RESERVED',
  STATE_VALIDATED: 'STATE_VALIDATED',
  INTENT_RESERVED: 'INTENT_RESERVED',
  TOKEN_EXCHANGE_STARTED: 'TOKEN_EXCHANGE_STARTED',
  TOKEN_EXCHANGE_SUCCEEDED: 'TOKEN_EXCHANGE_SUCCEEDED',
  CHANNEL_VERIFY_STARTED: 'CHANNEL_VERIFY_STARTED',
  CHANNEL_VERIFY_SUCCEEDED: 'CHANNEL_VERIFY_SUCCEEDED',
  REFRESH_TOKEN_VALIDATED: 'REFRESH_TOKEN_VALIDATED',
  PENDING_CONFIRMATION_CREATED: 'PENDING_CONFIRMATION_CREATED',
});

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
  return intent?.source || YOUTUBE_CONNECTION_SOURCE.WEB;
}

export async function getYouTubeProvider(trx) {
  const provider = await IntegrationProvider.query(trx)
    .where({ domain: 'publishing', code: 'youtube', adapter_key: 'publishing.youtube', is_enabled: true })
    .first();
  if (!provider) throw new Error('YouTube publishing provider is unavailable');
  return provider;
}

export async function assertUserOrganizationMembership({ userId, organizationId }) {
  const membership = await UserOrganizationRole.query()
    .where({ user_id: userId, organization_id: organizationId })
    .first();
  if (!membership) throw new Error('User is not authorized for the requested organization');
  return membership;
}

export async function createWebYouTubeConnectionIntent({ userId, organizationId, oauthClientFactory }) {
  const state = createOpaqueState();
  const { verifier, challenge } = createPkcePair();
  const provider = await getYouTubeProvider();
  const intent = await IntegrationConnectionIntent.query().insert({
    id: randomUUID(),
    nonce_hash: hashState(state),
    user_id: userId,
    organization_id: organizationId,
    provider_id: provider.id,
    purpose: YOUTUBE_CONNECTION_PURPOSE,
    source: YOUTUBE_CONNECTION_SOURCE.WEB,
    status: YOUTUBE_INTENT_STATUS.PENDING,
    pkce_verifier_encrypted: encryptConfigValue(verifier),
    expires_at: dbTimestamp(new Date(Date.now() + YOUTUBE_CONNECTION_TTL_MS)),
  });
  const client = oauthClientFactory();
  return {
    intent,
    authorizationUrl: buildYouTubeAuthorizationUrl(client, { state, codeChallenge: challenge }),
  };
}

export async function createTelegramYouTubeConnectionIntent({
  telegramUserId,
  telegramChatId,
  userId,
  organizationId,
}) {
  await assertUserOrganizationMembership({ userId, organizationId });
  const browserTicket = createOpaqueState();
  const provider = await getYouTubeProvider();
  const intent = await IntegrationConnectionIntent.query().insert({
    id: randomUUID(),
    nonce_hash: hashState(createOpaqueState()),
    browser_ticket_hash: hashState(browserTicket),
    user_id: userId,
    organization_id: organizationId,
    provider_id: provider.id,
    purpose: YOUTUBE_CONNECTION_PURPOSE,
    source: YOUTUBE_CONNECTION_SOURCE.TELEGRAM,
    telegram_user_id: String(telegramUserId),
    telegram_chat_id: String(telegramChatId),
    status: YOUTUBE_INTENT_STATUS.PENDING,
    expires_at: dbTimestamp(new Date(Date.now() + YOUTUBE_CONNECTION_TTL_MS)),
  });
  return {
    intent,
    browserTicket,
    browserUrl: buildYouTubeTicketUrl(browserTicket),
  };
}

export async function startYouTubeOAuthFromTelegramTicket({ ticket, oauthClientFactory }) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx)
      .where({ browser_ticket_hash: hashState(ticket) })
      .forUpdate()
      .first();
    if (
      !intent ||
      intentSource(intent) !== YOUTUBE_CONNECTION_SOURCE.TELEGRAM ||
      intent.purpose !== YOUTUBE_CONNECTION_PURPOSE ||
      intent.status !== YOUTUBE_INTENT_STATUS.PENDING ||
      intent.browser_ticket_reserved_at ||
      isExpired(intent)
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_TICKET' };
    }

    const state = createOpaqueState();
    const { verifier, challenge } = createPkcePair();
    await intent.$query(trx).patch({
      nonce_hash: hashState(state),
      browser_ticket_hash: null,
      browser_ticket_reserved_at: dbTimestamp(),
      pkce_verifier_encrypted: encryptConfigValue(verifier),
      callback_stage: YOUTUBE_CALLBACK_STAGE.BROWSER_TICKET_RESERVED,
    });
    await trx.commit();

    const client = oauthClientFactory();
    return {
      ok: true,
      intent,
      authorizationUrl: buildYouTubeAuthorizationUrl(client, { state, codeChallenge: challenge }),
    };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function reserveYouTubeCallbackIntent({ state, sessionUserId = null }) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx)
      .where({ nonce_hash: hashState(state) })
      .forUpdate()
      .first();
    const source = intentSource(intent);
    const sessionMatches = source === YOUTUBE_CONNECTION_SOURCE.TELEGRAM || (sessionUserId && intent?.user_id === sessionUserId);
    if (
      !intent ||
      intent.purpose !== YOUTUBE_CONNECTION_PURPOSE ||
      intent.status !== YOUTUBE_INTENT_STATUS.PENDING ||
      isExpired(intent) ||
      !sessionMatches
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_CALLBACK' };
    }
    await intent.$query(trx).patch({
      status: YOUTUBE_INTENT_STATUS.RESERVED,
      reserved_at: dbTimestamp(),
      callback_stage: YOUTUBE_CALLBACK_STAGE.INTENT_RESERVED,
    });
    await trx.commit();
    return { ok: true, intent };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function activateVerifiedYouTubeConnection({ intentId, userId, organizationId, channelId, source = null }) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx).findById(intentId).forUpdate();
    const expectedSource = source || intentSource(intent);
    if (
      !intent ||
      intent.user_id !== userId ||
      Number(intent.organization_id) !== Number(organizationId) ||
      intent.status !== YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION ||
      intentSource(intent) !== expectedSource ||
      isExpired(intent) ||
      channelId !== intent.verified_channel_id
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_CONFIRMATION' };
    }

    const provider = await getYouTubeProvider(trx);
    if (Number(intent.provider_id) !== Number(provider.id)) {
      await trx.rollback();
      return { ok: false, reason: 'PROVIDER_MISMATCH' };
    }

    const existing = await IntegrationConfig.query(trx)
      .where({ organization_id: organizationId, provider_id: provider.id })
      .whereNull('deleted_at')
      .first();
    const refreshToken = intent.pending_secret_json?.refresh_token
      ? decryptConfigValue(intent.pending_secret_json.refresh_token)
      : null;
    if (!refreshToken && existing?.external_account_id && existing.external_account_id !== intent.verified_channel_id) {
      throw new Error('A refresh token is required when the verified channel changes');
    }
    const configJson = buildProviderConfig({
      adapterKey: provider.adapter_key,
      submitted: refreshToken ? { refresh_token: refreshToken } : {},
      stored: existing?.config_json || {},
      isCreate: !existing,
    });
    if (!configJson.refresh_token) throw new Error('A refresh token is required for a new connection');

    const patch = {
      name: `${provider.display_name} Connection`,
      config_json: configJson,
      status: 'active',
      created_by: userId,
      external_account_id: intent.verified_channel_id,
      external_account_name: intent.verified_channel_title,
      last_verified_at: dbTimestamp(),
      deleted_at: null,
    };
    const config = existing
      ? await existing.$query(trx).patchAndFetch(patch)
      : await IntegrationConfig.query(trx).insertAndFetch({ provider_id: provider.id, organization_id: organizationId, ...patch });
    await intent.$query(trx).patch({
      status: YOUTUBE_INTENT_STATUS.CONSUMED,
      consumed_at: dbTimestamp(),
      pending_secret_json: null,
      pkce_verifier_encrypted: null,
      browser_ticket_hash: null,
    });
    await trx.commit();
    return { ok: true, config };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function cancelVerifiedYouTubeConnection({ intentId, userId, organizationId, source = YOUTUBE_CONNECTION_SOURCE.TELEGRAM }) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx).findById(intentId).forUpdate();
    if (
      !intent ||
      intent.user_id !== userId ||
      Number(intent.organization_id) !== Number(organizationId) ||
      intentSource(intent) !== source ||
      ![YOUTUBE_INTENT_STATUS.PENDING, YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION].includes(intent.status)
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_CANCEL' };
    }
    await intent.$query(trx).patch({
      status: YOUTUBE_INTENT_STATUS.CANCELLED,
      pending_secret_json: null,
      pkce_verifier_encrypted: null,
      browser_ticket_hash: null,
    });
    await trx.commit();
    return { ok: true };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function getYouTubeConnectionState(organizationId) {
  const provider = await getYouTubeProvider();
  const config = await IntegrationConfig.query()
    .where({ organization_id: organizationId, provider_id: provider.id })
    .whereNull('deleted_at')
    .first();
  return {
    provider,
    connected: config?.status === 'active',
    config: config || null,
  };
}

export async function disconnectYouTubeConnection({ userId, organizationId }) {
  const provider = await getYouTubeProvider();
  const config = await IntegrationConfig.query()
    .where({ organization_id: organizationId, provider_id: provider.id })
    .whereNull('deleted_at')
    .first();
  if (!config) return { ok: false, reason: 'NOT_CONNECTED' };
  await config.$query().patch({ status: 'disabled', deleted_at: dbTimestamp(), created_by: userId });
  return { ok: true };
}
