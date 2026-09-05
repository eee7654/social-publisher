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
    if (!job) {
      throw new Error(`PublishJob ${jobId} not found`);
    }

    console.log(`Transitioning Job ${jobId} from "${job.status}" back to "queued"...`);
    
    await PublishJob.query(trx).findById(jobId).patch({
      status: 'queued',
      attempt_count: 0, 
      external_stage: null // ensure pre-container state
    });

    console.log(`Creating canonical OutboxEvent for Job ${jobId}...`);
    
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
    console.log('✅ RECOVERY SUCCESS');
    console.log(`Job ${jobId} is now QUEUED.`);
    console.log(`OutboxEvent ${event.id} created for delivery.`);
  } catch (err) {
    await trx.rollback();
    console.error('❌ Failed to recover job:', err.message);
    process.exit(1);
  }
  
  await db.destroy();
  process.exit(0);
}

recover();
