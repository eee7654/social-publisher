import TelegramUserBinding from '../../db/models/core/TelegramUserBinding.js';
import IntegrationConnectionIntent from '../../db/models/core/IntegrationConnectionIntent.js';
import {
  activateVerifiedYouTubeConnection,
  cancelVerifiedYouTubeConnection,
  createTelegramYouTubeConnectionIntent,
  disconnectYouTubeConnection,
  getYouTubeConnectionState,
  intentSource,
  isExpired,
  YOUTUBE_CONNECTION_SOURCE,
  YOUTUBE_INTENT_STATUS,
} from '../platforms/youtube/connections.js';
import {
  activateVerifiedLinkedInConnection,
  cancelVerifiedLinkedInConnection,
  createTelegramLinkedInConnectionIntent,
  disconnectLinkedInConnection,
  getLinkedInConnectionState,
  LINKEDIN_CONNECTION_SOURCE,
  LINKEDIN_INTENT_STATUS,
} from '../platforms/linkedin/connections.js';
import {
  activateVerifiedTelegramConnection,
  cancelVerifiedTelegramConnection,
  createTelegramChannelConnectionIntent,
  disconnectTelegramConnection,
  getTelegramConnectionState,
  TELEGRAM_CONNECTION_SOURCE,
  TELEGRAM_INTENT_STATUS,
} from '../platforms/telegram/connections.js';
import {
  activateVerifiedAparatConnection,
  cancelVerifiedAparatConnection,
  createTelegramAparatConnectionIntent,
  disconnectAparatConnection,
  getAparatConnectionState,
  pendingTelegramAparatIntent,
  setDefaultAparatCategory,
} from '../platforms/aparat/connections.js';
import {
  APARAT_CONNECTION_SOURCE,
  APARAT_INTENT_STATUS,
  APARAT_CONNECTION_PURPOSE,
} from '../platforms/aparat/constants.js';

export const CONNECTION_CALLBACKS = Object.freeze({
  SELECT_ORG: 'conn_org',
  YOUTUBE_CONNECT: 'conn_yt',
  YOUTUBE_RECONNECT: 'conn_yt_re',
  YOUTUBE_DISCONNECT: 'conn_yt_dis',
  YOUTUBE_CONFIRM: 'conn_yt_ok',
  YOUTUBE_CANCEL: 'conn_yt_no',
  LINKEDIN_CONNECT: 'conn_li',
  LINKEDIN_RECONNECT: 'conn_li_re',
  LINKEDIN_DISCONNECT: 'conn_li_dis',
  LINKEDIN_CONFIRM: 'conn_li_ok',
  LINKEDIN_CANCEL: 'conn_li_no',
  TELEGRAM_CONNECT: 'conn_tg',
  TELEGRAM_RECONNECT: 'conn_tg_re',
  TELEGRAM_DISCONNECT: 'conn_tg_dis',
  TELEGRAM_CONFIRM: 'conn_tg_ok',
  TELEGRAM_CANCEL: 'conn_tg_no',
  APARAT_CONNECT: 'conn_ap',
  APARAT_RECONNECT: 'conn_ap_re',
  APARAT_DISCONNECT: 'conn_ap_dis',
  APARAT_CONFIRM: 'conn_ap_ok',
  APARAT_CANCEL: 'conn_ap_no',
  APARAT_CATEGORY: 'conn_ap_cat',
});

function connectionCallback(action, value) {
  return `${action}:${value}`;
}

export function isConnectionsCommand(text) {
  return String(text || '').trim() === '/connections';
}

export function isConnectionCallback(data) {
  const value = String(data || '');
  return Object.values(CONNECTION_CALLBACKS).some(action => value === action || value.startsWith(`${action}:`));
}

function buttonRows(buttons) {
  return { inline_keyboard: buttons.map(button => [button]) };
}

async function activeTelegramBindings(telegramUserId) {
  return TelegramUserBinding.query()
    .where({ telegram_user_id: String(telegramUserId), is_active: true })
    .withGraphFetched('[user, organization]');
}

function validBindings(bindings) {
  return bindings.filter(binding => binding.user && binding.organization && binding.organization.is_active);
}

async function bindingForOrganization(telegramUserId, organizationId) {
  const binding = await TelegramUserBinding.query()
    .where({ telegram_user_id: String(telegramUserId), organization_id: Number(organizationId), is_active: true })
    .withGraphFetched('[user, organization]')
    .first();
  if (!binding?.user || !binding.organization?.is_active) return null;
  return binding;
}

