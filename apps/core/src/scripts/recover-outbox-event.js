import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();
import PublishJob from '../db/models/core/PublishJob.js';
import { createOutboxEvent } from '../publisher/outbox.js';

async function recover() {
  const jobId = 715;
  const trx = await db.transaction();
  try {
    const job = await PublishJob.query(trx).findById(jobId).forUpdate();
    if (!job) throw new Error('Job not found');

    console.log('Creating recovery OutboxEvent for Job 715...');
    
    const event = await createOutboxEvent(trx, {
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

    await trx.commit();
    console.log('NEW RECOVERY OUTBOX ID:', event.id);
    console.log('RECOVERY OUTBOX STATUS:', event.status);
    console.log('Resolved destination subject: jobs.publish.instagram');
  } catch (err) {
    await trx.rollback();
    console.error('Failed to create recovery event', err);
    process.exit(1);
  }
  process.exit(0);
}

recover();
