import crypto from 'crypto';
import getDb from '../../config/database.js';
const db = getDb();
import TelegramUpdateReceipt from '../../db/models/core/TelegramUpdateReceipt.js';
import TelegramComposerSession from '../../db/models/core/TelegramComposerSession.js';
import Campaign from '../../db/models/core/Campaign.js';
import CampaignTarget from '../../db/models/core/CampaignTarget.js';
import Asset from '../../db/models/core/Asset.js';
import PublishJob from '../../db/models/core/PublishJob.js';
import IntegrationConfig from '../../db/models/core/IntegrationConfig.js';
import { createOutboxEvent } from '../outbox.js';
import { JOB_STATUS } from '../constants.js';
import { isPublisherAvailable } from './capabilities.js';
import {
  COMPOSER_STATE,
  RECEIPT_STATUS,
  RECEIPT_LEASE_TIMEOUT_SECONDS,
  BOT_COMMANDS,
  CALLBACK_ACTIONS,
  MAX_TELEGRAM_FILE_BYTES,
} from './constants.js';
import { getTelegramClient, sanitizeTelegramError } from './api.js';
import { resolveTelegramUserBinding } from './bindings.js';
import {
  getActiveSession,
  startOrResumeSession,
  updateSessionState,
  cancelSession,
  parseJsonField,
} from './state.js';
import { validatePrivateChatUpdate } from './validation.js';
import {
  getResumeOrCancelKeyboard,
  getTargetSelectionKeyboard,
  getMetadataSkipKeyboard,
  getFinalReviewKeyboard,
  getYouTubeModeKeyboard,
} from './keyboards.js';
import { getNextMetadataStep, formatReviewSummary } from './metadata.js';
import { ingestMediaStream } from '../media/ingest.js';
import { ASSET_KIND, ASSET_STATUS, FORBIDDEN_COVER_EXTENSIONS } from '../media/constants.js';
import { extractExtension } from '../media/objectKeys.js';
import { sanitizeMediaError } from '../media/sanitize.js';
import {
  handleTelegramConnectionCallback,
  handleTelegramConnectionMessage,
  isConnectionCallback,
  isConnectionsCommand,
  notifyTelegramChannelVerified,
  pendingTelegramChannelVerificationIntent,
} from './connections.js';
import { verifyTelegramChannelCandidate } from '../platforms/telegram/connections.js';

