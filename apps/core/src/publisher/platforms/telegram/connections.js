import { randomUUID } from 'node:crypto';
import getDb from '../../../config/database.js';
import IntegrationProvider from '../../../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../../../db/models/core/IntegrationConfig.js';
import IntegrationConnectionIntent from '../../../db/models/core/IntegrationConnectionIntent.js';
import TelegramChannel from '../../../db/models/core/TelegramChannel.js';
import UserOrganizationRole from '../../../db/models/core/UserOrganizationRole.js';
import { buildProviderConfig } from '../../../integrations/configSerializer.js';
import {
  TELEGRAM_ADAPTER_KEY,
  TELEGRAM_CONNECTION_PURPOSE,
  TELEGRAM_CONNECTION_SOURCE,
  TELEGRAM_CONNECTION_TTL_MS,
  TELEGRAM_INTENT_STATUS,
  TELEGRAM_PROVIDER_CODE,
} from './constants.js';

export {
  TELEGRAM_ADAPTER_KEY,
  TELEGRAM_CONNECTION_PURPOSE,
  TELEGRAM_CONNECTION_SOURCE,
  TELEGRAM_CONNECTION_TTL_MS,
  TELEGRAM_INTENT_STATUS,
  TELEGRAM_PROVIDER_CODE,
};

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
  return intent?.source || TELEGRAM_CONNECTION_SOURCE.TELEGRAM;
}

export async function getTelegramProvider(trx) {
  const provider = await IntegrationProvider.query(trx)
    .where({ domain: 'publishing', code: TELEGRAM_PROVIDER_CODE, adapter_key: TELEGRAM_ADAPTER_KEY, is_enabled: true })
    .first();
  if (!provider) throw new Error('Telegram publishing provider is unavailable');
  return provider;
}

export async function assertUserOrganizationMembership({ userId, organizationId }) {
  const membership = await UserOrganizationRole.query()
    .where({ user_id: userId, organization_id: organizationId })
    .first();
  if (!membership) throw new Error('User is not authorized for the requested organization');
  return membership;
}

export async function createTelegramChannelConnectionIntent({
  telegramUserId,
  telegramChatId,
  userId,
  organizationId,
}) {
  await assertUserOrganizationMembership({ userId, organizationId });
  const provider = await getTelegramProvider();
  const nonceHash = (await import('node:crypto')).createHash('sha256').update(randomUUID()).digest('hex');
  const intent = await IntegrationConnectionIntent.query().insert({
    id: randomUUID(),
    nonce_hash: nonceHash,
    user_id: userId,
    organization_id: organizationId,
    provider_id: provider.id,
    purpose: TELEGRAM_CONNECTION_PURPOSE,
    source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
    telegram_user_id: String(telegramUserId),
    telegram_chat_id: String(telegramChatId),
    status: TELEGRAM_INTENT_STATUS.PENDING,
    expires_at: dbTimestamp(new Date(Date.now() + TELEGRAM_CONNECTION_TTL_MS)),
  });

  return { intent };
}