function organizationName(bindingOrIntent) {
  return bindingOrIntent?.organization?.name || `Organization ${bindingOrIntent?.organization_id}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isTelegramUrlButtonSafe(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return parsed.protocol === 'https:' &&
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1' &&
    hostname !== '::1' &&
    !hostname.endsWith('.local');
}

async function pendingTelegramYouTubeIntent(binding) {
  const rows = await IntegrationConnectionIntent.query()
    .where({
      user_id: binding.user_id,
      organization_id: binding.organization_id,
      source: YOUTUBE_CONNECTION_SOURCE.TELEGRAM,
      status: YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
    })
    .orderBy('created_at', 'desc')
    .limit(5);
  return rows.find(intent => !isExpired(intent)) || null;
}

async function pendingTelegramLinkedInIntent(binding) {
  const rows = await IntegrationConnectionIntent.query()
    .where({
      user_id: binding.user_id,
      organization_id: binding.organization_id,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
      status: LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
    })
    .orderBy('created_at', 'desc')
    .limit(5);
  return rows.find(intent => !isExpired(intent)) || null;
}

export async function pendingTelegramChannelIntent(binding) {
  const rows = await IntegrationConnectionIntent.query()
    .where({
      user_id: binding.user_id,
      organization_id: binding.organization_id,
      source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
      status: TELEGRAM_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
    })
    .orderBy('created_at', 'desc')
    .limit(5);
  return rows.find(intent => !isExpired(intent)) || null;
}

export async function pendingTelegramChannelVerificationIntent(telegramUserId) {
  const rows = await IntegrationConnectionIntent.query()
    .where({
      source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
      status: TELEGRAM_INTENT_STATUS.PENDING,
    })
    .andWhere(builder => {
      builder.where({ telegram_user_id: String(telegramUserId) })
        .orWhere({ user_id: String(telegramUserId) });
    })
    .orderBy('created_at', 'desc')
    .limit(5);
  return rows.find(intent => !isExpired(intent)) || null;
}

async function sendOrganizationSelection({ telegramClient, chatId, bindings }) {
  const buttons = bindings.map(binding => ({
    text: organizationName(binding),
    callback_data: connectionCallback(CONNECTION_CALLBACKS.SELECT_ORG, binding.organization_id),
  }));
  await telegramClient.sendMessage({
    chat_id: chatId,
    text: 'Select organization for platform connections:',
    reply_markup: buttonRows(buttons),
  });
}

async function sendOrganizationConfirmation({ telegramClient, chatId, binding }) {
  await telegramClient.sendMessage({
    chat_id: chatId,
    text: `Organization: ${organizationName(binding)}`,
    reply_markup: buttonRows([{
      text: 'Use this organization',
      callback_data: connectionCallback(CONNECTION_CALLBACKS.SELECT_ORG, binding.organization_id),
    }]),
  });
}

export async function sendTelegramConnectionsMenu({ telegramClient, chatId, binding }) {
  const youtube = await getYouTubeConnectionState(binding.organization_id);
  const pendingYtIntent = await pendingTelegramYouTubeIntent(binding);
  const buttons = [];
  let youtubeText = 'YouTube: disconnected';
  if (pendingYtIntent) {
    youtubeText = `YouTube: pending confirmation\nChannel: ${pendingYtIntent.verified_channel_title || pendingYtIntent.verified_channel_id || 'verified channel'}`;
    buttons.push({ text: 'Confirm YouTube', callback_data: connectionCallback(CONNECTION_CALLBACKS.YOUTUBE_CONFIRM, pendingYtIntent.id) });
    buttons.push({ text: 'Cancel YouTube', callback_data: connectionCallback(CONNECTION_CALLBACKS.YOUTUBE_CANCEL, pendingYtIntent.id) });
  } else if (youtube.connected) {
    youtubeText = `YouTube: connected\nChannel: ${youtube.config.external_account_name || youtube.config.external_account_id || 'connected channel'}`;
    buttons.push({ text: 'Reconnect YouTube', callback_data: connectionCallback(CONNECTION_CALLBACKS.YOUTUBE_RECONNECT, binding.organization_id) });
    buttons.push({ text: 'Disconnect YouTube', callback_data: connectionCallback(CONNECTION_CALLBACKS.YOUTUBE_DISCONNECT, binding.organization_id) });
  } else {
    buttons.push({ text: 'Connect YouTube', callback_data: connectionCallback(CONNECTION_CALLBACKS.YOUTUBE_CONNECT, binding.organization_id) });
  }

  const linkedin = await getLinkedInConnectionState(binding.organization_id);
  const pendingLiIntent = await pendingTelegramLinkedInIntent(binding);
  let linkedinText = 'LinkedIn: disconnected';
  if (pendingLiIntent) {
    linkedinText = `LinkedIn: pending confirmation\nPage: ${pendingLiIntent.verified_channel_title || pendingLiIntent.verified_channel_id || 'verified page'}`;
    buttons.push({ text: 'Confirm LinkedIn', callback_data: connectionCallback(CONNECTION_CALLBACKS.LINKEDIN_CONFIRM, pendingLiIntent.id) });
    buttons.push({ text: 'Cancel LinkedIn', callback_data: connectionCallback(CONNECTION_CALLBACKS.LINKEDIN_CANCEL, pendingLiIntent.id) });
  } else if (linkedin.connected) {
    linkedinText = `LinkedIn: connected\nPage: ${linkedin.config.external_account_name || linkedin.config.external_account_id || 'connected page'}`;
    buttons.push({ text: 'Reconnect LinkedIn', callback_data: connectionCallback(CONNECTION_CALLBACKS.LINKEDIN_RECONNECT, binding.organization_id) });
    buttons.push({ text: 'Disconnect LinkedIn', callback_data: connectionCallback(CONNECTION_CALLBACKS.LINKEDIN_DISCONNECT, binding.organization_id) });
  } else {
    buttons.push({ text: 'Connect LinkedIn', callback_data: connectionCallback(CONNECTION_CALLBACKS.LINKEDIN_CONNECT, binding.organization_id) });
  }

  const telegram = await getTelegramConnectionState(binding.organization_id);
  const pendingTgIntent = await pendingTelegramChannelIntent(binding);
  let telegramText = 'Telegram Channel: disconnected';
  if (pendingTgIntent) {
    telegramText = `Telegram Channel: pending confirmation\nChannel: ${pendingTgIntent.verified_channel_title || pendingTgIntent.verified_channel_id || 'verified channel'}`;
    buttons.push({ text: 'Confirm Telegram Channel', callback_data: connectionCallback(CONNECTION_CALLBACKS.TELEGRAM_CONFIRM, pendingTgIntent.id) });
    buttons.push({ text: 'Cancel Telegram Channel', callback_data: connectionCallback(CONNECTION_CALLBACKS.TELEGRAM_CANCEL, pendingTgIntent.id) });
  } else if (telegram.connected) {
    telegramText = `Telegram Channel: connected\nChannel: ${telegram.config.external_account_name || telegram.config.external_account_id || 'connected channel'}`;
    buttons.push({ text: 'Reconnect Telegram Channel', callback_data: connectionCallback(CONNECTION_CALLBACKS.TELEGRAM_RECONNECT, binding.organization_id) });
    buttons.push({ text: 'Disconnect Telegram Channel', callback_data: connectionCallback(CONNECTION_CALLBACKS.TELEGRAM_DISCONNECT, binding.organization_id) });
  } else {
    buttons.push({ text: 'Connect Telegram Channel', callback_data: connectionCallback(CONNECTION_CALLBACKS.TELEGRAM_CONNECT, binding.organization_id) });
  }

  const aparat = await getAparatConnectionState(binding.organization_id);
  const pendingApIntent = await pendingTelegramAparatIntent(binding);
  let aparatText = 'Aparat: disconnected';
  if (pendingApIntent) {
    const verifiedUser = pendingApIntent.verified_channel_id ? `@${pendingApIntent.verified_channel_id}` : 'verified account';
    aparatText = `Aparat: pending confirmation\nAccount: ${verifiedUser}`;
    buttons.push({ text: 'Confirm Aparat', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CONFIRM, pendingApIntent.id) });
    buttons.push({ text: 'Cancel Aparat', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CANCEL, pendingApIntent.id) });
  } else if (aparat.connected) {
    const accountLabel = aparat.config.external_account_id ? `@${aparat.config.external_account_id}` : (aparat.config.external_account_name || 'connected account');
    aparatText = `Aparat: connected\nAccount: ${accountLabel}`;
    buttons.push({ text: 'Reconnect Aparat', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_RECONNECT, binding.organization_id) });
    buttons.push({ text: 'Disconnect Aparat', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_DISCONNECT, binding.organization_id) });
  } else {
    buttons.push({ text: 'Connect Aparat', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CONNECT, binding.organization_id) });
  }

  await telegramClient.sendMessage({
    chat_id: chatId,
    text: `Connections\nOrganization: ${organizationName(binding)}\n\n${youtubeText}\n\n${linkedinText}\n\n${telegramText}\n\n${aparatText}`,
    reply_markup: buttonRows(buttons),
  });
}

async function sendYouTubeBrowserTicket({ telegramClient, chatId, binding }) {
  const { intent, browserUrl } = await createTelegramYouTubeConnectionIntent({
    telegramUserId: binding.telegram_user_id,
    telegramChatId: chatId,
    userId: binding.user_id,
    organizationId: binding.organization_id,
  });
  try {
    if (isTelegramUrlButtonSafe(browserUrl)) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: `Open the browser to authorize YouTube for ${organizationName(binding)}.`,
        reply_markup: {
          inline_keyboard: [[{ text: 'Connect YouTube', url: browserUrl }]],
        },
      });
      return;
    }

    await telegramClient.sendMessage({
      chat_id: chatId,
      text: `Open this local authorization link in a browser:\n<code>${escapeHtml(browserUrl)}</code>\n\nFor a clickable Telegram button, set YOUTUBE_CONNECT_BASE_URL to a public HTTPS URL that forwards to Core.`,
    });
  } catch (error) {
    await cancelVerifiedYouTubeConnection({
      intentId: intent.id,
      userId: binding.user_id,
      organizationId: binding.organization_id,
      source: YOUTUBE_CONNECTION_SOURCE.TELEGRAM,
    }).catch(() => {});
    throw error;
  }
}

async function loadTelegramIntent(intentId) {
  const intent = await IntegrationConnectionIntent.query()
    .findById(intentId)
    .withGraphFetched('organization');
  if (!intent || intentSource(intent) !== YOUTUBE_CONNECTION_SOURCE.TELEGRAM) return null;
  return intent;
}

export async function notifyTelegramYouTubeVerified({ intent, telegramClient }) {
  if (!intent?.telegram_chat_id || intentSource(intent) !== YOUTUBE_CONNECTION_SOURCE.TELEGRAM) return false;
  const organization = intent.organization || (await IntegrationConnectionIntent.query().findById(intent.id).withGraphFetched('organization'))?.organization;
  const orgTitle = organization?.name || `Organization ${intent.organization_id}`;
  await telegramClient.sendMessage({
    chat_id: intent.telegram_chat_id,
    text: `YouTube account verified\n\nChannel: ${intent.verified_channel_title}\nChannel ID: ${intent.verified_channel_id}\nOrganization: ${orgTitle}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Confirm connection', callback_data: connectionCallback(CONNECTION_CALLBACKS.YOUTUBE_CONFIRM, intent.id) }],
        [{ text: 'Cancel', callback_data: connectionCallback(CONNECTION_CALLBACKS.YOUTUBE_CANCEL, intent.id) }],
      ],
    },
  });
  return true;
}

