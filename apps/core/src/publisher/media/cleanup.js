import getDb from '../../config/database.js';
const db = getDb();
import Asset from '../../db/models/core/Asset.js';
import Campaign from '../../db/models/core/Campaign.js';
import CampaignTarget from '../../db/models/core/CampaignTarget.js';
import PublishJob from '../../db/models/core/PublishJob.js';
import { deleteObject } from '../../services/storage/s3.js';
import { ASSET_STATUS } from './constants.js';
import { isObjectKeyOwnedByOrg } from './objectKeys.js';
import { JOB_STATUS } from '../constants.js';

const ACTIVE_JOB_STATUSES = [
  JOB_STATUS.QUEUED,
  JOB_STATUS.RUNNING,
  JOB_STATUS.RETRY_WAIT,
  JOB_STATUS.RECONCILE_REQUIRED,
];

export const STALE_UPLOAD_THRESHOLD_MS = parseInt(
  process.env.PUBLISHER_STALE_UPLOAD_THRESHOLD_MS || String(60 * 60 * 1000),
  10,
);

function isAlreadyMissingObjectError(error) {
  return error?.name === 'NoSuchKey' || /NoSuchKey|NotFound|404/i.test(error?.message || '');
}

/**
 * Explicit retention decision used by cleanup scheduling and tests. Protected
 * publish states always win over temporary-media age.
 */
export function decideAssetRetention(asset, campaign = null, jobs = [], now = Date.now()) {
  if (!asset) return { action: 'keep', reason: 'asset missing' };
  const activeJobs = jobs.filter(j => ACTIVE_JOB_STATUSES.includes(j.status));
  if (activeJobs.length) return { action: 'keep', reason: 'active publish workflow' };
  if (asset.status === ASSET_STATUS.UPLOADING) return { action: 'recover_upload', reason: 'stale upload requires recovery' };
  if (asset.status === ASSET_STATUS.PROBING) return { action: 'keep', reason: 'probe lease is handled by probe fencing' };
  if (asset.status === ASSET_STATUS.FAILED) return { action: 'delete', reason: 'failed temporary asset' };
  if (asset.status === ASSET_STATUS.READY || asset.status === ASSET_STATUS.STORED) {
    if (asset.expires_at && new Date(asset.expires_at).getTime() <= now) return { action: 'delete', reason: 'expired unreferenced asset' };
    return { action: 'keep', reason: 'ready asset has no expiry' };
  }
  return { action: 'keep', reason: `status ${asset.status} is not eligible` };
}

/**
 * Pure function evaluating whether an Asset is eligible for physical deletion.
 */
export function canDeleteAsset(asset, campaign = null, jobs = []) {
  if (!asset) {
    return { canDelete: false, reason: 'Asset is null or undefined' };
  }

  // If already deleted/expired
  if (asset.status === ASSET_STATUS.DELETED || asset.status === ASSET_STATUS.EXPIRED) {
    return { canDelete: false, reason: `Asset is already marked ${asset.status}` };
  }

  // If currently being uploaded or probed
  if (asset.status === ASSET_STATUS.UPLOADING || asset.status === ASSET_STATUS.PROBING) {
    return { canDelete: false, reason: `Asset is currently in active state '${asset.status}'` };
  }

  // Check active jobs referencing targets that use this asset
  const activeJobs = jobs.filter(j => ACTIVE_JOB_STATUSES.includes(j.status));
  if (activeJobs.length > 0) {
    const statuses = activeJobs.map(j => `${j.id}:${j.status}`).join(', ');
    return {
      canDelete: false,
      reason: `Asset is required by active publish jobs: [${statuses}]`,
    };
  }

  // If asset has explicit expiry in the past
  if (asset.expires_at && new Date(asset.expires_at).getTime() <= Date.now()) {
    return { canDelete: true, reason: 'Asset has expired (expires_at reached)' };
  }

  // If campaign exists and is draft with no active jobs or completed
  return { canDelete: true, reason: 'No active publish jobs or pending workflows require this asset' };
}

/**
 * Deletes an Asset from S3 and updates its database state to DELETED.
 * Strictly verifies tenant ownership and active job guards before S3 deletion.
 */
