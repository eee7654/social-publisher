import crypto from 'node:crypto';
import getDb from '../../../config/database.js';
import IntegrationProvider from '../../../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../../../db/models/core/IntegrationConfig.js';
import IntegrationConnectionIntent from '../../../db/models/core/IntegrationConnectionIntent.js';
import UserOrganizationRole from '../../../db/models/core/UserOrganizationRole.js';
import { buildProviderConfig } from '../../../integrations/configSerializer.js';
import { encryptConfigValue, decryptConfigValue } from '../../../integrations/secrets.js';
import {
  APARAT_PROVIDER_KEY,
  APARAT_PROVIDER_CODE,
  APARAT_AUTH_MODE,
  APARAT_CONNECTION_PURPOSE,
  APARAT_CONNECTION_SOURCE,
  APARAT_INTENT_STATUS,
  APARAT_CONNECTION_TTL_MS,
  APARAT_DEFAULT_CATEGORY_ID,
} from './constants.js';
import { AparatCookieJar } from './cookieJar.js';
import {
  bootstrapSignIn,
  signInStep1,
  signInStep2,
  getUploadConfig,
  sanitizeAparatError,
} from './api.js';

const db = getDb();

export function createOpaqueState() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashState(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function dbTimestamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function isExpired(intent) {
  if (!intent?.expires_at) return true;
  const raw = String(intent.expires_at);
  const timestamp = /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? new Date(raw) : new Date(`${raw.replace(' ', 'T')}Z`);
  return timestamp.getTime() <= Date.now();
}

export async function assertUserOrganizationMembership({ userId, organizationId }) {
  const membership = await UserOrganizationRole.query()
    .where({ user_id: userId, organization_id: Number(organizationId) })
    .first();
  if (!membership) {
    throw new Error(`User ${userId} does not belong to organization ${organizationId}`);
  }
}

export async function getAparatProvider(trx) {
  const query = IntegrationProvider.query(trx).where({
    domain: 'publishing',
    code: APARAT_PROVIDER_CODE,
    is_enabled: true,
  });
  const provider = await query.first();
  if (!provider) {
    throw new Error('Aparat provider is not registered in integration_providers');
  }
  return provider;
}

export function buildAparatTicketUrl(ticket) {
  const baseUrl = process.env.APARAT_CONNECT_BASE_URL ||
    process.env.CORE_URL ||
    'https://publisher-dev.elecio.co';
  return `${baseUrl.replace(/\/+$/, '')}/api/aparat/connect?t=${encodeURIComponent(ticket)}`;
}

export async function createTelegramAparatConnectionIntent({
  telegramUserId,
  telegramChatId,
  userId,
  organizationId,
}) {
  await assertUserOrganizationMembership({ userId, organizationId });
  const browserTicket = createOpaqueState();
  const provider = await getAparatProvider();

  const intent = await IntegrationConnectionIntent.query().insert({
    id: crypto.randomUUID(),
    nonce_hash: hashState(createOpaqueState()),
    browser_ticket_hash: hashState(browserTicket),
    user_id: userId,
    organization_id: Number(organizationId),
    provider_id: provider.id,
    purpose: APARAT_CONNECTION_PURPOSE,
    source: APARAT_CONNECTION_SOURCE.TELEGRAM,
    telegram_user_id: String(telegramUserId),
    telegram_chat_id: String(telegramChatId),
    status: APARAT_INTENT_STATUS.PENDING,
    expires_at: dbTimestamp(new Date(Date.now() + APARAT_CONNECTION_TTL_MS)),
  });

  return {
    intent,
    browserTicket,
    browserUrl: buildAparatTicketUrl(browserTicket),
  };
}

/**
 * Verifies credentials by executing modern first-party sign-in handshake:
 * 1. bootstrapSignIn
 * 2. signInStep1
 * 3. signInStep2
 * 4. getUploadConfig (authoritative proof)
 *
 * Stores minimal encrypted session in pending_secret_json.
 * Discards password immediately from memory.
 */
export async function verifyAparatCredentialsFromTicket({
  ticket,
  username,
  password,
  baseUrl,
  fetchImpl,
}) {
  if (!ticket) {
    return { ok: false, code: 'INVALID_TICKET', message: 'Missing connection ticket' };
  }

  const hashedTicket = hashState(ticket);
  const trx = await db.transaction();
  let intent;
  try {
    intent = await IntegrationConnectionIntent.query(trx)
      .where({ browser_ticket_hash: hashedTicket })
      .forUpdate()
      .first();

    if (
      !intent ||
      intent.purpose !== APARAT_CONNECTION_PURPOSE ||
      intent.source !== APARAT_CONNECTION_SOURCE.TELEGRAM ||
      intent.status !== APARAT_INTENT_STATUS.PENDING ||
      isExpired(intent)
    ) {
      await trx.rollback();
      return { ok: false, code: 'INVALID_OR_EXPIRED_TICKET', message: 'This connection ticket is invalid or has expired.' };
    }

    const cookieJar = new AparatCookieJar();

    // 1. Bootstrap sign in (captures initial AuthV1)
    const bootstrap = await bootstrapSignIn({ baseUrl, cookieJar, fetchImpl });

    // 2. Step 1 check
    const step1 = await signInStep1({
      account: username,
      guid: bootstrap.guid,
      temp_id: bootstrap.temp_id,
      baseUrl,
      cookieJar,
      fetchImpl,
    });

    // 3. Step 2 password submission (memory only)
    const profile = await signInStep2({
      account: username,
      temp_id: step1.temp_id,
      password,
      guid: bootstrap.guid,
      baseUrl,
      cookieJar,
      fetchImpl,
    });

    // 4. Authoritative session proof: call upload_config with minimal session
    const uploadConfig = await getUploadConfig({
      baseUrl,
      cookieJar,
      fetchImpl,
    });

    const categories = uploadConfig.categories || [];
    let defaultCategoryId = uploadConfig.defaultSetting?.cat_id ? String(uploadConfig.defaultSetting.cat_id) : null;
    let defaultCategoryTitle = null;

    if (!defaultCategoryId && categories.length > 0) {
      const match = categories.find(c => c.id === APARAT_DEFAULT_CATEGORY_ID) || categories[0];
      defaultCategoryId = match.id;
      defaultCategoryTitle = match.title;
    } else if (defaultCategoryId) {
      const match = categories.find(c => c.id === defaultCategoryId);
      if (match) defaultCategoryTitle = match.title;
    }

    const resolvedAccountId = uploadConfig.accountId || profile.id;

    // Encrypt minimal session (AuthV1, AFCN)
    const minimalSession = cookieJar.toJSON();
    const encryptedSession = encryptConfigValue(JSON.stringify(minimalSession));

    // Invalidate ticket immediately (one-time use)
    await intent.$query(trx).patch({
      browser_ticket_hash: null,
      browser_ticket_reserved_at: dbTimestamp(),
      status: APARAT_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      verified_channel_id: profile.username,
      verified_channel_title: profile.name || profile.username,
      pending_secret_json: {
        auth_mode: APARAT_AUTH_MODE,
        username: profile.username,
        account_id: resolvedAccountId,
        account_name: profile.name,
        session: encryptedSession,
        categories,
        default_category_id: defaultCategoryId,
        default_category_title: defaultCategoryTitle,
      },
    });

    await trx.commit();

    return {
      ok: true,
      intent,
      profile: {
        username: profile.username,
        name: profile.name,
        id: resolvedAccountId,
      },
      categories,
      defaultCategory: defaultCategoryId ? { id: defaultCategoryId, title: defaultCategoryTitle } : null,
    };
  } catch (err) {
    await trx.rollback().catch(() => {});
    return {
      ok: false,
      code: err.code || 'VERIFICATION_FAILED',
      message: sanitizeAparatError(err, [password]),
    };
  }
}

export async function setDefaultAparatCategory({
  intentId,
  categoryId,
  categoryTitle,
  userId,
  organizationId,
}) {
  const intent = await IntegrationConnectionIntent.query()
    .findById(intentId)
    .first();

  if (
    !intent ||
    String(intent.user_id) !== String(userId) ||
    Number(intent.organization_id) !== Number(organizationId) ||
    intent.status !== APARAT_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION ||
    isExpired(intent)
  ) {
    return { ok: false, reason: 'INVALID_INTENT' };
  }

  const secrets = intent.pending_secret_json || {};
  secrets.default_category_id = String(categoryId);
  if (categoryTitle) {
    secrets.default_category_title = String(categoryTitle);
  }

  await intent.$query().patch({
    pending_secret_json: secrets,
  });

  return { ok: true, intent };
}

export async function activateVerifiedAparatConnection({
  intentId,
  userId,
  organizationId,
}) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx)
      .findById(intentId)
      .forUpdate()
      .first();

    if (
      !intent ||
      String(intent.user_id) !== String(userId) ||
      Number(intent.organization_id) !== Number(organizationId) ||
      intent.purpose !== APARAT_CONNECTION_PURPOSE ||
      intent.source !== APARAT_CONNECTION_SOURCE.TELEGRAM ||
      intent.status !== APARAT_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION ||
      isExpired(intent)
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_INTENT' };
    }

    const provider = await getAparatProvider(trx);
    if (Number(intent.provider_id) !== Number(provider.id)) {
      await trx.rollback();
      return { ok: false, reason: 'PROVIDER_MISMATCH' };
    }

    const pendingSecrets = intent.pending_secret_json || {};
    if (!pendingSecrets.session) {
      throw new Error('Aparat session is missing from pending connection intent');
    }

    // Verify session can be decrypted
    const rawSession = decryptConfigValue(pendingSecrets.session);
    if (!rawSession) {
      throw new Error('Failed to decrypt pending Aparat session');
    }

    const configPayload = {
      auth_mode: APARAT_AUTH_MODE,
      username: pendingSecrets.username,
      account_id: pendingSecrets.account_id || null,
      account_name: pendingSecrets.account_name || null,
      session: rawSession,
      default_category_id: pendingSecrets.default_category_id || null,
      default_category_title: pendingSecrets.default_category_title || null,
    };

    const existing = await IntegrationConfig.query(trx)
      .where({ organization_id: Number(organizationId), provider_id: provider.id })
      .whereNull('deleted_at')
      .first();

    const configJson = buildProviderConfig({
      adapterKey: provider.adapter_key || APARAT_PROVIDER_KEY,
      submitted: configPayload,
      stored: existing?.config_json || {},
      isCreate: !existing,
    });

    let config;
    const displayName = pendingSecrets.account_name || pendingSecrets.username;
    if (existing) {
      config = await existing.$query(trx).patchAndFetch({
        name: `Aparat - ${displayName}`,
        status: 'active',
        config_json: configJson,
        external_account_id: pendingSecrets.username,
        external_account_name: displayName,
        updated_at: dbTimestamp(),
      });
    } else {
      config = await IntegrationConfig.query(trx).insert({
        organization_id: Number(organizationId),
        provider_id: provider.id,
        name: `Aparat - ${displayName}`,
        status: 'active',
        config_json: configJson,
        external_account_id: pendingSecrets.username,
        external_account_name: displayName,
        created_by: userId,
        updated_at: dbTimestamp(),
      });
    }

    // Mark intent consumed and wipe pending credentials
    await intent.$query(trx).patch({
      status: APARAT_INTENT_STATUS.CONSUMED,
      consumed_at: dbTimestamp(),
      pending_secret_json: null,
    });

    await trx.commit();
    return { ok: true, config };
  } catch (err) {
    await trx.rollback().catch(() => {});
    throw err;
  }
}