async function handleFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId }) {
  const intent = await loadTelegramIntent(intentId);
  if (!intent) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'No pending YouTube connection was found.' });
    return;
  }
  const binding = await bindingForOrganization(telegramUserId, intent.organization_id);
  if (!binding || binding.user_id !== intent.user_id) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized to confirm this connection.' });
    return;
  }

  if (action === CONNECTION_CALLBACKS.YOUTUBE_CANCEL || isExpired(intent)) {
    await cancelVerifiedYouTubeConnection({
      intentId: intent.id,
      userId: intent.user_id,
      organizationId: intent.organization_id,
      source: YOUTUBE_CONNECTION_SOURCE.TELEGRAM,
    });
    await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube connection cancelled.' });
    return;
  }

  if (intent.status !== YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube connection is not ready for confirmation.' });
    return;
  }

  const result = await activateVerifiedYouTubeConnection({
    intentId: intent.id,
    userId: intent.user_id,
    organizationId: intent.organization_id,
    channelId: intent.verified_channel_id,
    source: YOUTUBE_CONNECTION_SOURCE.TELEGRAM,
  });
  await telegramClient.sendMessage({
    chat_id: chatId,
    text: result.ok ? 'YouTube connection activated.' : 'YouTube connection could not be confirmed.',
  });
}

