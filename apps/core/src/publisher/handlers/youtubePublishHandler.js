import PublishJob from '../../db/models/core/PublishJob.js';
import CampaignTarget from '../../db/models/core/CampaignTarget.js';
import Campaign from '../../db/models/core/Campaign.js';
import Asset from '../../db/models/core/Asset.js';
import IntegrationConfig from '../../db/models/core/IntegrationConfig.js';
import { ERROR_CATEGORY } from '../constants.js';
import { publishToYouTube } from '../platforms/youtube/adapter.js';
import { resolveYouTubeTargetAsset } from '../platforms/youtube/selection.js';

export async function youtubePublishHandler({ jobId, organizationId, campaignTargetId, signal }) {
  const [job, target] = await Promise.all([
    PublishJob.query().where({ id: jobId, organization_id: organizationId }).first(),
    CampaignTarget.query().findById(campaignTargetId),
  ]);
  if (!job || !target) throw new Error('YouTube publish job or target was not found');
  const [campaign, asset, coverAsset, integrationConfig] = await Promise.all([
    Campaign.query().where({ id: target.campaign_id, organization_id: organizationId }).first(),
    Asset.query().where({ id: target.asset_id, organization_id: organizationId }).first(),
    target.cover_asset_id ? Asset.query().where({ id: target.cover_asset_id, organization_id: organizationId }).first() : null,
    IntegrationConfig.query().where({ id: target.integration_config_id, organization_id: organizationId, status: 'active' }).whereNull('deleted_at').first(),
  ]);
  if (!campaign || !asset || !integrationConfig) throw new Error('YouTube publish context is incomplete or not organization-owned');
  const selected = await resolveYouTubeTargetAsset({ target, masterAsset: asset });
  if (selected.status !== 'READY') {
    const error = new Error(`YouTube target is not ready: ${selected.status}`);
    error.code = 'TARGET_NOT_READY';
    error.category = ERROR_CATEGORY.TARGET_NOT_READY;
    error.safeMetadata = { reason: selected.status };
    throw error;
  }
  return publishToYouTube(job, { campaignTarget: target, campaign, asset: selected.asset, coverAsset, integrationConfig, signal, updateJob: patch => job.$query().patch(patch) });
}
