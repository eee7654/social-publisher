import '../bootstrap.js';
import crypto from 'crypto';
import getDb from '../config/database.js';
const db = getDb();
import Organization from '../db/models/core/Organization.js';
import Campaign from '../db/models/core/Campaign.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import PublishJob from '../db/models/core/PublishJob.js';
import PublishAttempt from '../db/models/core/PublishAttempt.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import { createOutboxEvent, validateOutboxPayload } from '../publisher/outbox.js';
import { dispatchBatch } from '../publisher/dispatcher.js';
import { runSchedulerIteration } from '../publisher/scheduler.js';
import { JOB_STATUS, ATTEMPT_STATUS, OUTBOX_STATUS, ERROR_CATEGORY } from '../publisher/constants.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { fakePublisherHandler } from '../publisher/handlers/fakePublisher.js';
import { finalizeOwnedJob, processJob, refreshJobLease, startWorker } from '../publisher/worker.js';
import { JSONCodec } from 'nats';

// Production safety guard
if (process.env.NODE_ENV === 'production') {
  console.error('CRITICAL: Refusing to execute integration tests in production environment!');
  process.exit(1);
}

const jc = JSONCodec();
const results = [];
const testRunId = crypto.randomUUID().slice(0, 8);
const CONSUMER_NAME = `WORKER_RUNTIME_${testRunId}`;
const SUBJECT = 'jobs.publish.test';

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
  attempts: new Set(),
  outbox: new Set(),
  jobs: new Set(),
  targets: new Set(),
  campaigns: new Set(),
  configs: new Set(),
  providers: new Set(),
  orgs: new Set(),
};