async function sendLinkedInBrowserTicket({ telegramClient, chatId, binding }) {
  const { intent, browserUrl } = await createTelegramLinkedInConnectionIntent({
    telegramUserId: binding.telegram_user_id,
    telegramChatId: chatId,
    userId: binding.user_id,
    organizationId: binding.organization_id,
  });
  try {
    if (isTelegramUrlButtonSafe(browserUrl)) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: `Open the browser to authorize LinkedIn for ${organizationName(binding)}.`,
        reply_markup: {
          inline_keyboard: [[{ text: 'Connect LinkedIn', url: browserUrl }]],
        },
      });
      return;
    }

    await telegramClient.sendMessage({
      chat_id: chatId,
      text: `Open this local authorization link in a browser:\n<code>${escapeHtml(browserUrl)}</code>\n\nFor a clickable Telegram button, set LINKEDIN_CONNECT_BASE_URL to a public HTTPS URL that forwards to Core.`,
    });
  } catch (error) {
    await cancelVerifiedLinkedInConnection({
      intentId: intent.id,
      userId: binding.user_id,
      organizationId: binding.organization_id,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
    }).catch(() => {});
    throw error;
  }
}

async function loadTelegramLinkedInIntent(intentId) {
  const intent = await IntegrationConnectionIntent.query()
    .findById(intentId)
    .withGraphFetched('organization');
  if (!intent || intentSource(intent) !== LINKEDIN_CONNECTION_SOURCE.TELEGRAM) return null;
  return intent;
}

