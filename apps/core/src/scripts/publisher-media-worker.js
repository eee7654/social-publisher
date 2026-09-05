import '../bootstrap.js';
import crypto from 'crypto';
import { JSONCodec } from 'nats';
import getDb from '../config/database.js';
const db = getDb();
import Asset from '../db/models/core/Asset.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { probeS3Object } from '../publisher/media/probe.js';
import { renderElecioHorizontalVariant, ELECIO_HORIZONTAL_PROFILE } from '../publisher/media/technicalLayout.js';
import { validateOutboxPayload } from '../publisher/outbox.js';
import { sanitizeMediaError } from '../publisher/media/sanitize.js';
import {
  ASSET_STATUS,
  PROBE_LEASE_TIMEOUT_SECONDS,
} from '../publisher/media/constants.js';
import { reconcileTargetsForVariant } from '../publisher/media/reconcileTargets.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';

const jc = JSONCodec();

export const MEDIA_WORKER_DEFAULTS = {
  CONSUMER_NAME: 'MEDIA_PROBE_WORKER',
  SUBJECT: 'jobs.media.probe',
  VARIANT_CONSUMER_NAME: 'MEDIA_VARIANT_WORKER',
  VARIANT_SUBJECT: 'jobs.media.variant',
  HEARTBEAT_MS: 10000,
  LOCK_TIMEOUT_SECONDS: PROBE_LEASE_TIMEOUT_SECONDS,
  SHUTDOWN_TIMEOUT_MS: 5000,
};

function isJetStreamConsumerNotFound(err) {
  return err?.code === '404' ||
    err?.api_error?.code === 404 ||
    err?.api_error?.err_code === 10014 ||
    err?.message?.includes('consumer not found') ||
    err?.message?.includes('10014') ||
    err?.message?.includes('404');
}

function isJetStreamConsumerAlreadyExists(err) {
  return err?.api_error?.err_code === 10148 ||
    err?.api_error?.description?.includes('consumer already exists') ||
    err?.message?.includes('consumer already exists') ||
    err?.message?.includes('already in use');
}

function assertCompatibleMediaConsumer(existing, { consumerName, subject }) {
  const config = existing?.config || {};
  if (config.durable_name && config.durable_name !== consumerName) {
    throw new Error(`Existing media consumer durable mismatch: expected ${consumerName}, found ${config.durable_name}`);
  }
  if (config.filter_subject && config.filter_subject !== subject) {
    throw new Error(`Existing media consumer subject mismatch: expected ${subject}, found ${config.filter_subject}`);
  }
  if (config.ack_policy && config.ack_policy !== 'explicit') {
    throw new Error(`Existing media consumer ack policy mismatch: expected explicit, found ${config.ack_policy}`);
  }
}

async function ensureMediaConsumer(jsm, { consumerName, subject }) {
  const consumerConfig = {
    durable_name: consumerName,
    ack_policy: 'explicit',
    deliver_policy: 'all',
    filter_subject: subject,
    max_deliver: 5,
    ack_wait: 30 * 1000000000, // 30s
  };

  try {
    const existing = await jsm.consumers.info('ELECIO_JOBS', consumerName);
    assertCompatibleMediaConsumer(existing, { consumerName, subject });
    return;
  } catch (err) {
    if (!isJetStreamConsumerNotFound(err)) throw err;
  }

  try {
    await jsm.consumers.add('ELECIO_JOBS', consumerConfig);
    console.log(`[MediaWorker] Created durable consumer ${consumerName}`);
  } catch (err) {
    if (!isJetStreamConsumerAlreadyExists(err)) throw err;
    const existing = await jsm.consumers.info('ELECIO_JOBS', consumerName);
    assertCompatibleMediaConsumer(existing, { consumerName, subject });
  }
}

