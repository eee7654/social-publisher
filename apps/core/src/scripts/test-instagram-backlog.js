import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();

import Organization from '../db/models/core/Organization.js';
import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import Campaign from '../db/models/core/Campaign.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import PublishJob from '../db/models/core/PublishJob.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { createOutboxEvent } from '../publisher/outbox.js';
import { startWorker } from '../publisher/worker.js';
import { OUTBOX_STATUS, JOB_STATUS } from '../publisher/constants.js';

const results = [];
const testRunId = Math.random().toString(36).substring(2, 9);
const SUBJECT = `jobs.publish.test_backlog_${testRunId}`;
const CONSUMER_NAME = `WORKER_BACKLOG_${testRunId.toUpperCase()}`;

function record(name, status, evidence = 'OK') {
  results.push({ test: name, status, evidence });
  console.log(`  ${status === 'PASS' ? '✅' : '❌'} ${name} -> ${evidence}`);
}

function check(condition, name, evidence) {
  if (condition) record(name, 'PASS', evidence);
  else record(name, 'FAIL', evidence);
}

const trackedIds = {
  orgs: new Set(),
  providers: new Set(),
  configs: new Set(),
  campaigns: new Set(),
  targets: new Set(),
  jobs: new Set(),
  outbox: new Set(),
};

async function cleanup(jsm) {
  console.log('\n🧹 Cleaning up isolated test fixtures & consumer...');
  try {
    if (jsm) {
      await jsm.consumers.delete('ELECIO_JOBS', CONSUMER_NAME).catch(() => {});
    }
    if (trackedIds.outbox.size > 0) {
      await OutboxEvent.query().whereIn('id', Array.from(trackedIds.outbox)).delete();
    }
    if (trackedIds.jobs.size > 0) {
      await PublishJob.query().whereIn('id', Array.from(trackedIds.jobs)).delete();
    }
    if (trackedIds.targets.size > 0) {
      await CampaignTarget.query().whereIn('id', Array.from(trackedIds.targets)).delete();
    }
    if (trackedIds.campaigns.size > 0) {
      await Campaign.query().whereIn('id', Array.from(trackedIds.campaigns)).delete();
    }
    if (trackedIds.configs.size > 0) {
      await IntegrationConfig.query().whereIn('id', Array.from(trackedIds.configs)).delete();
    }
    if (trackedIds.providers.size > 0) {
      await IntegrationProvider.query().whereIn('id', Array.from(trackedIds.providers)).delete();
    }
    if (trackedIds.orgs.size > 0) {
      await Organization.query().whereIn('id', Array.from(trackedIds.orgs)).delete();
    }
  } catch (err) {
    console.error('Fixture cleanup error:', err.message);
  }
}