export async function notifyTelegramLinkedInVerified({ intent, telegramClient }) {
  if (!intent?.telegram_chat_id || intentSource(intent) !== LINKEDIN_CONNECTION_SOURCE.TELEGRAM) return false;
  const organization = intent.organization || (await IntegrationConnectionIntent.query().findById(intent.id).withGraphFetched('organization'))?.organization;
  const orgTitle = organization?.name || `Organization ${intent.organization_id}`;
  const cleanOrgId = String(intent.verified_channel_id).replace(/^urn:li:organization:/, '');

  await telegramClient.sendMessage({
    chat_id: intent.telegram_chat_id,
    text: `LinkedIn Company Page verified\n\nPage: ${intent.verified_channel_title}\nOrganization ID: ${cleanOrgId}\nURN: ${intent.verified_channel_id}\nOrganization: ${orgTitle}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Confirm connection', callback_data: connectionCallback(CONNECTION_CALLBACKS.LINKEDIN_CONFIRM, intent.id) }],
        [{ text: 'Cancel', callback_data: connectionCallback(CONNECTION_CALLBACKS.LINKEDIN_CANCEL, intent.id) }],
      ],
    },
  });
  return true;
}

async function handleLinkedInFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId }) {
  const intent = await loadTelegramLinkedInIntent(intentId);
  if (!intent) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'No pending LinkedIn connection was found.' });
    return;
  }
  const binding = await bindingForOrganization(telegramUserId, intent.organization_id);
  if (!binding || binding.user_id !== intent.user_id) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized to confirm this connection.' });
    return;
  }

  if (action === CONNECTION_CALLBACKS.LINKEDIN_CANCEL || isExpired(intent)) {
    await cancelVerifiedLinkedInConnection({
      intentId: intent.id,
      userId: intent.user_id,
      organizationId: intent.organization_id,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
    });
    await telegramClient.sendMessage({ chat_id: chatId, text: 'LinkedIn connection cancelled.' });
    return;
  }

  if (intent.status !== LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'LinkedIn connection is not ready for confirmation.' });
    return;
  }

  const result = await activateVerifiedLinkedInConnection({
    intentId: intent.id,
    userId: intent.user_id,
    organizationId: intent.organization_id,
    organizationUrn: intent.verified_channel_id,
    source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
  });
  await telegramClient.sendMessage({
    chat_id: chatId,
    text: result.ok ? `LinkedIn connection activated for ${intent.verified_channel_title}.` : 'LinkedIn connection could not be confirmed.',
  });
}

export async function handleTelegramConnectionMessage({ telegramClient, chatId, telegramUserId }) {
  const bindings = validBindings(await activeTelegramBindings(telegramUserId));
  if (bindings.length === 0) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'Your Telegram account is not connected to an active organization.' });
    return { handled: true, authorized: false, error: 'UNBOUND_USER' };
  }
  if (bindings.length === 1) {
    await sendOrganizationConfirmation({ telegramClient, chatId, binding: bindings[0] });
    return { handled: true, needsOrganizationConfirmation: true };
  }
  await sendOrganizationSelection({ telegramClient, chatId, bindings });
  return { handled: true, needsOrganizationSelection: true };
}

export async function handleTelegramConnectionCallback({ telegramClient, chatId, telegramUserId, callbackQuery }) {
  const data = String(callbackQuery.data || '');
  const firstColon = data.indexOf(':');
  const action = firstColon === -1 ? data : data.slice(0, firstColon);
  const value = firstColon === -1 ? '' : data.slice(firstColon + 1);

  await telegramClient.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: '' }).catch(() => {});

  if (action === CONNECTION_CALLBACKS.SELECT_ORG) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'Organization selection is not authorized.' });
      return { handled: true, authorized: false };
    }
    await sendTelegramConnectionsMenu({ telegramClient, chatId, binding });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.YOUTUBE_CONNECT, CONNECTION_CALLBACKS.YOUTUBE_RECONNECT].includes(action)) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    await sendYouTubeBrowserTicket({ telegramClient, chatId, binding });
    return { handled: true };
  }

  if (action === CONNECTION_CALLBACKS.YOUTUBE_DISCONNECT) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    const result = await disconnectYouTubeConnection({ userId: binding.user_id, organizationId: binding.organization_id });
    await telegramClient.sendMessage({ chat_id: chatId, text: result.ok ? 'YouTube connection disconnected.' : 'No active YouTube connection was found.' });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.YOUTUBE_CONFIRM, CONNECTION_CALLBACKS.YOUTUBE_CANCEL].includes(action)) {
    await handleFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId: value });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.LINKEDIN_CONNECT, CONNECTION_CALLBACKS.LINKEDIN_RECONNECT].includes(action)) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    await sendLinkedInBrowserTicket({ telegramClient, chatId, binding });
    return { handled: true };
  }

  if (action === CONNECTION_CALLBACKS.LINKEDIN_DISCONNECT) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    const result = await disconnectLinkedInConnection({ userId: binding.user_id, organizationId: binding.organization_id });
    await telegramClient.sendMessage({ chat_id: chatId, text: result.ok ? 'LinkedIn connection disconnected.' : 'No active LinkedIn connection was found.' });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.LINKEDIN_CONFIRM, CONNECTION_CALLBACKS.LINKEDIN_CANCEL].includes(action)) {
    await handleLinkedInFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId: value });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.TELEGRAM_CONNECT, CONNECTION_CALLBACKS.TELEGRAM_RECONNECT].includes(action)) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    await createTelegramChannelConnectionIntent({
      telegramUserId: binding.telegram_user_id,
      telegramChatId: chatId,
      userId: binding.user_id,
      organizationId: binding.organization_id,
    });
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: `📢 <b>Connect Telegram Channel for ${organizationName(binding)}</b>\n\n1. Add this bot as an <b>Administrator</b> in your channel with <b>Post Messages</b> permission.\n2. Then <b>forward any message from the channel</b> to this chat, or send the channel username (e.g. <code>@mychannel</code>).`,
    });
    return { handled: true };
  }

  if (action === CONNECTION_CALLBACKS.TELEGRAM_DISCONNECT) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    const result = await disconnectTelegramConnection({ userId: binding.user_id, organizationId: binding.organization_id });
    await telegramClient.sendMessage({ chat_id: chatId, text: result.ok ? 'Telegram Channel connection disconnected.' : 'No active Telegram Channel was found.' });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.TELEGRAM_CONFIRM, CONNECTION_CALLBACKS.TELEGRAM_CANCEL].includes(action)) {
    await handleTelegramChannelFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId: value });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.APARAT_CONNECT, CONNECTION_CALLBACKS.APARAT_RECONNECT].includes(action)) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    await sendAparatBrowserTicket({ telegramClient, chatId, binding });
    return { handled: true };
  }

  if (action === CONNECTION_CALLBACKS.APARAT_DISCONNECT) {
    const binding = await bindingForOrganization(telegramUserId, value);
    if (!binding) {
      await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
      return { handled: true, authorized: false };
    }
    const result = await disconnectAparatConnection({ userId: binding.user_id, organizationId: binding.organization_id });
    await telegramClient.sendMessage({ chat_id: chatId, text: result.ok ? 'Aparat connection disconnected.' : 'No active Aparat connection was found.' });
    return { handled: true };
  }

  if ([CONNECTION_CALLBACKS.APARAT_CONFIRM, CONNECTION_CALLBACKS.APARAT_CANCEL].includes(action)) {
    await handleAparatFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId: value });
    return { handled: true };
  }

  if (action === CONNECTION_CALLBACKS.APARAT_CATEGORY) {
    await handleAparatCategorySelection({ telegramClient, chatId, telegramUserId, value });
    return { handled: true };
  }

  return { handled: false };
}

async function loadTelegramChannelIntent(intentId) {
  const intent = await IntegrationConnectionIntent.query()
    .findById(intentId)
    .withGraphFetched('organization');
  if (!intent || intentSource(intent) !== TELEGRAM_CONNECTION_SOURCE.TELEGRAM) return null;
  return intent;
}

export async function notifyTelegramChannelVerified({ intent, telegramClient }) {
  if (!intent?.telegram_chat_id || intentSource(intent) !== TELEGRAM_CONNECTION_SOURCE.TELEGRAM) return false;
  const organization = intent.organization || (await IntegrationConnectionIntent.query().findById(intent.id).withGraphFetched('organization'))?.organization;
  const orgTitle = organization?.name || `Organization ${intent.organization_id}`;

  await telegramClient.sendMessage({
    chat_id: intent.telegram_chat_id,
    text: `Telegram Channel verified\n\nChannel: ${intent.verified_channel_title}\nChat ID: ${intent.verified_channel_id}\nOrganization: ${orgTitle}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Confirm connection', callback_data: connectionCallback(CONNECTION_CALLBACKS.TELEGRAM_CONFIRM, intent.id) }],
        [{ text: 'Cancel', callback_data: connectionCallback(CONNECTION_CALLBACKS.TELEGRAM_CANCEL, intent.id) }],
      ],
    },
  });
  return true;
}

