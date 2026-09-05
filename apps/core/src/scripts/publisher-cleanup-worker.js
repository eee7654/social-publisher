import '../bootstrap.js';
import { JSONCodec } from 'nats';
import { initJetStream } from '../services/messaging/jetstream.js';
import { deleteAssetObject, recoverStaleUploadingAssets, sweepRetainedAssets } from '../publisher/media/cleanup.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';

const jc = JSONCodec();

export const CLEANUP_WORKER_DEFAULTS = {
  CONSUMER_NAME: 'CLEANUP_ASSETS_WORKER',
  SUBJECT: 'jobs.cleanup.assets',
  SHUTDOWN_TIMEOUT_MS: 5000,
  STALE_RECOVERY_INTERVAL_MS: 5 * 60 * 1000,
};

/**
 * Handles single cleanup task message.
 */
export async function processCleanupMessage(msg) {
  let payload;
  try {
    payload = jc.decode(msg.data);
  } catch (err) {
    console.error('[CleanupWorker] Failed to decode message data:', {
      subject: msg.subject,
      seq: msg.seq,
    });
    if (typeof msg.ack === 'function') msg.ack();
    return;
  }

  const { assetId, organizationId } = payload || {};
  if (!assetId || !organizationId) {
    console.error('[CleanupWorker] Missing assetId or organizationId. Discarding.', {
      subject: msg.subject,
      seq: msg.seq,
    });
    if (typeof msg.ack === 'function') msg.ack();
    return;
  }

  try {
    await deleteAssetObject(assetId, organizationId);
    console.log(`[CleanupWorker] Successfully cleaned asset ${assetId} for Org ${organizationId}.`);
    if (typeof msg.ack === 'function') msg.ack();
  } catch (err) {
    if (err.message.includes('CANNOT_DELETE_ASSET')) {
      console.log(`[CleanupWorker] Cleanup refused for Asset ${assetId}: ${err.message}`);
      if (typeof msg.ack === 'function') msg.ack();
    } else {
      console.error(`[CleanupWorker] Error cleaning Asset ${assetId}:`, err.message);
      // Storage and database failures are retryable. ACK only a deliberate
      // refusal or a successful/idempotent cleanup.
      if (typeof msg.nak === 'function') msg.nak(1000);
    }
  }
}

/**
 * Starts the Asset Cleanup Worker.
 */
export async function startCleanupWorker(options = {}) {
  const subject = options.subject || CLEANUP_WORKER_DEFAULTS.SUBJECT;
  const consumerName = options.consumerName || CLEANUP_WORKER_DEFAULTS.CONSUMER_NAME;
  const signal = options.signal;
  const shutdownTimeoutMs = options.shutdownTimeoutMs || CLEANUP_WORKER_DEFAULTS.SHUTDOWN_TIMEOUT_MS;
  const staleRecoveryIntervalMs = options.staleRecoveryIntervalMs || CLEANUP_WORKER_DEFAULTS.STALE_RECOVERY_INTERVAL_MS;

  const { js, jsm } = await initJetStream();
  const recoverStale = async () => {
    try {
      const results = await recoverStaleUploadingAssets();
      const retentionResults = await sweepRetainedAssets();
      if (results.length) console.log(`[CleanupWorker] Recovered ${results.filter(r => r.recovered).length}/${results.length} stale uploads.`);
      if (retentionResults.length) console.log(`[CleanupWorker] Retention sweep deleted ${retentionResults.filter(r => r.deleted).length}/${retentionResults.length} assets.`);
    } catch (err) {
      console.error('[CleanupWorker] Stale upload recovery failed:', err.message);
    }
  };
  await recoverStale();
  const staleRecoveryTimer = setInterval(recoverStale, staleRecoveryIntervalMs);

  try {
    await jsm.consumers.add('ELECIO_JOBS', {
      durable_name: consumerName,
      ack_policy: 'explicit',
      deliver_policy: 'all',
      filter_subject: subject,
      max_deliver: 5,
      ack_wait: 30 * 1000000000,
    });
  } catch (err) {
    if (!err.message?.includes('already in use')) throw err;
  }

  const consumer = await js.consumers.get('ELECIO_JOBS', consumerName);
  console.log(`[CleanupWorker] Listening on ${subject} using consumer ${consumerName}...`);

  const inFlight = new Set();
  const messages = await consumer.consume({ max_messages: 10 });

  const closePromise = (async () => {
    for await (const msg of messages) {
      if (signal?.aborted) {
        if (typeof msg.nak === 'function') msg.nak();
        break;
      }

      const taskPromise = processCleanupMessage(msg)
        .catch(err => console.error('[CleanupWorker] Unhandled task error:', err))
        .finally(() => inFlight.delete(taskPromise));

      inFlight.add(taskPromise);
    }
  })();

  if (signal) {
    signal.addEventListener('abort', async () => {
      clearInterval(staleRecoveryTimer);
      console.log('[CleanupWorker] Shutdown signal received. Draining in-flight tasks...');
      try {
        await messages.close();
      } catch (e) {}

      if (inFlight.size > 0) {
        const timeoutPromise = new Promise(r => setTimeout(r, shutdownTimeoutMs));
        await Promise.race([Promise.all(Array.from(inFlight)), timeoutPromise]);
      }
      console.log(`[CleanupWorker] Consumer ${consumerName} shut down.`);
    }, { once: true });
  }

  return closePromise;
}

// Standalone execution entrypoint
if (process.argv[1]?.endsWith('publisher-cleanup-worker.js')) {
  const controller = createShutdownController('CleanupWorker');

  startCleanupWorker({ signal: controller.signal })
    .then(async () => {
      await closeProcessResources('CleanupWorker');
      process.exit(0);
    })
    .catch(err => {
      console.error('[CleanupWorker] Fatal error:', err);
      process.exit(1);
    });
}
