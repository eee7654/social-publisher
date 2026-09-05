import PublishJob from '../../db/models/core/PublishJob.js';
import CampaignTarget from '../../db/models/core/CampaignTarget.js';
import Campaign from '../../db/models/core/Campaign.js';
import Asset from '../../db/models/core/Asset.js';
import IntegrationConfig from '../../db/models/core/IntegrationConfig.js';
import { ERROR_CATEGORY } from '../constants.js';
import { publishToLinkedIn } from '../platforms/linkedin/adapter.js';
import { getObjectRangeStream, getObjectStream } from '../../services/storage/s3.js';

export async function linkedinPublishHandler({
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
    const error = new Error('LinkedIn publish job or target was not found');
    error.code = 'TARGET_NOT_FOUND';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    throw error;
  }

  if (target.platform !== 'linkedin') {
    const error = new Error(`Target platform mismatch: expected linkedin, got ${target.platform}`);
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
    const error = new Error('LinkedIn publish context is incomplete or not organization-owned');
    error.code = 'CONTEXT_INCOMPLETE';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    throw error;
  }

  if (target.asset_id && !explicitAsset) {
    const error = new Error('Attached asset was not found or is not organization-owned');
    error.code = 'ASSET_NOT_FOUND';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    throw error;
  }

  // Resolve media asset: if target has no explicit asset_id, check campaign's master asset
  let asset = explicitAsset;
  if (!asset) {
    asset = await Asset.query()
      .where({ campaign_id: campaign.id, organization_id: organizationId })
      .whereNull('parent_asset_id')
      .first();
  }

  const coverAsset = explicitCoverAsset || (campaign.cover_asset_id ? await Asset.query().where({ id: campaign.cover_asset_id, organization_id: organizationId }).first() : null);

  // Determine content type:
  // A LinkedIn target backed by a Campaign video MUST resolve to LINKEDIN_VIDEO, not LINKEDIN_IMAGE.
  // Cover presence MUST NOT change post type from video to image.
  const isVideo = !!(asset?.mime_type?.startsWith('video/'));

  if (isVideo) {
    if (asset.status !== 'ready') {
      const error = new Error(`LinkedIn attached video asset is not ready: ${asset.status}`);
      error.code = 'TARGET_NOT_READY';
      error.category = ERROR_CATEGORY.TARGET_NOT_READY;
      error.safeMetadata = { assetStatus: asset.status };
      throw error;
    }
  } else if (asset && asset.status !== 'ready') {
    const error = new Error(`LinkedIn attached asset is not ready: ${asset.status}`);
    error.code = 'TARGET_NOT_READY';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    error.safeMetadata = { assetStatus: asset.status };
    throw error;
  }

  return publishToLinkedIn(job, {
    campaignTarget: target,
    campaign,
    asset,
    coverAsset,
    integrationConfig,
    signal,
    updateJob: patch => job.$query().patch(patch),
    fetchImpl,
    s3StreamFactory,
    s3RangeStreamFactory,
    contentType: isVideo ? 'LINKEDIN_VIDEO' : (asset?.mime_type?.startsWith('image/') || coverAsset?.mime_type?.startsWith('image/') ? 'LINKEDIN_IMAGE' : 'LINKEDIN_TEXT'),
  });
}