function toDbDate(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Main update handler for Telegram Bot Composer.
 */
export async function processTelegramUpdate(update, options = {}) {
  const telegramClient = options.telegramClient || getTelegramClient();
  const updateId = String(update?.update_id || '');

  if (!updateId) {
    return { processed: false, error: 'MISSING_UPDATE_ID' };
  }

  // 1. Private Chat Validation
  const validation = validatePrivateChatUpdate(update);
  if (!validation.valid) {
    // Non-private chat or channel post rejected safely
    return { processed: false, ignored: true, reason: validation.reason };
  }

  const { chatId, userId, type, message, callbackQuery } = validation;

  // 2. Durable Update Receipt & Lease Locking
  const lockToken = crypto.randomUUID();
  let receipt = null;

  try {
    await TelegramUpdateReceipt.query().insert({
      telegram_update_id: updateId,
      telegram_user_id: userId,
      status: RECEIPT_STATUS.PROCESSING,
      locked_at: toDbDate(new Date()),
      lock_token: lockToken,
    });
  } catch (insertErr) {
    // Unique violation: check existing receipt
    const existing = await TelegramUpdateReceipt.query()
      .where({ telegram_update_id: updateId })
      .first();

    if (!existing) {
      throw insertErr;
    }

    if (existing.status === RECEIPT_STATUS.PROCESSED) {
      return { processed: true, duplicate: true, status: RECEIPT_STATUS.PROCESSED };
    }

    if (existing.status === RECEIPT_STATUS.PROCESSING) {
      // Check lease timeout
      const lockedTime = existing.locked_at ? new Date(existing.locked_at).getTime() : 0;
      const isStale = Date.now() - lockedTime > RECEIPT_LEASE_TIMEOUT_SECONDS * 1000;

      if (!isStale) {
        return { processed: false, skipped: true, reason: 'IN_FLIGHT_LEASE_ACTIVE' };
      }

      // Reclaim stale lease
      const claimResult = await db.raw(`
        UPDATE telegram_update_receipts
        SET locked_at = NOW(),
            lock_token = ?
        WHERE telegram_update_id = ? AND status = ?
          AND (locked_at IS NULL OR locked_at <= DATE_SUB(NOW(), INTERVAL ? SECOND))
      `, [lockToken, updateId, RECEIPT_STATUS.PROCESSING, RECEIPT_LEASE_TIMEOUT_SECONDS]);

      if ((claimResult[0]?.affectedRows || 0) === 0) {
        return { processed: false, skipped: true, reason: 'LEASE_RECLAIM_RACE_LOST' };
      }
    }
  }

  // 3. Platform connection commands are not composer-session callbacks and
  // need explicit organization selection when multiple bindings exist.
  if (type === 'message' && message && isConnectionsCommand(message.text || message.caption)) {
    const result = await handleTelegramConnectionMessage({
      telegramClient,
      chatId,
      telegramUserId: userId,
    });
    await TelegramUpdateReceipt.query()
      .where({ telegram_update_id: updateId })
      .patch({
        status: RECEIPT_STATUS.PROCESSED,
        processed_at: toDbDate(new Date()),
        result_json: { success: true, connection: true, ...result },
      });
    return { processed: true, success: true, connection: true, ...result };
  }

  if (type === 'callback_query' && callbackQuery && isConnectionCallback(callbackQuery.data)) {
    const result = await handleTelegramConnectionCallback({
      telegramClient,
      chatId,
      telegramUserId: userId,
      callbackQuery,
    });
    await TelegramUpdateReceipt.query()
      .where({ telegram_update_id: updateId })
      .patch({
        status: RECEIPT_STATUS.PROCESSED,
        processed_at: toDbDate(new Date()),
        result_json: { success: true, connection: true, ...result },
      });
    return { processed: true, success: true, connection: true, ...result };
  }

  // 3b. Intercept forwarded channel messages or channel @username when pending channel connection exists
  if (type === 'message' && message) {
    const pendingIntent = await pendingTelegramChannelVerificationIntent(userId);
    if (pendingIntent) {
      let channelIdentifier = null;
      if (message.forward_from_chat?.type === 'channel') {
        channelIdentifier = message.forward_from_chat.id;
      } else if (message.text) {
        const trimmed = message.text.trim();
        if (trimmed.startsWith('@') || /^-100\d+$/.test(trimmed) || /^\d+$/.test(trimmed)) {
          channelIdentifier = trimmed;
        }
      }

      if (channelIdentifier) {
        const verifyRes = await verifyTelegramChannelCandidate({
          intentId: pendingIntent.id,
          channelIdentifier,
          telegramClient,
        });

        if (verifyRes.ok) {
          await notifyTelegramChannelVerified({ intent: verifyRes.intent, telegramClient });
        } else {
          const reasonMsg = verifyRes.error || verifyRes.reason || 'Verification failed';
          await telegramClient.sendMessage({
            chat_id: chatId,
            text: `❌ <b>بررسی کانال ناموفق بود:</b>\n<code>${reasonMsg}</code>\n\nلطفا مطمئن شوید که ربات در کانال به عنوان مدیر با دسترسی «ارسال پیام» (Post Messages) عضو شده است و مجددا پیامی از کانال را فوروارد نمایید یا نام کاربری کانال (مانند @mychannel) را ارسال کنید.`,
          });
        }

        await TelegramUpdateReceipt.query()
          .where({ telegram_update_id: updateId })
          .patch({
            status: RECEIPT_STATUS.PROCESSED,
            processed_at: toDbDate(new Date()),
            result_json: { success: true, channelVerification: true, ok: verifyRes.ok },
          });
        return { processed: true, success: true, channelVerification: true, ok: verifyRes.ok };
      }
    }
  }

  // 4. Resolve Organization Binding
  const bindingResult = await resolveTelegramUserBinding(userId);
  if (!bindingResult.resolved) {
    if (bindingResult.error === 'UNBOUND_USER') {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '⛔ <b>دسترسی غیرمجاز:</b>\nحساب کاربری تلگرام شما به هیچ سازمانی در سامانه متصل نیست. لطفا با مدیر سیستم تماس بگیرید.',
      }).catch(() => {});
    } else {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '⚠️ <b>خطای احراز هویت:</b>\nاتصال حساب کاربری شما با سازمان نامعتبر یا مبهم است.',
      }).catch(() => {});
    }

    await TelegramUpdateReceipt.query()
      .where({ telegram_update_id: updateId })
      .patch({
        status: RECEIPT_STATUS.PROCESSED,
        processed_at: toDbDate(new Date()),
        result_json: { error: bindingResult.error },
      });
    return { processed: true, authorized: false, error: bindingResult.error };
  }

  const { organizationId, userId: coreUserId } = bindingResult;

  try {
    // 5. Handle Callback Query
    if (type === 'callback_query' && callbackQuery) {
      await handleCallbackQuery({
        callbackQuery,
        chatId,
        telegramUserId: userId,
        organizationId,
        coreUserId,
        telegramClient,
      });
    }

    // 6. Handle Message / Command
    else if (type === 'message' && message) {
      await handleMessage({
        message,
        chatId,
        telegramUserId: userId,
        organizationId,
        coreUserId,
        telegramClient,
        options,
      });
    }

    // 7. Mark receipt as successfully processed
    await TelegramUpdateReceipt.query()
      .where({ telegram_update_id: updateId })
      .patch({
        status: RECEIPT_STATUS.PROCESSED,
        processed_at: toDbDate(new Date()),
        result_json: { success: true },
      });

    return { processed: true, success: true };
  } catch (err) {
    const safeError = sanitizeMediaError(err);
    await TelegramUpdateReceipt.query()
      .where({ telegram_update_id: updateId })
      .patch({
        status: RECEIPT_STATUS.FAILED,
        result_json: { error: safeError },
      });
    throw err;
  }
}

/**
 * Handles private Telegram messages and commands.
 */
