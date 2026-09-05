import { Transform } from 'node:stream';
import { decryptConfigValue } from '../../../integrations/secrets.js';
import { getObjectRangeStream, getObjectStream } from '../../../services/storage/s3.js';
import {
  createPost,
  finalizeVideoUpload,
  getVideoStatus,
  initializeImageUpload,
  initializeVideoUpload,
  uploadImageBinary,
  uploadVideoPart,
} from './api.js';
import { normalizeLinkedInError } from './errors.js';
import { reconcileLinkedInPost } from './reconciliation.js';
import { ERROR_CATEGORY } from '../../constants.js';

function createByteCountingStream(expectedBytes) {
  let bytesRead = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > expectedBytes) {
        callback(new Error(`Stream exceeded expected byte count ${expectedBytes} (got ${bytesRead})`));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (bytesRead !== expectedBytes) {
        callback(new Error(`Stream finished with short read: expected ${expectedBytes} bytes, got ${bytesRead}`));
        return;
      }
      callback();
    },
  });
}

async function waitForVideoReady(accessToken, videoUrn, {
  fetchImpl = fetch,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxAttempts = 6,
  initialDelayMs = 1500,
  maxDelayMs = 5000,
} = {}) {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const statusData = await getVideoStatus(accessToken, videoUrn, { fetchImpl });
    const status = statusData.status;
    if (status === 'AVAILABLE') {
      return statusData;
    }
    if (status === 'PROCESSING_FAILED') {
      const error = new Error(`LinkedIn video processing failed: ${JSON.stringify(statusData.raw || {})}`);
      error.code = 'LINKEDIN_VIDEO_PROCESSING_FAILED';
      error.category = ERROR_CATEGORY.VALIDATION;
      error.safeMetadata = { status, videoUrn };
      throw error;
    }
    if (attempt === maxAttempts) {
      const error = new Error(`LinkedIn video is still processing after ${maxAttempts} checks (status: ${status})`);
      error.code = 'LINKEDIN_VIDEO_PROCESSING';
      error.category = ERROR_CATEGORY.RETRY_WAIT;
      error.safeMetadata = { status, videoUrn, attempts: attempt };
      throw error;
    }
    await sleepImpl(delay);
    delay = Math.min(delay * 1.5, maxDelayMs);
  }
}