/** Variant rendering shares the Asset lease/fencing model with probing. */
export async function processMediaVariantMessage(msg, options = {}) {
  const payload = jc.decode(msg.data);
  validateOutboxPayload('jobs.media.variant', payload);
  if (payload.profile !== ELECIO_HORIZONTAL_PROFILE) throw new Error('Unsupported media variant profile');
  const token = crypto.randomUUID();
  const claimed = await db.raw(`UPDATE assets SET status=?, locked_at=NOW(), lock_token=? WHERE id=? AND organization_id=? AND status=?`, [
    ASSET_STATUS.PROBING, token, payload.assetId, payload.organizationId, ASSET_STATUS.STORED,
  ]);
  if (!(claimed[0]?.affectedRows)) { msg.ack(); return; }
  try {
    const variant = await Asset.query().where({ id: payload.assetId, organization_id: payload.organizationId }).first();
    const source = await Asset.query().where({ id: payload.sourceAssetId, organization_id: payload.organizationId, status: ASSET_STATUS.READY }).first();
    if (!variant || !source) throw new Error('Variant source is not READY or is outside tenant');
    const metadata = await (options.renderVariant || renderElecioHorizontalVariant)({ sourceAsset: source, variantAsset: variant, organizationId: payload.organizationId });
    const updated = await db.raw(`UPDATE assets SET status=?,width=?,height=?,duration_ms=?,fps=?,video_codec=?,audio_codec=?,aspect_ratio=?,size_bytes=?,probe_json=?,locked_at=NULL,lock_token=NULL,error_message=NULL WHERE id=? AND organization_id=? AND status=? AND lock_token=?`, [
      ASSET_STATUS.READY, metadata.width, metadata.height, metadata.duration_ms, metadata.fps, metadata.video_codec, metadata.audio_codec, metadata.aspect_ratio, metadata.size_bytes,
      JSON.stringify({ ...(variant.probe_json || {}), ...metadata.probe_json }), payload.assetId, payload.organizationId, ASSET_STATUS.PROBING, token,
    ]);
    if (!(updated[0]?.affectedRows)) { msg.nak(1000); return; }
    try {
      const reconcile = options.reconcileTargets || reconcileTargetsForVariant;
      await reconcile({ variantAsset: variant, organizationId: payload.organizationId });
    } catch (recErr) {
      console.error('[MediaWorker] Target reconciliation error after variant READY:', recErr);
    }
    msg.ack();
  } catch (error) {
    await db.raw(`UPDATE assets SET status=?, error_message=?, locked_at=NULL, lock_token=NULL WHERE id=? AND organization_id=? AND status=? AND lock_token=?`, [ASSET_STATUS.FAILED, sanitizeMediaError(error), payload.assetId, payload.organizationId, ASSET_STATUS.PROBING, token]);
    msg.ack();
  }
}

/**
 * Handles processing of a single media probe job message with fencing.
 */