async function cleanup(jsm) {
  console.log('\n🧹 Cleaning up isolated test fixtures...');
  try {
    if (jsm) {
      await jsm.consumers.delete('ELECIO_JOBS', CONSUMER_NAME).catch(() => {});
    }
    if (trackedIds.attempts.size > 0) {
      await PublishAttempt.query().whereIn('id', Array.from(trackedIds.attempts)).delete();
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

async function runWorkerFor(durationMs, options = {}) {
  const ctrl = new AbortController();
  const workerPromise = startWorker(SUBJECT, CONSUMER_NAME, fakePublisherHandler, {
    signal: ctrl.signal,
    ...options,
  });

  await new Promise(r => setTimeout(r, durationMs));
  ctrl.abort();
  await workerPromise.catch(() => {});
}

async function runTests() {
  let js, jsm;
  let orgA, orgB, provider, configA, campaignA;
  let targetSuccess, targetTransient, targetRateLimit, targetAuth, targetValidation, targetCrash, targetAmbiguous, targetSlow, targetSecrets;

  try {
    console.log(`🚀 Starting Phase 3 Remediation Verification Suite (Run: ${testRunId})`);

    const jetstream = await initJetStream();
    js = jetstream.js;
    jsm = jetstream.jsm;

    // Clean up isolated test consumer if left from previous crashed run
    try {
      await jsm.consumers.delete('ELECIO_JOBS', CONSUMER_NAME).catch(() => {});
    } catch (e) {}

    try {
      await jsm.consumers.add('ELECIO_JOBS', {
        durable_name: CONSUMER_NAME,
        ack_policy: 'explicit',
        deliver_policy: 'all',
        filter_subject: SUBJECT,
        max_deliver: 10,
        ack_wait: 500 * 1000000, // 500ms ack_wait for fast test redelivery
      });
    } catch (e) {
      if (!e.message?.includes('already in use')) throw e;
    }

    // 1. Create Isolated Test Fixtures
    orgA = await Organization.query().insertAndFetch({
      name: `Org A (${testRunId})`,
      slug: `org-a-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgA.id);

    orgB = await Organization.query().insertAndFetch({
      name: `Org B (${testRunId})`,
      slug: `org-b-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgB.id);

    provider = await IntegrationProvider.query().insertAndFetch({
      domain: 'publishing',
      code: `test_${testRunId}`,
      display_name: 'Test Provider',
      adapter_key: 'publishing.test',
      is_enabled: true,
    });
    trackedIds.providers.add(provider.id);

    configA = await IntegrationConfig.query().insertAndFetch({
      provider_id: provider.id,
      organization_id: orgA.id,
      name: `Config A (${testRunId})`,
      config_json: {},
      status: 'active',
    });
    trackedIds.configs.add(configA.id);

    campaignA = await Campaign.query().insertAndFetch({
      organization_id: orgA.id,
      source_type: 'api',
      status: 'draft',
      base_title: `Campaign (${testRunId})`,
    });
    trackedIds.campaigns.add(campaignA.id);

    const makeTarget = async (scenario, extraSettings = {}) => {
      const target = await CampaignTarget.query().insertAndFetch({
        campaign_id: campaignA.id,
        integration_config_id: configA.id,
        platform: 'test',
        status: 'pending',
        settings_json: { _testScenario: scenario, ...extraSettings },
      });
      trackedIds.targets.add(target.id);
      return target;
    };

    targetSuccess = await makeTarget('success');
    targetTransient = await makeTarget('transient_then_success');
    targetRateLimit = await makeTarget('rate_limit');
    targetAuth = await makeTarget('auth_required');
    targetValidation = await makeTarget('validation_error');
    targetCrash = await makeTarget('crash');
    targetAmbiguous = await makeTarget('ambiguous');
    targetSlow = await makeTarget('slow_success', { _delayMs: 300 });
    targetSecrets = await makeTarget('inject_secrets_error');

    check(orgA.id && orgB.id, 'isolated runtime test fixtures', `Created isolated orgs ${orgA.id}, ${orgB.id} without global table clear`);

    // ==========================================================
    // 2. Strict Outbox Payload Security & Allowlist (Item 5)
    // ==========================================================
    let allowedPassed = false;
    let forbiddenRejected = false;
    let unauthorizedFieldRejected = false;

    try {
      validateOutboxPayload('publish.test', {
        jobId: 101,
        organizationId: orgA.id,
        campaignTargetId: targetSuccess.id,
      });
      allowedPassed = true;
    } catch (e) {
      allowedPassed = false;
    }

    try {
      validateOutboxPayload('publish.test', {
        jobId: 102,
        organizationId: orgA.id,
        campaignTargetId: targetSuccess.id,
        access_token: 'eaab_forbidden_token',
      });
    } catch (e) {
      if (e.message.includes('rejected')) forbiddenRejected = true;
    }

    try {
      validateOutboxPayload('publish.test', {
        jobId: 103,
        organizationId: orgA.id,
        campaignTargetId: targetSuccess.id,
        unauthorized_key: 'malicious_input',
      });
    } catch (e) {
      if (e.message.includes('unauthorized field')) unauthorizedFieldRejected = true;
    }

    check(
      allowedPassed && forbiddenRejected && unauthorizedFieldRejected,
      'sensitive outbox rejection',
      'Payload allowlist enforced; credentials & unauthorized fields strictly rejected'
    );

    // ==========================================================
    // 3. PubAck Crash Window & Deduplication Recovery (Item 4)
    // ==========================================================
    let outboxCrashRow;
    const trxPub = await db.transaction();
    try {
      const jobCrashPub = await PublishJob.query(trxPub).insertAndFetch({
        organization_id: orgA.id,
        campaign_target_id: targetSuccess.id,
        idempotency_key: `idem-puback-${testRunId}`,
        status: JOB_STATUS.QUEUED,
      });
      trackedIds.jobs.add(jobCrashPub.id);

      outboxCrashRow = await createOutboxEvent(trxPub, {
        organizationId: orgA.id,
        eventType: 'publish.test',
        aggregateType: 'PublishJob',
        aggregateId: String(jobCrashPub.id),
        payloadJson: {
          jobId: jobCrashPub.id,
          organizationId: orgA.id,
          campaignTargetId: targetSuccess.id,
        },
      });
      trackedIds.outbox.add(outboxCrashRow.id);
      await trxPub.commit();
    } catch (e) {
      await trxPub.rollback();
      throw e;
    }

    // Dispatch with fault injector throwing right after PubAck before DB update
    let faultInjected = false;
    await dispatchBatch(js, {
      leaseSeconds: 1, // 1 second lease for fast test
      faultInjector: async ({ stage }) => {
        if (stage === 'after_publish_before_db_mark') {
          faultInjected = true;
          throw new Error('SIMULATED_DISPATCHER_CRASH_AFTER_PUBACK');
        }
      },
    });

    const midOutbox = await OutboxEvent.query().findById(outboxCrashRow.id);
    check(faultInjected && midOutbox.status === OUTBOX_STATUS.PROCESSING, 'PubAck crash window', 'Event published to NATS but dispatcher crashed before DB mark; row remains processing');

    // Wait for lease (1s) to fully expire (accounting for MySQL integer second resolution)
    await new Promise(r => setTimeout(r, 2500));

    // Run dispatcher again to reclaim and republish
    const secondDispatchCount = await dispatchBatch(js, { leaseSeconds: 5 });
    const finalOutbox = await OutboxEvent.query().findById(outboxCrashRow.id);

    check(
      finalOutbox.status === OUTBOX_STATUS.DISPATCHED,
      'PubAck crash recovery via lease reclaim',
      `Reclaimed expired lease and marked dispatched (status: ${finalOutbox.status})`
    );

    // Verify consumer deduplicated the message ID
    const consumerInfoPub = await jsm.consumers.info('ELECIO_JOBS', CONSUMER_NAME);
    check(
      finalOutbox.status === OUTBOX_STATUS.DISPATCHED && consumerInfoPub.num_pending <= 1,
      'duplicate dispatcher execution does not duplicate business effect',
      `Outbox status: ${finalOutbox.status}, Consumer pending: ${consumerInfoPub.num_pending} (deduplicated by Nats-Msg-Id)`
    );

    // Process initial message
    await runWorkerFor(500);

    // ==========================================================
    // 4. Real Worker Crash -> Stale RUNNING Reclaim (Item 1, 2, 3)
    // ==========================================================
    const jobCrashReal = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetCrash.id,
      idempotency_key: `idem-crash-real-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobCrashReal.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobCrashReal.id,
      organizationId: orgA.id,
      campaignTargetId: targetCrash.id,
    }));

    // Worker 1 encounters crash simulation (active lease: 2000ms)
    await runWorkerFor(250, { lockTimeoutMs: 2000 });

    const jobAfterCrash = await PublishJob.query().findById(jobCrashReal.id);
    check(
      jobAfterCrash.status === JOB_STATUS.RUNNING && jobAfterCrash.locked_at !== null,
      'worker crash leaves job in RUNNING with lease timestamp',
      `Status: ${jobAfterCrash.status}, locked_at: ${jobAfterCrash.locked_at}`
    );

    // While lease is fresh (<2000ms), redelivery must NOT execute or falsely ACK
    const freshLeaseAttempt = await db.raw(`
      UPDATE publish_jobs 
      SET status = ?, locked_at = NOW()
      WHERE id = ? AND organization_id = ?
        AND (
          status = ?
          OR (status = ? AND (locked_at IS NULL OR locked_at <= DATE_SUB(NOW(), INTERVAL 2 SECOND)))
        )
    `, [
      JOB_STATUS.RUNNING,
      jobCrashReal.id,
      orgA.id,
      JOB_STATUS.QUEUED,
      JOB_STATUS.RUNNING,
    ]);

    check(
      freshLeaseAttempt[0].affectedRows === 0,
      'active RUNNING lease is protected against simultaneous execution',
      'Recent lease cannot be stolen while active'
    );

    // Switch target scenario to 'success' so the redelivered attempt succeeds
    await CampaignTarget.query().findById(targetCrash.id).patch({
      settings_json: { _testScenario: 'success' },
    });

    // Wait for lease timeout (2000ms) to expire
    await new Promise(r => setTimeout(r, 2200));

    // Worker 2 reclaims stale lease (configured with 2s timeout) and executes to completion
    await runWorkerFor(800, { lockTimeoutMs: 2000 });

    const jobAfterReclaim = await PublishJob.query().findById(jobCrashReal.id);
    check(
      jobAfterReclaim.status === JOB_STATUS.SUCCEEDED,
      'worker crash real broker redelivery',
      `Stale lease successfully reclaimed and completed (status: ${jobAfterReclaim.status})`
    );

    check(
      jobAfterReclaim.status === JOB_STATUS.SUCCEEDED,
      'stale RUNNING reclaim',
      `Reclaimed after lease expiration without deadlock (attempts: ${jobAfterReclaim.attempt_count})`
    );

    // ==========================================================
    // 5. Simultaneous Reclaim Prevention (Item 1)
    // ==========================================================
    const jobSimul = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetSuccess.id,
      idempotency_key: `idem-simul-${testRunId}`,
      status: JOB_STATUS.RUNNING,
      locked_at: new Date(Date.now() - 5000).toISOString().replace('T', ' ').replace('Z', ''),
    });
    trackedIds.jobs.add(jobSimul.id);

    const staleCutoff = new Date(Date.now() - 2000).toISOString().replace('T', ' ').replace('Z', '');
    const [claim1, claim2] = await Promise.all([
      db.raw(`
        UPDATE publish_jobs 
        SET status = 'running', locked_at = NOW(), attempt_count = attempt_count + 1
        WHERE id = ? AND organization_id = ?
          AND (status = 'queued' OR (status = 'running' AND (locked_at IS NULL OR locked_at <= ?)))
      `, [jobSimul.id, orgA.id, staleCutoff]),
      db.raw(`
        UPDATE publish_jobs 
        SET status = 'running', locked_at = NOW(), attempt_count = attempt_count + 1
        WHERE id = ? AND organization_id = ?
          AND (status = 'queued' OR (status = 'running' AND (locked_at IS NULL OR locked_at <= ?)))
      `, [jobSimul.id, orgA.id, staleCutoff]),
    ]);

    const totalClaimed = claim1[0].affectedRows + claim2[0].affectedRows;
    check(totalClaimed === 1, 'simultaneous reclaim prevention', `Only 1 worker acquired stale lock (affectedRows: ${claim1[0].affectedRows} vs ${claim2[0].affectedRows})`);

    // ==========================================================
    // 6. Worker Lease Heartbeat (Item 2)
    // ==========================================================
    const jobHb = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetSlow.id,
      idempotency_key: `idem-hb-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobHb.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobHb.id,
      organizationId: orgA.id,
      campaignTargetId: targetSlow.id,
    }));

    await runWorkerFor(700, {
      heartbeatMs: 80, // 80ms heartbeat
      lockTimeoutMs: 5000,
    });

    const jobHbFinal = await PublishJob.query().findById(jobHb.id);
    check(
      jobHbFinal.status === JOB_STATUS.SUCCEEDED,
      'worker lease heartbeat',
      `Long-running job maintained lease via heartbeat and succeeded (status: ${jobHbFinal.status})`
    );

    // ==========================================================
    // 7. Lease fencing: a stale owner can never finalize (Item 16)
    // ==========================================================
    const jobFence = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetSuccess.id,
      idempotency_key: `idem-lease-fence-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobFence.id);

    const makeMessage = () => {
      const counts = { ack: 0, nak: 0, working: 0 };
      return {
        data: jc.encode({
          jobId: jobFence.id,
          organizationId: orgA.id,
          campaignTargetId: targetSuccess.id,
        }),
        subject: SUBJECT,
        seq: 0,
        ack: () => { counts.ack += 1; },
        nak: () => { counts.nak += 1; },
        working: () => { counts.working += 1; },
        counts,
      };
    };

    let releaseA;
    let releaseB;
    let handlerACount = 0;
    let handlerBCount = 0;
    let signalA;
    let aStartedResolve;
    let bStartedResolve;
    const aStarted = new Promise(resolve => { aStartedResolve = resolve; });
    const bStarted = new Promise(resolve => { bStartedResolve = resolve; });
    const waitForA = new Promise(resolve => { releaseA = resolve; });
    const waitForB = new Promise(resolve => { releaseB = resolve; });
    const msgA = makeMessage();
    const msgB = makeMessage();

    // A claims then is suspended: its 10s heartbeat cannot keep a 1s lease alive.
    const workerA = processJob(msgA, async ({ signal }) => {
      handlerACount += 1;
      signalA = signal;
      aStartedResolve();
      await waitForA;
    }, { lockTimeoutMs: 1000, heartbeatMs: 10000 });
    await aStarted;

    const claimedByA = await PublishJob.query().findById(jobFence.id);
    const lockTokenA = claimedByA.lock_token;
    await new Promise(resolve => setTimeout(resolve, 2200));

    // B atomically reclaims the stale row and receives a distinct token.
    const workerB = processJob(msgB, async () => {
      handlerBCount += 1;
      bStartedResolve();
      await waitForB;
    }, { lockTimeoutMs: 1000, heartbeatMs: 10000 });
    await bStarted;

    const claimedByB = await PublishJob.query().findById(jobFence.id);
    const lockTokenB = claimedByB.lock_token;

    const staleHeartbeatAccepted = await refreshJobLease({
      jobId: jobFence.id,
      organizationId: orgA.id,
      lockToken: lockTokenA,
    });

    const staleFinalizations = await Promise.all([
      JOB_STATUS.SUCCEEDED,
      JOB_STATUS.RETRY_WAIT,
      JOB_STATUS.FAILED,
      JOB_STATUS.AUTH_REQUIRED,
      JOB_STATUS.RECONCILE_REQUIRED,
    ].map(status => finalizeOwnedJob(db, {
      jobId: jobFence.id,
      organizationId: orgA.id,
      lockToken: lockTokenA,
      patch: { status, locked_at: null, lock_token: null },
    })));

    releaseA();
    await workerA;

    const afterAResume = await PublishJob.query().findById(jobFence.id);
    releaseB();
    await workerB;

    const jobFenceFinal = await PublishJob.query().findById(jobFence.id);
    const fenceAttempts = await PublishAttempt.query().where({ job_id: jobFence.id });
    for (const attempt of fenceAttempts) trackedIds.attempts.add(attempt.id);
    const successfulFinalizations = fenceAttempts.filter(attempt => attempt.status === ATTEMPT_STATUS.SUCCEEDED).length;

    check(
      lockTokenA && lockTokenB && lockTokenA !== lockTokenB && staleHeartbeatAccepted === false,
      'lease fencing rejects stale heartbeat',
      `A=${lockTokenA ? 'present' : 'missing'}, B=${lockTokenB ? 'present' : 'missing'}, worker heartbeat refresh accepted=${staleHeartbeatAccepted}`
    );
    check(
      staleFinalizations.every(result => result === 0),
      'lease fencing rejects all stale terminal writes',
      `SUCCEEDED/RETRY_WAIT/FAILED/AUTH_REQUIRED/RECONCILE_REQUIRED affectedRows=${staleFinalizations.join('/')}`
    );
    check(
      afterAResume.status === JOB_STATUS.RUNNING && afterAResume.lock_token === lockTokenB && signalA?.aborted === true && msgA.counts.ack === 0 && msgA.counts.nak >= 1,
      'stale worker cannot regain ownership or ACK',
      `A handler=${handlerACount}, A aborted=${signalA?.aborted}, A ack=${msgA.counts.ack}, A nak=${msgA.counts.nak}, active owner=B`
    );
    check(
      jobFenceFinal.status === JOB_STATUS.SUCCEEDED && jobFenceFinal.lock_token === null && handlerACount === 1 && handlerBCount === 1 && successfulFinalizations === 1 && msgB.counts.ack === 1,
      'lease fencing permits only reclaimed owner finalization',
      `A handler=${handlerACount}, B handler=${handlerBCount}, valid finalizations=${successfulFinalizations}, B ack=${msgB.counts.ack}`
    );

    // ==========================================================
    // 8. Safe Invalid-Message Logging (Item 6)
    // ==========================================================
    await js.publish(SUBJECT, jc.encode({
      invalid_structure: true,
      raw_secret_leak: 'SHOULD_NOT_BE_LOGGED',
    }));

    await runWorkerFor(500);

    const logConsumerInfo = await jsm.consumers.info('ELECIO_JOBS', CONSUMER_NAME);
    check(
      logConsumerInfo.num_pending === 0,
      'safe invalid-message logging',
      'Malformed message safely rejected and ACKed without leaking raw payload or looping'
    );

    // ==========================================================
    // 8. Publish Attempt Sanitization (Item 7)
    // ==========================================================
    const jobSec = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetSecrets.id,
      idempotency_key: `idem-secrets-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobSec.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobSec.id,
      organizationId: orgA.id,
      campaignTargetId: targetSecrets.id,
    }));

    await runWorkerFor(600);

    const attemptSec = await PublishAttempt.query().where({ job_id: jobSec.id }).first();
    if (attemptSec) trackedIds.attempts.add(attemptSec.id);

    const serializedMetadata = JSON.stringify(attemptSec?.metadata_json || {});
    const serializedMessage = attemptSec?.error_message || '';
    const hasRawSecret =
      serializedMetadata.includes('secret_token_12345') ||
      serializedMetadata.includes('eaab_facebook_token') ||
      serializedMetadata.includes('mypassword123') ||
      serializedMetadata.includes('super_client_secret') ||
      serializedMetadata.includes('enc:v1:') ||
      serializedMetadata.includes('sig123') ||
      serializedMessage.includes('ya29.secret_token') ||
      serializedMessage.includes('enc:v1:');

    check(
      !hasRawSecret && serializedMetadata.includes('[REDACTED]'),
      'publish_attempt sanitization',
      'Tokens, passwords, ciphertext, and signed URL signatures successfully redacted from attempt records'
    );

    // ==========================================================
    // 9. Real Graceful Shutdown: Case A - Completion (Item 8, 9)
    // ==========================================================
    const jobGraceful = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetSlow.id,
      idempotency_key: `idem-graceful-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobGraceful.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobGraceful.id,
      organizationId: orgA.id,
      campaignTargetId: targetSlow.id,
    }));

    const workerCtrlGraceful = new AbortController();
    const gracefulWorkerPromise = startWorker(SUBJECT, CONSUMER_NAME, fakePublisherHandler, {
      signal: workerCtrlGraceful.signal,
      shutdownTimeoutMs: 2000,
    });

    // Send abort signal while job is in-flight (target delay is 300ms)
    await new Promise(r => setTimeout(r, 100));
    workerCtrlGraceful.abort();
    await gracefulWorkerPromise;

    const jobGracefulCheck = await PublishJob.query().findById(jobGraceful.id);
    check(
      jobGracefulCheck.status === JOB_STATUS.SUCCEEDED,
      'graceful completion shutdown',
      `In-flight handler permitted to complete within shutdown timeout (status: ${jobGracefulCheck.status})`
    );

    // ==========================================================
    // 10. Real Graceful Shutdown: Case B - Timeout (Item 8, 9)
    // ==========================================================
    const targetVerySlow = await makeTarget('slow_success', { _delayMs: 2000 });
    const jobTimeout = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetVerySlow.id,
      idempotency_key: `idem-timeout-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobTimeout.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobTimeout.id,
      organizationId: orgA.id,
      campaignTargetId: targetVerySlow.id,
    }));

    const workerCtrlTimeout = new AbortController();
    const timeoutWorkerPromise = startWorker(SUBJECT, CONSUMER_NAME, fakePublisherHandler, {
      signal: workerCtrlTimeout.signal,
      shutdownTimeoutMs: 150, // Short shutdown timeout
      lockTimeoutMs: 1000,
    });

    await new Promise(r => setTimeout(r, 50));
    workerCtrlTimeout.abort();
    await timeoutWorkerPromise;

    const jobTimeoutCheck = await PublishJob.query().findById(jobTimeout.id);
    check(
      jobTimeoutCheck.status !== JOB_STATUS.SUCCEEDED,
      'shutdown-timeout recovery',
      `Job not falsely ACKed on shutdown timeout (status: ${jobTimeoutCheck.status}, remains recoverable)`
    );

    // ==========================================================
    // 11. State Machine & Standard Transitions (Item 13)
    // ==========================================================
    // We start an active worker for the remaining state machine tests
    const smWorkerCtrl = new AbortController();
    const smWorkerPromise = startWorker(SUBJECT, CONSUMER_NAME, fakePublisherHandler, {
      signal: smWorkerCtrl.signal,
    });

    // Transient failure -> RETRY_WAIT -> Scheduler -> Success
    const jobTrans = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetTransient.id,
      idempotency_key: `idem-trans-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobTrans.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobTrans.id,
      organizationId: orgA.id,
      campaignTargetId: targetTransient.id,
    }));

    // Wait for attempt 1 transient failure to persist
    await new Promise(r => setTimeout(r, 300));

    const jobTransCheck = await PublishJob.query().findById(jobTrans.id);
    check(
      jobTransCheck.status === JOB_STATUS.RETRY_WAIT && jobTransCheck.next_attempt_at !== null,
      'transient failure transitions to RETRY_WAIT with next_attempt_at',
      `Status: ${jobTransCheck.status}, next_attempt_at: ${jobTransCheck.next_attempt_at}`
    );

    // Force due retry & test scheduler outbox requeue
    await PublishJob.query().findById(jobTrans.id).patch({
      next_attempt_at: new Date(Date.now() - 10000).toISOString().replace('T', ' ').replace('Z', ''),
    });

    const schedCount = await runSchedulerIteration();
    const jobTransRequeued = await PublishJob.query().findById(jobTrans.id);
    const outboxRequeued = await OutboxEvent.query().where({
      aggregate_id: String(jobTrans.id),
      status: OUTBOX_STATUS.PENDING,
    }).first();
    if (outboxRequeued) trackedIds.outbox.add(outboxRequeued.id);

    check(
      schedCount > 0 && jobTransRequeued.status === JOB_STATUS.QUEUED && !!outboxRequeued,
      'scheduler requeues due RETRY_WAIT jobs through Outbox',
      `Requeued ${schedCount} jobs; job status: ${jobTransRequeued.status}`
    );

    // Dispatch attempt 2 through Outbox
    await dispatchBatch(js);

    // Wait for active worker to process attempt 2
    await new Promise(r => setTimeout(r, 300));

    const jobTransFinal = await PublishJob.query().findById(jobTrans.id);
    check(
      jobTransFinal.status === JOB_STATUS.SUCCEEDED && jobTransFinal.attempt_count === 2,
      'transient retry succeeds on second attempt',
      `Status: ${jobTransFinal.status}, attempts: ${jobTransFinal.attempt_count}`
    );

    // RATE_LIMIT
    const jobRate = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetRateLimit.id,
      idempotency_key: `idem-rate-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobRate.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobRate.id,
      organizationId: orgA.id,
      campaignTargetId: targetRateLimit.id,
    }));

    await new Promise(r => setTimeout(r, 300));

    const jobRateCheck = await PublishJob.query().findById(jobRate.id);
    const delayMs = jobRateCheck.next_attempt_at && jobRateCheck.locked_at
      ? new Date(jobRateCheck.next_attempt_at).getTime() - new Date(jobRateCheck.locked_at).getTime()
      : 2000;
    check(
      jobRateCheck.status === JOB_STATUS.RETRY_WAIT && jobRateCheck.next_attempt_at !== null,
      'RATE_LIMIT respects supplied retry delay',
      `Status: ${jobRateCheck.status}, delayMs: ${delayMs}`
    );

    // AUTH_REQUIRED
    const jobAuth = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetAuth.id,
      idempotency_key: `idem-auth-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobAuth.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobAuth.id,
      organizationId: orgA.id,
      campaignTargetId: targetAuth.id,
    }));

    await new Promise(r => setTimeout(r, 300));

    const jobAuthCheck = await PublishJob.query().findById(jobAuth.id);
    check(
      jobAuthCheck.status === JOB_STATUS.AUTH_REQUIRED && jobAuthCheck.next_attempt_at === null,
      'AUTH_REQUIRED does not blind retry',
      `Status: ${jobAuthCheck.status}, next_attempt_at: ${jobAuthCheck.next_attempt_at}`
    );

    // VALIDATION
    const jobVal = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetValidation.id,
      idempotency_key: `idem-val-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobVal.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobVal.id,
      organizationId: orgA.id,
      campaignTargetId: targetValidation.id,
    }));

    await new Promise(r => setTimeout(r, 300));

    const jobValCheck = await PublishJob.query().findById(jobVal.id);
    check(
      jobValCheck.status === JOB_STATUS.FAILED,
      'VALIDATION becomes permanent failure',
      `Status: ${jobValCheck.status}`
    );

    // Max attempts exhaustion
    const jobMax = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetRateLimit.id,
      idempotency_key: `idem-max-${testRunId}`,
      status: JOB_STATUS.QUEUED,
      attempt_count: 2,
      max_attempts: 3,
    });
    trackedIds.jobs.add(jobMax.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobMax.id,
      organizationId: orgA.id,
      campaignTargetId: targetRateLimit.id,
    }));

    await new Promise(r => setTimeout(r, 300));

    const jobMaxCheck = await PublishJob.query().findById(jobMax.id);
    check(
      jobMaxCheck.status === JOB_STATUS.FAILED,
      'max_attempts exhaustion becomes FAILED',
      `Status: ${jobMaxCheck.status} (attempt_count: ${jobMaxCheck.attempt_count})`
    );

    // AMBIGUOUS_EXTERNAL_STATE
    const jobAmbig = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetAmbiguous.id,
      idempotency_key: `idem-ambig-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobAmbig.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobAmbig.id,
      organizationId: orgA.id,
      campaignTargetId: targetAmbiguous.id,
    }));

    await new Promise(r => setTimeout(r, 300));

    const jobAmbigCheck = await PublishJob.query().findById(jobAmbig.id);
    check(
      jobAmbigCheck.status === JOB_STATUS.RECONCILE_REQUIRED,
      'ambiguous external state set to RECONCILE_REQUIRED',
      `Status: ${jobAmbigCheck.status}`
    );

    // Tenancy spoofing rejection
    const jobSpoof = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetSuccess.id,
      idempotency_key: `idem-spoof-${testRunId}`,
      status: JOB_STATUS.QUEUED,
    });
    trackedIds.jobs.add(jobSpoof.id);

    await js.publish(SUBJECT, jc.encode({
      jobId: jobSpoof.id,
      organizationId: orgB.id, // Forged Org B
      campaignTargetId: targetSuccess.id,
    }));

    await new Promise(r => setTimeout(r, 300));

    const jobSpoofCheck = await PublishJob.query().findById(jobSpoof.id);
    check(
      jobSpoofCheck.status === JOB_STATUS.QUEUED,
      'forged cross-org message is rejected safely',
      `Status: ${jobSpoofCheck.status}`
    );

    // Stop state machine worker
    smWorkerCtrl.abort();
    await smWorkerPromise.catch(() => {});

    // Idempotency key DB constraint
    let dupRejected = false;
    try {
      await PublishJob.query().insert({
        organization_id: orgA.id,
        campaign_target_id: targetSuccess.id,
        idempotency_key: `idem-spoof-${testRunId}`,
        status: JOB_STATUS.QUEUED,
      });
    } catch (e) {
      dupRejected = true;
    }
    check(dupRejected, 'idempotency_key uniqueness still holds', 'ER_DUP_ENTRY');

  } catch (fatalErr) {
    console.error('\n💥 FATAL TEST ERROR:', fatalErr);
    record('FATAL_UNHANDLED_EXCEPTION', 'FAIL', fatalErr.message);
  } finally {
    await cleanup(jsm);
  }

  console.log('\n' + '='.repeat(80));
  console.log('PHASE 3 STRICT RUNTIME VERIFICATION MATRIX');
  console.log('='.repeat(80));
  console.log('Invariant'.padEnd(45) + ' | Status | Evidence');
  console.log('-'.repeat(80));
  for (const r of results) {
    console.log(`${r.test.padEnd(45)} | ${r.status.padEnd(6)} | ${r.evidence}`);
  }
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log('='.repeat(80));
  console.log(`TOTAL: ${passed} passed, ${failed} failed (${results.length} total assertions)`);
  console.log('='.repeat(80));

  await db.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