async function handleTelegramChannelFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId }) {
  const intent = await loadTelegramChannelIntent(intentId);
  if (!intent) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'No pending Telegram Channel connection was found.' });
    return;
  }
  const binding = await bindingForOrganization(telegramUserId, intent.organization_id);
  if (!binding || binding.user_id !== intent.user_id) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized to confirm this connection.' });
    return;
  }

  if (action === CONNECTION_CALLBACKS.TELEGRAM_CANCEL || isExpired(intent)) {
    await cancelVerifiedTelegramConnection({
      intentId: intent.id,
      userId: intent.user_id,
      organizationId: intent.organization_id,
      source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
    });
    await telegramClient.sendMessage({ chat_id: chatId, text: 'Telegram Channel connection cancelled.' });
    return;
  }

  if (intent.status !== TELEGRAM_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'Telegram Channel connection is not ready for confirmation.' });
    return;
  }

  const result = await activateVerifiedTelegramConnection({
    intentId: intent.id,
    userId: intent.user_id,
    organizationId: intent.organization_id,
    channelId: intent.verified_channel_id,
    source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
  });
  await telegramClient.sendMessage({
    chat_id: chatId,
    text: result.ok ? `Telegram Channel connection activated for ${intent.verified_channel_title}.` : 'Telegram Channel connection could not be confirmed.',
  });
}