export async function processMediaProbeMessage(msg, options = {}) {
  const lockTimeoutSeconds = options.lockTimeoutSeconds || MEDIA_WORKER_DEFAULTS.LOCK_TIMEOUT_SECONDS;
  const heartbeatMs = options.heartbeatMs || MEDIA_WORKER_DEFAULTS.HEARTBEAT_MS;
  const probeObject = options.probeObject || probeS3Object;

  let payload;
  try {
    payload = jc.decode(msg.data);
    validateOutboxPayload('jobs.media.probe', payload);
  } catch (err) {
    console.error('[MediaWorker] Invalid message data. Discarding.', {
      subject: msg.subject,
      seq: msg.seq,
    });
    if (typeof msg.ack === 'function') msg.ack();
    return;
  }

  const { assetId, organizationId } = payload || {};
  if (!assetId || !organizationId) {
    console.error('[MediaWorker] Missing assetId or organizationId. Discarding.', {
      subject: msg.subject,
      seq: msg.seq,
    });
    if (typeof msg.ack === 'function') msg.ack();
    return;
  }

  // 1. Atomic Lease Claim with unique lock_token
  const lockToken = crypto.randomUUID();
  const claimResult = await db.raw(`
    UPDATE assets 
    SET status = ?, 
        locked_at = NOW(),
        lock_token = ?
    WHERE id = ? AND organization_id = ?
      AND (
        status = ?
        OR (status = ? AND (locked_at IS NULL OR locked_at <= DATE_SUB(NOW(), INTERVAL ? SECOND)))
      )
  `, [
    ASSET_STATUS.PROBING,
    lockToken,
    assetId,
    organizationId,
    ASSET_STATUS.STORED,
    ASSET_STATUS.PROBING,
    lockTimeoutSeconds,
  ]);

  const affectedRows = claimResult[0]?.affectedRows || 0;

  if (affectedRows === 0) {
    const currentAsset = await Asset.query().where({ id: assetId, organization_id: organizationId }).first();
    if (!currentAsset) {
      console.warn(`[MediaWorker] Asset ${assetId} not found for Org ${organizationId}. Discarding message.`);
      if (typeof msg.ack === 'function') msg.ack();
      return;
    }

    if (currentAsset.status === ASSET_STATUS.READY) {
      if (typeof msg.ack === 'function') msg.ack();
      return;
    }

    if (currentAsset.status === ASSET_STATUS.PROBING) {
      console.log(`[MediaWorker] Asset ${assetId} currently has an active probe lease. Redelivering later.`);
      if (typeof msg.nak === 'function') msg.nak(500);
      return;
    }

    if (typeof msg.ack === 'function') msg.ack();
    return;
  }

  // 2. Refresh asset details
  const asset = await Asset.query().where({ id: assetId, organization_id: organizationId }).first();
  if (!asset) {
    if (typeof msg.ack === 'function') msg.ack();
    return;
  }

  // 3. Heartbeat & Ownership Guard Setup
  const abortController = new AbortController();
  let heartbeatLost = false;

  const heartbeatInterval = setInterval(async () => {
    try {
      const hbResult = await db.raw(`
        UPDATE assets 
        SET locked_at = NOW() 
        WHERE id = ? AND organization_id = ? AND status = ? AND lock_token = ?
      `, [assetId, organizationId, ASSET_STATUS.PROBING, lockToken]);

      if ((hbResult[0]?.affectedRows || 0) === 0) {
        heartbeatLost = true;
        console.warn(`[MediaWorker] Lost probe lock ownership for Asset ${assetId}. Aborting execution.`);
        clearInterval(heartbeatInterval);
        abortController.abort();
      } else if (typeof msg.working === 'function') {
        // Extend broker ACK time only after the DB fence confirms ownership.
        msg.working();
      }
    } catch (hbErr) {
      console.error(`[MediaWorker] Probe heartbeat failed for Asset ${assetId}:`, hbErr.message);
    }
  }, heartbeatMs);

  try {
    // 4. Perform FFprobe analysis on S3 object
    const metadata = await probeObject(asset.object_key, asset.kind, {
      signal: abortController.signal,
      timeoutMs: options.timeoutMs,
      tempDir: options.tempDir,
    });

    clearInterval(heartbeatInterval);

    if (heartbeatLost) {
      if (typeof msg.nak === 'function') msg.nak(1000);
      return;
    }

    // 5. Persist Normalized Metadata & Update status to READY requiring lock_token
    const finalUpdate = await db.raw(`
      UPDATE assets
      SET status = ?,
          width = ?,
          height = ?,
          duration_ms = ?,
          fps = ?,
          video_codec = ?,
          audio_codec = ?,
          aspect_ratio = ?,
          probe_json = ?,
          size_bytes = COALESCE(?, size_bytes),
          error_message = NULL,
          locked_at = NULL,
          lock_token = NULL
      WHERE id = ? AND organization_id = ? AND status = ? AND lock_token = ?
    `, [
      ASSET_STATUS.READY,
      metadata.width,
      metadata.height,
      metadata.duration_ms,
      metadata.fps,
      metadata.video_codec,
      metadata.audio_codec,
      metadata.aspect_ratio,
      JSON.stringify(metadata.probe_json),
      metadata.size_bytes,
      assetId,
      organizationId,
      ASSET_STATUS.PROBING,
      lockToken,
    ]);

    if ((finalUpdate[0]?.affectedRows || 0) > 0) {
      console.log(`[MediaWorker] Asset ${assetId} successfully probed and marked READY.`);
      if (typeof msg.ack === 'function') msg.ack();
    } else {
      console.warn(`[MediaWorker] Failed to commit READY state for Asset ${assetId} due to expired lock.`);
      if (typeof msg.nak === 'function') msg.nak(1000);
    }
  } catch (probeErr) {
    clearInterval(heartbeatInterval);

    const safeError = sanitizeMediaError(probeErr);
    console.error(`[MediaWorker] Probe failed for Asset ${assetId}:`, safeError);

    // Differentiate corrupt/invalid media from transient storage errors
    const isPermanentValidationFailure =
      probeErr.message.includes('contains no video stream') ||
      probeErr.message.includes('invalid dimensions') ||
      probeErr.message.includes('invalid duration') ||
      probeErr.message.includes('empty (0 bytes)') ||
      probeErr.message.includes('not an allowed image format') ||
      probeErr.message.includes('FFPROBE_MEDIA_INVALID') ||
      probeErr.message.includes('reported media error') ||
      probeErr.message.includes('Invalid data found');

    if (isPermanentValidationFailure) {
      const finalFailure = await db.raw(`
        UPDATE assets
        SET status = ?,
            error_message = ?,
            locked_at = NULL,
            lock_token = NULL
        WHERE id = ? AND organization_id = ? AND status = ? AND lock_token = ?
      `, [
        ASSET_STATUS.FAILED,
        safeError,
        assetId,
        organizationId,
        ASSET_STATUS.PROBING,
        lockToken,
      ]);

      if ((finalFailure[0]?.affectedRows || 0) > 0) {
        if (typeof msg.ack === 'function') msg.ack();
      } else if (typeof msg.nak === 'function') {
        // A reclaimed owner may never ACK a terminal result.
        msg.nak(1000);
      }
    } else {
      // Transient error (e.g. S3 timeout) -> release lock and NAK for retry
      await db.raw(`
        UPDATE assets
        SET locked_at = NULL,
            lock_token = NULL
        WHERE id = ? AND organization_id = ? AND status = ? AND lock_token = ?
      `, [assetId, organizationId, ASSET_STATUS.PROBING, lockToken]);

      if (typeof msg.nak === 'function') msg.nak(1000);
    }
  }
}

