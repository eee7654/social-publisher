import { initJetStream } from '../services/messaging/jetstream.js';
import { JSONCodec } from 'nats';
import { randomUUID } from 'crypto';
import getDb from '../config/database.js';
const db = getDb();
import PublishJob from '../db/models/core/PublishJob.js';
import PublishAttempt from '../db/models/core/PublishAttempt.js';
import { JOB_STATUS, ATTEMPT_STATUS, ERROR_CATEGORY } from './constants.js';

const jc = JSONCodec();

export const WORKER_DEFAULTS = {
  LOCK_TIMEOUT_MS: 60000,
  HEARTBEAT_MS: 15000,
  SHUTDOWN_TIMEOUT_MS: 5000,
  CONCURRENCY: 10,
};

function toDbDate(d = new Date()) {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Refreshes a lease only when the caller still owns its fencing token.
 */
export async function refreshJobLease({ jobId, organizationId, lockToken }) {
  const result = await db.raw(`
    UPDATE publish_jobs
    SET locked_at = NOW()
    WHERE id = ? AND status = ? AND organization_id = ? AND lock_token = ?
  `, [jobId, JOB_STATUS.RUNNING, organizationId, lockToken]);
  return result[0].affectedRows === 1;
}

/**
 * Applies a terminal job mutation only when the caller still owns its lease.
 */
export async function finalizeOwnedJob(queryable, {
  jobId,
  organizationId,
  lockToken,
  patch,
}) {
  return PublishJob.query(queryable)
    .where({
      id: jobId,
      status: JOB_STATUS.RUNNING,
      organization_id: organizationId,
      lock_token: lockToken,
    })
    .patch(patch);
}

/**
 * Sanitizes strings by removing sensitive tokens, passwords, authorization headers, and signed S3 query parameters.
 */
export function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/enc:v1:[A-Za-z0-9+/=_-]+/gi, '[REDACTED_CIPHERTEXT]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._~+/-]+/gi, '[REDACTED_TOKEN]')
    .replace(/(password|secret|token|access_token|refresh_token|client_secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/X-Amz-Signature=[^&\s]+/gi, 'X-Amz-Signature=[REDACTED]')
    .replace(/X-Amz-Credential=[^&\s]+/gi, 'X-Amz-Credential=[REDACTED]')
    .replace(/X-Amz-Security-Token=[^&\s]+/gi, 'X-Amz-Security-Token=[REDACTED]')
    .replace(/Signature=[^&\s]+/gi, 'Signature=[REDACTED]');
}

/**
 * Recursively sanitizes metadata objects to ensure no credentials or raw secrets are persisted.
 */
export function sanitizeAttemptData(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return sanitizeString(data);
  if (Array.isArray(data)) return data.map(item => sanitizeAttemptData(item));
  if (typeof data === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      const lowerKey = k.toLowerCase();
      const isSensitiveKey = [
        'password', 'secret', 'token', 'access_token', 'refresh_token',
        'auth', 'cookie', 'credential', 'system_user'
      ].some(s => lowerKey.includes(s));

      if (isSensitiveKey) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = sanitizeAttemptData(v);
      }
    }
    return clean;
  }
  return data;
}

/**
 * Normalizes an error from a platform adapter into the infrastructure format.
 */
function normalizeError(err) {
  if (err && err.isNormalized) {
    return err;
  }
  
  return {
    isNormalized: true,
    category: err?.category || ERROR_CATEGORY.PERMANENT,
    code: err?.code || 'UNKNOWN_ERROR',
    message: err?.message || 'An unknown error occurred',
    retryAfterMs: err?.retryAfterMs || null,
    safeMetadata: err?.safeMetadata || {},
    stack: err?.stack,
  };
}

/**
 * Handles processing a single job message.
 */
