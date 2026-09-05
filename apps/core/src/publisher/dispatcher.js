import getDb from '../config/database.js';
const db = getDb();
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import { OUTBOX_STATUS } from './constants.js';
import { connectNats } from '../services/messaging/nats.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { JSONCodec } from 'nats';

const jc = JSONCodec();

/**
 * Resolves the final JetStream subject for a given Outbox event type.
 * @param {string} eventType 
 * @returns {string} The resolved JetStream subject
 * @throws {Error} If the event type is unknown or invalid
 */
export function resolveOutboxSubject(eventType) {
  if (typeof eventType !== 'string' || !eventType) {
    throw new Error(`Invalid event type: ${eventType}`);
  }

  // Canonical behavior: return unchanged
  if (eventType.startsWith('jobs.') || eventType.startsWith('events.')) {
    return eventType;
  }

  // Legacy transitional job event types
  if (eventType.startsWith('publish.') || eventType.startsWith('media.') || eventType.startsWith('cleanup.')) {
    return `jobs.${eventType}`;
  }

  // Unknown event type
  throw new Error(`Unknown outbox event type: ${eventType}. Cannot resolve routing subject.`);
}

/**
 * Claims pending or expired outbox events for processing.
 * Short transaction, skips locked rows.
 */
async function claimEvents(batchSize = 50, leaseSeconds = 30) {
  const trx = await db.transaction();
  try {
    // Find rows that are pending or have expired processing leases
    const candidates = await trx.raw(`
      SELECT id, event_type, payload_json
      FROM outbox_events
      WHERE status = 'pending' 
         OR (status = 'processing' AND (available_at IS NULL OR available_at <= NOW()))
      ORDER BY id ASC
      LIMIT ?
      FOR UPDATE SKIP LOCKED
    `, [batchSize]);

    const rows = candidates[0];
    if (!rows || rows.length === 0) {
      await trx.commit();
      return [];
    }

    const ids = rows.map(r => r.id);
    
    // Update them to processing with a lease expiry
    await trx.raw(`
      UPDATE outbox_events
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          available_at = TIMESTAMPADD(SECOND, ?, NOW())
      WHERE id IN (?)
    `, [leaseSeconds, ids]);

    await trx.commit();
    return rows;
  } catch (err) {
    await trx.rollback();
    throw err;
  }
}

/**
 * Marks events as successfully dispatched.
 */
async function markDispatched(id) {
  await OutboxEvent.query().findById(id).patch({
    status: OUTBOX_STATUS.DISPATCHED,
    dispatched_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
  });
}

/**
 * Marks events as failed if max attempts reached.
 */
async function markFailed(id) {
  // If we really want to mark it failed, for now let's just let it fall back
  // to lease expiry and get picked up again. We could implement a hard failure limit.
  await OutboxEvent.query().findById(id).patch({
    status: OUTBOX_STATUS.FAILED,
  });
}

/**
 * Run one iteration of the dispatcher loop.
 *
 * @param {import("nats").JetStreamClient} js
 * @param {Object} [options]
 * @param {number} [options.batchSize=50]
 * @param {number} [options.leaseSeconds=30]
 * @param {Function} [options.faultInjector] - async ({ stage, event }) => void
 */
export async function dispatchBatch(js, options = {}) {
  const batchSize = typeof options === 'number' ? options : (options.batchSize || 50);
  const leaseSeconds = options.leaseSeconds || 30;
  const faultInjector = options.faultInjector || null;

  const events = await claimEvents(batchSize, leaseSeconds);
  if (events.length === 0) {
    return 0; // No events processed
  }

  let dispatchedCount = 0;

  for (const event of events) {
    // Trusted internal subject routing derivation
    let subject;
    try {
      subject = resolveOutboxSubject(event.event_type);
    } catch (err) {
      console.error(`[OutboxDispatcher] Subject resolution failed for event ${event.id}:`, err.message);
      // Fail dispatch safely, DO NOT mark as dispatched, leaving it to fail and be retried
      // or reclaimed if we ever add a failed state for outbox. For now it just throws or skips.
      // Since we want it to remain retryable or stuck without marking dispatched:
      continue; // Skip processing this event (it will be picked up again until fixed)
    }

    const msgId = `outbox-${event.id}`;

    try {
      // Publish to NATS with deduplication ID
      await js.publish(subject, jc.encode(event.payload_json), {
        msgID: msgId,
      });

      // Controlled fault injection seam
      if (faultInjector) {
        await faultInjector({ stage: 'after_publish_before_db_mark', event });
      }

      // TX 2: Mark as dispatched
      await markDispatched(event.id);
      dispatchedCount++;
    } catch (err) {
      console.error(`[OutboxDispatcher] Failed to publish event ${event.id}:`, err.message || err);
      // We don't mark it failed unless we want to stop trying. 
      // It remains 'processing' until the lease expires, then it's reclaimed.
    }
  }

  return dispatchedCount;
}

export async function runDispatcherLoop(signal, options = {}) {
  const { js } = await initJetStream();

  console.log('[OutboxDispatcher] Started.');

  while (!signal?.aborted) {
    try {
      const count = await dispatchBatch(js, options);
      if (count === 0) {
        // Sleep backoff when idle
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error('[OutboxDispatcher] Loop error:', err);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
