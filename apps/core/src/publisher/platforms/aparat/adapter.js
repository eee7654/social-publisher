import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { AparatCookieJar } from './cookieJar.js';
import {
  APARAT_CHUNK_BYTES,
  APARAT_MAX_COVER_BYTES,
  APARAT_MAX_TITLE_CHARS,
  APARAT_MIN_TAGS,
  APARAT_MAX_TAGS,
  APARAT_DEFAULT_CATEGORY_ID,
} from './constants.js';
import {
  getUploadConfig,
  allocateUpload,
  createVideo,
  updateVideoMetadata,
  sanitizeAparatError,
} from './api.js';
import {
  queryServerChunks,
  uploadChunk,
  completeChunksDone,
  verifyAssembledFile,
} from './upload.js';
import { rotateAparatSession } from './connections.js';
import { encryptConfigValue, decryptConfigValue } from '../../../integrations/secrets.js';
import { ERROR_CATEGORY } from '../../constants.js';
import CampaignTarget from '../../../db/models/core/CampaignTarget.js';

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Validates Aparat metadata constraints:
 * - Title: 1..100 chars (no silent truncation)
 * - Description: <= descr_limit (no silent truncation)
 * - Tags: 3..5 tags, each <= max_tag_character_cnt
 */
export function validateAparatMetadata({ title, descr, tags, descrLimit = 2000, maxTagCharCount = 32 }) {
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    const err = new Error('Aparat title is required');
    err.code = 'VALIDATION_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  const cleanTitle = title.trim();
  if (cleanTitle.length > APARAT_MAX_TITLE_CHARS) {
    const err = new Error(`Aparat title exceeds maximum of ${APARAT_MAX_TITLE_CHARS} characters (received ${cleanTitle.length})`);
    err.code = 'VALIDATION_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  const cleanDescr = typeof descr === 'string' ? descr.trim() : '';
  if (cleanDescr.length > descrLimit) {
    const err = new Error(`Aparat description exceeds account limit of ${descrLimit} characters (received ${cleanDescr.length})`);
    err.code = 'VALIDATION_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  if (!Array.isArray(tags) || tags.length < APARAT_MIN_TAGS) {
    const err = new Error(`Aparat requires at least ${APARAT_MIN_TAGS} tags (received ${tags?.length || 0})`);
    err.code = 'VALIDATION_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  if (tags.length > APARAT_MAX_TAGS) {
    const err = new Error(`Aparat allows at most ${APARAT_MAX_TAGS} tags (received ${tags.length})`);
    err.code = 'VALIDATION_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  for (const tag of tags) {
    const cleanTag = String(tag).trim();
    if (!cleanTag) {
      const err = new Error('Aparat tags cannot be empty strings');
      err.code = 'VALIDATION_FAILED';
      err.category = ERROR_CATEGORY.VALIDATION;
      throw err;
    }
    if (cleanTag.length > maxTagCharCount) {
      const err = new Error(`Aparat tag '${cleanTag}' exceeds maximum length of ${maxTagCharCount} characters`);
      err.code = 'VALIDATION_FAILED';
      err.category = ERROR_CATEGORY.VALIDATION;
      throw err;
    }
  }

  return {
    title: cleanTitle,
    descr: cleanDescr,
    tagsHyphen: tags.map(t => String(t).trim()).join('-'),
  };
}

/**
 * Publishes an ElecIO CampaignTarget to Aparat via resumable UC chunk uploads and direct public publish.
 */
export async function publishToAparat(job, context) {
  const {
    campaignTarget,
    campaign,
    asset,
    coverAsset,
    integrationConfig,
    signal,
    updateJob,
    fetchImpl = fetch,
    s3StreamFactory,
    s3RangeStreamFactory,
  } = context;

  // 1. Session initialization
  const rawSession = integrationConfig.session || integrationConfig.config_json?.session;
  if (!rawSession) {
    const err = new Error('Aparat integration config is missing session credentials');
    err.code = 'APARAT_AUTH_REQUIRED';
    err.category = ERROR_CATEGORY.AUTH_REQUIRED;
    throw err;
  }

  const decryptedSession = typeof rawSession === 'string' && rawSession.startsWith('enc:')
    ? decryptConfigValue(rawSession)
    : rawSession;

  if (!decryptedSession) {
    const err = new Error('Failed to decrypt Aparat session');
    err.code = 'APARAT_AUTH_REQUIRED';
    err.category = ERROR_CATEGORY.AUTH_REQUIRED;
    throw err;
  }

  const cookieJar = AparatCookieJar.fromJSON(decryptedSession, async (newSession) => {
    try {
      await rotateAparatSession({
        integrationConfigId: integrationConfig.id,
        newSessionJson: newSession,
      });
    } catch {
      // Non-blocking rotation persistence
    }
  });

  if (!cookieJar.hasValidSession()) {
    const err = new Error('Aparat cookie jar has no valid AuthV1 session');
    err.code = 'APARAT_AUTH_REQUIRED';
    err.category = ERROR_CATEGORY.AUTH_REQUIRED;
    throw err;
  }

  // 2. Authoritative session proof via upload_config
  let uploadConfig;
  try {
    uploadConfig = await getUploadConfig({ cookieJar, fetchImpl });
  } catch (authErr) {
    if (authErr.code === 'APARAT_AUTH_REQUIRED') {
      authErr.category = ERROR_CATEGORY.AUTH_REQUIRED;
    }
    throw authErr;
  }

  const uploadServer = uploadConfig.server;
  const fileSize = Number(asset.size_bytes);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    const err = new Error(`Invalid video asset size: ${asset.size_bytes}`);
    err.code = 'VALIDATION_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  const totalParts = Math.ceil(fileSize / APARAT_CHUNK_BYTES);

  // 3. Upload allocation (or resume persisted state)
  const existingState = job.sensitive_external_state_json?.aparat;
  let clientUploadUuid = existingState?.client_uuid || null;
  let serverUploadId = existingState?.server_upload_id || null;
  let uploadToken = existingState?.upload_token ? decryptConfigValue(existingState.upload_token) : null;
  let activeUploadServer = existingState?.upload_server || uploadServer;

  if (!clientUploadUuid || !serverUploadId || !uploadToken) {
    clientUploadUuid = crypto.randomUUID();
    let alloc;
    try {
      alloc = await allocateUpload({
        uploadServer,
        clientUploadUuid,
        cookieJar,
        fetchImpl,
      });
    } catch (allocErr) {
      if (allocErr.code === 'APARAT_AUTH_REQUIRED') {
        allocErr.category = ERROR_CATEGORY.AUTH_REQUIRED;
      }
      throw allocErr;
    }

    uploadToken = alloc.token;
    serverUploadId = String(alloc.uploadId);
    activeUploadServer = uploadServer;

    await updateJob({
      external_stage: 'ALLOCATED',
      sensitive_external_state_json: {
        aparat: {
          upload_server: activeUploadServer,
          client_uuid: clientUploadUuid,
          server_upload_id: serverUploadId,
          upload_token: encryptConfigValue(uploadToken),
          chunk_size: APARAT_CHUNK_BYTES,
          total_parts: totalParts,
          stage: 'ALLOCATED',
        },
      },
    });
  }

  // 4. Server-truth chunk validation
  const serverChunks = await queryServerChunks({
    uploadServer: activeUploadServer,
    qquuid: clientUploadUuid,
    fetchImpl,
  });

  const validUploadedParts = new Set();
  if (Array.isArray(serverChunks.parts)) {
    serverChunks.parts.forEach((partIdx, idx) => {
      const reportedSize = serverChunks.sizes?.[idx];
      const isLastPart = partIdx === totalParts - 1;
      const expectedSize = isLastPart ? (fileSize - partIdx * APARAT_CHUNK_BYTES) : APARAT_CHUNK_BYTES;

      if (reportedSize == null || Number(reportedSize) === expectedSize) {
        validUploadedParts.add(partIdx);
      }
    });
  }

  // 5. Upload missing parts
  for (let partIndex = 0; partIndex < totalParts; partIndex++) {
    if (signal?.aborted) {
      const err = new Error('Publish job aborted');
      err.code = 'ABORTED';
      throw err;
    }

    if (validUploadedParts.has(partIndex)) {
      continue; // Part already confirmed on server
    }

    const start = partIndex * APARAT_CHUNK_BYTES;
    const endExclusive = Math.min(start + APARAT_CHUNK_BYTES, fileSize);
    const partSize = endExclusive - start;

    // Read exact S3 Range
    const stream = await s3RangeStreamFactory(asset.object_key, start, endExclusive - 1);
    const chunkBuffer = await streamToBuffer(stream);

    await updateJob({ external_stage: `UPLOADING_CHUNK_${partIndex}` });

    await uploadChunk({
      uploadServer: activeUploadServer,
      uploadToken,
      partIndex,
      partOffset: start,
      partSize,
      totalFileSize: fileSize,
      totalParts,
      qquuid: clientUploadUuid,
      filename: 'video.mp4',
      mimeType: asset.mime_type || 'video/mp4',
      chunkBuffer,
      fetchImpl,
    });

    validUploadedParts.add(partIndex);
  }

  // 6. Complete chunks done and verify assembled file
  // Ambiguity protection: if assembled file already exists with exact size, skip chunksdone
  let alreadyVerified = false;
  try {
    const existingFile = await verifyAssembledFile({
      uploadServer: activeUploadServer,
      qquuid: clientUploadUuid,
      expectedSize: fileSize,
      fetchImpl,
    });
    if (existingFile.verified) {
      alreadyVerified = true;
    }
  } catch {
    // File not assembled yet, proceed with chunksdone
  }

  if (!alreadyVerified) {
    await updateJob({ external_stage: 'COMPLETING_CHUNKS' });
    await completeChunksDone({
      uploadServer: activeUploadServer,
      uploadToken,
      qquuid: clientUploadUuid,
      filename: 'video.mp4',
      totalFileSize: fileSize,
      totalParts,
      fetchImpl,
    });

    await verifyAssembledFile({
      uploadServer: activeUploadServer,
      qquuid: clientUploadUuid,
      expectedSize: fileSize,
      fetchImpl,
    });
  }

  // 7. Cover resolution and serialization (data URI)
  if (!coverAsset) {
    const err = new Error('Aparat publishing requires a ready 16:9 cover asset');
    err.code = 'COVER_REQUIRED';
    err.category = ERROR_CATEGORY.TARGET_NOT_READY;
    throw err;
  }

  const coverStream = await s3StreamFactory(coverAsset.object_key);
  const coverBuffer = await streamToBuffer(coverStream);

  if (coverBuffer.length > APARAT_MAX_COVER_BYTES) {
    const err = new Error(`Cover image exceeds maximum allowed size of ${APARAT_MAX_COVER_BYTES} bytes (received ${coverBuffer.length})`);
    err.code = 'VALIDATION_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  const thumbnailDataUri = `data:image/jpeg;base64,${coverBuffer.toString('base64')}`;

  // 8. Metadata resolution and validation
  const title = campaignTarget.title_override || campaign.base_title || '';
  const descr = campaignTarget.caption_override || campaign.base_caption || '';
  const settings = campaignTarget.settings_json || {};
  const tags = Array.isArray(settings.tags)
    ? settings.tags
    : (Array.isArray(campaign.tags) ? campaign.tags : []);

  const validatedMeta = validateAparatMetadata({
    title,
    descr,
    tags,
    descrLimit: uploadConfig.descr_limit,
    maxTagCharCount: uploadConfig.max_tag_character_cnt,
  });

  const category = settings.category_id ||
    uploadConfig.defaultSetting?.cat_id ||
    integrationConfig.default_category_id ||
    APARAT_DEFAULT_CATEGORY_ID;

  const comment = settings.comment_enable ||
    uploadConfig.defaultSetting?.comment_enable ||
    'yes';

  const duration = Math.round((asset.duration_ms || 0) / 1000);
  const playlistid = settings.playlist_id ? [String(settings.playlist_id)] : [];

  // Final payload for Aparat API
  const createPayload = {
    video_pass: 0, // DIRECT PUBLIC PUBLISH (locked, always numeric 0)
    watermark: '1',
    watermark_bool: true,
    category: String(category),
    comment: String(comment),
    kids_friendly: false,
    title: validatedMeta.title,
    descr: validatedMeta.descr,
    tags: validatedMeta.tagsHyphen,
    playlistid,
    new_playlist: [],
    publish_date: null, // NO SCHEDULING
    duration,
    thumbnail: thumbnailDataUri,
    upload_base_url: activeUploadServer,
    uploadId: serverUploadId,
    video: clientUploadUuid,
  };

  await updateJob({ external_stage: 'CREATING_VIDEO' });

  // 9. State-changing final publication POST
  let createResult;
  try {
    createResult = await createVideo({
      serverUploadId,
      payload: createPayload,
      cookieJar,
      fetchImpl,
    });
  } catch (postErr) {
    if (postErr.code === 'APARAT_MUTATION_AMBIGUOUS') {
      postErr.category = ERROR_CATEGORY.RECONCILE_REQUIRED;
    } else if (postErr.code === 'APARAT_AUTH_REQUIRED') {
      postErr.category = ERROR_CATEGORY.AUTH_REQUIRED;
    } else if (postErr.code === 'APARAT_RATE_LIMIT') {
      postErr.category = ERROR_CATEGORY.RATE_LIMIT;
    } else if (
      postErr.code === 'APARAT_VALIDATION_ERROR' ||
      postErr.code === 'APARAT_CREATE_FAILED' ||
      postErr.code === 'APARAT_FORBIDDEN'
    ) {
      postErr.category = ERROR_CATEGORY.VALIDATION;
    }
    throw postErr;
  }

  // If duplicate existing video UID was returned by Aparat, synchronize metadata so current target title/tags are set
  if (createResult.duplicate && createResult.uid) {
    try {
      await updateVideoMetadata({
        uid: createResult.uid,
        title: validatedMeta.title,
        descr: validatedMeta.descr,
        tags: validatedMeta.tagsHyphen,
        category: String(category),
        comment: String(comment),
        cookieJar,
        fetchImpl,
      });
    } catch (editErr) {
      console.warn('[AparatAdapter] Warning: Failed to sync metadata on duplicate video:', editErr?.message);
    }
  }

  // Clear sensitive upload state upon confirmed publication
  await updateJob({
    external_stage: 'VIDEO_CREATED',
    external_media_id: String(createResult.id),
    sensitive_external_state_json: null,
  });

  const permalink = `https://www.aparat.com/v/${createResult.uid}`;

  // Update CampaignTarget status and published URL
  try {
    if (campaignTarget && typeof campaignTarget.$query === 'function') {
      await campaignTarget.$query().patch({
        status: 'published',
        published_url: permalink,
        external_post_id: String(createResult.uid),
      });
    } else if (campaignTarget?.id) {
      await CampaignTarget.query().findById(campaignTarget.id).patch({
        status: 'published',
        published_url: permalink,
        external_post_id: String(createResult.uid),
      });
    }
  } catch (targetPatchErr) {
    console.warn('[AparatAdapter] Warning: Could not patch CampaignTarget:', targetPatchErr.message);
  }

  return {
    externalMediaId: String(createResult.id),
    uid: String(createResult.uid),
    permalink,
  };
}