async function handleMessage({
  message,
  chatId,
  telegramUserId,
  organizationId,
  coreUserId,
  telegramClient,
  options = {},
}) {
  const text = (message.text || message.caption || '').trim();

  // Command: /start or /help
  if (text === BOT_COMMANDS.START || text === BOT_COMMANDS.HELP) {
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '👋 <b>به ربات انتشار محتوا خوش آمدید!</b>\n\nبرای شروع ایجاد یک پست ویدیویی جدید، دستور زیر را ارسال کنید:\n/newpost\n\nبرای لغو فرایند جاری:\n/cancel',
    });
    return;
  }

  // Command: /cancel
  if (text === BOT_COMMANDS.CANCEL) {
    const active = await getActiveSession(telegramUserId);
    if (!active) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: 'ℹ️ هیچ پیش‌نویس فعالی برای لغو وجود ندارد.',
      });
      return;
    }
    await cancelSession(active.id);
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '🗑️ پیش‌نویس جاری با موفقیت لغو شد. برای شروع جدید از /newpost استفاده کنید.',
    });
    return;
  }

  // Command: /newpost
  if (text === BOT_COMMANDS.NEWPOST) {
    const active = await getActiveSession(telegramUserId);
    if (active) {
      const keyboard = getResumeOrCancelKeyboard();
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '📌 شما یک پیش‌نویس ناتمام در جریان دارید. مایلید آن را ادامه دهید یا لغو کرده و پست جدیدی بسازید؟',
        reply_markup: keyboard,
      });
      return;
    }

    const { session } = await startOrResumeSession({
      telegramUserId,
      telegramChatId: chatId,
      organizationId,
      userId: coreUserId,
      sourceRef: message.message_id,
    });

    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '🎥 <b>ایجاد پست جدید</b>\n\nلطفا <b>فایل ویدیوی اصلی (Master Video)</b> را ارسال فرمایید (حداکثر حجم ۳۰۰ مگابایت):',
    });
    return;
  }

  // Handle active session state
  const session = await getActiveSession(telegramUserId);
  if (!session) {
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: 'ℹ️ لطفا ابتدا با دستور /newpost یک پست جدید ایجاد کنید.',
    });
    return;
  }

  // State: WAITING_MEDIA
  if (session.state === COMPOSER_STATE.WAITING_MEDIA) {
    const videoObj = message.video || (message.document?.mime_type?.startsWith('video/') ? message.document : null);
    if (!videoObj) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '⚠️ لطفا یک <b>فایل ویدیویی</b> ارسال کنید.',
      });
      return;
    }

    const fileSize = videoObj.file_size || 0;
    if (fileSize > MAX_TELEGRAM_FILE_BYTES) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: `❌ حجم فایل ارسالی (${Math.round(fileSize / (1024 * 1024))} MB) بیشتر از سقف مجاز (۳۰۰ مگابایت) است.`,
      });
      return;
    }

    const fileId = videoObj.file_id;
    const fileUniqueId = videoObj.file_unique_id;

    // Idempotency: Check if an asset for this unique file already exists in session context
    const sessionCtx = parseJsonField(session.context_json);
    if (sessionCtx.media_file_unique_id === fileUniqueId && sessionCtx.assetId) {
      const existingAsset = await Asset.query()
        .where({ id: sessionCtx.assetId, organization_id: organizationId })
        .first();

      if (existingAsset && existingAsset.status !== ASSET_STATUS.FAILED) {
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_MEDIA_READY);
        await telegramClient.sendMessage({
          chat_id: chatId,
          text: '⏳ در حال بررسی مجدد مشخصات فنی ویدیو...',
        });
        return;
      }
    }

    const fileMeta = await telegramClient.getFile(fileId);
    if (!fileMeta?.file_path) {
      throw new Error('Telegram Bot API returned no file_path for video');
    }

    const downloadStream = await telegramClient.downloadFileStream(fileMeta.file_path);
    const originalFilename = message.document?.file_name || 'telegram_video.mp4';

    const asset = await ingestMediaStream({
      organizationId,
      campaignId: session.campaign_id,
      stream: downloadStream,
      originalFilename,
      mimeType: videoObj.mime_type || 'video/mp4',
      knownLength: fileSize || null,
      kind: ASSET_KIND.MASTER,
      testHooks: options.testHooks,
    });

    await updateSessionState(session.id, COMPOSER_STATE.WAITING_MEDIA_READY, {
      assetId: asset.id,
      media_file_unique_id: fileUniqueId,
      media_file_id: fileId,
    });

    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '⏳ <b>ویدیو دریافت شد.</b>\nدر حال بررسی و تحلیل مشخصات فنی و سازگاری...',
    });
    return;
  }

  // State: WAITING_COVER
  if (session.state === COMPOSER_STATE.WAITING_COVER) {
    let photoItem = null;
    if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
      // Choose largest photo
      photoItem = message.photo[message.photo.length - 1];
    } else if (message.document && message.document.mime_type?.startsWith('image/')) {
      photoItem = message.document;
    }

    if (!photoItem) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '⚠️ لطفا یک <b>تصویر کاور</b> (JPEG / PNG / WebP) ارسال کنید:',
      });
      return;
    }

    const originalFilename = message.document?.file_name || 'cover.jpg';
    const ext = extractExtension(originalFilename);
    if (FORBIDDEN_COVER_EXTENSIONS.includes(`.${ext}`)) {
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: `❌ فرمت تصویر .${ext} مجاز نیست. لطفا تصویر JPEG، PNG یا WebP ارسال کنید.`,
      });
      return;
    }

    const fileId = photoItem.file_id;
    const fileUniqueId = photoItem.file_unique_id;

    // Idempotency check for cover
    const coverCtx = parseJsonField(session.context_json);
    if (coverCtx.cover_file_unique_id === fileUniqueId && coverCtx.coverAssetId) {
      const existingCover = await Asset.query()
        .where({ id: coverCtx.coverAssetId, organization_id: organizationId })
        .first();

      if (existingCover && existingCover.status !== ASSET_STATUS.FAILED) {
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_COVER_READY);
        await telegramClient.sendMessage({
          chat_id: chatId,
          text: '⏳ در حال بررسی مجدد تصویر کاور...',
        });
        return;
      }
    }

    const fileMeta = await telegramClient.getFile(fileId);
    if (!fileMeta?.file_path) {
      throw new Error('Telegram Bot API returned no file_path for cover image');
    }

    const downloadStream = await telegramClient.downloadFileStream(fileMeta.file_path);

    const coverAsset = await ingestMediaStream({
      organizationId,
      campaignId: session.campaign_id,
      stream: downloadStream,
      originalFilename,
      mimeType: photoItem.mime_type || 'image/jpeg',
      kind: ASSET_KIND.COVER,
      testHooks: options.testHooks,
    });

    await updateSessionState(session.id, COMPOSER_STATE.WAITING_COVER_READY, {
      coverAssetId: coverAsset.id,
      cover_file_unique_id: fileUniqueId,
      cover_file_id: fileId,
    });

    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '⏳ <b>تصویر کاور دریافت شد.</b>\nدر حال تایید و آماده‌سازی پیشنهادهای انتشار...',
    });
    return;
  }

  // State: WAITING_COMMON_METADATA
  if (session.state === COMPOSER_STATE.WAITING_COMMON_METADATA) {
    const currentMetadata = session.context_json?.metadata || {};
    const youtubeSelected = !!session.context_json?.youtubeSelected;
    const aparatSelected = !!session.context_json?.aparatSelected;

    if (youtubeSelected) {
      if (!('base_caption' in currentMetadata)) {
        const newMeta = { ...currentMetadata, base_caption: text };
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata: newMeta, currentTarget: 'youtube' });
        await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube mode:', reply_markup: getYouTubeModeKeyboard() });
        return;
      }
    }

    if (!('base_title' in currentMetadata)) {
      const newMeta = { ...currentMetadata, base_title: text };
      await updateSessionState(session.id, COMPOSER_STATE.WAITING_COMMON_METADATA, { metadata: newMeta });

      const skipKeyboard = getMetadataSkipKeyboard();
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '✍️ لطفا <b>متن یا کپشن اصلی (Caption)</b> ویدیو را ارسال کنید، یا روی «رد کردن» کلیک کنید:',
        reply_markup: skipKeyboard,
      });
      return;
    }

    if (!('base_caption' in currentMetadata)) {
      const newMeta = { ...currentMetadata, base_caption: text };

      if (aparatSelected) {
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata: newMeta, currentTarget: 'aparat', aparatStep: 'tags' });
        await telegramClient.sendMessage({
          chat_id: chatId,
          text: '🏷️ لطفا <b>تگ‌های آپارات</b> را با کاما (,) جدا کرده و ارسال کنید (حداقل ۳ و حداکثر ۵ تگ، مثلا: آموزش, ویدیو, هوش مصنوعی):',
          reply_markup: getMetadataSkipKeyboard(),
        });
        return;
      }

      await updateSessionState(session.id, COMPOSER_STATE.REVIEW, { metadata: newMeta });

      // Build and send review
      await presentReviewSummary({ session, metadata: newMeta, chatId, telegramClient });
      return;
    }
  }

  if (session.state === COMPOSER_STATE.WAITING_TARGET_METADATA) {
    const current = session.context_json?.metadata || {};
    const aparatSelected = !!session.context_json?.aparatSelected;
    const currentTarget = session.context_json?.currentTarget || (session.context_json?.aparatStep ? 'aparat' : 'youtube');

    if (currentTarget === 'aparat' || session.context_json?.aparatStep === 'tags') {
      const parsedTags = text.split(/[,،\n]/).map(v => v.trim().replace(/^#/, '')).filter(Boolean);
      if (parsedTags.length < 3) {
        await telegramClient.sendMessage({
          chat_id: chatId,
          text: '⚠️ آپارات حداقل به ۳ تگ نیاز دارد. لطفا حداقل ۳ تگ را با کاما (,) جدا کرده و ارسال کنید (مثلا: آموزش, ویدیو, هوش مصنوعی):',
          reply_markup: getMetadataSkipKeyboard(),
        });
        return;
      }
      const finalTags = parsedTags.slice(0, 5);
      const metadata = { ...current, aparat: { ...(current.aparat || {}), tags: finalTags } };
      await updateSessionState(session.id, COMPOSER_STATE.REVIEW, { metadata, currentTarget: null, aparatStep: null });
      await presentReviewSummary({ session, metadata, chatId, telegramClient });
      return;
    }

    const yt = current.youtube || {};
    if (!yt.title) {
      const metadata = { ...current, youtube: { ...yt, title: text } };
      await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata, youtubeStep: 'description' });
      await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube description (optional; common caption is the default):', reply_markup: getMetadataSkipKeyboard() });
      return;
    }
    if (!('description' in yt)) {
      const metadata = { ...current, youtube: { ...yt, description: text } };
      await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata, youtubeStep: 'tags' });
      await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube tags, comma-separated (optional):', reply_markup: getMetadataSkipKeyboard() });
      return;
    }
    const metadata = { ...current, youtube: { ...yt, tags: text.split(',').map(v => v.trim()).filter(Boolean) } };

    if (aparatSelected) {
      await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata, currentTarget: 'aparat', aparatStep: 'tags' });
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '🏷️ لطفا <b>تگ‌های آپارات</b> را با کاما (,) جدا کرده و ارسال کنید (حداقل ۳ و حداکثر ۵ تگ، مثلا: آموزش, ویدیو, هوش مصنوعی):',
        reply_markup: getMetadataSkipKeyboard(),
      });
      return;
    }

    await updateSessionState(session.id, COMPOSER_STATE.REVIEW, { metadata });
    await presentReviewSummary({ session, metadata, chatId, telegramClient });
    return;
  }

  // State: REVIEW / other
  if (session.state === COMPOSER_STATE.REVIEW) {
    const reviewKeyboard = getFinalReviewKeyboard();
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '📌 لطفا جهت تایید نهایی روی دکمه زیر کلیک کنید:',
      reply_markup: reviewKeyboard,
    });
    return;
  }
}

