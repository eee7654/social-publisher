import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();

import Organization from '../db/models/core/Organization.js';
import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import Campaign from '../db/models/core/Campaign.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import Asset from '../db/models/core/Asset.js';
import PublishJob from '../db/models/core/PublishJob.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import { instagramPublisherAdapter } from '../publisher/platforms/instagram/adapter.js';
import { evaluateCompatibility } from '../publisher/media/compatibility.js';
import { COMPATIBILITY_STATUS } from '../publisher/media/constants.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

async function main() {
  console.log('================================================================================');
  console.log('🚀 ELECIO SOCIAL PUBLISHER — OPERATOR-GATED INSTAGRAM LIVE PUBLICATION');
  console.log('================================================================================');

  // Strict Operator Safety Gate
  if (process.env.INSTAGRAM_LIVE_TEST !== 'true') {
    console.error('⛔ EXECUTION BLOCKED: INSTAGRAM_LIVE_TEST=true environment variable is required.');
    console.error('To execute a real Instagram publication, run:');
    console.error('  INSTAGRAM_LIVE_TEST=true npm run publisher:instagram:live -- --campaign-id=<ID>');
    process.exit(1);
  }

  const args = parseArgs();
  const orgId = Number(args['org-id'] || 19);

  // 1. Resolve Organization
  const org = await Organization.query().findById(orgId);
  if (!org) {
    console.error(`❌ Organization ${orgId} not found.`);
    process.exit(1);
  }

  // 2. Resolve Instagram IntegrationConfig
  const provider = await IntegrationProvider.query()
    .where({ domain: 'publishing', code: 'instagram' })
    .first();

  if (!provider) {
    console.error('❌ Provider "publishing.instagram" not found.');
    process.exit(1);
  }

  const config = await IntegrationConfig.query()
    .where({ organization_id: org.id, provider_id: provider.id, status: 'active' })
    .first();

  if (!config) {
    console.error(`❌ No active Instagram IntegrationConfig found for Organization ${org.id}.`);
    process.exit(1);
  }

  // 3. Resolve Campaign
  let campaign = null;
  if (args['campaign-id']) {
    campaign = await Campaign.query()
      .where({ id: Number(args['campaign-id']), organization_id: org.id })
      .first();
  } else {
    // Find latest ready/draft campaign
    campaign = await Campaign.query()
      .where({ organization_id: org.id })
      .orderBy('id', 'desc')
      .first();
  }

  if (!campaign) {
    console.error('❌ Target Campaign not found.');
    process.exit(1);
  }

  // 4. Resolve Master Asset & Cover Asset
  const masterAsset = await Asset.query()
    .where({ organization_id: org.id, kind: 'master', status: 'ready' })
    .where('duration_ms', '>=', 3000)
    .orderBy('id', 'desc')
    .first();

  if (!masterAsset) {
    console.error('❌ No compatible READY master asset (duration >= 3s) found.');
    process.exit(1);
  }

  const coverAsset = campaign.cover_asset_id
    ? await Asset.query().findById(campaign.cover_asset_id)
    : await Asset.query().where({ organization_id: org.id, kind: 'cover', status: 'ready' }).orderBy('id', 'desc').first();

  // 5. Pre-flight Compatibility Evaluation
  const compatibility = evaluateCompatibility({
    size_bytes: masterAsset.size_bytes,
    duration_ms: masterAsset.duration_ms,
    width: masterAsset.width,
    height: masterAsset.height,
    fps: masterAsset.fps,
    aspect_ratio: masterAsset.aspect_ratio,
    video_codec: masterAsset.video_codec,
    audio_codec: masterAsset.audio_codec,
    has_video: true,
    has_audio: masterAsset.audio_codec != null,
  }, 'instagram');

  if (compatibility.status !== COMPATIBILITY_STATUS.COMPATIBLE) {
    console.error(`❌ Master Asset ${masterAsset.id} is not compatible with Instagram:`, compatibility.reasons);
    process.exit(1);
  }

  // 6. Ensure CampaignTarget exists
  let target = await CampaignTarget.query()
    .where({
      campaign_id: campaign.id,
      integration_config_id: config.id,
      platform: 'instagram',
    })
    .first();

  if (!target) {
    target = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaign.id,
      integration_config_id: config.id,
      platform: 'instagram',
      status: 'pending',
      suggested_by_system: true,
      confirmed_by_user: true,
      asset_id: masterAsset.id,
      cover_asset_id: coverAsset?.id || null,
      caption_override: campaign.base_caption || null,
      title_override: campaign.base_title || null,
    });
  } else {
    await CampaignTarget.query().findById(target.id).patch({
      asset_id: masterAsset.id,
      cover_asset_id: coverAsset?.id || null,
      status: 'pending',
    });
  }

  // 7. Print Safe Confirmation Data (NO SECRETS / TOKENS)
  console.log('📌 LIVE PUBLICATION TARGET CONFIRMATION:');
  console.log(`   • Organization:        [ID: ${org.id}] ${org.name || org.slug}`);
  console.log(`   • Instagram Account:   ${config.name || '@elecio_co'} [Config ID: ${config.id}]`);
  console.log(`   • Campaign ID:         ${campaign.id} (${campaign.base_title || 'Untitled'})`);
  console.log(`   • CampaignTarget ID:   ${target.id}`);
  console.log(`   • Master Asset ID:     ${masterAsset.id} (${masterAsset.width}x${masterAsset.height}, ${masterAsset.duration_ms}ms, ${masterAsset.aspect_ratio})`);
  console.log(`   • Cover Asset ID:      ${coverAsset?.id || 'None (auto-selected from video)'}`);
  console.log('--------------------------------------------------------------------------------');

  // 8. Create / Claim PublishJob
  const idempotencyKey = `live-ig-${campaign.id}-${target.id}-${Date.now()}`;
  const job = await PublishJob.query().insertAndFetch({
    campaign_target_id: target.id,
    organization_id: org.id,
    idempotency_key: idempotencyKey,
    status: 'queued',
  });

  console.log(`✨ Created PublishJob [ID: ${job.id}] with Idempotency Key: "${idempotencyKey}".`);

  // 9. Execute Publish directly via adapter
  console.log(`📡 Executing Instagram publish lifecycle via InstagramPublisherAdapter...`);
  const result = await instagramPublisherAdapter.publish({
    jobId: job.id,
    organizationId: org.id,
    campaignTargetId: target.id,
  });

  console.log('================================================================================');
  console.log('🎉 LIVE PUBLICATION SUCCEEDED!');
  console.log(`   • External Media ID:   ${result.externalMediaId || 'N/A'}`);
  console.log(`   • Live Permalink:      ${result.permalink || 'N/A'}`);
  console.log('================================================================================');

  await db.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('💥 Live publication encountered an error:', err.message || err);
  if (err.category) console.error(`   • Category: ${err.category}`);
  if (err.code) console.error(`   • Code:     ${err.code}`);
  await db.destroy();
  process.exit(1);
});