async function sendAparatBrowserTicket({ telegramClient, chatId, binding }) {
  const { intent, browserUrl } = await createTelegramAparatConnectionIntent({
    telegramUserId: binding.telegram_user_id,
    telegramChatId: chatId,
    userId: binding.user_id,
    organizationId: binding.organization_id,
  });
  try {
    if (isTelegramUrlButtonSafe(browserUrl)) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: `Open the browser to enter your Aparat credentials for ${organizationName(binding)}.`,
        reply_markup: {
          inline_keyboard: [[{ text: 'Connect Aparat', url: browserUrl }]],
        },
      });
      return;
    }

    await telegramClient.sendMessage({
      chat_id: chatId,
      text: `Open this link in a browser to connect Aparat for ${organizationName(binding)}:\n<code>${escapeHtml(browserUrl)}</code>\n\nFor a clickable Telegram button, set APARAT_CONNECT_BASE_URL to a public HTTPS URL that forwards to Core.`,
    });
  } catch (error) {
    await cancelVerifiedAparatConnection({
      intentId: intent.id,
      userId: binding.user_id,
      organizationId: binding.organization_id,
    }).catch(() => {});
    throw error;
  }
}

async function loadAparatIntent(intentId) {
  const intent = await IntegrationConnectionIntent.query()
    .findById(intentId)
    .withGraphFetched('organization');
  if (!intent || intent.purpose !== APARAT_CONNECTION_PURPOSE || intent.source !== APARAT_CONNECTION_SOURCE.TELEGRAM) return null;
  return intent;
}

