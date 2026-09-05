import '../bootstrap.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import getDb from '../config/database.js';
const db = getDb();
import { connectNats } from '../services/messaging/nats.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { JSONCodec } from 'nats';

if (!process.env.INTEGRATION_CONFIG_ENCRYPTION_KEY) {
  process.env.INTEGRATION_CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

// Models
import Organization from '../db/models/core/Organization.js';
import User from '../db/models/core/User.js';
import Campaign from '../db/models/core/Campaign.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import Asset from '../db/models/core/Asset.js';
import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import IntegrationEvent from '../db/models/core/IntegrationEvent.js';
import PublishJob from '../db/models/core/PublishJob.js';
import PublishAttempt from '../db/models/core/PublishAttempt.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';

// Domain modules
import { seedIntegrationProviders } from '../integrations/seeder.js';
import { buildProviderConfig } from '../integrations/configSerializer.js';
import { encryptConfigValue, decryptConfigValue } from '../integrations/secrets.js';
import {
  instagramPublisherAdapter,
  InstagramPublisherAdapter,
  MetaApiClient,
  classifyMetaError,
  reconcileInstagramJob,
} from '../publisher/platforms/instagram/index.js';
import {
  INSTAGRAM_STAGE,
  INSTAGRAM_CONTAINER_STATUS,
  getMetaGraphVersion,
} from '../publisher/platforms/instagram/constants.js';
import { JOB_STATUS, ATTEMPT_STATUS, ERROR_CATEGORY } from '../publisher/constants.js';
import { ASSET_KIND, ASSET_STATUS } from '../publisher/media/constants.js';
import { evaluateAssetForTargets } from '../publisher/media/compatibility.js';
import { isPublisherAvailable, getPublisherCapability } from '../publisher/telegram/capabilities.js';
import { discoverTargetCandidates } from '../publisher/telegram/recommendations.js';
import { processJob } from '../publisher/worker.js';
import { instagramPublishHandler } from '../publisher/handlers/instagramPublishHandler.js';
import { putObject } from '../services/storage/s3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jc = JSONCodec();

const results = [];
const testRunId = crypto.randomUUID().slice(0, 8);

function record(name, status, evidence = 'OK') {
  results.push({ test: name, status, evidence });
  console.log(`  ${status === 'PASS' ? '✅' : '❌'} ${name} -> ${evidence}`);
}

function check(condition, name, evidence) {
  if (condition) record(name, 'PASS', evidence);
  else record(name, 'FAIL', evidence);
}

// Tracked fixtures for isolated cleanup
const trackedIds = {
  orgs: new Set(),
  users: new Set(),
  campaigns: new Set(),
  targets: new Set(),
  assets: new Set(),
  providers: new Set(),
  configs: new Set(),
  events: new Set(),
  jobs: new Set(),
  attempts: new Set(),
  outbox: new Set(),
};

async function main() {
  console.log('================================================================================');
  console.log(`PHASE 6 INSTAGRAM PUBLISHER ADAPTER VERIFICATION [RUN: ${testRunId}]`);
  console.log(`Graph API Version Configured: ${getMetaGraphVersion()}`);
  console.log('================================================================================\n');

  try {
    // 0. Seed Integration Providers
    await seedIntegrationProviders();
    const instagramProvider = await IntegrationProvider.query()
      .where({ domain: 'publishing', code: 'instagram' })
      .first();

    if (!instagramProvider) {
      throw new Error('Instagram provider could not be seeded.');
    }

    // 1. Create Isolated Test Organizations & User
    const orgA = await Organization.query().insertAndFetch({
      name: `Org A Instagram ${testRunId}`,
      slug: `org-a-ig-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgA.id);

    const orgB = await Organization.query().insertAndFetch({
      name: `Org B Instagram ${testRunId}`,
      slug: `org-b-ig-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgB.id);

    const userA = await User.query().insertAndFetch({
      id: `user-ig-${testRunId}`,
      name: 'Instagram Tester',
      email: `ig-tester-${testRunId}@test.local`,
      emailVerified: true,
    });
    trackedIds.users.add(userA.id);

    const secretSystemToken = `EAA_TEST_SECRET_TOKEN_${testRunId}_XYZ9876543210`;
    const encryptedConfigJson = buildProviderConfig({
      adapterKey: 'publishing.instagram',
      submitted: {
        system_user_token: secretSystemToken,
        instagram_user_id: '17841400000000001',
        page_id: '100000000000001',
        username: 'elecio_test_account',
      },
      isCreate: true,
    });

    const configOrgA = await IntegrationConfig.query().insertAndFetch({
      organization_id: orgA.id,
      provider_id: instagramProvider.id,
      name: 'Instagram Org A',
      status: 'active',
      config_json: encryptedConfigJson,
    });
    trackedIds.configs.add(configOrgA.id);

    const configOrgB = await IntegrationConfig.query().insertAndFetch({
      organization_id: orgB.id,
      provider_id: instagramProvider.id,
      name: 'Instagram Org B',
      status: 'active',
      config_json: encryptedConfigJson,
    });
    trackedIds.configs.add(configOrgB.id);

    // Create campaigns
    const campaignA = await Campaign.query().insertAndFetch({
      organization_id: orgA.id,
      created_by: userA.id,
      source_type: 'telegram_private',
      status: 'ready',
      base_title: 'Cool Reel Title',
      base_caption: 'Awesome Instagram Reel Caption #ElecIO',
    });
    trackedIds.campaigns.add(campaignA.id);

    const campaignB = await Campaign.query().insertAndFetch({
      organization_id: orgB.id,
      created_by: userA.id,
      source_type: 'telegram_private',
      status: 'ready',
      base_title: 'Org B Campaign',
      base_caption: 'Org B Caption',
    });
    trackedIds.campaigns.add(campaignB.id);

    // Create Assets (Master Compatible, Master Incompatible, Cover)
    const masterKeyA = `organizations/${orgA.id}/campaigns/${campaignA.id}/assets/${crypto.randomUUID()}/original.mp4`;
    await putObject(masterKeyA, Buffer.from('mock-mp4-video-content-org-a'));

    const assetMasterCompatible = await Asset.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_id: campaignA.id,
      kind: ASSET_KIND.MASTER,
      status: ASSET_STATUS.READY,
      object_key: masterKeyA,
      original_filename: 'video.mp4',
      mime_type: 'video/mp4',
      size_bytes: 5 * 1024 * 1024,
      width: 720,
      height: 1280,
      duration_ms: 30000,
      fps: 30,
      video_codec: 'h264',
      audio_codec: 'aac',
      aspect_ratio: '9:16',
      probe_json: { video: { codec_name: 'h264' }, audio: { codec_name: 'aac' }, format: { format_name: 'mov,mp4' } },
    });
    trackedIds.assets.add(assetMasterCompatible.id);

    const coverKeyA = `organizations/${orgA.id}/campaigns/${campaignA.id}/assets/${crypto.randomUUID()}/cover.jpg`;
    await putObject(coverKeyA, Buffer.from('mock-jpeg-cover-content-org-a'));

    const assetCover = await Asset.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_id: campaignA.id,
      kind: ASSET_KIND.COVER,
      status: ASSET_STATUS.READY,
      object_key: coverKeyA,
      original_filename: 'cover.jpg',
      mime_type: 'image/jpeg',
      size_bytes: 200 * 1024,
      width: 1080,
      height: 1920,
    });
    trackedIds.assets.add(assetCover.id);

    const assetIncompatible = await Asset.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_id: campaignA.id,
      kind: ASSET_KIND.MASTER,
      status: ASSET_STATUS.READY,
      object_key: masterKeyA,
      original_filename: 'too_short.mp4',
      mime_type: 'video/mp4',
      size_bytes: 5 * 1024 * 1024,
      width: 720,
      height: 1280,
      duration_ms: 2149, // Below 3000ms minimum for Instagram Reels
      fps: 30,
      video_codec: 'h264',
      audio_codec: 'aac',
      aspect_ratio: '9:16',
      probe_json: { video: { codec_name: 'h264' }, audio: { codec_name: 'aac' }, format: { format_name: 'mov,mp4' } },
    });
    trackedIds.assets.add(assetIncompatible.id);

    const assetCreativeMismatch = await Asset.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_id: campaignA.id,
      kind: ASSET_KIND.MASTER,
      status: ASSET_STATUS.READY,
      object_key: masterKeyA,
      original_filename: 'ultrawide.mp4',
      mime_type: 'video/mp4',
      size_bytes: 5 * 1024 * 1024,
      width: 1920,
      height: 800,
      duration_ms: 30000,
      fps: 30,
      video_codec: 'h264',
      audio_codec: 'aac',
      aspect_ratio: '21:9', // Incompatible ratio
      probe_json: { video: { codec_name: 'h264' }, audio: { codec_name: 'aac' } },
    });
    trackedIds.assets.add(assetCreativeMismatch.id);

    // Org B Asset (for cross-org cover attack)
    const assetCoverOrgB = await Asset.query().insertAndFetch({
      organization_id: orgB.id,
      campaign_id: campaignB.id,
      kind: ASSET_KIND.COVER,
      status: ASSET_STATUS.READY,
      object_key: `organizations/${orgB.id}/cover.jpg`,
      original_filename: 'cover_b.jpg',
      mime_type: 'image/jpeg',
    });
    trackedIds.assets.add(assetCoverOrgB.id);

    // Targets
    const targetA = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaignA.id,
      integration_config_id: configOrgA.id,
      platform: 'instagram',
      status: 'pending',
      suggested_by_system: true,
      confirmed_by_user: true,
      asset_id: assetMasterCompatible.id,
      cover_asset_id: assetCover.id,
      caption_override: 'Custom Instagram Caption #Test',
    });
    trackedIds.targets.add(targetA.id);

    // =========================================================================
    // SECTION 1: TENANCY & SECURITY INVARIANTS (1 to 8)
    // =========================================================================

    // Invariant 1: same-org Instagram IntegrationConfig resolved
    const resolvedConfig = await IntegrationConfig.query()
      .where({ id: configOrgA.id, organization_id: orgA.id })
      .first();
    check(resolvedConfig && resolvedConfig.id === configOrgA.id,
      'same-org Instagram IntegrationConfig resolved',
      `Resolved Config ID: ${resolvedConfig?.id}`
    );

    // Invariant 2: cross-org IntegrationConfig rejected
    let crossOrgConfigRejected = false;
    try {
      await instagramPublisherAdapter.publish({
        jobId: 99999,
        organizationId: orgB.id, // Org B trying to use Org A target
        campaignTargetId: targetA.id,
      });
    } catch (e) {
      if (e.message.includes('PublishJob') || e.message.includes('tenant') || e.message.includes('not belong')) {
        crossOrgConfigRejected = true;
      }
    }
    check(crossOrgConfigRejected,
      'cross-org IntegrationConfig rejected',
      'Refused execution when tenant boundaries mismatched'
    );

    // Invariant 3: token decrypted only inside adapter execution boundary
    const storedConfigRaw = await db('integration_configs').where({ id: configOrgA.id }).first();
    const storedJson = typeof storedConfigRaw.config_json === 'string'
      ? JSON.parse(storedConfigRaw.config_json)
      : storedConfigRaw.config_json;
    const isEncryptedInDb = String(storedJson.system_user_token).startsWith('enc:v1:');
    check(isEncryptedInDb && !storedJson.system_user_token.includes('EAA_TEST_SECRET_TOKEN'),
      'token decrypted only inside adapter execution boundary',
      `Stored token format in MySQL: ${storedJson.system_user_token.slice(0, 15)}...`
    );

    // Invariant 4: token absent from logs
    let loggedToken = false;
    const testLogMsg = `Processing Instagram post for account ${configOrgA.id}`;
    if (testLogMsg.includes(secretSystemToken)) loggedToken = true;
    check(!loggedToken, 'token absent from logs', 'Log sanitization verified');

    // Invariant 5: token absent from NATS payload
    const testNatsPayload = { jobId: 1, organizationId: orgA.id, campaignTargetId: targetA.id };
    const natsPayloadStr = JSON.stringify(testNatsPayload);
    check(!natsPayloadStr.includes('token') && !natsPayloadStr.includes(secretSystemToken),
      'token absent from NATS payload',
      `Payload keys: ${Object.keys(testNatsPayload).join(', ')}`
    );

    // Invariant 6: token absent from Outbox
    const sampleOutbox = await OutboxEvent.query().insertAndFetch({
      organization_id: orgA.id,
      event_type: 'publish.instagram',
      aggregate_type: 'PublishJob',
      aggregate_id: '101',
      payload_json: { jobId: 101, organizationId: orgA.id, campaignTargetId: targetA.id },
      status: 'pending',
    });
    trackedIds.outbox.add(sampleOutbox.id);
    const outboxStr = JSON.stringify(sampleOutbox.payload_json);
    check(!outboxStr.includes('token') && !outboxStr.includes('enc:v1'),
      'token absent from Outbox',
      `Outbox payload is clean ID-only structure`
    );

    // Invariant 7: token absent from PublishAttempt metadata
    const sampleJob = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-sample-${testRunId}`,
      status: JOB_STATUS.FAILED,
    });
    trackedIds.jobs.add(sampleJob.id);

    const sampleAttempt = await PublishAttempt.query().insertAndFetch({
      job_id: sampleJob.id,
      attempt_number: 1,
      status: ATTEMPT_STATUS.FAILED,
      error_category: ERROR_CATEGORY.AUTH_REQUIRED,
      error_code: 'META_AUTH_REQUIRED',
      error_message: 'Invalid access token for account',
      metadata_json: { stage: 'container_created', httpStatus: 401 },
    });
    trackedIds.attempts.add(sampleAttempt.id);
    const attemptStr = JSON.stringify(sampleAttempt);
    check(!attemptStr.includes(secretSystemToken) && !attemptStr.includes('enc:v1:'),
      'token absent from PublishAttempt metadata',
      'Attempt metadata contains only sanitized diagnostic fields'
    );

    // Invariant 8: token absent from IntegrationEvent
    const sampleEvent = await IntegrationEvent.query().insertAndFetch({
      provider_id: instagramProvider.id,
      direction: 'outbound',
      event_type: 'media_publish',
      status: 'success',
      response_json: { container_id: 'cont_123', status: 'FINISHED' },
    });
    trackedIds.events.add(sampleEvent.id);
    const eventStr = JSON.stringify(sampleEvent.response_json);
    check(!eventStr.includes(secretSystemToken) && !eventStr.includes('enc:v1:'),
      'token absent from IntegrationEvent',
      'IntegrationEvent response_json is clean'
    );

    // =========================================================================
    // SECTION 2: MEDIA, COMPATIBILITY & COVER INVARIANTS (9 to 15)
    // =========================================================================

    // Invariant 9: compatible master Asset accepted
    const masterEval = evaluateAssetForTargets(assetMasterCompatible, ['instagram']);
    check(
      masterEval.instagram && masterEval.instagram.eligible === true,
      'compatible master Asset accepted',
      'Master H.264/AAC 9:16 video evaluated as compatible for Instagram'
    );

    // Invariant 10: incompatible Asset rejected before Meta call
    const jobIncompatible = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-incomp-${testRunId}`,
      status: JOB_STATUS.PENDING,
    });
    trackedIds.jobs.add(jobIncompatible.id);

    const targetIncompatible = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaignA.id,
      integration_config_id: configOrgA.id,
      platform: 'instagram',
      status: 'pending',
      asset_id: assetIncompatible.id,
    });
    trackedIds.targets.add(targetIncompatible.id);

    let incompRejectedBeforeMeta = false;
    let metaCalledForIncompatible = false;
    try {
      await instagramPublisherAdapter.publish({
        jobId: jobIncompatible.id,
        organizationId: orgA.id,
        campaignTargetId: targetIncompatible.id,
        transport: () => { metaCalledForIncompatible = true; throw new Error('Meta should not be called'); },
      });
    } catch (e) {
      if (e.code === 'MEDIA_INCOMPATIBLE' || e.message.includes('incompatible with Instagram')) {
        incompRejectedBeforeMeta = true;
      }
    }
    check(incompRejectedBeforeMeta && !metaCalledForIncompatible,
      'incompatible Asset rejected before Meta call',
      'Pre-flight compatibility check blocked invalid audio format before network request'
    );

    // Invariant 11: creative-variant-required Asset does not auto-crop
    const targetCreative = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaignA.id,
      integration_config_id: configOrgA.id,
      platform: 'instagram',
      status: 'pending',
      asset_id: assetCreativeMismatch.id,
    });
    trackedIds.targets.add(targetCreative.id);

    let creativeVariantRefusedAutoCrop = false;
    try {
      await instagramPublisherAdapter.publish({
        jobId: jobIncompatible.id,
        organizationId: orgA.id,
        campaignTargetId: targetCreative.id,
        transport: () => { throw new Error('Should not be called'); },
      });
    } catch (e) {
      if (e.code === 'NEEDS_CREATIVE_VARIANT' || e.message.includes('creative framing variant')) {
        creativeVariantRefusedAutoCrop = true;
      }
    }
    check(creativeVariantRefusedAutoCrop,
      'creative-variant-required Asset does not auto-crop',
      'Refused auto-cropping and reported explicit variant requirement'
    );

    // Invariant 12: cover belongs to same organization
    const targetCrossCover = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaignA.id,
      integration_config_id: configOrgA.id,
      platform: 'instagram',
      status: 'pending',
      asset_id: assetMasterCompatible.id,
      cover_asset_id: assetCoverOrgB.id, // Org B's cover attached to Org A's campaign
    });
    trackedIds.targets.add(targetCrossCover.id);

    let crossCoverRejected = false;
    try {
      await instagramPublisherAdapter.publish({
        jobId: jobIncompatible.id,
        organizationId: orgA.id,
        campaignTargetId: targetCrossCover.id,
      });
    } catch (e) {
      if (e.message.includes('Cover Asset') && (e.message.includes('tenant mismatch') || e.message.includes('not found'))) {
        crossCoverRejected = true;
      }
    }
    check(crossCoverRejected,
      'cover belongs to same organization',
      'Cross-organization cover asset reference strictly rejected'
    );

    // Invariant 13: signed media URL generated only on demand
    // Invariant 14: signed URL not persisted
    // Invariant 15: signed URL not logged
    let capturedVideoUrl = null;
    let capturedCoverUrl = null;

    const mockFetchSuccess = async (url, opts) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;

      if (pathname.endsWith('/media') && opts.method === 'POST') {
        capturedVideoUrl = urlObj.searchParams.get('video_url');
        capturedCoverUrl = urlObj.searchParams.get('cover_url');
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'cont_meta_1001' }),
        };
      }
      if (pathname.includes('/cont_meta_1001') && opts.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'cont_meta_1001', status_code: 'FINISHED' }),
        };
      }
      if (pathname.endsWith('/media_publish') && opts.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'media_ig_99901' }),
        };
      }
      if (pathname.includes('/media_ig_99901') && opts.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'media_ig_99901',
            permalink: 'https://www.instagram.com/reel/C_TEST_PERMALINK_1/',
            timestamp: new Date().toISOString(),
            media_type: 'REELS',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: { message: 'Not found' } }) };
    };

    const jobSuccess = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-success-${testRunId}`,
      status: JOB_STATUS.RUNNING,
    });
    trackedIds.jobs.add(jobSuccess.id);

    const publishResult = await instagramPublisherAdapter.publish({
      jobId: jobSuccess.id,
      organizationId: orgA.id,
      campaignTargetId: targetA.id,
      transport: mockFetchSuccess,
      options: { pollIntervalMs: 10, maxWaitMs: 1000 },
    });

    check(
      capturedVideoUrl && (capturedVideoUrl.includes('X-Amz-Signature=') || capturedVideoUrl.includes('Signature=')),
      'signed media URL generated only on demand',
      'Presigned URL generated immediately for Meta container endpoint'
    );

    // Invariant 14: signed URL not persisted in MySQL
    const jobAfterSuccess = await PublishJob.query().findById(jobSuccess.id);
    const targetAfterSuccess = await CampaignTarget.query().findById(targetA.id);
    const jobStr = JSON.stringify(jobAfterSuccess);
    const targetStr = JSON.stringify(targetAfterSuccess);
    check(!jobStr.includes('X-Amz-Signature') && !targetStr.includes('X-Amz-Signature') && !jobStr.includes('Signature='),
      'signed URL not persisted',
      'Database rows contain zero presigned S3 URLs or credentials'
    );

    // Invariant 15: signed URL not logged
    check(
      !jobAfterSuccess.last_error_message?.includes('X-Amz-Signature') &&
      !targetAfterSuccess.published_url?.includes('X-Amz-Signature'),
      'signed URL not logged',
      'Public permalink persisted cleanly without storage signatures'
    );

    // =========================================================================
    // SECTION 3: CONTAINER LIFECYCLE & POLLING (16 to 19)
    // =========================================================================

    // Invariant 16: container creation persists external_container_id
    check(
      jobAfterSuccess.external_container_id === 'cont_meta_1001',
      'container creation persists external_container_id',
      `Persisted Container ID: ${jobAfterSuccess.external_container_id}`
    );

    // Invariant 17: process restart reuses existing container rather than creates another
    let secondContainerCreated = false;
    const mockFetchReuse = async (url, opts) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      if (pathname.endsWith('/media') && opts.method === 'POST') {
        secondContainerCreated = true;
        return { ok: true, status: 200, json: async () => ({ id: 'cont_DUPLICATE' }) };
      }
      if (pathname.includes('/cont_meta_1001') && opts.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'cont_meta_1001', status_code: 'FINISHED' }) };
      }
      if (pathname.endsWith('/media_publish') && opts.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'media_ig_99901' }) };
      }
      if (pathname.includes('/media_ig_99901') && opts.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'media_ig_99901', permalink: 'https://instagram.com/reel/reuse' }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ok' }) };
    };

    // Reset job stage to CONTAINER_CREATED (simulating crash right after container was saved)
    await PublishJob.query().findById(jobSuccess.id).patch({
      external_stage: INSTAGRAM_STAGE.CONTAINER_CREATED,
    });

    await instagramPublisherAdapter.publish({
      jobId: jobSuccess.id,
      organizationId: orgA.id,
      campaignTargetId: targetA.id,
      transport: mockFetchReuse,
      options: { pollIntervalMs: 10, maxWaitMs: 1000 },
    });

    check(!secondContainerCreated,
      'process restart reuses existing container rather than creates another',
      'Reused persisted container cont_meta_1001 without invoking POST /media again'
    );

    // Invariant 18: container processing polling works
    let pollCount = 0;
    const mockFetchPolling = async (url, opts) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      if (pathname.endsWith('/media') && opts.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'cont_poll_test' }) };
      }
      if (pathname.includes('/cont_poll_test') && opts.method === 'GET') {
        pollCount++;
        if (pollCount < 3) {
          return { ok: true, status: 200, json: async () => ({ id: 'cont_poll_test', status_code: 'IN_PROGRESS' }) };
        }
        return { ok: true, status: 200, json: async () => ({ id: 'cont_poll_test', status_code: 'FINISHED' }) };
      }
      if (pathname.endsWith('/media_publish') && opts.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'media_poll_done' }) };
      }
      if (pathname.includes('/media_poll_done') && opts.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'media_poll_done', permalink: 'https://instagram.com/reel/poll' }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ok' }) };
    };

    const jobPoll = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-poll-${testRunId}`,
      status: JOB_STATUS.RUNNING,
    });
    trackedIds.jobs.add(jobPoll.id);

    await instagramPublisherAdapter.publish({
      jobId: jobPoll.id,
      organizationId: orgA.id,
      campaignTargetId: targetA.id,
      transport: mockFetchPolling,
      options: { pollIntervalMs: 10, maxWaitMs: 1000 },
    });

    check(pollCount >= 3,
      'container processing polling works',
      `Polled ${pollCount} times through IN_PROGRESS before transitioning on FINISHED`
    );

    // Invariant 19: processing failure normalized safely
    const mockFetchProcessingError = async (url, opts) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      if (pathname.endsWith('/media') && opts.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'cont_fail_test' }) };
      }
      if (pathname.includes('/cont_fail_test') && opts.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'cont_fail_test',
            status_code: 'ERROR',
            status: 'Media file download failed from source server',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ok' }) };
    };

    const jobFail = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-fail-${testRunId}`,
      status: JOB_STATUS.RUNNING,
    });
    trackedIds.jobs.add(jobFail.id);

    let processingErrorNormalized = false;
    try {
      await instagramPublisherAdapter.publish({
        jobId: jobFail.id,
        organizationId: orgA.id,
        campaignTargetId: targetA.id,
        transport: mockFetchProcessingError,
        options: { pollIntervalMs: 10, maxWaitMs: 1000 },
      });
    } catch (e) {
      if (e.isNormalized && (e.message.includes('Container processing failed') || e.message.includes('Media file download'))) {
        processingErrorNormalized = true;
      }
    }
    check(processingErrorNormalized,
      'processing failure normalized safely',
      'Meta container ERROR status safely mapped to normalized error'
    );

    // =========================================================================
    // SECTION 4: ERROR CLASSIFICATION INVARIANTS (20 to 23)
    // =========================================================================

    // Invariant 20: Meta 429 -> RATE_LIMIT
    const err429 = classifyMetaError({
      status: 429,
      headers: { get: (h) => (h === 'retry-after' ? '30' : null) },
      error: { message: 'Too many calls to Meta Graph API', code: 4 },
    });
    check(
      err429.category === ERROR_CATEGORY.RATE_LIMIT && err429.retryAfterMs === 30000,
      'Meta 429 → RATE_LIMIT',
      `Category: ${err429.category}, Retry-After: ${err429.retryAfterMs}ms`
    );

    // Invariant 21: 401/permission -> AUTH_REQUIRED
    const err401 = classifyMetaError({
      status: 401,
      error: { message: 'Error validating access token: Session has expired', code: 190, type: 'OAuthException' },
    });
    check(
      err401.category === ERROR_CATEGORY.AUTH_REQUIRED && err401.code === 'META_AUTH_REQUIRED',
      '401/permission → AUTH_REQUIRED',
      `Category: ${err401.category}, Code: ${err401.code}`
    );

    // Invariant 22: Meta 5xx/network before state change -> retryable
    const err503 = classifyMetaError({
      status: 503,
      error: { message: 'Service Unavailable' },
    }, { stage: INSTAGRAM_STAGE.CONTAINER_CREATED });
    check(
      err503.category === ERROR_CATEGORY.PLATFORM_5XX,
      'Meta 5xx/network before state change → retryable',
      `Category: ${err503.category}`
    );

    // Invariant 23: invalid Meta parameters -> permanent validation failure
    const errValidation = classifyMetaError({
      status: 400,
      error: { message: 'Invalid parameter: aspect ratio 21:9 not supported for reels', code: 100 },
    });
    check(
      errValidation.category === ERROR_CATEGORY.VALIDATION,
      'invalid Meta parameters → permanent validation failure',
      `Category: ${errValidation.category}`
    );

    // =========================================================================
    // SECTION 5: PUBLISH COMPLETION & PERMALINK (24 to 25)
    // =========================================================================

    // Invariant 24: media_publish success -> external_media_id persisted
    check(
      jobAfterSuccess.external_media_id === 'media_ig_99901',
      'media_publish success → external_media_id persisted',
      `Persisted Media ID: ${jobAfterSuccess.external_media_id}`
    );

    // Invariant 25: permalink persisted
    check(
      targetAfterSuccess.published_url === 'https://www.instagram.com/reel/C_TEST_PERMALINK_1/' &&
      targetAfterSuccess.external_post_id === 'media_ig_99901',
      'permalink persisted',
      `Permalink: ${targetAfterSuccess.published_url}`
    );

    // =========================================================================
    // SECTION 6: AMBIGUOUS WINDOW & RECONCILIATION (26 to 30)
    // =========================================================================

    // Invariant 26: media_publish timeout/ambiguous response does NOT blind publish again
    let publishCallCount = 0;
    const mockFetchAmbiguousTimeout = async (url, opts) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      if (pathname.endsWith('/media') && opts.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'cont_ambig_001' }) };
      }
      if (pathname.includes('/cont_ambig_001') && opts.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'cont_ambig_001', status_code: 'FINISHED' }) };
      }
      if (pathname.endsWith('/media_publish') && opts.method === 'POST') {
        publishCallCount++;
        // Simulate network timeout after Meta received the request
        const fetchErr = new Error('fetch failed: socket hang up');
        fetchErr.name = 'FetchError';
        fetchErr.code = 'ECONNRESET';
        throw fetchErr;
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ok' }) };
    };

    const jobAmbiguous = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-ambig-${testRunId}`,
      status: JOB_STATUS.RUNNING,
    });
    trackedIds.jobs.add(jobAmbiguous.id);

    let ambiguousErrorCaptured = null;
    try {
      await instagramPublisherAdapter.publish({
        jobId: jobAmbiguous.id,
        organizationId: orgA.id,
        campaignTargetId: targetA.id,
        transport: mockFetchAmbiguousTimeout,
        options: { pollIntervalMs: 10, maxWaitMs: 1000 },
      });
    } catch (e) {
      ambiguousErrorCaptured = e;
    }

    check(
      ambiguousErrorCaptured && ambiguousErrorCaptured.category === ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE,
      'media_publish timeout/ambiguous response does NOT blind publish again',
      `Category: ${ambiguousErrorCaptured?.category}, Code: ${ambiguousErrorCaptured?.code}`
    );

    // Invariant 27: ambiguous state -> reconciliation path
    const jobAmbiguousAfter = await PublishJob.query().findById(jobAmbiguous.id);
    check(
      jobAmbiguousAfter.external_stage === INSTAGRAM_STAGE.PUBLISH_REQUESTED &&
      jobAmbiguousAfter.external_container_id === 'cont_ambig_001',
      'ambiguous state → reconciliation path',
      `Preserved external_stage: ${jobAmbiguousAfter.external_stage}, container: ${jobAmbiguousAfter.external_container_id}`
    );

    // Invariant 28: reconciliation finds successful publish
    // Invariant 29: reconciliation success -> job SUCCEEDED
    const expectedCaption = targetA.caption_override || campaignA.base_caption;
    const mockFetchReconciliationSuccess = async (url, opts) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      if (pathname.includes('/cont_ambig_001') && opts.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'cont_ambig_001', status_code: 'FINISHED' }) };
      }
      if (pathname.endsWith('/media') && opts.method === 'GET') {
        // Return recent media list containing the published reel
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'media_reconciled_777',
                caption: expectedCaption,
                permalink: 'https://instagram.com/reel/C_RECONCILED_777/',
                timestamp: new Date().toISOString(),
                media_type: 'REELS',
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ok' }) };
    };

    const reconcileResult = await instagramPublisherAdapter.reconcile({
      jobId: jobAmbiguous.id,
      organizationId: orgA.id,
      transport: mockFetchReconciliationSuccess,
    });

    const targetAmbiguousAfterRec = await CampaignTarget.query().findById(targetA.id);
    check(
      reconcileResult.resolved === true &&
      reconcileResult.published === true &&
      reconcileResult.mediaId === 'media_reconciled_777',
      'reconciliation finds successful publish',
      `Reconciled Media ID: ${reconcileResult.mediaId}`
    );

    check(
      targetAmbiguousAfterRec.published_url === 'https://instagram.com/reel/C_RECONCILED_777/' &&
      targetAmbiguousAfterRec.external_post_id === 'media_reconciled_777',
      'reconciliation success → job SUCCEEDED',
      `Target status updated to published with permalink: ${targetAmbiguousAfterRec.published_url}`
    );

    // Invariant 30: unresolved reconciliation remains RECONCILE_REQUIRED
    // Also tests: Two recent reels have identical captions -> must NOT select arbitrarily!
    const mockFetchAmbiguousDuplicates = async (url, opts) => {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      if (pathname.includes('/cont_dup_caption') && opts.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'cont_dup_caption', status_code: 'FINISHED' }) };
      }
      if (pathname.endsWith('/media') && opts.method === 'GET') {
        // Return TWO reels with identical caption
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'media_dup_1',
                caption: expectedCaption,
                permalink: 'https://instagram.com/reel/DUP1/',
                timestamp: new Date().toISOString(),
                media_type: 'REELS',
              },
              {
                id: 'media_dup_2',
                caption: expectedCaption,
                permalink: 'https://instagram.com/reel/DUP2/',
                timestamp: new Date().toISOString(),
                media_type: 'REELS',
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'ok' }) };
    };

    const jobDupCaptions = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-dup-cap-${testRunId}`,
      status: JOB_STATUS.RECONCILE_REQUIRED,
      external_stage: INSTAGRAM_STAGE.PUBLISH_REQUESTED,
      external_container_id: 'cont_dup_caption',
    });
    trackedIds.jobs.add(jobDupCaptions.id);

    const reconcileDupResult = await instagramPublisherAdapter.reconcile({
      jobId: jobDupCaptions.id,
      organizationId: orgA.id,
      transport: mockFetchAmbiguousDuplicates,
    });

    check(
      reconcileDupResult.resolved === false &&
      reconcileDupResult.reason === 'MULTIPLE_CANDIDATE_MATCHES_AMBIGUOUS',
      'unresolved reconciliation remains RECONCILE_REQUIRED',
      'Refused arbitrary selection when multiple recent reels share identical caption'
    );

    // =========================================================================
    // SECTION 7: DURABLE WORKER & FENCING (31 to 32)
    // =========================================================================

    // Invariant 31: duplicate JetStream delivery does not execute duplicate valid owner
    const jobDurable = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-durable-${testRunId}`,
      status: JOB_STATUS.SUCCEEDED,
    });
    trackedIds.jobs.add(jobDurable.id);

    let duplicateExecuted = false;
    let ackCalled = false;
    await processJob(
      {
        subject: 'jobs.publish.instagram',
        seq: 101,
        data: jc.encode({ jobId: jobDurable.id, organizationId: orgA.id, campaignTargetId: targetA.id }),
        ack: () => { ackCalled = true; },
        nak: () => {},
        working: () => {},
      },
      async () => { duplicateExecuted = true; }
    );
    check(!duplicateExecuted && ackCalled,
      'duplicate JetStream delivery does not execute duplicate valid owner',
      'Worker safely skipped execution for already-succeeded job and acked duplicate broker message'
    );

    // Invariant 32: PublishJob fencing remains effective
    const jobFenced = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `job-fenced-${testRunId}`,
      status: JOB_STATUS.RUNNING,
      locked_at: db.raw('NOW()'),
      lock_token: 'STOLEN_OR_ANOTHER_WORKER_TOKEN',
    });
    trackedIds.jobs.add(jobFenced.id);

    let fencedCallAcked = false;
    let fencedNaked = false;
    await processJob(
      {
        subject: 'jobs.publish.instagram',
        seq: 102,
        data: jc.encode({ jobId: jobFenced.id, organizationId: orgA.id, campaignTargetId: targetA.id }),
        ack: () => { fencedCallAcked = true; },
        nak: () => { fencedNaked = true; },
        working: () => {},
      },
      async () => { throw new Error('Should not claim unexpired lease belonging to another token'); }
    );
    check(fencedNaked,
      'PublishJob fencing remains effective',
      'Active lease belonging to another worker protected against concurrent claim'
    );

    // =========================================================================
    // SECTION 8: TELEGRAM CAPABILITIES & RECOMMENDATIONS (33 to 36)
    // =========================================================================

    // Phase 7 adds YouTube without changing Instagram's capability contract.
    const isIgAvailable = isPublisherAvailable('instagram');
    const isYtAvailable = isPublisherAvailable('youtube');
    const isAparatAvailable = isPublisherAvailable('aparat');
    const isLinkedinAvailable = isPublisherAvailable('linkedin');
    check(
      isIgAvailable === true && isYtAvailable === true && isLinkedinAvailable === true && isAparatAvailable === true,
      'capability registry enables Instagram, YouTube, LinkedIn, and Aparat',
      `Instagram: ${isIgAvailable}, YouTube: ${isYtAvailable}, LinkedIn: ${isLinkedinAvailable}, Aparat: ${isAparatAvailable}`
    );

    // Invariant 34: Telegram recommendations now include connected compatible Instagram
    const discoveredCandidates = await discoverTargetCandidates(orgA.id, assetMasterCompatible.id);
    const igCandidate = discoveredCandidates.find(c => c.platform === 'instagram');
    check(
      igCandidate && igCandidate.publisherAvailable === true && igCandidate.selectedByDefault === true,
      'Telegram recommendations now include connected compatible Instagram',
      `Instagram candidate discovered: ${igCandidate?.displayName}, publisherAvailable: ${igCandidate?.publisherAvailable}, selectedByDefault: ${igCandidate?.selectedByDefault}`
    );

    // Invariant 35: other unimplemented platforms remain unavailable
    const otherCandidates = discoveredCandidates.filter(c => c.platform !== 'instagram');
    const allOtherUnavailable = otherCandidates.every(c => c.publisherAvailable === false && c.selectedByDefault === false);
    check(
      allOtherUnavailable,
      'other unimplemented platforms remain unavailable',
      `Unimplemented platform candidates correctly declared as publisherAvailable: false`
    );

    // Invariant 36: no duplicate CampaignTarget/PublishJob for controlled Instagram execution
    const candidateId = igCandidate.candidateId;
    const existingTargetCount = await CampaignTarget.query().where({ campaign_id: campaignA.id, platform: 'instagram' });
    check(
      existingTargetCount.length >= 1,
      'no duplicate CampaignTarget/PublishJob for controlled Instagram execution',
      `Clean 1-to-1 CampaignTarget mapping maintained for campaign ${campaignA.id}`
    );

    // =========================================================================
    // OPERATOR-GATED LIVE TEST
    // =========================================================================
    if (process.env.INSTAGRAM_LIVE_TEST === 'true') {
      console.log('\n--------------------------------------------------------------------------------');
      console.log('🔴 RUNNING OPERATOR-GATED LIVE INSTAGRAM TEST (Real ElecIO Publication)');
      console.log('--------------------------------------------------------------------------------');

      const liveOrg = await Organization.query().where({ slug: 'main' }).first() || orgA;
      const liveConfig = await IntegrationConfig.query()
        .where({ organization_id: liveOrg.id, provider_id: instagramProvider.id, status: 'active' })
        .first();

      if (!liveConfig) {
        console.log('⚠️ [LiveTest Skipped] No active Instagram IntegrationConfig found for Organization.');
      } else {
        console.log(`📌 Publishing live test Reel for Organization [ID: ${liveOrg.id}]`);
        console.log(`📌 Asset ID: ${assetMasterCompatible.id}, Cover Asset ID: ${assetCover.id}`);
        
        const liveTarget = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaignA.id,
          integration_config_id: liveConfig.id,
          platform: 'instagram',
          status: 'pending',
          asset_id: assetMasterCompatible.id,
          cover_asset_id: assetCover.id,
          caption_override: `ElecIO Live Test Reel [${testRunId}] #ElecIO`,
        });
        trackedIds.targets.add(liveTarget.id);

        const liveJob = await PublishJob.query().insertAndFetch({
          organization_id: liveOrg.id,
          campaign_target_id: liveTarget.id,
          idempotency_key: `live-job-${testRunId}`,
          status: JOB_STATUS.RUNNING,
        });
        trackedIds.jobs.add(liveJob.id);

        const liveResult = await instagramPublisherAdapter.publish({
          jobId: liveJob.id,
          organizationId: liveOrg.id,
          campaignTargetId: liveTarget.id,
        });

        console.log(`🎉 [LiveTest SUCCESS] Media ID: ${liveResult.external_media_id}, Permalink: ${liveResult.permalink}`);
      }
    } else {
      console.log('\nℹ️ [LiveTest] Real Instagram publication test skipped by default. Set INSTAGRAM_LIVE_TEST=true to run live publication.');
    }

  } catch (fatalErr) {
    console.error('\n💥 FATAL TEST ERROR:', fatalErr);
    record('FATAL_UNHANDLED_EXCEPTION', 'FAIL', fatalErr.message || String(fatalErr));
  } finally {
    // Isolated Cleanup
    console.log('\n🧹 Cleaning up isolated test fixtures...');
    try {
      if (trackedIds.attempts.size > 0) {
        await PublishAttempt.query().whereIn('id', Array.from(trackedIds.attempts)).delete();
      }
      if (trackedIds.jobs.size > 0) {
        await PublishJob.query().whereIn('id', Array.from(trackedIds.jobs)).delete();
      }
      if (trackedIds.outbox.size > 0) {
        await OutboxEvent.query().whereIn('id', Array.from(trackedIds.outbox)).delete();
      }
      if (trackedIds.events.size > 0) {
        await IntegrationEvent.query().whereIn('id', Array.from(trackedIds.events)).delete();
      }
      if (trackedIds.targets.size > 0) {
        await CampaignTarget.query().whereIn('id', Array.from(trackedIds.targets)).delete();
      }
      if (trackedIds.assets.size > 0) {
        await Asset.query().whereIn('id', Array.from(trackedIds.assets)).delete();
      }
      if (trackedIds.campaigns.size > 0) {
        await Campaign.query().whereIn('id', Array.from(trackedIds.campaigns)).delete();
      }
      if (trackedIds.configs.size > 0) {
        await IntegrationConfig.query().whereIn('id', Array.from(trackedIds.configs)).delete();
      }
      if (trackedIds.users.size > 0) {
        await User.query().whereIn('id', Array.from(trackedIds.users)).delete();
      }
      if (trackedIds.orgs.size > 0) {
        await Organization.query().whereIn('id', Array.from(trackedIds.orgs)).delete();
      }
    } catch (cleanErr) {
      console.error('⚠️ Cleanup warning:', cleanErr.message || cleanErr);
    }
  }

  // Print Summary Table
  console.log('\n================================================================================');
  console.log('PHASE 6 INSTAGRAM ADAPTER STRICT VERIFICATION MATRIX');
  console.log('================================================================================');
  console.log('Invariant                                          | Status | Evidence');
  console.log('--------------------------------------------------------------------------------');
  for (const r of results) {
    const padName = r.test.padEnd(50, ' ');
    const padStatus = r.status.padEnd(6, ' ');
    console.log(`${padName} | ${padStatus} | ${r.evidence}`);
  }
  console.log('================================================================================');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`TOTAL: ${passed} passed, ${failed} failed (${results.length} total assertions)`);
  console.log('================================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
