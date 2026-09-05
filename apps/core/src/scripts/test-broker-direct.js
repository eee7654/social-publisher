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
import PublishAttempt from '../db/models/core/PublishAttempt.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { startWorker } from '../publisher/worker.js';
import { JSONCodec } from 'nats';

const jc = JSONCodec();

async function runTest() {
  const jetstream = await initJetStream();
  const jsm = jetstream.jsm;
  const js = jetstream.js;

  console.log('\n==================================================');
  console.log('TEST A: ISOLATED DIAGNOSTIC SUBJECT/CONSUMER');
  console.log('==================================================');
  const testSub = 'jobs.publish.diag';
  const testCons = 'WORKER_DIAG';

  // cleanup previous
  await jsm.consumers.delete('ELECIO_JOBS', testCons).catch(() => {});
  
  let handlerStubInvoked = false;
  
  const ac1 = new AbortController();
  const w1 = startWorker(testSub, testCons, async (ctx) => {
    console.log('[Test] Handler stub invoked for test subject');
    handlerStubInvoked = true;
    ac1.abort();
  }, { signal: ac1.signal });

  // Wait a bit for consumer to bind
  await new Promise(r => setTimeout(r, 1000));
  
  console.log('[Test] Publishing ID-only message to', testSub);
  const pubAck1 = await js.publish(testSub, jc.encode({ jobId: 99999, organizationId: 99, campaignTargetId: 99 }));
  console.log('[Test] PubAck:', pubAck1.seq);
  
  await w1.catch(() => {});
  console.log('[Test] handlerStubInvoked:', handlerStubInvoked);

  console.log('\n==================================================');
  console.log('TEST B: REAL INSTAGRAM SUBJECT WITH FIXTURE JOB');
  console.log('==================================================');

  // Create a database fixture job
  const org = await Organization.query().insertAndFetch({ name: 'Diag Org', slug: 'diag-org', is_active: true });
  const provider = await IntegrationProvider.query().insertAndFetch({ domain: 'publishing', code: 'ig_diag', display_name: 'IG Diag', adapter_key: 'publishing.instagram', is_enabled: true });
  const config = await IntegrationConfig.query().insertAndFetch({ organization_id: org.id, provider_id: provider.id, name: 'Config', config_json: {}, status: 'active' });
  const campaign = await Campaign.query().insertAndFetch({ organization_id: org.id, source_type: 'telegram_private', status: 'ready', base_title: 'Diag' });
  const target = await CampaignTarget.query().insertAndFetch({ campaign_id: campaign.id, integration_config_id: config.id, platform: 'instagram', status: 'pending', settings_json: {} });
  
  const [jobId] = await db('publish_jobs').insert({
    campaign_target_id: target.id,
    organization_id: org.id,
    idempotency_key: 'idem-diag',
    status: 'queued',
    attempt_count: 0,
    max_attempts: 3,
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  });

  console.log(`[Test] Created fixture PublishJob ${jobId}`);

  // Mock handler (representing the adapter transport mock)
  let realSubjectDelivery = false;
  let publishJobClaimed = false;
  
  const ac2 = new AbortController();
  // Using a test consumer name but the REAL live subject
  const realSubject = 'jobs.publish.instagram';
  const testConsReal = 'WORKER_DIAG_REAL_SUB';
  await jsm.consumers.delete('ELECIO_JOBS', testConsReal).catch(() => {});

  const w2 = startWorker(realSubject, testConsReal, async (ctx) => {
    console.log('[Test] Handler invoked for REAL subject');
    realSubjectDelivery = true;
    const currentJob = await PublishJob.query().findById(jobId);
    if (currentJob.status === 'running') publishJobClaimed = true;
    ac2.abort(); // stop after one message
  }, { signal: ac2.signal });

  await new Promise(r => setTimeout(r, 1000));

  console.log('[Test] Publishing ID-only message to', realSubject);
  const pubAck2 = await js.publish(realSubject, jc.encode({ jobId, organizationId: org.id, campaignTargetId: target.id }));
  console.log('[Test] PubAck:', pubAck2.seq);

  await w2.catch(() => {});

  console.log('[Test] realSubjectDelivery:', realSubjectDelivery);
  console.log('[Test] publishJobClaimed:', publishJobClaimed);
  const attempts = await PublishAttempt.query().where({ job_id: jobId });
  console.log('[Test] publishAttempt creation count:', attempts.length);

  // cleanup
  await jsm.consumers.delete('ELECIO_JOBS', testCons).catch(() => {});
  await jsm.consumers.delete('ELECIO_JOBS', testConsReal).catch(() => {});
  await PublishJob.query().deleteById(jobId);
  await CampaignTarget.query().deleteById(target.id);
  await Campaign.query().deleteById(campaign.id);
  await IntegrationConfig.query().deleteById(config.id);
  await IntegrationProvider.query().deleteById(provider.id);
  await Organization.query().deleteById(org.id);

  await db.destroy();
  process.exit(0);
}

runTest();
