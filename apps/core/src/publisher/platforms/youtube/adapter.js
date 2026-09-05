import { YouTubeApiClient } from './api.js';
import { categorizeYouTubeError, YouTubeAdapterError } from './errors.js';
import { getObjectRangeStream, headObject } from '../../../services/storage/s3.js';
import { decryptConfigValue, encryptConfigValue } from '../../../integrations/secrets.js';
import { ERROR_CATEGORY } from '../../constants.js';

export const YOUTUBE_CHUNK_ALIGNMENT = 256 * 1024; // 256 KiB

export function getYouTubeChunkBytes() {
  const bytes = Number(process.env.YOUTUBE_UPLOAD_CHUNK_BYTES || 8 * 1024 * 1024);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % YOUTUBE_CHUNK_ALIGNMENT !== 0) {
    throw new YouTubeAdapterError(ERROR_CATEGORY.VALIDATION, `YOUTUBE_UPLOAD_CHUNK_BYTES (${bytes}) must be a positive multiple of 256 KiB (${YOUTUBE_CHUNK_ALIGNMENT})`);
  }
  return bytes;
}

// 8 MiB is large enough to avoid needless requests while retaining bounded memory.
export const YOUTUBE_CHUNK_BYTES = Number(process.env.YOUTUBE_UPLOAD_CHUNK_BYTES || 8 * 1024 * 1024);

function getSessionUri(job) {
  const stored = job.sensitive_external_state_json?.youtube?.resumable_session_uri;
  return stored ? decryptConfigValue(stored) : null;
}

function withSessionUri(sessionUri, bytesReceived = 0) {
  return {
    youtube: {
      resumable_session_uri: encryptConfigValue(sessionUri),
      bytes_received: bytesReceived,
    },
  };
}

/**
 * Uploads bounded S3 ranges through YouTube's resumable protocol. The session
 * capability is encrypted at rest and never placed in NATS, logs, or stages.
 */
export async function publishToYouTube(job, context) {
  try {
    const { integrationConfig, campaignTarget, asset } = context;
    const storedRefreshToken = integrationConfig.refresh_token || integrationConfig.config_json?.refresh_token;
    const refreshToken = typeof storedRefreshToken === 'string' && storedRefreshToken.startsWith('enc:')
      ? decryptConfigValue(storedRefreshToken)
      : storedRefreshToken;
    if (!refreshToken) throw new YouTubeAdapterError(ERROR_CATEGORY.AUTH_REQUIRED, 'YouTube publishing connection has no refresh token');
    const client = new YouTubeApiClient(null, refreshToken);
    const object = await headObject(asset.object_key);
    const fileSize = Number(object.ContentLength);
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new YouTubeAdapterError(ERROR_CATEGORY.VALIDATION, 'YouTube asset size is invalid');

    const settings = campaignTarget.settings_json || {};
    if (!['SHORT', 'REGULAR'].includes(settings.youtube_mode)) throw new YouTubeAdapterError(ERROR_CATEGORY.VALIDATION, 'YouTube target mode is required');
    const title = campaignTarget.title_override || context.campaign.base_title;
    if (!title) throw new YouTubeAdapterError(ERROR_CATEGORY.VALIDATION, 'YouTube title is required');

    const selfDeclaredMadeForKids = typeof settings.made_for_kids === 'boolean'
      ? settings.made_for_kids
      : (typeof settings.youtube_made_for_kids === 'boolean' ? settings.youtube_made_for_kids : false);

    const metadata = {
      snippet: {
        title,
        description: settings.youtube_description ?? campaignTarget.caption_override ?? context.campaign.base_caption ?? '',
        tags: Array.isArray(settings.youtube_tags) ? settings.youtube_tags : undefined,
      },
      // Phase 7 deliberately refuses a public/unlisted first upload.
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids,
      },
    };
    let sessionUri = getSessionUri(job);
    let nextByte = 0;
    if (!sessionUri) {
      sessionUri = await client.createResumableSession(metadata, fileSize);
      await context.updateJob({ external_stage: 'SESSION_CREATED', sensitive_external_state_json: withSessionUri(sessionUri, 0) });
    } else {
      const status = await client.getUploadStatus(sessionUri, fileSize);
      if (status.status === 'completed') {
        await context.updateJob({ external_stage: 'VIDEO_CREATED', external_media_id: status.videoId, sensitive_external_state_json: null });
        return completeVideo(status.videoId, client, context);
      }
      nextByte = status.bytesReceived;
      await context.updateJob({ sensitive_external_state_json: withSessionUri(sessionUri, nextByte) });
    }

    const chunkBytes = getYouTubeChunkBytes();
    while (nextByte < fileSize) {
      const endByte = Math.min(nextByte + chunkBytes - 1, fileSize - 1);
      const chunkSize = endByte - nextByte + 1;
      const stream = await getObjectRangeStream(asset.object_key, nextByte, endByte);
      await context.updateJob({ external_stage: 'UPLOADING' });
      const result = await client.uploadVideo(sessionUri, stream, chunkSize, nextByte, fileSize);
      if (result.status === 'completed') {
        await context.updateJob({ external_stage: 'VIDEO_CREATED', external_media_id: result.videoId, sensitive_external_state_json: null });
        return completeVideo(result.videoId, client, context);
      }
      if (result.status === 'incomplete' && Number.isSafeInteger(result.bytesReceived) && result.bytesReceived > nextByte) {
        nextByte = result.bytesReceived;
      } else {
        const status = await client.getUploadStatus(sessionUri, fileSize);
        if (status.status === 'completed') {
          await context.updateJob({ external_stage: 'VIDEO_CREATED', external_media_id: status.videoId, sensitive_external_state_json: null });
          return completeVideo(status.videoId, client, context);
        }
        nextByte = status.bytesReceived;
      }
      // Persist confirmed offset in MySQL
      await context.updateJob({
        sensitive_external_state_json: withSessionUri(sessionUri, nextByte),
      });
    }
    throw new YouTubeAdapterError(ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE, 'YouTube upload ended without a video identity');
  } catch (error) {
    if (error?.code === 'YOUTUBE_RESUMABLE_SESSION_EXPIRED') {
      // A vanished session cannot prove that Google did not create the video.
      throw new YouTubeAdapterError(ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE, 'YouTube resumable session expired; reconciliation is required', error);
    }
    throw categorizeYouTubeError(error);
  }
}