async function runTests() {
  console.log(`🚀 Starting Phase 6 Instagram Durable Backlog Delivery Test Suite (Run: ${testRunId})`);

  let jsm = null;
  let js = null;

  try {
    const jetstream = await initJetStream();
    js = jetstream.js;
    jsm = jetstream.jsm;

    // 1. Setup isolated Organization
    const org = await Organization.query().insertAndFetch({
      name: `Org Backlog (${testRunId})`,
      slug: `org-backlog-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(org.id);

    const provider = await IntegrationProvider.query().insertAndFetch({
      domain: 'publishing',
      code: `instagram_${testRunId}`,
      display_name: 'Instagram Test',
      adapter_key: 'publishing.instagram',
      is_enabled: true,
    });
    trackedIds.providers.add(provider.id);

    const config = await IntegrationConfig.query().insertAndFetch({
      organization_id: org.id,
      provider_id: provider.id,
      name: `Instagram Backlog (${testRunId})`,
      config_json: { instagram_user_id: '17841472834822420', username: 'test_user' },
      status: 'active',
    });
    trackedIds.configs.add(config.id);

    const campaign = await Campaign.query().insertAndFetch({
      organization_id: org.id,
      source_type: 'telegram_private',
      status: 'ready',
      base_title: 'Test Backlog Delivery',
    });
    trackedIds.campaigns.add(campaign.id);

    const target = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaign.id,
      integration_config_id: config.id,
      platform: 'instagram',
      status: 'pending',
      settings_json: {},
    });
    trackedIds.targets.add(target.id);

    // 2. Create PublishJob in QUEUED status
    const [jobId] = await db('publish_jobs').insert({
      campaign_target_id: target.id,
      organization_id: org.id,
      idempotency_key: `backlog-ig-${testRunId}`,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    trackedIds.jobs.add(jobId);

    // ==========================================================
    // Step 1: Publish message to ELECIO_JOBS while worker DOES NOT exist
    // ==========================================================
    console.log('\n[Step 1] Publishing message to ELECIO_JOBS before consumer exists...');
    const payload = {
      jobId,
      organizationId: org.id,
      campaignTargetId: target.id,
    };

    const pubAck = await js.publish(
      SUBJECT,
      new TextEncoder().encode(JSON.stringify(payload)),
      { msgID: `msg-backlog-${testRunId}` }
    );
    console.log(`  Published stream sequence: ${pubAck.seq}, duplicate: ${pubAck.duplicate}`);

    // Verify consumer does NOT exist yet
    let consumerExists = true;
    try {
      await jsm.consumers.info('ELECIO_JOBS', CONSUMER_NAME);
    } catch (e) {
      consumerExists = false;
    }
    check(!consumerExists, 'consumer does not exist when message was published', `Consumer: ${CONSUMER_NAME}`);

    // ==========================================================
    // Step 2 & 3: Start/Create durable worker afterward & assert delivery
    // ==========================================================
    console.log('\n[Step 2 & 3] Starting worker and asserting backlog delivery...');
    let deliveredMessages = [];
    const abortCtrl = new AbortController();

    const mockHandler = async (context) => {
      console.log(`  [Handler] Received backlog payload for Job ID: ${context.jobId}`);
      deliveredMessages.push(context);
      abortCtrl.abort(); // Stop worker after processing
    };

    await startWorker(SUBJECT, CONSUMER_NAME, mockHandler, {
      signal: abortCtrl.signal,
      lockTimeoutMs: 5000,
    });

    const claimedJob = await PublishJob.query().findById(jobId);

    check(
      deliveredMessages.length === 1 && deliveredMessages[0].jobId === jobId,
      'previously published backlog message is delivered to newly started durable worker',
      `Delivered count: ${deliveredMessages.length}, Job ID: ${deliveredMessages[0]?.jobId}`
    );

    check(
      claimedJob.status === 'succeeded',
      'worker successfully claims and transitions the corresponding QUEUED PublishJob',
      `Job status: ${claimedJob?.status}`
    );

    // ==========================================================
    // Step 4 & 5: Restart worker and verify already-ACKed message is NOT replayed
    // ==========================================================
    console.log('\n[Step 4 & 5] Restarting worker to assert no replay of ACKed message...');
    let replayedMessages = [];
    const abortCtrl2 = new AbortController();

    const mockHandler2 = async (context) => {
      replayedMessages.push(context);
    };

    // Run second worker instance for 1000ms
    const workerPromise = startWorker(SUBJECT, CONSUMER_NAME, mockHandler2, {
      signal: abortCtrl2.signal,
      lockTimeoutMs: 5000,
    });

    await new Promise(r => setTimeout(r, 1000));
    abortCtrl2.abort();
    await workerPromise.catch(() => {});

    check(
      replayedMessages.length === 0,
      'restart worker and verify already-ACKed message is not replayed',
      `Replayed count: ${replayedMessages.length}`
    );

  } catch (err) {
    console.error('💥 Test suite failure:', err);
    record('test_suite_execution', 'FAIL', err.message);
  } finally {
    await cleanup(jsm);
    await db.destroy();
  }

  console.log('\n================================================================================');
  console.log('INSTAGRAM DURABLE BACKLOG DELIVERY VERIFICATION MATRIX');
  console.log('================================================================================');
  console.table(results);
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`TOTAL: ${passed} passed, ${failed} failed (${results.length} total assertions)`);
  console.log('================================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