export async function processJob(msg, handler, options = {}) {
  const lockTimeoutMs = options.lockTimeoutMs || WORKER_DEFAULTS.LOCK_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs || WORKER_DEFAULTS.HEARTBEAT_MS;
  const lockTimeoutSec = Math.max(1, Math.floor(lockTimeoutMs / 1000));

  let payload;
  try {
    payload = jc.decode(msg.data);
  } catch (err) {
    console.error('[Worker] Malformed message rejected:', {
      subject: msg.subject,
      seq: msg.seq,
      reason: 'Invalid JSON',
    });
    msg.ack();
    return;
  }

  if (!payload || typeof payload !== 'object' || !payload.jobId || !payload.organizationId) {
    console.error('[Worker] Invalid payload rejected:', {
      subject: msg.subject,
      seq: msg.seq,
      reason: 'Missing jobId or organizationId',
    });
    msg.ack();
    return;
  }

  const { jobId, organizationId, campaignTargetId } = payload;
  // A new opaque token is generated for every initial claim and stale-lease
  // reclaim. It is internal-only and fences every later ownership mutation.
  const lockToken = randomUUID();

  // Atomic Job Claim / Reclaim using pure MySQL time calculations
  let job;
  const trx = await db.transaction();
  try {
    const claimRes = await trx.raw(`
      UPDATE publish_jobs 
       SET status = ?, 
           locked_at = NOW(),
           lock_token = ?,
           attempt_count = attempt_count + 1
      WHERE id = ? AND organization_id = ?
        AND (
          status = ?
          OR (status = ? AND (locked_at IS NULL OR locked_at <= DATE_SUB(NOW(), INTERVAL ? SECOND)))
        )
    `, [
       JOB_STATUS.RUNNING,
       lockToken,
       jobId,
      organizationId,
      JOB_STATUS.QUEUED,
      JOB_STATUS.RUNNING,
      lockTimeoutSec,
    ]);

    if (claimRes[0].affectedRows === 0) {
      console.log(`[Worker] CLAIM RESULT: not_claimed`);
      await trx.commit();
      
      // Check why it was not claimable
      const currentJob = await PublishJob.query().where({ id: jobId, organization_id: organizationId }).first();
      
      if (!currentJob) {
        console.log(`[Worker] reason: not_found`);
        console.warn(`[Worker] Job ${jobId} not found for Org ${organizationId}. Discarding message.`);
        msg.ack();
        return;
      }

      if (currentJob.status === JOB_STATUS.RUNNING) {
        console.log(`[Worker] reason: active_lease`);
        console.log(`[Worker] Job ${jobId} currently has an active lease. Redelivering later.`);
        msg.nak(500);
        return;
      }

      if (
        currentJob.status === JOB_STATUS.SUCCEEDED ||
        currentJob.status === JOB_STATUS.FAILED ||
        currentJob.status === JOB_STATUS.AUTH_REQUIRED ||
        currentJob.status === JOB_STATUS.RECONCILE_REQUIRED ||
        currentJob.status === JOB_STATUS.RETRY_WAIT
      ) {
        console.log(`[Worker] reason: terminal_or_wait_status_${currentJob.status}`);
        console.log(`[Worker] Job ${jobId} already in status '${currentJob.status}'. Ignoring duplicate broker message.`);
        msg.ack();
        return;
      }

      console.log(`[Worker] reason: other_unclaimable`);
      msg.nak();
      return;
    }

    console.log(`[Worker] CLAIM RESULT: claimed`);
    job = await PublishJob.query(trx).findById(jobId);

    // Tenancy verification
    if (campaignTargetId) {
      const targetInfo = await trx.raw(`
        SELECT ct.id FROM campaign_targets ct
        JOIN campaigns c ON ct.campaign_id = c.id
        WHERE ct.id = ? AND c.organization_id = ?
      `, [campaignTargetId, organizationId]);

      if (!targetInfo[0] || targetInfo[0].length === 0) {
        throw new Error(`Tenancy violation: Target ${campaignTargetId} does not belong to Org ${organizationId}`);
      }
    }

    await trx.commit();
  } catch (err) {
    await trx.rollback();
    console.error(`[Worker] Internal error during job claim for job ${jobId}:`, err.message || err);
    msg.nak();
    return;
  }

  // Create attempt record
  const attempt = await PublishAttempt.query().insertAndFetch({
    job_id: job.id,
    attempt_number: job.attempt_count,
    status: ATTEMPT_STATUS.RUNNING,
    started_at: toDbDate(),
  });

  const abortController = new AbortController();

  // Worker Lease Heartbeat
  const heartbeatInterval = setInterval(async () => {
    try {
      if (typeof msg.working === 'function') {
        msg.working();
      }

      const ownsLease = await refreshJobLease({
        jobId: job.id,
        organizationId,
        lockToken,
      });

      if (!ownsLease) {
        console.warn(`[Worker] Lease ownership lost for job ${job.id}. Aborting execution.`);
        abortController.abort();
        clearInterval(heartbeatInterval);
      }
    } catch (hbErr) {
      console.error(`[Worker] Heartbeat error for job ${job.id}:`, hbErr.message || hbErr);
    }
  }, heartbeatMs);

  try {
    // Execute business logic handler
    const handlerResult = await handler({
      jobId,
      organizationId,
      campaignTargetId,
      attemptNumber: job.attempt_count,
      signal: abortController.signal,
    });

    clearInterval(heartbeatInterval);

    if (abortController.signal.aborted) {
      console.warn(`[Worker] Handler finished after lease cancellation for job ${job.id}. Skipping success commit.`);
      msg.nak();
      return;
    }

    // On Success: Update job to SUCCEEDED and attempt to SUCCEEDED
    const successTrx = await db.transaction();
    try {
      const finalized = await finalizeOwnedJob(successTrx, {
        jobId: job.id,
        organizationId,
        lockToken,
        patch: {
        status: JOB_STATUS.SUCCEEDED,
        completed_at: toDbDate(),
        locked_at: null,
        lock_token: null,
        },
      });

      if (finalized === 0) {
        await successTrx.rollback();
        abortController.abort();
        console.warn(`[Worker] Lease ownership lost before success finalization for job ${job.id}.`);
        msg.nak();
        return;
      }

      const attemptPatch = {
        status: ATTEMPT_STATUS.SUCCEEDED,
        finished_at: toDbDate(),
      };
      if (handlerResult?.thumbnail) {
        attemptPatch.metadata_json = { thumbnail: handlerResult.thumbnail };
      }
      await PublishAttempt.query(successTrx).findById(attempt.id).patch(attemptPatch);

      await successTrx.commit();
      msg.ack();
    } catch (err) {
      await successTrx.rollback();
      throw err;
    }

  } catch (rawError) {
    clearInterval(heartbeatInterval);

    if (rawError.message === 'CRASH_SIMULATION') {
      console.error('[Worker] Simulated crash before safe business state persisted.');
      msg.nak(500);
      return;
    }

    const error = normalizeError(rawError);
    const sanitizedMetadata = sanitizeAttemptData(error.safeMetadata || {});
    const sanitizedErrorCode = sanitizeString(String(error.code).substring(0, 255));
    const sanitizedErrorMessage = sanitizeString(String(error.message).substring(0, 65535));
    
    const failTrx = await db.transaction();
    try {
      const attemptUpdate = {
        status: ATTEMPT_STATUS.FAILED,
        finished_at: toDbDate(),
        error_category: error.category,
        error_code: sanitizedErrorCode,
        error_message: sanitizedErrorMessage,
        metadata_json: sanitizedMetadata,
      };

      const jobUpdate = {
        locked_at: null,
        lock_token: null,
        last_error_code: sanitizedErrorCode,
        last_error_message: sanitizedErrorMessage,
      };

      // Determine next status based on error category
      if (
        error.category === ERROR_CATEGORY.TRANSIENT_NETWORK ||
        error.category === ERROR_CATEGORY.PLATFORM_5XX ||
        error.category === ERROR_CATEGORY.RATE_LIMIT
      ) {
        if (job.attempt_count >= job.max_attempts) {
          jobUpdate.status = JOB_STATUS.FAILED;
        } else {
          jobUpdate.status = JOB_STATUS.RETRY_WAIT;
          
          let retryDelayMs = 0;
          if (error.category === ERROR_CATEGORY.RATE_LIMIT && error.retryAfterMs) {
            retryDelayMs = error.retryAfterMs;
          } else {
            const baseMs = 60000;
            const factor = Math.pow(2, job.attempt_count - 1);
            const jitter = Math.random() * 5000;
            retryDelayMs = (baseMs * factor) + jitter;
          }
          jobUpdate.next_attempt_at = toDbDate(new Date(Date.now() + retryDelayMs));
        }
      } else if (error.category === ERROR_CATEGORY.AUTH_REQUIRED) {
        jobUpdate.status = JOB_STATUS.AUTH_REQUIRED;
        jobUpdate.next_attempt_at = null;
      } else if (
        error.category === ERROR_CATEGORY.VALIDATION ||
        error.category === ERROR_CATEGORY.PERMANENT ||
        error.category === ERROR_CATEGORY.TARGET_NOT_READY
      ) {
        jobUpdate.status = JOB_STATUS.FAILED;
      } else if (error.category === ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE) {
        jobUpdate.status = JOB_STATUS.RECONCILE_REQUIRED;
      }

      const finalized = await finalizeOwnedJob(failTrx, {
        jobId: job.id,
        organizationId,
        lockToken,
        patch: jobUpdate,
      });

      if (finalized === 0) {
        await failTrx.rollback();
        abortController.abort();
        console.warn(`[Worker] Lease ownership lost before failure finalization for job ${job.id}.`);
        msg.nak();
        return;
      }

      await PublishAttempt.query(failTrx).findById(attempt.id).patch(attemptUpdate);
      
      await failTrx.commit();
      msg.ack();
    } catch (err) {
      await failTrx.rollback();
      console.error(`[Worker] Failed to persist error state for job ${job.id}:`, err.message || err);
      msg.nak();
    }
  }
}