async function completeVideo(videoId, client, context) {
  const cover = context.coverAsset;
  if (!cover) return { success: true, videoId };

  try {
    const settings = context.campaignTarget.settings_json || {};
    const mode = settings.youtube_mode || 'SHORT';

    const { YOUTUBE_MAX_THUMBNAIL_BYTES, ensureYouTubeThumbnailVariant } = await import('../../media/thumbnailVariants.js');

    let thumbnailAsset = cover;
    const isJpegOrPng = cover.mime_type === 'image/jpeg' || cover.mime_type === 'image/png';
    const isUnder2MB = Number(cover.size_bytes) <= YOUTUBE_MAX_THUMBNAIL_BYTES;
    const is16x9 = cover.aspect_ratio === '16:9' || (cover.width && cover.height && Math.abs(cover.width / cover.height - 16 / 9) < 0.05);
    const is9x16 = cover.aspect_ratio === '9:16' || (cover.width && cover.height && Math.abs(cover.width / cover.height - 9 / 16) < 0.05) || (cover.height > cover.width);

    let needsVariant = false;
    if (mode === 'REGULAR') {
      // REGULAR requires 16:9 JPEG/PNG <= 2 MB. If supplied cover is 9:16 or oversized/unsupported, generate elecio_thumbnail_16x9_v1.
      needsVariant = !is16x9 || !isJpegOrPng || !isUnder2MB;
    } else {
      // SHORT requires 9:16 JPEG/PNG <= 2 MB. If supplied cover meets this, upload directly without converting to 16:9.
      needsVariant = !is9x16 || !isJpegOrPng || !isUnder2MB;
    }

    if (needsVariant) {
      const variantRes = await ensureYouTubeThumbnailVariant(cover, { mode });
      thumbnailAsset = variantRes.asset;
    }

    const { getObjectStream } = await import('../../../services/storage/s3.js');
    const coverStream = await getObjectStream(thumbnailAsset.object_key);
    await client.setThumbnail(videoId, coverStream, thumbnailAsset.mime_type || 'image/jpeg', thumbnailAsset.size_bytes);

    let readBackHasCustomThumbnail = true;
    try {
      const details = await client.getVideoDetails(videoId, ['contentDetails']);
      if (details?.contentDetails && typeof details.contentDetails.hasCustomThumbnail === 'boolean') {
        readBackHasCustomThumbnail = details.contentDetails.hasCustomThumbnail;
      }
    } catch {
      // Non-fatal if read-back check fails
    }

    return {
      success: true,
      videoId,
      thumbnail: {
        status: 'succeeded',
        hasCustomThumbnail: readBackHasCustomThumbnail,
        assetId: thumbnailAsset.id,
      },
    };
  } catch (error) {
    let warningCategory = 'THUMBNAIL_ERROR';
    const status = error?.status || error?.code || error?.response?.status;
    const msg = error?.message || 'Unknown thumbnail error';

    if (status === 400 || msg.includes('invalidImage')) {
      warningCategory = 'THUMBNAIL_INVALID_IMAGE';
    } else if (status === 403 || msg.includes('forbidden') || msg.includes('unexpectedEligibility')) {
      warningCategory = 'THUMBNAIL_PERMISSION_DENIED';
    } else if (status === 404 || msg.includes('videoNotFound')) {
      warningCategory = 'THUMBNAIL_VIDEO_NOT_FOUND';
    } else if (status === 429 || msg.includes('uploadRateLimitExceeded')) {
      warningCategory = 'THUMBNAIL_RATE_LIMIT';
    }

    console.warn(`[YouTubeAdapter] Thumbnail upload warning for video ${videoId}: [${warningCategory}] ${msg}`);

    // Thumbnail is strictly secondary: NEVER fail video publishing
    return {
      success: true,
      videoId,
      thumbnail: {
        status: 'warning',
        warningCategory,
        message: msg,
      },
    };
  }
}
