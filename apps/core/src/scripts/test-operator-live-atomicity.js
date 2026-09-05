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
import { createOutboxEvent } from '../publisher/outbox.js';
import { OUTBOX_STATUS, JOB_STATUS } from '../publisher/constants.js';

const results = [];
const testRunId = Math.random().toString(36).substring(2, 9);

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
  assets: new Set(),
  jobs: new Set(),
  outbox: new Set(),
};

async function cleanup() {
  console.log('\n🧹 Cleaning up isolated test fixtures...');
  try {
    if (trackedIds.outbox.size > 0) {
      await OutboxEvent.query().whereIn('id', Array.from(trackedIds.outbox)).delete();
    }
    if (trackedIds.jobs.size > 0) {
      await PublishJob.query().whereIn('id', Array.from(trackedIds.jobs)).delete();
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
  console.log(`🚀 Starting Phase 6 Operator Live Utility Atomicity Test Suite (Run: ${testRunId})`);

  try {
    // 1. Setup isolated Organization A & B
    const orgA = await Organization.query().insertAndFetch({
      name: `Org A (${testRunId})`,
      slug: `org-a-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgA.id);

    const provider = await IntegrationProvider.query().insertAndFetch({
      domain: 'publishing',
      code: `instagram_${testRunId}`,
      display_name: 'Instagram Test',
      adapter_key: 'publishing.instagram',
      is_enabled: true,
    });
    trackedIds.providers.add(provider.id);

    const configA = await IntegrationConfig.query().insertAndFetch({
      organization_id: orgA.id,
      provider_id: provider.id,
      name: `Instagram Org A (${testRunId})`,
      config_json: { instagram_user_id: '17841472834822420', username: 'test_user' },
      status: 'active',
    });
    trackedIds.configs.add(configA.id);

    const campaignA = await Campaign.query().insertAndFetch({
      organization_id: orgA.id,
      source_type: 'telegram_private',
      status: 'ready',
      base_title: 'Test Campaign Atomicity',
    });
    trackedIds.campaigns.add(campaignA.id);

    const targetA = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaignA.id,
      integration_config_id: configA.id,
      platform: 'instagram',
      status: 'pending',
      settings_json: {},
    });
    trackedIds.targets.add(targetA.id);

    // ==========================================================
    // Test 1: Forced Outbox failure rolls back PublishJob (Atomicity)
    // ==========================================================
    let forcedErrorCaught = false;
    let attemptedJobId = null;

    try {
      await db.transaction(async (trx) => {
        const [lockedTarget] = await trx('campaign_targets').where({ id: targetA.id }).forUpdate();
        const [lockedCampaign] = await trx('campaigns').where({ id: lockedTarget.campaign_id }).forUpdate();
        const authoritativeOrgId = lockedCampaign.organization_id;

        const [jobId] = await trx('publish_jobs').insert({
          campaign_target_id: lockedTarget.id,
          organization_id: authoritativeOrgId,
          idempotency_key: `test-failed-outbox-${testRunId}`,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          created_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
        attemptedJobId = jobId;

        // Trigger payload validation failure
        await createOutboxEvent(trx, {
          organizationId: authoritativeOrgId,
          eventType: 'jobs.publish.instagram',
          aggregateType: 'publish_jobs',
          aggregateId: String(jobId),
          payloadJson: {
            jobId,
            organizationId: authoritativeOrgId,
            campaignTargetId: lockedTarget.id,
            unauthorized_key_leak: 'secret_leak',
          },
        });
      });
    } catch (err) {
      forcedErrorCaught = true;
    }

    const orphanJob = attemptedJobId ? await PublishJob.query().findById(attemptedJobId) : null;
    const orphanOutbox = attemptedJobId ? await OutboxEvent.query().where({ aggregate_id: String(attemptedJobId) }) : [];

    check(
      forcedErrorCaught && !orphanJob && orphanOutbox.length === 0,
      'forced Outbox INSERT failure rolls back PublishJob without orphans',
      `Error caught: ${forcedErrorCaught}, orphanJob: ${orphanJob ? 'EXISTS' : 'NONE'}, orphanOutbox: ${orphanOutbox.length}`
    );

    // ==========================================================
    // Test 2: Successful Transactional Enqueue Populates Canonical Fields
    // ==========================================================
    let createdJob = null;
    let createdOutbox = null;
    const idempotencyKeyA = `live-ig-c${campaignA.id}-t${targetA.id}`;

    await db.transaction(async (trx) => {
      const [lockedTarget] = await trx('campaign_targets').where({ id: targetA.id }).forUpdate();
      const [lockedCampaign] = await trx('campaigns').where({ id: lockedTarget.campaign_id }).forUpdate();
      const authoritativeOrgId = lockedCampaign.organization_id;

      const [jobId] = await trx('publish_jobs').insert({
        campaign_target_id: lockedTarget.id,
        organization_id: authoritativeOrgId,
        idempotency_key: idempotencyKeyA,
        status: 'queued',
        attempt_count: 0,
        max_attempts: 3,
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });

      createdOutbox = await createOutboxEvent(trx, {
        organizationId: authoritativeOrgId,
        eventType: 'jobs.publish.instagram',
        aggregateType: 'publish_jobs',
        aggregateId: String(jobId),
        payloadJson: {
          jobId,
          organizationId: authoritativeOrgId,
          campaignTargetId: lockedTarget.id,
        },
      });

      [createdJob] = await trx('publish_jobs').where({ id: jobId });
    });

    if (createdJob) trackedIds.jobs.add(createdJob.id);
    if (createdOutbox) trackedIds.outbox.add(createdOutbox.id);

    check(
      createdJob &&
      createdOutbox &&
      createdOutbox.organization_id === orgA.id &&
      createdJob.organization_id === orgA.id &&
      createdOutbox.payload_json.organizationId === orgA.id &&
      createdOutbox.event_type === 'jobs.publish.instagram' &&
      createdOutbox.aggregate_type === 'publish_jobs' &&
      createdOutbox.aggregate_id === String(createdJob.id) &&
      createdOutbox.status === OUTBOX_STATUS.PENDING &&
      createdJob.status === JOB_STATUS.QUEUED,
      'successful command commits QUEUED job + canonical Outbox event with matching authoritative organization',
      `Job Org: ${createdJob?.organization_id}, Outbox Org: ${createdOutbox?.organization_id}, Status: ${createdOutbox?.status}`
    );

    // ==========================================================
    // Test 3: Idempotency prevents duplicate PublishJob / Outbox
    // ==========================================================
    let duplicateCreated = false;
    let duplicateJob = null;

    await db.transaction(async (trx) => {
      const [lockedTarget] = await trx('campaign_targets').where({ id: targetA.id }).forUpdate();

      const existingJob = await trx('publish_jobs')
        .where({ campaign_target_id: lockedTarget.id })
        .whereIn('status', ['queued', 'running', 'retry_wait', 'reconcile_required', 'succeeded'])
        .first();

      if (existingJob) {
        duplicateJob = existingJob;
        return;
      }

      const [newJobId] = await trx('publish_jobs').insert({
        campaign_target_id: lockedTarget.id,
        organization_id: orgA.id,
        idempotency_key: idempotencyKeyA,
        status: 'queued',
      });
      duplicateCreated = true;
    });

    const totalJobsForTarget = await PublishJob.query().where({ campaign_target_id: targetA.id });
    const totalOutboxForTarget = await OutboxEvent.query().where({ aggregate_id: String(createdJob.id) });

    check(
      !duplicateCreated && duplicateJob?.id === createdJob.id && totalJobsForTarget.length === 1 && totalOutboxForTarget.length === 1,
      'duplicate invocation reuses existing job and creates no duplicate active jobs/outbox events',
      `Total jobs: ${totalJobsForTarget.length}, Total outbox: ${totalOutboxForTarget.length}, Reused ID: ${duplicateJob?.id}`
    );

  } catch (err) {
    console.error('💥 Test suite failure:', err);
    record('test_suite_execution', 'FAIL', err.message);
  } finally {
    await cleanup();
    await db.destroy();
  }

  console.log('\n================================================================================');
  console.log('OPERATOR LIVE ATOMICITY VERIFICATION MATRIX');
  console.log('================================================================================');
  console.table(results);
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`TOTAL: ${passed} passed, ${failed} failed (${results.length} total assertions)`);
  console.log('================================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests();
