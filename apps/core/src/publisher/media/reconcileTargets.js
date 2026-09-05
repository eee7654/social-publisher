import CampaignTarget from '../../db/models/core/CampaignTarget.js';
import Campaign from '../../db/models/core/Campaign.js';
import Asset from '../../db/models/core/Asset.js';
import { resolveYouTubeTargetAsset } from '../platforms/youtube/selection.js';
import { resolveAparatTargetMedia } from '../platforms/aparat/selection.js';

/**
 * Automatically reconciles dependent targets when a media variant becomes READY.
 */
export async function reconcileTargetsForVariant({ variantAsset, organizationId }) {
  if (!variantAsset?.parent_asset_id) return [];

  const targets = await CampaignTarget.query()
    .join('campaigns', 'campaign_targets.campaign_id', 'campaigns.id')
    .where('campaigns.organization_id', organizationId)
    .whereIn('campaign_targets.platform', ['youtube', 'aparat'])
    .where((builder) => {
      builder
        .where('campaign_targets.campaign_id', variantAsset.campaign_id)
        .orWhere('campaign_targets.asset_id', variantAsset.parent_asset_id)
        .orWhere('campaign_targets.asset_id', variantAsset.id)
        .orWhere('campaign_targets.cover_asset_id', variantAsset.parent_asset_id)
        .orWhere('campaign_targets.cover_asset_id', variantAsset.id);
    })
    .select('campaign_targets.*');

  const masterAsset = await Asset.query()
    .where({ id: variantAsset.parent_asset_id, organization_id: organizationId })
    .first();

  const updatedTargets = [];

  for (const target of targets) {
    if (target.platform === 'youtube' && masterAsset) {
      const resolved = await resolveYouTubeTargetAsset({ target, masterAsset });
      if (resolved.status === 'READY') {
        await CampaignTarget.query()
          .where({ id: target.id })
          .patch({
            asset_id: resolved.asset.id,
            status: 'ready',
          });
        updatedTargets.push(target.id);
      }
    } else if (target.platform === 'aparat') {
      const videoAsset = (masterAsset && masterAsset.mime_type?.startsWith('video/'))
        ? masterAsset
        : (target.asset_id ? await Asset.query().findById(target.asset_id) : null);
      const coverAsset = target.cover_asset_id
        ? await Asset.query().findById(target.cover_asset_id)
        : null;

      if (videoAsset) {
        const resolved = await resolveAparatTargetMedia({
          target,
          masterAsset: videoAsset,
          coverAsset,
          organizationId,
        });
        if (resolved.status === 'READY') {
          await CampaignTarget.query()
            .where({ id: target.id })
            .patch({
              asset_id: resolved.videoAsset.id,
              cover_asset_id: resolved.coverAsset?.id || target.cover_asset_id,
              status: 'ready',
            });
          updatedTargets.push(target.id);
        }
      }
    }
  }

  // If targets were updated, check if dependent campaigns can be marked ready
  if (updatedTargets.length > 0) {
    const campaignIds = [...new Set(targets.map((t) => t.campaign_id))];
    for (const campaignId of campaignIds) {
      const remainingUnready = await CampaignTarget.query()
        .where({ campaign_id: campaignId })
        .whereIn('status', ['waiting_media_ready', 'pending'])
        .first();

      if (!remainingUnready) {
        await Campaign.query()
          .where({ id: campaignId, organization_id: organizationId })
          .patch({ status: 'ready' });
      }
    }
  }

  return updatedTargets;
}