/**
 * Starts a durable pull consumer worker with heartbeat and graceful shutdown lifecycle.
 *
 * @param {string} subject
 * @param {string} consumerName
 * @param {Function} handler
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.lockTimeoutMs]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.shutdownTimeoutMs]
 * @param {number} [options.concurrency]
 * @param {string} [options.streamName]
 */
export async function startWorker(subject, consumerName, handler, options = {}) {
  const signal = options.signal || null;
  const streamName = options.streamName || 'ELECIO_JOBS';
  const concurrency = Math.max(1, Number(options.concurrency || WORKER_DEFAULTS.CONCURRENCY));
  const shutdownTimeoutMs = options.shutdownTimeoutMs || WORKER_DEFAULTS.SHUTDOWN_TIMEOUT_MS;

  const { js, jsm } = await initJetStream();

  const ackWaitNs = (options.lockTimeoutMs ? Math.max(options.lockTimeoutMs, 1000) : 30000) * 1000000;
  const consumerConfig = {
    durable_name: consumerName,
    ack_policy: 'explicit',
    deliver_policy: 'all',
    filter_subject: subject,
    max_deliver: 10,
    ack_wait: ackWaitNs,
  };

  // Ensure consumer exists with backlog-safe deliver_policy: 'all'
  try {
    const existing = await jsm.consumers.info(streamName, consumerName);
    if (existing?.config?.filter_subject && existing.config.filter_subject !== subject) {
      throw new Error(`Existing consumer ${consumerName} subject mismatch: expected ${subject}, found ${existing.config.filter_subject}`);
    }
    if (existing?.config?.deliver_policy !== 'all') {
      throw new Error(`Existing consumer ${consumerName} deliver policy mismatch: expected all, found ${existing?.config?.deliver_policy}`);
    }
  } catch (err) {
    const isNotFound = 
      err.code === '404' || 
      err.api_error?.code === 404 || 
      err.api_error?.err_code === 10014 || 
      (err.message && (err.message.includes('consumer not found') || err.message.includes('10014') || err.message.includes('404')));

    if (isNotFound) {
      await jsm.consumers.add(streamName, consumerConfig);
      console.log(`[Worker] Created durable consumer ${consumerName}`);
    } else {
      throw err;
    }
  }

  const consumer = await js.consumers.get(streamName, consumerName);
  console.log(`[Worker] CONSUMER BOUND`);
  console.log(`[Worker] consumer name:`, consumerName);
  console.log(`[Worker] server-side filter_subject:`, consumerConfig.filter_subject);
  console.log(`[Worker] consumer deliver policy:`, consumerConfig.deliver_policy);
  console.log(`[Worker] consumer concurrency:`, concurrency);

  const messages = await consumer.consume({ max_messages: Math.min(10, concurrency) });
  
  console.log(`[Worker] Listening on ${subject} using consumer ${consumerName}...`);

  const inFlight = new Set();
  let shuttingDown = false;

  if (signal) {
    signal.addEventListener('abort', () => {
      shuttingDown = true;
      try {
        messages.close();
      } catch (e) {}
    }, { once: true });
  }

  try {
    console.log(`[Worker] CONSUME LOOP STARTED`);
    for await (const msg of messages) {
      if (shuttingDown) break;

      let payloadJson;
      try {
        payloadJson = jc.decode(msg.data);
      } catch (e) {
        payloadJson = {};
      }

      console.log(`[Worker] MESSAGE RECEIVED:`);
      console.log(`[Worker] subject: ${msg.subject}`);
      console.log(`[Worker] stream sequence: ${msg.seq}`);
      console.log(`[Worker] consumer sequence: ${msg.info?.consumerSequence || 'unknown'}`);
      console.log(`[Worker] jobId: ${payloadJson.jobId}`);

      while (inFlight.size >= concurrency) {
        await Promise.race(inFlight);
      }

      console.log(`[Worker] HANDLER ENTERED`);
      const jobPromise = processJob(msg, handler, options).catch(e => {
        console.error('[Worker] Unhandled error processing message:', e.message || e);
        msg.nak();
      });

      inFlight.add(jobPromise);
      jobPromise.finally(() => inFlight.delete(jobPromise));
    }
  } catch (err) {
    if (!shuttingDown) {
      console.error('[Worker] Consumer iterator error:', err.message || err);
    }
  } finally {
    if (inFlight.size > 0) {
      console.log(`[Worker] Waiting for ${inFlight.size} in-flight jobs to complete (timeout: ${shutdownTimeoutMs}ms)...`);
      const timeoutPromise = new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), shutdownTimeoutMs));
      const inFlightPromise = Promise.allSettled(Array.from(inFlight));

      const res = await Promise.race([inFlightPromise, timeoutPromise]);
      if (res === 'TIMEOUT') {
        console.warn(`[Worker] Shutdown timeout reached with ${inFlight.size} jobs still in-flight.`);
      } else {
        console.log(`[Worker] All in-flight jobs completed gracefully.`);
      }
    }
    console.log(`[Worker] Consumer ${consumerName} shut down.`);
  }
}