export async function publishToLinkedIn(job, {
  campaignTarget,
  campaign,
  asset,
  coverAsset,
  integrationConfig,
  signal,
  updateJob = async () => {},
  fetchImpl = fetch,
  s3StreamFactory = getObjectStream,
  s3RangeStreamFactory = getObjectRangeStream,
  contentType,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollOptions = {},
}) {
  // Idempotency: if already published and external post ID recorded
  if (job.external_media_id) {
    return {
      status: 'succeeded',
      external_media_id: job.external_media_id,
    };
  }

  // Decrypt credentials
  const configJson = integrationConfig?.config_json || {};
  const encryptedAccessToken = configJson.access_token;
  if (!encryptedAccessToken) {
    const error = new Error('LinkedIn access token missing from IntegrationConfig');
    error.category = ERROR_CATEGORY.AUTH_REQUIRED;
    error.code = 'LINKEDIN_AUTH_REQUIRED';
    throw error;
  }

  const accessToken = decryptConfigValue(encryptedAccessToken);
  const organizationUrn = configJson.organization_urn || integrationConfig.external_account_id;
  if (!organizationUrn) {
    const error = new Error('LinkedIn organization URN missing from IntegrationConfig');
    error.category = ERROR_CATEGORY.VALIDATION;
    error.code = 'LINKEDIN_CONFIG_INVALID';
    throw error;
  }

  // Verify token expiry
  if (integrationConfig.expires_at) {
    const expiresAt = new Date(integrationConfig.expires_at).getTime();
    if (expiresAt <= Date.now()) {
      const error = new Error('LinkedIn access token has expired; re-authentication required');
      error.category = ERROR_CATEGORY.AUTH_REQUIRED;
      error.code = 'LINKEDIN_AUTH_REQUIRED';
      throw error;
    }
  }

  // Resolve commentary
  const commentary = campaignTarget.caption_override || campaignTarget.title_override || campaign.base_caption || campaign.caption || campaign.base_title || campaign.title;
  if (!commentary || !commentary.trim()) {
    const error = new Error('Post commentary/text is required for LinkedIn post');
    error.category = ERROR_CATEGORY.VALIDATION;
    error.code = 'LINKEDIN_COMMENTARY_REQUIRED';
    throw error;
  }

  // Determine media routing:
  // A LinkedIn target backed by a Campaign video MUST resolve to LINKEDIN_VIDEO.
  // Cover presence MUST NOT change post type from video to image.
  const isVideo = contentType === 'LINKEDIN_VIDEO' || !!(asset?.mime_type?.startsWith('video/'));
  let mediaUrn = null;

  if (isVideo) {
    const videoAsset = asset?.mime_type?.startsWith('video/') ? asset : null;
    if (!videoAsset) {
      const error = new Error('LinkedIn video publish target is missing video asset');
      error.code = 'LINKEDIN_VIDEO_ASSET_MISSING';
      error.category = ERROR_CATEGORY.TARGET_NOT_READY;
      throw error;
    }

    if (videoAsset.status !== 'ready') {
      const error = new Error(`LinkedIn video asset is not ready: ${videoAsset.status}`);
      error.code = 'TARGET_NOT_READY';
      error.category = ERROR_CATEGORY.TARGET_NOT_READY;
      error.safeMetadata = { assetStatus: videoAsset.status };
      throw error;
    }

    try {
      let videoUrn = job.external_container_id?.startsWith('urn:li:video:') ? job.external_container_id : null;
      let uploadInstructions = null;
      let uploadToken = null;
      let uploadedPartIds = [];

      // Crash / resume safety: check if we can reuse an existing video asset or resume upload
      if (videoUrn) {
        try {
          const statusData = await getVideoStatus(accessToken, videoUrn, { fetchImpl });
          if (statusData.status === 'AVAILABLE') {
            mediaUrn = videoUrn;
          } else if (statusData.status === 'PROCESSING') {
            await waitForVideoReady(accessToken, videoUrn, { fetchImpl, sleepImpl, ...pollOptions });
            mediaUrn = videoUrn;
          } else if (statusData.status === 'WAITING_UPLOAD') {
            const savedState = job.sensitive_external_state_json || {};
            if (
              savedState.videoUrn === videoUrn &&
              savedState.uploadUrlsExpireAt &&
              savedState.uploadUrlsExpireAt > Date.now() &&
              Array.isArray(savedState.uploadInstructions)
            ) {
              uploadInstructions = savedState.uploadInstructions;
              uploadToken = savedState.uploadToken || '';
              uploadedPartIds = savedState.uploadedPartIds || [];
            } else {
              videoUrn = null; // Expired or unusable, re-initialize
            }
          } else {
            videoUrn = null;
          }
        } catch (statusErr) {
          if (statusErr.status === 404) {
            videoUrn = null;
          } else {
            throw statusErr;
          }
        }
      }

      if (!mediaUrn) {
        if (!videoUrn) {
          await updateJob({ external_stage: 'INITIALIZING_VIDEO' });
          const initResult = await initializeVideoUpload(accessToken, organizationUrn, videoAsset.size_bytes, { fetchImpl });
          videoUrn = initResult.videoUrn;
          uploadInstructions = initResult.uploadInstructions;
          uploadToken = initResult.uploadToken;
          uploadedPartIds = [];

          await updateJob({
            external_container_id: videoUrn,
            external_stage: 'VIDEO_INITIALIZED',
            sensitive_external_state_json: {
              videoUrn,
              uploadToken,
              uploadUrlsExpireAt: initResult.uploadUrlsExpireAt,
              uploadInstructions,
              uploadedPartIds,
            },
          });
        }

        // Upload parts according to server instructions
        await updateJob({ external_stage: 'UPLOADING_VIDEO' });
        for (let i = uploadedPartIds.length; i < uploadInstructions.length; i++) {
          const instruction = uploadInstructions[i];
          const expectedBytes = instruction.lastByte - instruction.firstByte + 1;
          const rawStream = await s3RangeStreamFactory(videoAsset.object_key, instruction.firstByte, instruction.lastByte);
          const stream = rawStream && typeof rawStream.pipe === 'function' ? rawStream.pipe(createByteCountingStream(expectedBytes)) : rawStream;

          const partResult = await uploadVideoPart(instruction.uploadUrl, stream, expectedBytes, { fetchImpl });
          if (!partResult.etag) {
            throw new Error(`Video part ${i} upload failed: missing ETag header`);
          }
          uploadedPartIds.push(partResult.etag);

          await updateJob({
            sensitive_external_state_json: {
              videoUrn,
              uploadToken,
              uploadInstructions,
              uploadedPartIds,
            },
          });
        }

        // Finalize upload
        await updateJob({ external_stage: 'FINALIZING_VIDEO' });
        await finalizeVideoUpload(accessToken, { videoUrn, uploadToken, uploadedPartIds }, { fetchImpl });
        await updateJob({
          external_stage: 'VIDEO_FINALIZED',
          sensitive_external_state_json: null,
        });

        // Bounded readiness polling
        await updateJob({ external_stage: 'WAITING_VIDEO_READY' });
        await waitForVideoReady(accessToken, videoUrn, { fetchImpl, sleepImpl, ...pollOptions });
        await updateJob({ external_stage: 'VIDEO_READY' });

        mediaUrn = videoUrn;
      }
    } catch (videoError) {
      throw normalizeLinkedInError(videoError);
    }
  } else {
    // Image flow: strictly for non-video targets
    const imageAsset = (asset?.mime_type?.startsWith('image/')) ? asset : (coverAsset?.mime_type?.startsWith('image/') ? coverAsset : null);
    if (imageAsset) {
      try {
        await updateJob({ external_stage: 'UPLOADING_IMAGE' });

        // Step 1: Initialize upload
        const initResult = await initializeImageUpload(accessToken, organizationUrn, { fetchImpl });
        const { uploadUrl, imageUrn } = initResult;

        // Step 2: Stream binary from private S3
        const stream = await s3StreamFactory(imageAsset.object_key);
        await uploadImageBinary(uploadUrl, stream, imageAsset.mime_type, imageAsset.size_bytes, { fetchImpl });

        mediaUrn = imageUrn;
        await updateJob({ external_container_id: imageUrn });
      } catch (imageError) {
        throw normalizeLinkedInError(imageError);
      }
    }
  }

  // Critical assertion: for video posts, mediaUrn MUST start with urn:li:video:
  if (isVideo) {
    if (!mediaUrn || !mediaUrn.startsWith('urn:li:video:')) {
      throw new Error(`Critical assertion failed: video post mediaUrn must start with urn:li:video:, got: ${mediaUrn}`);
    }
    if (mediaUrn.startsWith('urn:li:image:')) {
      throw new Error('Critical assertion failed: cannot publish image URN for video post (fail closed)');
    }
  }

  // Create Post
  let isAfterPostSubmission = false;
  try {
    await updateJob({ external_stage: 'PUBLISHING_POST' });
    isAfterPostSubmission = true;

    const postTitle = campaignTarget.title_override || campaign.title || undefined;
    const postResult = await createPost(accessToken, {
      authorUrn: organizationUrn,
      commentary,
      mediaUrn,
      title: postTitle,
      mediaType: isVideo ? 'video' : (asset?.mime_type?.startsWith('image/') ? 'image' : undefined),
    }, { fetchImpl });

    const externalPostId = postResult.postId;
    await updateJob({
      external_media_id: externalPostId,
      external_stage: 'COMPLETED',
    });

    return {
      status: 'succeeded',
      external_media_id: externalPostId,
    };
  } catch (postError) {
    if (isAfterPostSubmission && (postError.name === 'AbortError' || postError.code === 'ECONNRESET' || postError.code === 'ETIMEDOUT')) {
      // Attempt reconciliation to avoid duplicate posts
      const reconciled = await reconcileLinkedInPost({
        accessToken,
        organizationUrn,
        expectedCommentary: commentary,
      }, { fetchImpl });

      if (reconciled.reconciled && reconciled.postId) {
        await updateJob({
          external_media_id: reconciled.postId,
          external_stage: 'COMPLETED',
        });
        return {
          status: 'succeeded',
          external_media_id: reconciled.postId,
        };
      }

      throw normalizeLinkedInError(postError, { isAmbiguous: true });
    }

    throw normalizeLinkedInError(postError);
  }
}

