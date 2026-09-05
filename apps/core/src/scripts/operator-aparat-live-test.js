import '../bootstrap.js';
import getDb from '../config/database.js';
import { createOutboxEvent } from '../publisher/outbox.js';
import { resolveAparatMedia, resolveAparatTargetMedia } from '../publisher/handlers/aparatPublishHandler.js';

const db = getDb();
const targetArg = process.argv.find(arg => arg.startsWith('--target='));
const targetId = targetArg ? Number(targetArg.split('=')[1]) : null;

if (process.env.APARAT_LIVE_TEST !== 'true' || !Number.isInteger(targetId) || targetId <= 0) {
  console.error('Refusing: set APARAT_LIVE_TEST=true and pass --target=<CampaignTarget ID>.');
  process.exitCode = 1;
} else {
  try {
    const preflight = await db.transaction(async (trx) => {
      const target = await trx('campaign_targets').where({ id: targetId }).forUpdate().first();
      if (!target || target.platform !== 'aparat') {
        throw new Error('Target is not an Aparat target');
      }
      if (target.status === 'waiting_media_ready') {
        throw new Error('TARGET_NOT_READY: WAITING_MEDIA_READY');
      }

      const campaign = await trx('campaigns').where({ id: target.campaign_id }).forUpdate().first();
      if (!campaign || campaign.status !== 'ready') {
        throw new Error('Campaign is not READY');
      }

      if (!target.integration_config_id) {
        throw new Error('Aparat target is missing an active integration connection');
      }

      const config = await trx('integration_configs')
        .where({ id: target.integration_config_id, organization_id: campaign.organization_id, status: 'active' })
        .whereNull('deleted_at')
        .first();

      if (!config) {
        throw new Error('Integration config is not tenant-owned, active, or found');
      }

      const configJson = config.config_json || {};
      if (configJson.auth_mode !== 'aparat_web_session_v1' || !configJson.session) {
        throw new Error('Integration config is not a valid aparat_web_session_v1 connection (legacy ltoken is not allowed)');
      }

      const masterAsset = await trx('assets')
        .where({ id: target.asset_id || campaign.asset_id, organization_id: campaign.organization_id })
        .first();

      if (!masterAsset) {
        throw new Error('Target master video asset not found or not tenant-owned');
      }

      const coverAsset = await trx('assets')
        .where({ id: target.cover_asset_id || campaign.cover_asset_id, organization_id: campaign.organization_id })
        .first();

      if (!coverAsset) {
        throw new Error('Target cover asset not found or not tenant-owned');
      }

      const resolved = await resolveAparatTargetMedia({
        target,
        masterAsset,
        coverAsset,
        organizationId: campaign.organization_id,
        trx,
      });

      if (resolved.status !== 'READY') {
        await trx('campaign_targets').where({ id: targetId }).update({
          asset_id: resolved.videoAsset?.id || target.asset_id,
          cover_asset_id: resolved.coverAsset?.id || target.cover_asset_id,
          status: 'waiting_media_ready',
        });
        return {
          waitingMedia: true,
          status: resolved.status,
          variantAssetId: resolved.videoAsset?.id,
          coverVariantAssetId: resolved.coverAsset?.id,
        };
      }

      if (target.asset_id !== resolved.videoAsset.id || target.cover_asset_id !== resolved.coverAsset.id || target.status !== 'ready') {
        await trx('campaign_targets').where({ id: targetId }).update({
          asset_id: resolved.videoAsset.id,
          cover_asset_id: resolved.coverAsset.id,
          status: 'ready',
        });
      }

      let currentSettings = typeof target.settings_json === 'string'
        ? JSON.parse(target.settings_json || '{}')
        : (target.settings_json || {});
      const effectiveTags = Array.isArray(currentSettings.tags) && currentSettings.tags.length >= 3
        ? currentSettings.tags
        : (Array.isArray(campaign.tags) && campaign.tags.length >= 3 ? campaign.tags : ['الکسیو', 'ویدیو', 'تست']);

      if (!Array.isArray(currentSettings.tags) || currentSettings.tags.length < 3) {
        currentSettings = {
          ...currentSettings,
          tags: effectiveTags,
          category_id: currentSettings.category_id || config.default_category_id || '16',
        };
        await trx('campaign_targets').where({ id: targetId }).update({
          settings_json: JSON.stringify(currentSettings),
        });
      }

      const allJobs = await trx('publish_jobs')
        .where({ campaign_target_id: targetId });
      const activeJob = allJobs.find(j => ['queued', 'running', 'retry_wait', 'reconcile_required', 'succeeded'].includes(j.status));

      let jobId;
      if (activeJob) {
        jobId = activeJob.id;
      } else {
        const runSuffix = allJobs.length > 0 ? `-r${allJobs.length + 1}` : '';
        const [insertedId] = await trx('publish_jobs').insert({
          organization_id: campaign.organization_id,
          campaign_target_id: targetId,
          idempotency_key: `live-aparat-c${campaign.id}-t${targetId}${runSuffix}`,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          created_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
        jobId = insertedId;

        await createOutboxEvent(trx, {
          organizationId: campaign.organization_id,
          eventType: 'jobs.publish.aparat',
          aggregateType: 'PublishJob',
          aggregateId: String(jobId),
          payloadJson: {
            jobId,
            organizationId: campaign.organization_id,
            campaignTargetId: targetId,
          },
        });
      }

      const tags = effectiveTags;

      return {
        organizationId: campaign.organization_id,
        campaignId: campaign.id,
        campaignTargetId: targetId,
        publishJobId: jobId,
        masterAssetId: masterAsset.id,
        derivedVideoAssetId: resolved.videoAsset.id,
        videoBytes: resolved.videoAsset.size_bytes,
        coverAssetId: resolved.coverAsset.id,
        title: target.title_override || campaign.base_title || 'ویدیو جدید',
        descriptionLength: (target.caption_override || campaign.base_caption || '').length,
        tags,
        category: currentSettings.category_id || config.default_category_id || '16',
        username: configJson.username,
      };
    });

    if (preflight.waitingMedia) {
      console.error('Refusing: TARGET_NOT_READY: WAITING_MEDIA_READY');
      console.error(`Media variant ${preflight.variantAssetId} is queued for rendering in background.`);
      process.exitCode = 1;
    } else {
      console.log('\n==================================================');
      console.log('APARAT LIVE TEST PREFLIGHT (SAFE FIELDS ONLY)');
      console.log('==================================================');
      console.log(`Organization ID:        ${preflight.organizationId}`);
      console.log(`Campaign ID:            ${preflight.campaignId}`);
      console.log(`CampaignTarget ID:      ${preflight.campaignTargetId}`);
      console.log(`PublishJob ID:          ${preflight.publishJobId}`);
      console.log(`Master Video Asset ID:  ${preflight.masterAssetId}`);
      console.log(`Derived 16:9 Asset ID:  ${preflight.derivedVideoAssetId}`);
      console.log(`Video Byte Size:        ${preflight.videoBytes} bytes`);
      console.log(`Cover Asset ID:         ${preflight.coverAssetId}`);
      console.log(`Title:                  ${preflight.title}`);
      console.log(`Description Length:     ${preflight.descriptionLength} characters`);
      console.log(`Tag Count:              ${preflight.tags.length} (${preflight.tags.join(', ')})`);
      console.log(`Category:               ${preflight.category}`);
      console.log(`Aparat Username:        ${preflight.username}`);
      console.log('==================================================');
      console.log(`Queued Aparat PublishJob ${preflight.publishJobId} on jobs.publish.aparat.`);
      console.log('No Aparat public video create POST was called directly by this CLI.');
    }
  } catch (err) {
    console.error(`Refusing: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
