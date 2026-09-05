import getDb from '../config/database.js';
const db = getDb();
import PublishJob from '../db/models/core/PublishJob.js';
import { createOutboxEvent } from './outbox.js';
import { JOB_STATUS } from './constants.js';

/**
 * Finds due retry jobs and requeues them via the outbox.
 */
export async function runSchedulerIteration(batchSize = 50) {
  const trx = await db.transaction();
  try {
    const candidates = await trx.raw(`
      SELECT id, organization_id, campaign_target_id
      FROM publish_jobs
      WHERE status = ? AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC
      LIMIT ?
      FOR UPDATE SKIP LOCKED
    `, [JOB_STATUS.RETRY_WAIT, batchSize]);

    const jobs = candidates[0];
    if (!jobs || jobs.length === 0) {
      await trx.commit();
      return 0;
    }

    let requeuedCount = 0;
    for (const job of jobs) {
      // Find the platform for the outbox event subject
      const targetData = await trx.raw(`
        SELECT platform FROM campaign_targets WHERE id = ?
      `, [job.campaign_target_id]);
      
      const platform = targetData[0][0]?.platform || 'unknown';

      // Update job to QUEUED
      await PublishJob.query(trx).findById(job.id).patch({
        status: JOB_STATUS.QUEUED,
        next_attempt_at: null,
      });

      // Insert outbox event
      await createOutboxEvent(trx, {
        organizationId: job.organization_id,
        eventType: `publish.${platform}`,
        aggregateType: 'PublishJob',
        aggregateId: String(job.id),
        payloadJson: {
          jobId: job.id,
          organizationId: job.organization_id,
          campaignTargetId: job.campaign_target_id,
        },
      });
      requeuedCount++;
    }

    await trx.commit();
    return requeuedCount;
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}

export async function runSchedulerLoop(signal) {
  console.log('[Scheduler] Started.');
  while (!signal?.aborted) {
    try {
      const count = await runSchedulerIteration();
      if (count === 0) {
        await new Promise(r => setTimeout(r, 5000)); // Poll every 5s if empty
      } else {
        console.log(`[Scheduler] Requeued ${count} jobs for retry.`);
      }
    } catch (err) {
      console.error('[Scheduler] Loop error:', err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
