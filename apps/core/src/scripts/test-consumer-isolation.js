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
import { startWorker } from '../publisher/worker.js';

const results = [];
const testRunId = Math.random().toString(36).substring(2, 9);
const LIVE_SUBJECT = 'jobs.publish.instagram';
const LIVE_CONSUMER_NAME = 'WORKER_PUBLISH_INSTAGRAM';

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
  testConsumers: new Set(),
};

async function cleanup(jsm) {
  console.log('\n🧹 Cleaning up test fixtures & isolated test consumers...');
  try {
    if (jsm) {
      for (const cName of trackedIds.testConsumers) {
        await jsm.consumers.delete('ELECIO_JOBS', cName).catch(() => {});
      }
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
  console.log(`🚀 Starting Phase 6 JetStream Consumer Isolation Regression Suite (Run: ${testRunId})`);

  let jsm = null;
  let js = null;

  try {
    const jetstream = await initJetStream();
    js = jetstream.js;
    jsm = jetstream.jsm;

    // Ensure the live durable consumer exists in JetStream
    try {
      await jsm.consumers.info('ELECIO_JOBS', LIVE_CONSUMER_NAME);
    } catch (err) {
      await jsm.consumers.add('ELECIO_JOBS', {
        durable_name: LIVE_CONSUMER_NAME,
        ack_policy: 'explicit',
        deliver_policy: 'all',
        filter_subject: LIVE_SUBJECT,
        max_deliver: 10,
        ack_wait: 30 * 1000000000,
      });
    }

    const liveConsumerBefore = await jsm.consumers.info('ELECIO_JOBS', LIVE_CONSUMER_NAME);
    const initialAckFloor = liveConsumerBefore.ack_floor.stream_seq;

    // 1. Verify isolated test consumer creation does NOT alter live consumer
    const testConsumerName = `TEST_ISOLATION_${testRunId.toUpperCase()}`;
    const testSubject = `jobs.publish.test_iso_${testRunId}`;
    trackedIds.testConsumers.add(testConsumerName);

    await jsm.consumers.add('ELECIO_JOBS', {
      durable_name: testConsumerName,
      ack_policy: 'explicit',
      deliver_policy: 'all',
      filter_subject: testSubject,
      max_deliver: 5,
      ack_wait: 1000 * 1000000,
    });

    const liveConsumerAfterTestAdd = await jsm.consumers.info('ELECIO_JOBS', LIVE_CONSUMER_NAME);
    check(
      liveConsumerAfterTestAdd.ack_floor.stream_seq === initialAckFloor &&
      liveConsumerAfterTestAdd.config.durable_name === LIVE_CONSUMER_NAME,
      'test consumers use unique durable names and do not mutate live consumer config',
      `Live Consumer: ${LIVE_CONSUMER_NAME}, Test Consumer: ${testConsumerName}`
    );

    // 2. Setup isolated DB test fixture
    const org = await Organization.query().insertAndFetch({
      name: `Org Iso (${testRunId})`,
      slug: `org-iso-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(org.id);

    const provider = await IntegrationProvider.query().insertAndFetch({
      domain: 'publishing',
      code: `instagram_iso_${testRunId}`,
      display_name: 'Instagram Test Iso',
      adapter_key: 'publishing.instagram',
      is_enabled: true,
    });
    trackedIds.providers.add(provider.id);

    const config = await IntegrationConfig.query().insertAndFetch({
      organization_id: org.id,
      provider_id: provider.id,
      name: `Instagram Iso (${testRunId})`,
      config_json: { instagram_user_id: '17841472834822420', username: 'test_user' },
      status: 'active',
    });
    trackedIds.configs.add(config.id);

    const campaign = await Campaign.query().insertAndFetch({
      organization_id: org.id,
      source_type: 'telegram_private',
      status: 'ready',
      base_title: 'Test Isolation Campaign',
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

    const [jobId] = await db('publish_jobs').insert({
      campaign_target_id: target.id,
      organization_id: org.id,
      idempotency_key: `iso-ig-${testRunId}`,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    trackedIds.jobs.add(jobId);

    // 3. Publish message to test subject while worker is offline
    const testPayload = { jobId, organizationId: org.id, campaignTargetId: target.id };
    const pubAck = await js.publish(
      testSubject,
      new TextEncoder().encode(JSON.stringify(testPayload)),
      { msgID: `msg-iso-${testRunId}` }
    );

    check(
      pubAck.seq > 0,
      'a message published while worker is offline remains deliverable on stream',
      `Published seq: ${pubAck.seq}`
    );

    // 4. Start worker and verify message delivery
    let processed = false;
    const abortCtrl = new AbortController();
    const mockHandler = async (ctx) => {
      processed = ctx.jobId === jobId;
      abortCtrl.abort();
    };

    await startWorker(testSubject, testConsumerName, mockHandler, {
      signal: abortCtrl.signal,
      lockTimeoutMs: 5000,
    });

    check(
      processed,
      'starting worker later receives the offline-published backlog message',
      `Processed Job ID: ${jobId}`
    );

    // 5. Verify ACK advances only the test consumer, NOT the live consumer
    const testConsumerInfo = await jsm.consumers.info('ELECIO_JOBS', testConsumerName);
    const liveConsumerAfterAck = await jsm.consumers.info('ELECIO_JOBS', LIVE_CONSUMER_NAME);

    check(
      testConsumerInfo.num_ack_pending === 0 &&
      liveConsumerAfterAck.ack_floor.stream_seq === initialAckFloor,
      'ACK advances only the test consumer without altering live consumer ack floor',
      `Test ack floor: ${testConsumerInfo.ack_floor.stream_seq}, Live ack floor: ${liveConsumerAfterAck.ack_floor.stream_seq}`
    );

    // 6. Verify restart does NOT replay acknowledged message
    let replayed = false;
    const abortCtrl2 = new AbortController();
    const mockHandler2 = async () => { replayed = true; };

    const restartPromise = startWorker(testSubject, testConsumerName, mockHandler2, {
      signal: abortCtrl2.signal,
      lockTimeoutMs: 5000,
    });

    await new Promise(r => setTimeout(r, 600));
    abortCtrl2.abort();
    await restartPromise.catch(() => {});

    check(
      !replayed,
      'restart does not replay acknowledged messages',
      `Replayed: ${replayed}`
    );

  } catch (err) {
    console.error('💥 Test suite failure:', err);
    record('test_suite_execution', 'FAIL', err.message);
  } finally {
    await cleanup(jsm);
    await db.destroy();
  }

  console.log('\n================================================================================');
  console.log('JETSTREAM CONSUMER ISOLATION VERIFICATION MATRIX');
  console.log('================================================================================');
  console.table(results);
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`TOTAL: ${passed} passed, ${failed} failed (${results.length} total assertions)`);
  console.log('================================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