/**
 * Starts the standalone Media Worker loop.
 */
export async function startMediaWorker(options = {}) {
  const subject = options.subject || MEDIA_WORKER_DEFAULTS.SUBJECT;
  const consumerName = options.consumerName || MEDIA_WORKER_DEFAULTS.CONSUMER_NAME;
  const signal = options.signal;
  const shutdownTimeoutMs = options.shutdownTimeoutMs || MEDIA_WORKER_DEFAULTS.SHUTDOWN_TIMEOUT_MS;

  const { js, jsm } = await initJetStream();

  await ensureMediaConsumer(jsm, { consumerName, subject });

  const consumer = await js.consumers.get('ELECIO_JOBS', consumerName);
  console.log(`[MediaWorker] Listening on ${subject} using consumer ${consumerName}...`);

  const inFlight = new Set();
  const messages = await consumer.consume({ max_messages: 10 });

  const closePromise = (async () => {
    for await (const msg of messages) {
      if (signal?.aborted) {
        if (typeof msg.nak === 'function') msg.nak();
        break;
      }

      const taskPromise = (msg.subject === 'jobs.media.variant' ? processMediaVariantMessage(msg, options) : processMediaProbeMessage(msg, options))
        .catch(err => console.error('[MediaWorker] Unhandled task error:', err))
        .finally(() => inFlight.delete(taskPromise));

      inFlight.add(taskPromise);
    }
  })();

  if (signal) {
    signal.addEventListener('abort', async () => {
      console.log('[MediaWorker] Shutdown signal received. Draining in-flight tasks...');
      try {
        await messages.close();
      } catch (e) {}

      if (inFlight.size > 0) {
        const timeoutPromise = new Promise(r => setTimeout(r, shutdownTimeoutMs));
        await Promise.race([Promise.all(Array.from(inFlight)), timeoutPromise]);
      }
      console.log(`[MediaWorker] Consumer ${consumerName} shut down.`);
    }, { once: true });
  }

  return closePromise;
}

export async function startMediaWorkers(options = {}) {
  if (options.subject || options.consumerName) {
    return startMediaWorker(options);
  }

  const probeWorker = startMediaWorker({
    ...options,
    subject: MEDIA_WORKER_DEFAULTS.SUBJECT,
    consumerName: MEDIA_WORKER_DEFAULTS.CONSUMER_NAME,
  });
  const variantWorker = startMediaWorker({
    ...options,
    subject: MEDIA_WORKER_DEFAULTS.VARIANT_SUBJECT,
    consumerName: MEDIA_WORKER_DEFAULTS.VARIANT_CONSUMER_NAME,
  });

  return Promise.all([probeWorker, variantWorker]);
}

// Standalone execution entrypoint
if (process.argv[1]?.endsWith('publisher-media-worker.js') || process.env.pm_exec_path?.endsWith('publisher-media-worker.js')) {
  const controller = createShutdownController('MediaWorker');

  startMediaWorkers({ signal: controller.signal })
    .then(async () => {
      await closeProcessResources('MediaWorker');
      process.exit(0);
    })
    .catch(err => {
      console.error('[MediaWorker] Fatal error:', err);
      process.exit(1);
    });
}