export async function cancelVerifiedAparatConnection({
  intentId,
  userId,
  organizationId,
}) {
  const intent = await IntegrationConnectionIntent.query()
    .findById(intentId)
    .first();

  if (!intent) return { ok: false, reason: 'NOT_FOUND' };
  if (
    String(intent.user_id) !== String(userId) ||
    Number(intent.organization_id) !== Number(organizationId)
  ) {
    return { ok: false, reason: 'TENANT_MISMATCH' };
  }

  await intent.$query().patch({
    status: APARAT_INTENT_STATUS.CANCELLED,
    pending_secret_json: null,
  });

  return { ok: true };
}

export async function disconnectAparatConnection({ userId, organizationId }) {
  const provider = await getAparatProvider();
  const config = await IntegrationConfig.query()
    .where({ organization_id: Number(organizationId), provider_id: provider.id })
    .whereNull('deleted_at')
    .first();

  if (!config) {
    return { ok: false, reason: 'CONFIG_NOT_FOUND' };
  }

  await config.$query().patch({
    status: 'inactive',
    updated_at: dbTimestamp(),
  });

  return { ok: true, config };
}

export async function getAparatConnectionState(organizationId) {
  try {
    const provider = await getAparatProvider();
    const config = await IntegrationConfig.query()
      .where({
        organization_id: Number(organizationId),
        provider_id: provider.id,
        status: 'active',
      })
      .whereNull('deleted_at')
      .first();

    if (!config) return { connected: false, config: null };

    // Strict web session check: must have auth_mode === 'aparat_web_session_v1' and session
    const configJson = config.config_json || {};
    const hasValidSession = configJson.auth_mode === APARAT_AUTH_MODE && Boolean(configJson.session);

    if (!hasValidSession) {
      // Legacy ltoken config is not considered active
      return { connected: false, config: null };
    }

    return {
      connected: true,
      config,
    };
  } catch {
    return { connected: false, config: null };
  }
}

