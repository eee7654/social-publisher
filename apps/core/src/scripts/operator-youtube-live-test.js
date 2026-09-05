import '../bootstrap.js';
import getDb from '../config/database.js';
import { createOutboxEvent } from '../publisher/outbox.js';
import { resolveYouTubeTargetAsset } from '../publisher/platforms/youtube/selection.js';

const db = getDb();
const id = Number(process.argv.find(arg => arg.startsWith('--target='))?.split('=')[1]);
if (process.env.YOUTUBE_LIVE_TEST !== 'true' || !Number.isInteger(id) || id <= 0) {
  console.error('Refusing: set YOUTUBE_LIVE_TEST=true and pass --target=<CampaignTarget ID>.'); process.exitCode = 1;
} else {
  try {
    const job = await db.transaction(async trx => {
      const target = await trx('campaign_targets').where({ id }).forUpdate().first();
      if (!target || target.platform !== 'youtube') throw new Error('Target is not a YouTube target');
      if (target.status === 'waiting_media_ready') throw new Error('TARGET_NOT_READY: WAITING_MEDIA_READY');
      const campaign = await trx('campaigns').where({ id: target.campaign_id }).forUpdate().first();
      if (!campaign || campaign.status !== 'ready') throw new Error('Campaign is not READY');
      if (!target.integration_config_id || !target.asset_id || !target.title_override || !['SHORT', 'REGULAR'].includes(target.settings_json?.youtube_mode)) throw new Error('YouTube target is missing connection, mode, title, or resolved asset');
      
      const masterAsset = await trx('assets').where({ id: target.asset_id, organization_id: campaign.organization_id }).first();
      if (!masterAsset) throw new Error('Target master asset not found or not tenant-owned');

      const resolved = await resolveYouTubeTargetAsset({ target, masterAsset, trx });
      if (resolved.status !== 'READY') throw new Error(`TARGET_NOT_READY: ${resolved.status}`);

      const config = await trx('integration_configs').where({ id: target.integration_config_id, organization_id: campaign.organization_id, status: 'active' }).whereNull('deleted_at').first();
      const asset = await trx('assets').where({ id: resolved.asset.id, organization_id: campaign.organization_id, status: 'ready' }).first();
      if (!config || !asset) throw new Error('Connection or resolved asset is not tenant-owned and READY');

      if (target.asset_id !== resolved.asset.id || target.status !== 'ready') {
        await trx('campaign_targets').where({ id }).update({ asset_id: resolved.asset.id, status: 'ready' });
      }

      const existing = await trx('publish_jobs').where({ campaign_target_id: id }).whereIn('status', ['queued', 'running', 'retry_wait', 'reconcile_required', 'succeeded']).first();
      if (existing) return existing;
      const [jobId] = await trx('publish_jobs').insert({ organization_id: campaign.organization_id, campaign_target_id: id, idempotency_key: `live-yt-c${campaign.id}-t${id}`, status: 'queued', attempt_count: 0, max_attempts: 3, created_at: db.fn.now(), updated_at: db.fn.now() });
      await createOutboxEvent(trx, { organizationId: campaign.organization_id, eventType: 'jobs.publish.youtube', aggregateType: 'PublishJob', aggregateId: String(jobId), payloadJson: { jobId, organizationId: campaign.organization_id, campaignTargetId: id } });
      return trx('publish_jobs').where({ id: jobId }).first();
    });
    console.log(`Queued YouTube PublishJob ${job.id} on jobs.publish.youtube; no Google API was called.`);
  } catch (error) { console.error(`Refusing: ${error.message}`); process.exitCode = 1; }
  finally { await db.destroy(); }
}