export async function notifyTelegramAparatVerified({
  intent,
  profile,
  categories = [],
  defaultCategory = null,
  telegramClient,
}) {
  if (!intent?.telegram_chat_id) return false;
  const organization = intent.organization || (await IntegrationConnectionIntent.query().findById(intent.id).withGraphFetched('organization'))?.organization;
  const orgTitle = organization?.name || `Organization ${intent.organization_id}`;

  const categoryText = defaultCategory ? defaultCategory.title : (categories.length > 0 ? 'Not selected' : 'None available');

  const inlineKeyboard = [];

  // If multiple categories exist, provide selection buttons
  if (categories.length > 1) {
    for (const cat of categories.slice(0, 5)) {
      inlineKeyboard.push([{
        text: `📂 ${cat.title}`,
        callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CATEGORY, `${intent.id}:${cat.id}`),
      }]);
    }
  }

  inlineKeyboard.push([
    { text: 'Confirm Connection', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CONFIRM, intent.id) },
    { text: 'Cancel', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CANCEL, intent.id) },
  ]);

  await telegramClient.sendMessage({
    chat_id: intent.telegram_chat_id,
    text: `Aparat\n\nAccount: @${profile.username}\nName: ${profile.name || profile.username}\nStatus: Verified ✅\nDefault category: ${categoryText}\nOrganization: ${orgTitle}`,
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  });

  return true;
}

async function handleAparatCategorySelection({ telegramClient, chatId, telegramUserId, value }) {
  const [intentId, categoryId] = String(value || '').split(':');
  if (!intentId || !categoryId) return;

  const intent = await loadAparatIntent(intentId);
  if (!intent) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'This Aparat connection intent is no longer available.' });
    return;
  }

  const binding = await bindingForOrganization(telegramUserId, intent.organization_id);
  if (!binding) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized for this organization.' });
    return;
  }

  const categories = intent.pending_secret_json?.categories || [];
  const selectedCat = categories.find(c => String(c.id) === String(categoryId));
  const categoryTitle = selectedCat?.title || `Category ${categoryId}`;

  await setDefaultAparatCategory({
    intentId: intent.id,
    categoryId,
    categoryTitle,
    userId: binding.user_id,
    organizationId: binding.organization_id,
  });

  await telegramClient.sendMessage({
    chat_id: chatId,
    text: `Selected default category: ${categoryTitle}\nClick Confirm Connection to activate.`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Confirm Connection', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CONFIRM, intent.id) }],
        [{ text: 'Cancel', callback_data: connectionCallback(CONNECTION_CALLBACKS.APARAT_CANCEL, intent.id) }],
      ],
    },
  });
}

async function handleAparatFinalDecision({ telegramClient, chatId, telegramUserId, action, intentId }) {
  const intent = await loadAparatIntent(intentId);
  if (!intent) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'This Aparat connection confirmation is no longer available.' });
    return;
  }

  const binding = await bindingForOrganization(telegramUserId, intent.organization_id);
  if (!binding || binding.user_id !== intent.user_id) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'You are not authorized to confirm this connection.' });
    return;
  }

  if (action === CONNECTION_CALLBACKS.APARAT_CANCEL || isExpired(intent)) {
    await cancelVerifiedAparatConnection({
      intentId: intent.id,
      userId: binding.user_id,
      organizationId: binding.organization_id,
    });
    await telegramClient.sendMessage({ chat_id: chatId, text: 'Aparat connection cancelled.' });
    return;
  }

  if (intent.status !== APARAT_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION) {
    await telegramClient.sendMessage({ chat_id: chatId, text: 'Aparat connection is not ready for confirmation.' });
    return;
  }

  const result = await activateVerifiedAparatConnection({
    intentId: intent.id,
    userId: binding.user_id,
    organizationId: binding.organization_id,
  });

  await telegramClient.sendMessage({
    chat_id: chatId,
    text: result.ok ? 'Aparat connection activated.' : 'Aparat connection could not be confirmed.',
  });
}