export async function pendingTelegramAparatIntent(binding) {
  const rows = await IntegrationConnectionIntent.query()
    .where({
      user_id: binding.user_id,
      organization_id: binding.organization_id,
      purpose: APARAT_CONNECTION_PURPOSE,
      source: APARAT_CONNECTION_SOURCE.TELEGRAM,
      status: APARAT_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
    })
    .orderBy('created_at', 'desc')
    .limit(5);

  return rows.find(intent => !isExpired(intent)) || null;
}

/**
 * Safely updates rotated session cookies in IntegrationConfig without disconnecting.
 */
export async function rotateAparatSession({ integrationConfigId, newSessionJson, trx = db }) {
  if (!integrationConfigId || !newSessionJson) return;

  const config = await IntegrationConfig.query(trx).findById(integrationConfigId);
  if (!config || !config.config_json) return;

  // Avoid redundant DB writes if session cookies did not materially change
  if (config.config_json.session) {
    try {
      const existingDecrypted = decryptConfigValue(config.config_json.session);
      const existingObj = typeof existingDecrypted === 'string' ? JSON.parse(existingDecrypted) : existingDecrypted;
      const newObj = typeof newSessionJson === 'string' ? JSON.parse(newSessionJson) : newSessionJson;
      if (
        existingObj?.AuthV1 === newObj?.AuthV1 &&
        existingObj?.AFCN === newObj?.AFCN
      ) {
        return;
      }
    } catch {}
  }

  const encryptedSession = encryptConfigValue(
    typeof newSessionJson === 'string' ? newSessionJson : JSON.stringify(newSessionJson)
  );

  const updatedConfigJson = {
    ...config.config_json,
    session: encryptedSession,
  };

  await config.$query(trx).patch({
    config_json: updatedConfigJson,
    updated_at: dbTimestamp(),
  });
}