export async function verifyTelegramChannelCandidate({
  intentId,
  channelIdentifier,
  telegramClient,
}) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx)
      .findById(intentId)
      .forUpdate();

    if (
      !intent ||
      intent.purpose !== TELEGRAM_CONNECTION_PURPOSE ||
      intent.status !== TELEGRAM_INTENT_STATUS.PENDING ||
      isExpired(intent)
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_INTENT' };
    }

    // 1. Query getChat to verify chat existence and get type/title
    let chat;
    try {
      chat = await telegramClient.getChat(channelIdentifier);
    } catch (chatErr) {
      await trx.rollback();
      return { ok: false, reason: 'CHANNEL_NOT_FOUND', error: chatErr.message };
    }

    if (!chat || chat.type !== 'channel') {
      await trx.rollback();
      return { ok: false, reason: 'NOT_A_CHANNEL', error: `Target chat type is ${chat?.type || 'unknown'}, must be channel` };
    }

    // 2. Query getMe to get the bot's own ID
    const bot = await telegramClient.getMe();
    if (!bot?.id) {
      await trx.rollback();
      throw new Error('Telegram Bot getMe returned invalid bot info');
    }

    // 3. Query getChatMember to verify bot administrator role and can_post_messages permission
    let member;
    try {
      member = await telegramClient.getChatMember(chat.id, bot.id);
    } catch (memberErr) {
      await trx.rollback();
      return { ok: false, reason: 'MEMBER_LOOKUP_FAILED', error: memberErr.message };
    }

    const isCreator = member?.status === 'creator';
    const isAdmin = member?.status === 'administrator';
    const canPost = isCreator || (isAdmin && member?.can_post_messages === true);

    if (!canPost) {
      await trx.rollback();
      return {
        ok: false,
        reason: 'BOT_NOT_ADMIN_OR_CANNOT_POST',
        error: 'Bot must be an administrator in the channel with can_post_messages permission',
        memberStatus: member?.status,
        canPostMessages: member?.can_post_messages,
      };
    }

    // 4. Update intent to VERIFIED_PENDING_CONFIRMATION
    const verifiedId = String(chat.id);
    const verifiedTitle = chat.title || (chat.username ? `@${chat.username}` : `Channel ${verifiedId}`);
    const metadata = {
      chat_id: verifiedId,
      chat_title: chat.title || null,
      chat_username: chat.username ? `@${chat.username.replace(/^@/, '')}` : null,
    };

    const updated = await intent.$query(trx).patchAndFetch({
      status: TELEGRAM_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      verified_channel_id: verifiedId,
      verified_channel_title: verifiedTitle,
      pending_secret_json: metadata,
      updated_at: dbTimestamp(),
    });

    await trx.commit();
    return { ok: true, intent: updated, chat };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function activateVerifiedTelegramConnection({
  intentId,
  userId,
  organizationId,
  channelId,
  source = null,
}) {
  const trx = await db.transaction();
  try {
    const intent = await IntegrationConnectionIntent.query(trx)
      .findById(intentId)
      .forUpdate();
    const expectedSource = source || intentSource(intent);

    if (
      !intent ||
      intent.user_id !== userId ||
      Number(intent.organization_id) !== Number(organizationId) ||
      intent.status !== TELEGRAM_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION ||
      intentSource(intent) !== expectedSource ||
      isExpired(intent) ||
      (channelId && channelId !== intent.verified_channel_id)
    ) {
      await trx.rollback();
      return { ok: false, reason: 'INVALID_OR_EXPIRED_CONFIRMATION' };
    }

    const provider = await getTelegramProvider(trx);
    if (Number(intent.provider_id) !== Number(provider.id)) {
      await trx.rollback();
      return { ok: false, reason: 'PROVIDER_MISMATCH' };
    }

    const pendingMeta = intent.pending_secret_json || {};
    const chatId = intent.verified_channel_id || pendingMeta.chat_id;
    const chatTitle = intent.verified_channel_title || pendingMeta.chat_title;
    const chatUsername = pendingMeta.chat_username || null;

    if (!chatId) {
      throw new Error('chat_id is missing from pending connection intent');
    }

    const existingConfig = await IntegrationConfig.query(trx)
      .where({ organization_id: organizationId, provider_id: provider.id })
      .whereNull('deleted_at')
      .first();

    const submitted = {
      chat_id: chatId,
      chat_title: chatTitle,
      chat_username: chatUsername,
    };

    const configJson = buildProviderConfig({
      adapterKey: provider.adapter_key,
      submitted,
      stored: existingConfig?.config_json || {},
      isCreate: !existingConfig,
    });

    const patch = {
      name: `Telegram - ${chatTitle || chatId}`,
      config_json: configJson,
      status: 'active',
      external_account_id: chatId,
      external_account_name: chatTitle,
      metadata_json: {
        chat_id: chatId,
        chat_title: chatTitle,
        chat_username: chatUsername,
      },
      deleted_at: null,
      updated_at: dbTimestamp(),
    };

    let config;
    if (existingConfig) {
      config = await existingConfig.$query(trx).patchAndFetch(patch);
    } else {
      config = await IntegrationConfig.query(trx).insertAndFetch({
        organization_id: organizationId,
        provider_id: provider.id,
        created_by: userId,
        is_default: true,
        ...patch,
      });
    }

    // Sync telegram_channels table
    const existingChannel = await TelegramChannel.query(trx)
      .where({ organization_id: organizationId, chat_id: chatId })
      .first();

    let channel;
    if (existingChannel) {
      channel = await existingChannel.$query(trx).patchAndFetch({
        integration_config_id: config.id,
        username: chatUsername ? chatUsername.replace(/^@/, '') : null,
        title: chatTitle,
        owner_user_id: userId,
        is_active: true,
        updated_at: dbTimestamp(),
      });
    } else {
      channel = await TelegramChannel.query(trx).insertAndFetch({
        organization_id: organizationId,
        integration_config_id: config.id,
        chat_id: chatId,
        username: chatUsername ? chatUsername.replace(/^@/, '') : null,
        title: chatTitle,
        owner_user_id: userId,
        is_active: true,
      });
    }

    await intent.$query(trx).patch({
      status: TELEGRAM_INTENT_STATUS.CONSUMED,
      consumed_at: dbTimestamp(),
      pending_secret_json: null,
    });

    await trx.commit();
    return { ok: true, config, channel };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export async function cancelVerifiedTelegramConnection({ intentId, userId, organizationId, source = null }) {
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
      status: TELEGRAM_INTENT_STATUS.CANCELLED,
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

export async function disconnectTelegramConnection({ organizationId, userId }) {
  const provider = await getTelegramProvider();
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

  await TelegramChannel.query()
    .where({ organization_id: organizationId, integration_config_id: config.id })
    .patch({
      is_active: false,
      updated_at: dbTimestamp(),
    });

  return { ok: true };
}

export async function getTelegramConnectionState(organizationId) {
  const provider = await getTelegramProvider();
  const config = await IntegrationConfig.query()
    .where({ organization_id: organizationId, provider_id: provider.id, status: 'active' })
    .whereNull('deleted_at')
    .first();

  if (!config) {
    return { connected: false, config: null, channel: null };
  }

  const channel = await TelegramChannel.query()
    .where({ organization_id: organizationId, integration_config_id: config.id, is_active: true })
    .first();

  return {
    connected: true,
    config,
    channel,
  };
}
