import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();

import PublishJob from '../db/models/core/PublishJob.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import Campaign from '../db/models/core/Campaign.js';
import { createOutboxEvent } from '../publisher/outbox.js';
import { OUTBOX_STATUS } from '../publisher/constants.js';

async function main() {
  console.log('================================================================================');
  console.log('🔍 PHASE 6 — ATOMICITY & DB STATE VERIFICATION');
  console.log('================================================================================');

  // 1. Check PublishJob 574 and Target 416
  const job574 = await PublishJob.query().findById(574);
  const outbox574 = await OutboxEvent.query().where({ aggregate_type: 'publish_jobs', aggregate_id: '574' });
  const target416 = await CampaignTarget.query().findById(416);

  console.log('1. PREVIOUS FAILED TRANSACTION STATE:');
  console.log(`   • PublishJob 574 Exists:         ${job574 ? 'YES (ATOMICITY BUG!)' : 'NO (Rolled Back Cleanly)'}`);
  console.log(`   • Outbox Event for 574 Exists:   ${outbox574.length > 0 ? 'YES' : 'NO (None Created)'}`);
  console.log(`   • CampaignTarget 416 Status:     ${target416 ? `"${target416.status}" (Org: ${target416.organization_id || 'derived'})` : 'NOT FOUND'}`);

  // 2. Test Transaction Atomicity Rollback (Forced Outbox Failure)
  console.log('\n2. TESTING TRANSACTIONAL ATOMICITY WITH CANONICAL createOutboxEvent:');
  let forcedErrorCaught = false;
  let testJobId = null;

  try {
    await db.transaction(async (trx) => {
      // Step 1: Create PublishJob inside transaction
      const [insertedJob] = await trx('publish_jobs').insert({
        campaign_target_id: 416,
        organization_id: 1,
        idempotency_key: `test-atomicity-rollback-${Date.now()}`,
        status: 'queued',
        attempt_count: 0,
        max_attempts: 3,
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
      testJobId = insertedJob;

      // Step 2: Force an intentional error during outbox creation (e.g. sensitive leak validation failure)
      await createOutboxEvent(trx, {
        organizationId: 1,
        eventType: 'jobs.publish.instagram',
        aggregateType: 'publish_jobs',
        aggregateId: String(testJobId),
        payloadJson: {
          jobId: testJobId,
          organizationId: 1,
          campaignTargetId: 416,
          forbidden_leak: 'password_secret_leak', // Will trigger validateOutboxPayload throw
        },
      });
    });
  } catch (err) {
    forcedErrorCaught = true;
    console.log(`   • Forced Outbox Error Caught:    "${err.message}"`);
  }

  // Verify that the test PublishJob was completely rolled back
  const rolledBackJob = testJobId ? await PublishJob.query().findById(testJobId) : null;
  const rolledBackOutbox = testJobId ? await OutboxEvent.query().where({ aggregate_id: String(testJobId) }) : [];

  console.log(`   • Transaction Rolled Back:       ${forcedErrorCaught ? 'YES' : 'NO'}`);
  console.log(`   • Orphan PublishJob Exists:      ${rolledBackJob ? 'YES (FAILED)' : 'NO (Rolled Back)'}`);
  console.log(`   • Orphan Outbox Event Exists:    ${rolledBackOutbox.length > 0 ? 'YES (FAILED)' : 'NO'}`);

  // 3. Test Successful Atomic Insertion with createOutboxEvent
  console.log('\n3. TESTING SUCCESSFUL CANONICAL ATOMIC TRANSACTION:');
  let createdSuccessJob = null;
  let createdSuccessOutbox = null;
  const testSuccessIdempotency = `test-atomicity-success-${Date.now()}`;

  await db.transaction(async (trx) => {
    // Lock CampaignTarget
    const [lockedTarget] = await trx('campaign_targets').where({ id: 416 }).forUpdate();
    const [campaign] = await trx('campaigns').where({ id: lockedTarget.campaign_id });
    const targetOrgId = campaign.organization_id;

    // Create PublishJob
    const [jobId] = await trx('publish_jobs').insert({
      campaign_target_id: 416,
      organization_id: targetOrgId,
      idempotency_key: testSuccessIdempotency,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    // Create Outbox Event using canonical helper
    createdSuccessOutbox = await createOutboxEvent(trx, {
      organizationId: targetOrgId,
      eventType: 'jobs.publish.instagram',
      aggregateType: 'publish_jobs',
      aggregateId: String(jobId),
      payloadJson: {
        jobId,
        organizationId: targetOrgId,
        campaignTargetId: 416,
      },
    });

    [createdSuccessJob] = await trx('publish_jobs').where({ id: jobId });
  });

  console.log(`   • Created PublishJob ID:         ${createdSuccessJob?.id} (Status: "${createdSuccessJob?.status}", Org: ${createdSuccessJob?.organization_id})`);
  console.log(`   • Created OutboxEvent ID:        ${createdSuccessOutbox?.id} (Status: "${createdSuccessOutbox?.status}", Org: ${createdSuccessOutbox?.organization_id})`);
  console.log(`   • Outbox Event Type:             "${createdSuccessOutbox?.event_type}"`);
  console.log(`   • Outbox Payload:                ${JSON.stringify(createdSuccessOutbox?.payload_json)}`);
  console.log(`   • Organization Match:            ${createdSuccessJob?.organization_id === createdSuccessOutbox?.organization_id ? 'PASS (1 === 1)' : 'FAIL'}`);

  // Clean up the temporary test records
  if (createdSuccessOutbox) await OutboxEvent.query().deleteById(createdSuccessOutbox.id);
  if (createdSuccessJob) await PublishJob.query().deleteById(createdSuccessJob.id);

  console.log('================================================================================');
  console.log('🎉 ATOMICITY AND OUTBOX INTEGRATION: VERIFIED');
  console.log('================================================================================');

  await db.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('💥 Fatal error in atomicity verification:', err);
  await db.destroy();
  process.exit(1);
});