/**
 * Handles inline keyboard callback queries with strict session & tenant verification.
 */
async function handleCallbackQuery({
  callbackQuery,
  chatId,
  telegramUserId,
  organizationId,
  coreUserId,
  telegramClient,
}) {
  const data = callbackQuery.data || '';
  const messageId = callbackQuery.message?.message_id;

  const answer = async (text = '', showAlert = false) => {
    await telegramClient.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text,
      show_alert: showAlert,
    }).catch(() => {});
  };

  const session = await getActiveSession(telegramUserId);
  if (!session) {
    await answer('⚠️ این پیش‌نویس دیگر فعال نیست.', true);
    return;
  }

  // Verify Organization ownership
  if (session.organization_id !== organizationId) {
    await answer('⛔ دسترسی به این پیش‌نویس غیرمجاز است.', true);
    return;
  }

  // Callback: RESUME_DRAFT
  if (data === CALLBACK_ACTIONS.RESUME_DRAFT) {
    await answer('ادامه پیش‌نویس...');
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: `▶️ <b>ادامه پیش‌نویس در وضعیت:</b> <code>${session.state}</code>`,
    });
    return;
  }

  // Callback: CANCEL_START_NEW
  if (data === CALLBACK_ACTIONS.CANCEL_START_NEW) {
    await answer('شروع پیش‌نویس جدید...');
    await cancelSession(session.id);
    const { session: newSession } = await startOrResumeSession({
      telegramUserId,
      telegramChatId: chatId,
      organizationId,
      userId: coreUserId,
    });
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '🎥 <b>پیش‌نویس جدید ایجاد شد.</b>\nلطفا فایل ویدیوی اصلی را ارسال فرمایید:',
    });
    return;
  }

  // Callback: CANCEL_COMPOSITION
  if (data === CALLBACK_ACTIONS.CANCEL_COMPOSITION) {
    await answer('لغو شد.');
    await cancelSession(session.id);
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: '🗑️ پیش‌نویس با موفقیت لغو شد.',
    });
    return;
  }

  // Callback: TOGGLE_TARGET:<candidateId>
  if (data.startsWith(`${CALLBACK_ACTIONS.TOGGLE_TARGET}:`)) {
    const candidateId = data.split(':')[1];
    const ctx = parseJsonField(session.context_json);
    const candidates = ctx.candidates || [];
    const candidate = candidates.find(c => c.candidateId === candidateId);

    if (!candidate) {
      await answer('مقصد نامعتبر است.', true);
      return;
    }

    const currentSelected = new Set(ctx.selectedTargetIds || []);
    if (currentSelected.has(candidateId)) {
      currentSelected.delete(candidateId);
    } else {
      currentSelected.add(candidateId);
    }

    const updatedList = Array.from(currentSelected);
    await updateSessionState(session.id, session.state, { selectedTargetIds: updatedList });

    const newKeyboard = getTargetSelectionKeyboard(candidates, currentSelected);
    if (messageId) {
      await telegramClient.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: '🎯 <b>مقصدهای انتشار پیشنهادی (Target Destinations):</b>\n\nمقصدهای سازگار به صورت خودکار انتخاب شده‌اند. می‌توانید با کلیک روی هر گزینه، آن را فعال یا غیرفعال کنید:',
        reply_markup: newKeyboard,
      }).catch(() => {});
    }

    await answer();
    return;
  }

  // Callback: CONFIRM_TARGETS
  if (data === CALLBACK_ACTIONS.CONFIRM_TARGETS) {
    const ctx = parseJsonField(session.context_json);
    const selectedIds = ctx.selectedTargetIds || [];
    if (selectedIds.length === 0) {
      await answer('⚠️ حداقل یک مقصد انتشار باید انتخاب شود.', true);
      return;
    }

    await answer('مقصدهای انتشار تایید شدند.');
    const candidates = ctx.candidates || [];
    const youtubeSelected = candidates.some(c => selectedIds.includes(c.candidateId) && c.platform === 'youtube');
    const aparatSelected = candidates.some(c => selectedIds.includes(c.candidateId) && c.platform === 'aparat');
    await updateSessionState(session.id, COMPOSER_STATE.WAITING_COMMON_METADATA, { youtubeSelected, aparatSelected });

    const skipKeyboard = getMetadataSkipKeyboard();
    await telegramClient.sendMessage({
      chat_id: chatId,
      text: youtubeSelected ? '✍️ متن مشترک/کپشن را ارسال کنید (برای Instagram caption و پیش‌فرض YouTube description):' : '📝 لطفا <b>عنوان اصلی (Title)</b> ویدیو را ارسال کنید، یا روی «رد کردن» کلیک کنید:',
      reply_markup: skipKeyboard,
    });
    return;
  }

  if (data.startsWith(`${CALLBACK_ACTIONS.YOUTUBE_MODE}:`)) {
    const mode = data.split(':')[1];
    if (!['SHORT', 'REGULAR'].includes(mode)) { await answer('YouTube mode is invalid.', true); return; }
    const ctx = parseJsonField(session.context_json); const metadata = ctx.metadata || {};
    await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata: { ...metadata, youtube: { ...(metadata.youtube || {}), mode } }, youtubeStep: 'title' });
    await answer();
    await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube title (required):' });
    return;
  }

  // Callback: SKIP_METADATA
  if (data === CALLBACK_ACTIONS.SKIP_METADATA) {
    await answer('رد شد.');
    const ctx = parseJsonField(session.context_json);
    const currentMeta = ctx.metadata || {};
    const aparatSelected = !!ctx.aparatSelected;
    const youtubeSelected = !!ctx.youtubeSelected;

    if (session.state === COMPOSER_STATE.WAITING_TARGET_METADATA) {
      const currentTarget = ctx.currentTarget || (ctx.aparatStep ? 'aparat' : 'youtube');

      if (currentTarget === 'aparat' || ctx.aparatStep === 'tags') {
        const defaultTags = ['ویدیو', 'اشتراک', 'الکسیو'];
        const metadata = { ...currentMeta, aparat: { ...(currentMeta.aparat || {}), tags: defaultTags } };
        await updateSessionState(session.id, COMPOSER_STATE.REVIEW, { metadata, currentTarget: null, aparatStep: null });
        await presentReviewSummary({ session, metadata, chatId, telegramClient });
        return;
      }

      const yt = currentMeta.youtube || {};
      if (!('description' in yt)) {
        const metadata = { ...currentMeta, youtube: { ...yt, description: currentMeta.base_caption || '' } };
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata, youtubeStep: 'tags' });
        await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube tags, comma-separated (optional):', reply_markup: getMetadataSkipKeyboard() });
        return;
      }
      const metadata = { ...currentMeta, youtube: { ...yt, tags: [] } };

      if (aparatSelected) {
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata, currentTarget: 'aparat', aparatStep: 'tags' });
        await telegramClient.sendMessage({
          chat_id: chatId,
          text: '🏷️ لطفا <b>تگ‌های آپارات</b> را با کاما (,) جدا کرده و ارسال کنید (حداقل ۳ و حداکثر ۵ تگ، مثلا: آموزش, ویدیو, هوش مصنوعی):',
          reply_markup: getMetadataSkipKeyboard(),
        });
        return;
      }

      await updateSessionState(session.id, COMPOSER_STATE.REVIEW, { metadata });
      await presentReviewSummary({ session, metadata, chatId, telegramClient });
      return;
    }

    if (youtubeSelected && !('base_caption' in currentMeta)) {
      const newMeta = { ...currentMeta, base_caption: null };
      await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata: newMeta, currentTarget: 'youtube' });
      await telegramClient.sendMessage({ chat_id: chatId, text: 'YouTube mode:', reply_markup: getYouTubeModeKeyboard() });
      return;
    }

    if (!('base_title' in currentMeta)) {
      const newMeta = { ...currentMeta, base_title: null };
      await updateSessionState(session.id, COMPOSER_STATE.WAITING_COMMON_METADATA, { metadata: newMeta });

      const skipKeyboard = getMetadataSkipKeyboard();
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: '✍️ لطفا <b>متن یا کپشن اصلی (Caption)</b> ویدیو را ارسال کنید، یا روی «رد کردن» کلیک کنید:',
        reply_markup: skipKeyboard,
      });
      return;
    }

    if (!('base_caption' in currentMeta)) {
      const newMeta = { ...currentMeta, base_caption: null };

      if (aparatSelected) {
        await updateSessionState(session.id, COMPOSER_STATE.WAITING_TARGET_METADATA, { metadata: newMeta, currentTarget: 'aparat', aparatStep: 'tags' });
        await telegramClient.sendMessage({
          chat_id: chatId,
          text: '🏷️ لطفا <b>تگ‌های آپارات</b> را با کاما (,) جدا کرده و ارسال کنید (حداقل ۳ و حداکثر ۵ تگ، مثلا: آموزش, ویدیو, هوش مصنوعی):',
          reply_markup: getMetadataSkipKeyboard(),
        });
        return;
      }

      await updateSessionState(session.id, COMPOSER_STATE.REVIEW, { metadata: newMeta });

      await presentReviewSummary({ session, metadata: newMeta, chatId, telegramClient });
      return;
    }
    return;
  }

  // Callback: FINAL_CONFIRM (Strictly idempotent transaction)
  if (data === CALLBACK_ACTIONS.FINAL_CONFIRM) {
    await answer('در حال ثبت نهایی...');
    try {
      const result = await finalizeComposerSession(session.id, organizationId);

      if (result.alreadyFinalized) {
        await telegramClient.sendMessage({
          chat_id: chatId,
          text: 'ℹ️ <b>این کمپین پیش‌تر با موفقیت تایید و ایجاد شده است.</b>',
        });
        return;
      }

      await telegramClient.sendMessage({
        chat_id: chatId,
        text: `🚀 <b>کمپین با موفقیت تایید شد و صف انتشار آغاز گردید!</b>\n\n` +
          `📋 شناسه کمپین: <code>${result.campaignId}</code>\n` +
          `🎯 تعداد مقصدهای انتشار: <b>${result.targetsCount}</b>\n` +
          `⚡ کارهای انتشار ایجاد شده: <b>${result.createdJobsCount}</b>\n\n` +
          `عملیات انتشار توسط سرویس‌های پس‌زمینه در حال انجام است.`,
      });
      return;
    } catch (err) {
      console.error('[TelegramComposer] Error finalizing session:', err);
      const safeErr = sanitizeTelegramError(err, telegramClient.botToken);
      await telegramClient.sendMessage({
        chat_id: chatId,
        text: `❌ <b>خطا در نهایی‌سازی و ثبت کمپین:</b>\n<code>${safeErr}</code>`,
      });
      return;
    }
  }

  await answer('دستور نامعتبر است.');
}

