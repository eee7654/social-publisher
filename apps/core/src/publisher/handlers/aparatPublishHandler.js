import PublishJob from '../../db/models/core/PublishJob.js';
import CampaignTarget from '../../db/models/core/CampaignTarget.js';
import Campaign from '../../db/models/core/Campaign.js';
import Asset from '../../db/models/core/Asset.js';
import IntegrationConfig from '../../db/models/core/IntegrationConfig.js';
import { ERROR_CATEGORY } from '../constants.js';
import { publishToAparat } from '../platforms/aparat/adapter.js';
import { getObjectStream, getObjectRangeStream } from '../../services/storage/s3.js';
import { ensureElecioHorizontalVariant, isElecioHorizontalVariant } from '../media/variants.js';
import { ensureElecioThumbnail16x9Variant, isElecioThumbnail16x9Variant } from '../media/thumbnailVariants.js';
import { ASSET_STATUS } from '../media/constants.js';

import { resolveAparatTargetMedia } from '../platforms/aparat/selection.js';

export { resolveAparatTargetMedia };

export async function resolveAparatMedia({ target, masterAsset, coverAsset, organizationId, trx }) {
  const resolved = await resolveAparatTargetMedia({
    target,
    masterAsset,
    coverAsset,
    organizationId,
    trx,
  });

  if (resolved.status !== 'READY') {
    const err = new Error('Aparat landscape video variant is waiting for media rendering');
    err.code = 'WAITING_MEDIA_READY';
    err.category = ERROR_CATEGORY.TARGET_NOT_READY;
    err.safeMetadata = {
      variantAssetId: resolved.videoAsset?.id,
      coverVariantAssetId: resolved.coverAsset?.id,
    };
    throw err;
  }

  return {
    videoAsset: resolved.videoAsset,
    coverAsset: resolved.coverAsset,
  };
}

export async function aparatPublishHandler({
  jobId,
  organizationId,
  campaignTargetId,
  signal,
  fetchImpl = fetch,
  s3StreamFactory = getObjectStream,
  s3RangeStreamFactory = getObjectRangeStream,
}) {
  const [job, target] = await Promise.all([
    PublishJob.query().where({ id: jobId, organization_id: organizationId }).first(),
    CampaignTarget.query().findById(campaignTargetId),
  ]);

  if (!job || !target) {
    const error = new Error('Aparat publish job or target was not found');
    error.code = 'TARGET_NOT_FOUND';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    throw error;
  }

  if (target.platform !== 'aparat') {
    const error = new Error(`Target platform mismatch: expected aparat, got ${target.platform}`);
    error.code = 'PLATFORM_MISMATCH';
    error.category = ERROR_CATEGORY.VALIDATION;
    throw error;
  }

  const [campaign, explicitAsset, explicitCoverAsset, integrationConfig] = await Promise.all([
    Campaign.query().where({ id: target.campaign_id, organization_id: organizationId }).first(),
    target.asset_id ? Asset.query().where({ id: target.asset_id, organization_id: organizationId }).first() : null,
    target.cover_asset_id ? Asset.query().where({ id: target.cover_asset_id, organization_id: organizationId }).first() : null,
    IntegrationConfig.query().where({ id: target.integration_config_id, organization_id: organizationId, status: 'active' }).whereNull('deleted_at').first(),
  ]);

  if (!campaign || !integrationConfig) {
    const error = new Error('Aparat publish context is incomplete or not organization-owned');
    error.code = 'CONTEXT_INCOMPLETE';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    throw error;
  }

  // Resolve master video and cover assets
  let masterAsset = explicitAsset;
  if (!masterAsset) {
    masterAsset = await Asset.query()
      .where({ campaign_id: campaign.id, organization_id: organizationId })
      .whereNull('parent_asset_id')
      .first();
  }

  const baseCoverAsset = explicitCoverAsset || (campaign.cover_asset_id ? await Asset.query().where({ id: campaign.cover_asset_id, organization_id: organizationId }).first() : null);

  // Resolve required landscape media variants
  const { videoAsset, coverAsset } = await resolveAparatMedia({
    target,
    masterAsset,
    coverAsset: baseCoverAsset,
    organizationId,
  });

  return publishToAparat(job, {
    campaignTarget: target,
    campaign,
    asset: videoAsset,
    coverAsset,
    integrationConfig,
    signal,
    updateJob: patch => job.$query().patch(patch),
    fetchImpl,
    s3StreamFactory,
    s3RangeStreamFactory,
  });
}
