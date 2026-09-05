import crypto from 'crypto';
import { Transform, PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import { Upload } from '@aws-sdk/lib-storage';
import getDb from '../../config/database.js';
const db = getDb();
import Organization from '../../db/models/core/Organization.js';
import Campaign from '../../db/models/core/Campaign.js';
import Asset from '../../db/models/core/Asset.js';
import { initS3, deleteObject, abortMultipartUploadsForKey } from '../../services/storage/s3.js';
import { createOutboxEvent } from '../outbox.js';
import {
  MAX_MEDIA_BYTES,
  MAX_COVER_BYTES,
  ASSET_STATUS,
  ASSET_KIND,
  ALLOWED_COVER_MIME_TYPES,
  FORBIDDEN_COVER_EXTENSIONS,
  PUBLISHER_MEDIA_RETENTION_MS,
} from './constants.js';
import {
  extractExtension,
  buildMasterObjectKey,
  buildCoverObjectKey,
  buildVariantObjectKey,
} from './objectKeys.js';
import { sanitizeMediaError } from './sanitize.js';

function toDbDate(date) {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Creates a stream transform that computes SHA-256 and enforces byte limit during streaming.
 */
function createHashingLimiter(maxBytes) {
  const hash = crypto.createHash('sha256');
  let totalBytes = 0;

  const transform = new Transform({
    transform(chunk, encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        return callback(new Error(`MEDIA_SIZE_EXCEEDED: Media stream exceeds maximum allowed size of ${maxBytes} bytes`));
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  return {
    stream: transform,
    getDigest: () => hash.digest('hex'),
    getTotalBytes: () => totalBytes,
  };
}

/**
 * Ingests a media stream into private S3 storage and records the Asset.
 */
export async function ingestMediaStream({
  organizationId,
  campaignId = null,
  stream,
  originalFilename = 'unnamed',
  knownLength = null,
  kind = ASSET_KIND.MASTER,
  variantName = null,
  parentAssetId = null,
  mimeType = null,
  maxBytes = null,
  uploadPartSize = undefined,
  // Test-only hooks keep crash-window verification deterministic without
  // changing the production ingest contract.
  testHooks = null,
}) {
  if (!organizationId) {
    throw new Error('organizationId is required for media ingest');
  }
  if (!stream || typeof stream.pipe !== 'function') {
    throw new Error('Valid readable stream is required for media ingest');
  }

  // 1. Verify organization and campaign ownership
  const org = await Organization.query().findById(organizationId);
  if (!org) {
    throw new Error(`Organization ${organizationId} not found`);
  }

  if (campaignId) {
    const campaign = await Campaign.query().where({ id: campaignId, organization_id: organizationId }).first();
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} does not belong to organization ${organizationId}`);
    }
  }

  // 2. Validate kind and size limits
  const effectiveMaxBytes = maxBytes !== null
    ? maxBytes
    : (kind === ASSET_KIND.COVER ? MAX_COVER_BYTES : MAX_MEDIA_BYTES);

  if (knownLength !== null && knownLength > effectiveMaxBytes) {
    throw new Error(`MEDIA_SIZE_EXCEEDED: Declared content length ${knownLength} exceeds limit of ${effectiveMaxBytes} bytes`);
  }

  const ext = extractExtension(originalFilename);

  // Cover image checks
  if (kind === ASSET_KIND.COVER) {
    if (FORBIDDEN_COVER_EXTENSIONS.includes(`.${ext}`)) {
      throw new Error(`Forbidden cover extension: .${ext} (SVG and executable formats are rejected)`);
    }
    if (mimeType && mimeType.includes('svg')) {
      throw new Error('SVG cover images are forbidden');
    }
  }

  // 3. Generate deterministic object key & asset UUID
  const assetUuid = crypto.randomUUID();
  let objectKey;
  if (kind === ASSET_KIND.COVER) {
    objectKey = buildCoverObjectKey(organizationId, campaignId, assetUuid, ext);
  } else if (kind === ASSET_KIND.VARIANT) {
    objectKey = buildVariantObjectKey(organizationId, campaignId, assetUuid, variantName || 'variant', ext);
  } else {
    objectKey = buildMasterObjectKey(organizationId, campaignId, assetUuid, ext);
  }

  // 4. Create initial Asset record in UPLOADING state
  let asset = await Asset.query().insertAndFetch({
    organization_id: organizationId,
    campaign_id: campaignId,
    parent_asset_id: parentAssetId,
    kind,
    status: ASSET_STATUS.UPLOADING,
    object_key: objectKey,
    original_filename: originalFilename.slice(0, 255),
    mime_type: mimeType,
    expires_at: toDbDate(new Date(Date.now() + PUBLISHER_MEDIA_RETENTION_MS)),
  });
  await testHooks?.onAssetCreated?.(asset);

  const s3Client = initS3();
  const bucketName = process.env.S3_BUCKET;
  const limiter = createHashingLimiter(effectiveMaxBytes);

  let upload = null;
  try {
    // 5. Stream object to S3 while hashing and counting using pipeline
    const passThrough = new PassThrough();
    const pipePromise = pipeline(stream, limiter.stream, passThrough);

    upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: objectKey,
        Body: passThrough,
        ContentType: mimeType || undefined,
      },
      // The size limiter can fail after multipart upload has begun. Never
      // deliberately leave parts behind for a future, undefined reaper.
      leavePartsOnError: false,
      ...(uploadPartSize ? { partSize: uploadPartSize } : {}),
    });

    try {
      await Promise.all([upload.done(), pipePromise]);
    } catch (uploadError) {
      // Wait for lib-storage's abort/part-cleanup path before exposing the
      // failure; otherwise a fast limiter error can race a started multipart
      // upload and leave it visible briefly (or indefinitely on MinIO).
      await upload.abort().catch(() => {});
      await upload.done().catch(() => {});
      await abortMultipartUploadsForKey(objectKey).catch(() => {});
      throw uploadError;
    }

    const finalSize = limiter.getTotalBytes();
    const finalSha = limiter.getDigest();

    if (finalSize === 0) {
      throw new Error('Uploaded file is empty (0 bytes)');
    }

    // 6. On success: Transactionally persist metadata, set STORED, create media.probe Outbox event
    const trx = await db.transaction();
    try {
      await testHooks?.beforeFinalize?.({ asset, objectKey, finalSize, finalSha });
      asset = await Asset.query(trx).patchAndFetchById(asset.id, {
        status: ASSET_STATUS.STORED,
        size_bytes: finalSize,
        sha256: finalSha,
      });

      await createOutboxEvent(trx, {
        organizationId,
        eventType: 'media.probe',
        aggregateType: 'Asset',
        aggregateId: String(asset.id),
        payloadJson: {
          assetId: asset.id,
          organizationId,
          campaignId,
        },
      });

      await trx.commit();
      return asset;
    } catch (dbErr) {
      await trx.rollback();
      throw dbErr;
    }
  } catch (err) {
    // 7. On failure: mark FAILED and best-effort object cleanup
    try {
      await upload?.abort().catch(() => {});
      await Asset.query().patchAndFetchById(asset.id, {
        status: ASSET_STATUS.FAILED,
        error_message: sanitizeMediaError(err),
      });
      await deleteObject(objectKey).catch(() => {});
    } catch (cleanupErr) {
      console.error('Failed to update asset failure state:', cleanupErr.message);
    }
    throw err;
  }
}