/**
 * Formats and presents the final review summary to the chat.
 */
async function presentReviewSummary({ session, metadata, chatId, telegramClient }) {
  const ctx = parseJsonField(session.context_json);
  const masterAsset = ctx.assetId
    ? await Asset.query().findById(ctx.assetId)
    : null;

  const coverAsset = ctx.coverAssetId
    ? await Asset.query().findById(ctx.coverAssetId)
    : null;

  const candidates = ctx.candidates || [];
  const selectedIds = new Set(ctx.selectedTargetIds || []);
  const selectedCandidates = candidates.filter(c => selectedIds.has(c.candidateId));

  const summaryText = formatReviewSummary({
    asset: masterAsset,
    coverAsset,
    selectedCandidates,
    metadata,
  });

  const reviewKeyboard = getFinalReviewKeyboard();
  await telegramClient.sendMessage({
    chat_id: chatId,
    text: summaryText,
    reply_markup: reviewKeyboard,
  });
}

/**
 * Transactionally finalizes the campaign and composer session.
 */
export async function finalizeComposerSession(sessionId, organizationId) {
  const trx = await db.transaction();
  try {
    const session = await TelegramComposerSession.query(trx).findById(sessionId);
    if (!session) {
      throw new Error(`Composer session ${sessionId} not found`);
    }

    if (session.state === COMPOSER_STATE.READY) {
      await trx.commit();
      return { alreadyFinalized: true };
    }

    // 1. Lock Campaign row
    const campaign = await Campaign.query(trx)
      .where({ id: session.campaign_id, organization_id: organizationId })
      .forUpdate()
      .first();

    if (!campaign) {
      throw new Error(`Campaign ${session.campaign_id} not found for Org ${organizationId}`);
    }

    if (campaign.status === 'ready' || campaign.status === 'ready_for_publish') {
      await TelegramComposerSession.query(trx)
        .where({ id: sessionId })
        .patch({ state: COMPOSER_STATE.READY });
      await trx.commit();
      return { alreadyFinalized: true };
    }

    const ctx = parseJsonField(session.context_json);
    const metadata = ctx.metadata || {};
    const candidates = ctx.candidates || [];
    const selectedIds = new Set(ctx.selectedTargetIds || []);
    const selectedCandidates = candidates.filter(c => selectedIds.has(c.candidateId));

    if (selectedCandidates.length === 0) {
      throw new Error('حداقل یک مقصد انتشار باید انتخاب شود.');
    }

    // 2. Validate target eligibility and active integration connections
    for (const c of selectedCandidates) {
      const targetPlatform = c.platform === 'telegram_channel' ? 'telegram' : c.platform;
      if (c.integrationConfigId) {
        const config = await IntegrationConfig.query(trx)
          .where({ id: c.integrationConfigId, organization_id: organizationId, status: 'active' })
          .whereNull('deleted_at')
          .first();
        if (!config) {
          throw new Error(`اتصال برای مقصد "${c.displayName || targetPlatform}" معتبر یا فعال نیست.`);
        }
      }
    }

    const youtubeMetadata = metadata.youtube || {};
    if (selectedCandidates.some(c => c.platform === 'youtube') && (!youtubeMetadata.mode || !youtubeMetadata.title)) {
      throw new Error('YouTube target requires mode and title before finalization');
    }

    let createdJobsCount = 0;

    // 3. Transactionally create/update CampaignTarget rows idempotently
    for (const c of selectedCandidates) {
      // Check existing target
      const targetPlatform = c.platform === 'telegram_channel' ? 'telegram' : c.platform;
      const integrationConfigId = c.integrationConfigId || null;
      const existing = await CampaignTarget.query(trx)
        .where({
          campaign_id: campaign.id,
          platform: targetPlatform,
          integration_config_id: integrationConfigId,
        })
        .first();

      let targetAssetId = ctx.assetId || null;
      let targetCoverAssetId = ctx.coverAssetId || null;
      let initialTargetStatus = 'pending';

      if (c.platform === 'youtube') {
        const master = ctx.assetId ? await Asset.query(trx).findById(ctx.assetId) : null;
        if (master) {
          const { resolveYouTubeTargetAsset } = await import('../platforms/youtube/selection.js');
          const resolved = await resolveYouTubeTargetAsset({
            target: { settings_json: { youtube_mode: youtubeMetadata.mode }, title_override: youtubeMetadata.title },
            masterAsset: master,
            trx,
          });
          if (resolved.status === 'READY') {
            targetAssetId = resolved.asset.id;
            initialTargetStatus = 'ready';
          } else if (resolved.status === 'WAITING_MEDIA_READY') {
            initialTargetStatus = 'waiting_media_ready';
            targetAssetId = resolved.asset?.id || targetAssetId;
          }
        }
      } else if (c.platform === 'aparat') {
        const master = ctx.assetId ? await Asset.query(trx).findById(ctx.assetId) : null;
        const cover = ctx.coverAssetId ? await Asset.query(trx).findById(ctx.coverAssetId) : null;
        if (master) {
          const { resolveAparatTargetMedia } = await import('../platforms/aparat/selection.js');
          const resolved = await resolveAparatTargetMedia({
            target: { asset_id: master.id, cover_asset_id: cover?.id },
            masterAsset: master,
            coverAsset: cover,
            organizationId: campaign.organization_id,
            trx,
          });
          if (resolved.status === 'READY') {
            targetAssetId = resolved.videoAsset.id;
            targetCoverAssetId = resolved.coverAsset?.id || targetCoverAssetId;
            initialTargetStatus = 'ready';
          } else if (resolved.status === 'WAITING_MEDIA_READY') {
            initialTargetStatus = 'waiting_media_ready';
            targetAssetId = resolved.videoAsset?.id || targetAssetId;
            targetCoverAssetId = resolved.coverAsset?.id || targetCoverAssetId;
          }
        }
      } else if (c.platform === 'telegram' || c.platform === 'telegram_channel' || c.platform === 'linkedin') {
        initialTargetStatus = 'ready';
      }

      const aparatMetadata = metadata.aparat || {};
      const aparatTags = Array.isArray(aparatMetadata.tags) && aparatMetadata.tags.length >= 3
        ? aparatMetadata.tags
        : ['ویدیو', 'اشتراک', 'الکسیو'];
      const aparatTitle = aparatMetadata.title || metadata.base_title || 'ویدیو جدید';

      let targetRow;
      if (!existing) {
        targetRow = await CampaignTarget.query(trx).insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: c.integrationConfigId,
          platform: c.platform === 'telegram_channel' ? 'telegram' : c.platform,
          status: initialTargetStatus,
          suggested_by_system: !!c.selectedByDefault,
          confirmed_by_user: true,
          asset_id: targetAssetId,
          cover_asset_id: targetCoverAssetId,
          title_override: c.platform === 'youtube'
            ? youtubeMetadata.title
            : (c.platform === 'aparat' ? aparatTitle : null),
          caption_override: c.platform === 'youtube'
            ? (youtubeMetadata.description ?? metadata.base_caption ?? null)
            : (metadata.base_caption || null),
          settings_json: c.platform === 'youtube' ? {
            youtube_mode: youtubeMetadata.mode,
            youtube_description: youtubeMetadata.description ?? metadata.base_caption ?? '',
            youtube_tags: youtubeMetadata.tags || [],
            privacy: 'private',
            made_for_kids: false,
          } : (c.platform === 'aparat' ? {
            tags: aparatTags,
            category_id: aparatMetadata.category_id || null,
          } : null),
        });
      } else {
        const updates = {
          confirmed_by_user: true,
          asset_id: targetAssetId || existing.asset_id,
          cover_asset_id: targetCoverAssetId || existing.cover_asset_id,
        };
        if (initialTargetStatus !== 'pending') {
          updates.status = initialTargetStatus;
        }
        if (c.platform === 'youtube') {
          updates.title_override = youtubeMetadata.title || existing.title_override;
          updates.caption_override = youtubeMetadata.description ?? metadata.base_caption ?? existing.caption_override;
          updates.settings_json = {
            ...(existing.settings_json || {}),
            youtube_mode: youtubeMetadata.mode,
            youtube_description: youtubeMetadata.description ?? metadata.base_caption ?? '',
            youtube_tags: youtubeMetadata.tags || [],
            privacy: 'private',
            made_for_kids: false,
          };
        } else if (c.platform === 'aparat') {
          updates.title_override = aparatTitle;
          updates.caption_override = metadata.base_caption || existing.caption_override;
          updates.settings_json = {
            ...(existing.settings_json || {}),
            tags: aparatTags,
            category_id: aparatMetadata.category_id || existing.settings_json?.category_id || null,
          };
        }
        targetRow = await CampaignTarget.query(trx).patchAndFetchById(existing.id, updates);
      }

      // 4. Transactionally create PublishJob and OutboxEvent if target is ready and publisher is available
      if (targetRow && targetRow.status === 'ready' && isPublisherAvailable(targetPlatform)) {
        const existingJob = await PublishJob.query(trx)
          .where({ campaign_target_id: targetRow.id })
          .first();

        if (!existingJob) {
          const newJob = await PublishJob.query(trx).insertAndFetch({
            organization_id: campaign.organization_id,
            campaign_target_id: targetRow.id,
            idempotency_key: `campaign-${campaign.id}-target-${targetRow.id}`,
            status: JOB_STATUS.QUEUED,
            attempt_count: 0,
            max_attempts: 5,
          });

          await createOutboxEvent(trx, {
            organizationId: campaign.organization_id,
            eventType: `jobs.publish.${targetPlatform}`,
            aggregateType: 'PublishJob',
            aggregateId: String(newJob.id),
            payloadJson: {
              jobId: newJob.id,
              organizationId: campaign.organization_id,
              campaignTargetId: targetRow.id,
            },
          });
          createdJobsCount++;
        }
      }
    }

    // 5. Update Campaign status to 'ready'
    await Campaign.query(trx)
      .where({ id: campaign.id })
      .patch({
        status: 'ready',
        base_title: metadata.base_title || null,
        base_caption: metadata.base_caption || null,
        cover_asset_id: ctx.coverAssetId || null,
      });

    // 6. Update session to 'ready'
    await TelegramComposerSession.query(trx)
      .where({ id: sessionId })
      .patch({
        state: COMPOSER_STATE.READY,
      });

    await trx.commit();
    return {
      alreadyFinalized: false,
      success: true,
      campaignId: campaign.id,
      targetsCount: selectedCandidates.length,
      createdJobsCount,
    };
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}
