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
import { decryptProviderConfig } from '../integrations/secrets.js';
import { evaluateCompatibility } from '../publisher/media/compatibility.js';
import { COMPATIBILITY_STATUS } from '../publisher/media/constants.js';
import { createSignedReadUrl, isPrivateOrLocalHost } from '../services/storage/s3.js';
import { createOutboxEvent } from '../publisher/outbox.js';

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
  const args = parseArgs();
  const isExecuteMode = process.env.INSTAGRAM_LIVE_TEST === 'true';

  console.log('================================================================================');
  console.log('📸 ELECIO PUBLISHER — PHASE 6 INSTAGRAM OPERATOR-GATED LIVE PUBLISH UTILITY');
  console.log('================================================================================');

  const orgId = 1;
  const org = await Organization.query().findById(orgId);
  if (!org) {
    console.error(`❌ Organization ${orgId} not found.`);
    process.exit(1);
  }

  // 1. Resolve Active Instagram Provider & Config
  const provider = await IntegrationProvider.query()
    .where({ domain: 'publishing', code: 'instagram', is_enabled: true })
    .first();

  if (!provider) {
    console.error('❌ Provider "publishing.instagram" not enabled.');
    process.exit(1);
  }

  const config = await IntegrationConfig.query()
    .where({ organization_id: orgId, provider_id: provider.id, status: 'active' })
    .first();

  if (!config) {
    console.error(`❌ No active Instagram IntegrationConfig for Organization ${orgId}.`);
    process.exit(1);
  }

  // Decrypt credentials safely inside memory boundary
  const decrypted = decryptProviderConfig(config.config_json);
  const accountUsername = decrypted?.username ? `@${decrypted.username}` : '@elecio_co';

  // 2. Identify the Target Campaign & Target
  let campaign = null;
  let target = null;

  if (args['target']) {
    target = await CampaignTarget.query().findById(Number(args['target']));
    if (!target || target.platform !== 'instagram') {
      console.error(`❌ CampaignTarget ${args['target']} not found or not Instagram.`);
      process.exit(1);
    }
    campaign = await Campaign.query().where({ id: target.campaign_id, organization_id: orgId }).first();
    if (!campaign) {
      console.error(`❌ CampaignTarget ${args['target']} does not belong to Organization ${orgId}.`);
      process.exit(1);
    }
  } else if (args['campaign-id']) {
    campaign = await Campaign.query().where({ id: Number(args['campaign-id']), organization_id: orgId }).first();
    if (!campaign) {
      console.error(`❌ Campaign ${args['campaign-id']} not found for Organization ${orgId}.`);
      process.exit(1);
    }
    target = await CampaignTarget.query().where({ campaign_id: campaign.id, platform: 'instagram' }).first();
  } else {
    // Find the most recent READY/DRAFT campaign for Org 1 from Telegram
    const recentCampaigns = await Campaign.query()
      .where({ organization_id: orgId, source_type: 'telegram_private' })
      .orderBy('id', 'desc');

    for (const c of recentCampaigns) {
      const t = await CampaignTarget.query().where({ campaign_id: c.id, platform: 'instagram' }).first();
      if (t) {
        campaign = c;
        target = t;
        break;
      }
    }
  }

  if (!campaign || !target) {
    console.error('❌ Could not resolve a valid Instagram Campaign & CampaignTarget for Organization 1.');
    process.exit(1);
  }

  // 3. Resolve Master & Cover Assets
  const masterAssetId = target.asset_id || campaign.asset_id;
  const masterAsset = await Asset.query().where({ id: masterAssetId, organization_id: orgId }).first();

  const coverAssetId = target.cover_asset_id || campaign.cover_asset_id;
  const coverAsset = coverAssetId ? await Asset.query().where({ id: coverAssetId, organization_id: orgId }).first() : null;

  if (!masterAsset || masterAsset.status !== 'ready') {
    console.error(`❌ Master Asset ${masterAssetId} is missing or not in READY status.`);
    process.exit(1);
  }

  if (masterAsset.duration_ms < 3000) {
    console.error(`❌ Master Asset duration (${masterAsset.duration_ms}ms) is below 3000ms Meta Reels minimum.`);
    process.exit(1);
  }

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
    console.error('❌ Master Asset is not COMPATIBLE with Instagram:', compatibility.reasons);
    process.exit(1);
  }

  // 4. Preflight Media Signed URL & Public Reachability Gate
  const ttlSeconds = 86400; // 24 hours standard Instagram ingest TTL
  const sampleVideoUrl = await createSignedReadUrl(masterAsset.object_key, ttlSeconds);
  const sampleCoverUrl = coverAsset ? await createSignedReadUrl(coverAsset.object_key, ttlSeconds) : null;

  const parsedVideoUrl = new URL(sampleVideoUrl);
  const hostCheck = isPrivateOrLocalHost(parsedVideoUrl.hostname);
  const isHttps = parsedVideoUrl.protocol === 'https:';

  console.log('🌐 MEDIA URL PUBLIC REACHABILITY PREFLIGHT:');
  console.log(`   • Internal S3 Endpoint:    ${process.env.S3_ENDPOINT || 'http://127.0.0.1:9000'}`);
  console.log(`   • Public Signing Host:     ${parsedVideoUrl.hostname} (${parsedVideoUrl.protocol.replace(':', '').toUpperCase()})`);
  console.log(`   • Host Classification:     ${hostCheck.reason} (${hostCheck.isPublic ? 'Publicly Routable' : 'Private / Localhost'})`);
  console.log(`   • HTTPS Protocol:          ${isHttps ? 'Yes (Secure)' : 'No (HTTP)'}`);
  console.log(`   • Ingest Window TTL:       ${ttlSeconds}s (${Math.round(ttlSeconds / 60)} minutes)`);
  console.log(`   • Public Reachability:     ${hostCheck.isPublic ? '✅ PASS (Externally Routable)' : '❌ FAIL (Local / Private)'}`);
  console.log('--------------------------------------------------------------------------------');

  // If in execution mode and host is NOT public, refuse to proceed
  if (isExecuteMode && !hostCheck.isPublic) {
    console.error('⛔ EXECUTION BLOCKED: Media URL host is not publicly reachable.');
    console.error(`Current public host "${parsedVideoUrl.hostname}" cannot be downloaded by Meta Graph API servers.`);
    console.error('');
    console.error('To proceed safely for Phase 6:');
    console.error('  1. Expose MinIO port 9000 (S3 API only) via HTTPS tunnel (e.g. Cloudflare Tunnel / Ngrok)');
    console.error('  2. Set S3_PUBLIC_ENDPOINT=https://<your-tunnel-host> in apps/core/.env');
    console.error('  3. Re-run: $env:INSTAGRAM_LIVE_TEST="true"; npm run publisher:instagram:live-test -- --target=' + target.id);
    process.exit(1);
  }

  // If NOT in execution mode, safely display status and stop
  if (!isExecuteMode) {
    if (hostCheck.isPublic) {
      console.log('ℹ️  STATUS: LIVE READINESS PASS (Inspection Mode)');
      console.log('   All preconditions passed. Media URLs are publicly reachable.');
      console.log('');
      console.log('👉 To execute live publication, start required daemons and run:');
      console.log(`   $env:INSTAGRAM_LIVE_TEST="true"; npm run publisher:instagram:live-test -- --target=${target.id}`);
    } else {
      console.log('⚠️  STATUS: EXTERNAL MEDIA PREFLIGHT FAILED');
      console.log('   Local and database readiness: PASS');
      console.log('   Public media reachability:    FAIL (S3_PUBLIC_ENDPOINT required for Meta ingest)');
      console.log('');
      console.log('👉 Setup S3_PUBLIC_ENDPOINT with HTTPS tunnel before running live test.');
    }
    console.log('================================================================================');
    await db.destroy();
    process.exit(0);
  }

  // 5. Execution Mode: Transactional Job & Outbox Creation
  console.log('🚀 EXECUTION MODE: Creating transactional PublishJob and OutboxEvent...');

  const idempotencyKey = `live-ig-c${campaign.id}-t${target.id}`;

  const createdJob = await db.transaction(async (trx) => {
    // Lock CampaignTarget
    const [lockedTarget] = await trx('campaign_targets')
      .where({ id: target.id })
      .forUpdate();

    if (!lockedTarget) {
      throw new Error(`CampaignTarget ${target.id} not found under transaction lock`);
    }

    const [lockedCampaign] = await trx('campaigns')
      .where({ id: lockedTarget.campaign_id })
      .forUpdate();

    if (!lockedCampaign) {
      throw new Error(`Campaign ${lockedTarget.campaign_id} not found for CampaignTarget ${target.id}`);
    }

    const targetOrgId = lockedCampaign.organization_id;

    // Check for existing active or successful PublishJob
    const existingJob = await trx('publish_jobs')
      .where({ campaign_target_id: target.id })
      .whereIn('status', ['queued', 'running', 'retry_wait', 'reconcile_required', 'succeeded'])
      .first();

    if (existingJob) {
      console.log(`⚠️ Existing PublishJob [ID: ${existingJob.id}] found in status "${existingJob.status}". Reusing existing job.`);
      return existingJob;
    }

    // Create exactly ONE PublishJob
    const [jobId] = await trx('publish_jobs').insert({
      campaign_target_id: target.id,
      organization_id: targetOrgId,
      idempotency_key: idempotencyKey,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    // Create Outbox Event using canonical helper
    await createOutboxEvent(trx, {
      organizationId: targetOrgId,
      eventType: 'jobs.publish.instagram',
      aggregateType: 'publish_jobs',
      aggregateId: String(jobId),
      payloadJson: {
        jobId,
        organizationId: targetOrgId,
        campaignTargetId: target.id,
      },
    });

    const [job] = await trx('publish_jobs').where({ id: jobId });
    return job;
  });

  console.log(`✅ PublishJob [ID: ${createdJob.id}] successfully queued via Outbox!`);
  console.log(`   • Idempotency Key: "${idempotencyKey}"`);
  console.log(`   • NATS Subject:    "jobs.publish.instagram"`);
  console.log('================================================================================');
  console.log('📡 The job is now queued in the Transactional Outbox.');
  console.log('   The Outbox Dispatcher and Instagram Worker will process the publication.');
  console.log('================================================================================');

  await db.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('💥 Error in operator live utility:', err.message || err);
  await db.destroy();
  process.exit(1);
});