export async function deleteAssetObject(assetId, organizationId, {
  deleteObjectFn = deleteObject,
  markDeletedFn = null,
} = {}) {
  if (!assetId || !organizationId) {
    throw new Error('assetId and organizationId are required for deletion');
  }

  // 1. Fetch Asset from database with tenant isolation
  const asset = await Asset.query().where({ id: assetId, organization_id: organizationId }).first();
  if (!asset) {
    throw new Error(`Asset ${assetId} not found for Organization ${organizationId}`);
  }

  // 2. Fetch campaign and associated jobs
  let campaign = null;
  if (asset.campaign_id) {
    campaign = await Campaign.query().where({ id: asset.campaign_id, organization_id: organizationId }).first();
  }

  // Find all campaign_targets that reference this asset or cover
  const targets = await CampaignTarget.query()
    .where('asset_id', asset.id)
    .orWhere('cover_asset_id', asset.id);

  const targetIds = targets.map(t => t.id);
  let jobs = [];
  if (targetIds.length > 0) {
    jobs = await PublishJob.query().whereIn('campaign_target_id', targetIds);
  }

  // 3. Evaluate deletion safety
  const { canDelete, reason } = canDeleteAsset(asset, campaign, jobs);
  if (!canDelete) {
    throw new Error(`CANNOT_DELETE_ASSET: ${reason}`);
  }

  // 4. Verify object key belongs to organization
  if (!isObjectKeyOwnedByOrg(asset.object_key, organizationId)) {
    throw new Error(`Security Violation: Object key '${asset.object_key}' does not belong to organization ${organizationId}`);
  }

  // 5. Delete object from S3 (idempotent)
  try {
    await deleteObjectFn(asset.object_key);
  } catch (s3Err) {
    // DeleteObject is idempotent; an explicit already-missing response is safe.
    // Any other storage failure must leave the database non-DELETED for retry.
    if (!isAlreadyMissingObjectError(s3Err)) throw s3Err;
  }

  // 6. Update database record to DELETED
  const updatedAsset = markDeletedFn
    ? await markDeletedFn(asset)
    : await Asset.query().patchAndFetchById(asset.id, {
      status: ASSET_STATUS.DELETED,
      locked_at: null,
      lock_token: null,
    });

  return updatedAsset;
}

/**
 * Process-death recovery for uploads that never reached their final DB
 * transaction. The Asset row remains authoritative for the only key deleted.
 */
export async function recoverStaleUploadingAssets({
  staleThresholdMs = STALE_UPLOAD_THRESHOLD_MS,
  now = new Date(),
  deleteObjectFn = deleteObject,
} = {}) {
  const cutoff = new Date(now.getTime() - staleThresholdMs);
  const staleAssets = await Asset.query()
    .where('status', ASSET_STATUS.UPLOADING)
    .where('updated_at', '<=', cutoff);
  const results = [];
  for (const asset of staleAssets) {
    if (!isObjectKeyOwnedByOrg(asset.object_key, asset.organization_id)) {
      results.push({ assetId: asset.id, recovered: false, reason: 'unsafe object key' });
      continue;
    }
    try {
      await deleteObjectFn(asset.object_key);
      await Asset.query().patchAndFetchById(asset.id, {
        status: ASSET_STATUS.FAILED,
        error_message: 'STALE_UPLOAD_RECOVERED',
        locked_at: null,
        lock_token: null,
      });
      results.push({ assetId: asset.id, recovered: true });
    } catch (error) {
      if (isAlreadyMissingObjectError(error)) {
        await Asset.query().patchAndFetchById(asset.id, {
          status: ASSET_STATUS.FAILED,
          error_message: 'STALE_UPLOAD_OBJECT_MISSING',
          locked_at: null,
          lock_token: null,
        });
        results.push({ assetId: asset.id, recovered: true });
      } else {
        results.push({ assetId: asset.id, recovered: false, reason: error.message });
      }
    }
  }
  return results;
}

/** Runs the bounded retention policy; only Asset-row-derived keys are deleted. */
export async function sweepRetainedAssets({ now = new Date(), deleteObjectFn = deleteObject } = {}) {
  const candidates = await Asset.query()
    .whereIn('status', [ASSET_STATUS.FAILED, ASSET_STATUS.READY, ASSET_STATUS.STORED])
    .where((builder) => builder.where('status', ASSET_STATUS.FAILED).orWhere('expires_at', '<=', now));
  const results = [];
  for (const asset of candidates) {
    try {
      const deleted = await deleteAssetObject(asset.id, asset.organization_id, { deleteObjectFn });
      results.push({ assetId: asset.id, deleted: deleted.status === ASSET_STATUS.DELETED });
    } catch (error) {
      // Active RETRY_WAIT / RECONCILE_REQUIRED references are intentionally
      // protected; other failures remain observable and retryable next sweep.
      results.push({ assetId: asset.id, deleted: false, reason: error.message });
    }
  }
  return results;
}
