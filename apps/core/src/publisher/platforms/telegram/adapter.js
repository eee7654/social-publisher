import { getTelegramClient } from '../../telegram/api.js';
import { getObjectStream } from '../../../services/storage/s3.js';
import { normalizeTelegramError } from './errors.js';
import { ERROR_CATEGORY } from '../../constants.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTelegramText({ title, caption }) {
  const cleanTitle = title ? String(title).trim() : '';
  const cleanCaption = caption ? String(caption).trim() : '';
  if (cleanTitle && cleanCaption) {
    return `${cleanTitle}\n\n${cleanCaption}`;
  }
  return cleanTitle || cleanCaption || '';
}

export function formatTelegramCaption({ title, caption, maxLength = 1024 }) {
  const formatted = formatTelegramText({ title, caption });
  if (formatted.length > maxLength) {
    const err = new Error(`Telegram caption exceeds maximum allowed limit of ${maxLength} characters (length: ${formatted.length})`);
    err.code = 'TELEGRAM_CAPTION_TOO_LONG';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }
  return formatted;
}

export function buildTelegramPublishedUrl(chatId, username, messageId) {
  if (!messageId) return null;
  if (username) {
    const cleanUser = String(username).replace(/^@/, '');
    return `https://t.me/${cleanUser}/${messageId}`;
  }
  const strId = String(chatId || '');
  if (strId.startsWith('-100')) {
    const channelNumericId = strId.replace(/^-100/, '');
    return `https://t.me/c/${channelNumericId}/${messageId}`;
  }
  return `https://t.me/${strId}/${messageId}`;
}

export async function publishToTelegramChannel(job, {
  campaignTarget,
  campaign,
  asset,
  coverAsset,
  integrationConfig,
  signal,
  updateJob = async () => {},
  s3StreamFactory = getObjectStream,
  telegramClient = getTelegramClient(),
  contentType = 'TELEGRAM_TEXT',
}) {
  // Idempotency: skip publish if external_media_id is already set
  if (job.external_media_id) {
    console.log(`[TelegramAdapter] Job ${job.id} already published with media ID ${job.external_media_id}. Skipping.`);
    return {
      ok: true,
      idempotentSkipped: true,
      externalMediaId: job.external_media_id,
    };
  }

  const configJson = typeof integrationConfig.config_json === 'string'
    ? JSON.parse(integrationConfig.config_json)
    : (integrationConfig.config_json || {});

  const chatId = configJson.chat_id || integrationConfig.external_account_id;
  if (!chatId) {
    const error = new Error('Telegram chat_id is missing from IntegrationConfig');
    error.code = 'CHAT_ID_MISSING';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    throw error;
  }

  const channelUsername = configJson.chat_username || integrationConfig.external_account_name;
  const title = campaignTarget.title_override || campaign.base_title || null;
  const caption = campaignTarget.caption_override || campaign.base_caption || null;

  try {
    let result;

    if (contentType === 'TELEGRAM_TEXT') {
      const text = formatTelegramText({ title, caption }) || 'New post';
      await updateJob({ external_stage: 'POSTING_TEXT' });
      result = await telegramClient.sendMessage({
        chat_id: chatId,
        text,
      });
    } else if (contentType === 'TELEGRAM_PHOTO') {
      if (!asset) {
        throw new Error('Photo asset is missing for TELEGRAM_PHOTO target');
      }
      await updateJob({ external_stage: 'POSTING_PHOTO' });
      const photoStream = await s3StreamFactory(asset.object_key);
      const photoCaption = formatTelegramCaption({ title, caption });
      result = await telegramClient.sendPhoto({
        chat_id: chatId,
        photo: photoStream,
        caption: photoCaption,
        filename: asset.original_filename || 'photo.jpg',
        fileSizeBytes: asset.size_bytes || null,
      });
    } else if (contentType === 'TELEGRAM_VIDEO') {
      if (!asset) {
        throw new Error('Video asset is missing for TELEGRAM_VIDEO target');
      }

      // Fail BEFORE opening or consuming video stream if Cloud mode exceeds 50 MB
      const isCloud = telegramClient.mode === 'cloud';
      if (isCloud && asset.size_bytes && asset.size_bytes > 50 * 1024 * 1024) {
        const err = new Error(`[TelegramAdapter] Video size (${asset.size_bytes} bytes) exceeds Telegram Cloud Bot API limit of 50 MB`);
        err.code = 'TELEGRAM_CLOUD_FILE_TOO_LARGE';
        err.category = ERROR_CATEGORY.VALIDATION;
        throw err;
      }

      await updateJob({ external_stage: 'POSTING_VIDEO' });
      const videoStream = await s3StreamFactory(asset.object_key);
      let coverStream = null;
      let coverSizeBytes = null;
      let coverFilename = 'cover.jpg';

      if (coverAsset && coverAsset.status === 'ready') {
        try {
          const isImage = coverAsset.mime_type?.startsWith('image/') || /\.(jpg|jpeg|png)$/i.test(coverAsset.original_filename || '');
          if (!isImage) {
            console.warn(`[TelegramAdapter] Non-blocking warning: cover asset ${coverAsset.id} is not an image (mime: ${coverAsset.mime_type}). Publishing video without custom cover.`);
          } else {
            coverStream = await s3StreamFactory(coverAsset.object_key);
            coverSizeBytes = coverAsset.size_bytes || null;
            coverFilename = coverAsset.original_filename || 'cover.jpg';
          }
        } catch (coverErr) {
          console.warn(`[TelegramAdapter] Non-blocking warning: failed to open cover stream for asset ${coverAsset.id}: ${coverErr.message}. Publishing video without custom cover.`);
          coverStream = null;
          coverSizeBytes = null;
        }
      }

      const videoCaption = formatTelegramCaption({ title, caption });
      const duration = asset.duration_ms ? Math.round(asset.duration_ms / 1000) : undefined;

      result = await telegramClient.sendVideo({
        chat_id: chatId,
        video: videoStream,
        caption: videoCaption,
        duration,
        width: asset.width || undefined,
        height: asset.height || undefined,
        cover: coverStream,
        filename: asset.original_filename || 'video.mp4',
        coverFilename,
        fileSizeBytes: asset.size_bytes || null,
        coverSizeBytes,
        supports_streaming: true,
      });
    } else {
      throw new Error(`Unsupported Telegram content type: ${contentType}`);
    }

    const messageId = result?.message_id;
    if (!messageId) {
      throw new Error('Telegram publish returned no message_id');
    }

    const externalMediaId = String(messageId);
    const publishedUrl = buildTelegramPublishedUrl(chatId, channelUsername, messageId);

    // Update target and job
    await campaignTarget.$query().patch({
      published_url: publishedUrl,
      external_post_id: externalMediaId,
      status: 'published',
    });

    await updateJob({
      external_media_id: externalMediaId,
      external_stage: 'PUBLISHED',
    });

    return {
      ok: true,
      externalMediaId,
      publishedUrl,
      messageId,
    };
  } catch (err) {
    throw normalizeTelegramError(err);
  }
}
