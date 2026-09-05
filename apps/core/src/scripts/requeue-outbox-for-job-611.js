import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();

import OutboxEvent from '../db/models/core/OutboxEvent.js';
import PublishJob from '../db/models/core/PublishJob.js';
import { createOutboxEvent } from '../publisher/outbox.js';
import { OUTBOX_STATUS } from '../publisher/constants.js';

async function main() {
  console.log('================================================================================');
  console.log('🔄 REQUEUING CANONICAL OUTBOX DELIVERY EVENT FOR EXISTING JOB 611');
  console.log('================================================================================');

  const job = await PublishJob.query().findById(611);
  if (!job) {
    console.error('❌ PublishJob 611 not found.');
    process.exit(1);
  }

  if (job.status !== 'queued') {
    console.error(`❌ PublishJob 611 is in status "${job.status}", expected "queued".`);
    process.exit(1);
  }

  // Verify no pending or processing outbox event exists for 611
  const inFlightOutbox = await OutboxEvent.query()
    .where({ aggregate_id: '611' })
    .whereIn('status', [OUTBOX_STATUS.PENDING, OUTBOX_STATUS.PROCESSING]);

  if (inFlightOutbox.length > 0) {
    console.log(`⚠️ Found ${inFlightOutbox.length} in-flight outbox event(s) for Job 611. No new event needed.`);
    await db.destroy();
    process.exit(0);
  }

  // Create new canonical outbox event
  const createdOutbox = await db.transaction(async (trx) => {
    return await createOutboxEvent(trx, {
      organizationId: job.organization_id,
      eventType: 'jobs.publish.instagram',
      aggregateType: 'publish_jobs',
      aggregateId: String(job.id),
      payloadJson: {
        jobId: job.id,
        organizationId: job.organization_id,
        campaignTargetId: job.campaign_target_id,
      },
    });
  });

  console.log(`✅ Created fresh canonical OutboxEvent [ID: ${createdOutbox.id}] for Job 611.`);
  console.log(`   Status: "${createdOutbox.status}", Org: ${createdOutbox.organization_id}, Event: "${createdOutbox.event_type}"`);
  console.log('================================================================================');

  await db.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('💥 Fatal error in requeue script:', err);
  await db.destroy();
  process.exit(1);
});
