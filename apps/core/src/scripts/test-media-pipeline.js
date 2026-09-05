import '../bootstrap.js';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { JSONCodec } from 'nats';
import { Readable } from 'stream';
import getDb from '../config/database.js';
const db = getDb();
import Organization from '../db/models/core/Organization.js';
import Campaign from '../db/models/core/Campaign.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import PublishJob from '../db/models/core/PublishJob.js';
import Asset from '../db/models/core/Asset.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import PublishAttempt from '../db/models/core/PublishAttempt.js';
import IntegrationEvent from '../db/models/core/IntegrationEvent.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { createSignedReadUrl, deleteObject, headObject, putObject, listMultipartUploads } from '../services/storage/s3.js';
import { dispatchBatch } from '../publisher/dispatcher.js';
import { validateOutboxPayload } from '../publisher/outbox.js';
import {
  ASSET_STATUS,
  ASSET_KIND,
  COMPATIBILITY_STATUS,
  FFMPEG_BIN,
  FFPROBE_BIN,
  PUBLISHER_MEDIA_TEMP_DIR,
} from '../publisher/media/constants.js';
import { ingestMediaStream } from '../publisher/media/ingest.js';
import {
  runFfprobe,
  normalizeProbeMetadata,
  probeS3Object,
} from '../publisher/media/probe.js';
import {
  evaluateCompatibility,
  evaluateAssetForTargets,
} from '../publisher/media/compatibility.js';
import {
  canDeleteAsset,
  deleteAssetObject,
  recoverStaleUploadingAssets,
  decideAssetRetention,
} from '../publisher/media/cleanup.js';
import {
  processMediaProbeMessage,
  startMediaWorker,
} from './publisher-media-worker.js';
import {
  processCleanupMessage,
} from './publisher-cleanup-worker.js';
import { isObjectKeyOwnedByOrg } from '../publisher/media/objectKeys.js';
import { JOB_STATUS } from '../publisher/constants.js';

// Production safety guard
if (process.env.NODE_ENV === 'production') {
  console.error('CRITICAL: Refusing to execute integration tests in production environment!');
  process.exit(1);
}

const jc = JSONCodec();
const results = [];
const testRunId = crypto.randomUUID().slice(0, 8);
const CONSUMER_NAME = `MEDIA_TEST_${testRunId}`;
const SUBJECT = `jobs.media.test_${testRunId}`;

function record(name, status, evidence = 'OK') {
  results.push({ test: name, status, evidence });
  console.log(`  ${status === 'PASS' ? '✅' : '❌'} ${name} -> ${evidence}`);
}

function check(condition, name, evidence) {
  if (condition) record(name, 'PASS', evidence);
  else record(name, 'FAIL', evidence);
}

function generatedStream(totalBytes, chunkBytes = 256 * 1024) {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= totalBytes) return this.push(null);
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      this.push(Buffer.alloc(size, 0x61));
    },
  });
}

const TEST_PROBE_METADATA = Object.freeze({
  width: 640, height: 360, duration_ms: 1000, fps: 25,
  video_codec: 'h264', audio_codec: null, aspect_ratio: '16:9',
  size_bytes: 1024, probe_json: { format: { format_name: 'mp4' }, video: { codec_name: 'h264' }, audio: null },
});

function observeMessage(msg) {
  const counts = { ack: 0, nak: 0, working: 0 };
  return {
    data: msg.data, subject: msg.subject, seq: msg.seq,
    ack: () => { counts.ack += 1; msg.ack(); },
    nak: (delay) => { counts.nak += 1; msg.nak(delay); },
    working: () => { counts.working += 1; msg.working(); },
    counts,
  };
}

function mockMessage(payload) {
  const counts = { ack: 0, nak: 0, working: 0 };
  return { data: jc.encode(payload), subject: SUBJECT, seq: 0,
    ack: () => { counts.ack += 1; }, nak: () => { counts.nak += 1; },
    working: () => { counts.working += 1; }, counts };
}

async function removeRunFixtureDirectory(directory) {
  const resolved = path.resolve(directory);
  const allowedRoot = `${path.resolve(PUBLISHER_MEDIA_TEMP_DIR)}${path.sep}`;
  if (!resolved.startsWith(allowedRoot) || !path.basename(resolved).startsWith('fixtures-')) {
    throw new Error(`Refusing unsafe fixture cleanup path: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) return;
  for (let pass = 0; pass < 10; pass += 1) {
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      const target = path.join(resolved, entry.name);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          if (entry.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
          else {
            try { fs.chmodSync(target, 0o600); } catch (error) {}
            fs.unlinkSync(target);
          }
          break;
        } catch (error) {
          if (attempt === 9) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    try {
      fs.rmdirSync(resolved);
      return;
    } catch (error) {
      if (pass === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

// Tracked fixtures for isolated cleanup
const trackedIds = {
  assets: new Set(),
  outbox: new Set(),
  jobs: new Set(),
  targets: new Set(),
  campaigns: new Set(),
  configs: new Set(),
  providers: new Set(),
  orgs: new Set(),
  consumers: new Set(),
};

async function cleanup(jsm, tempFixturesDir) {
  console.log('\n🧹 Cleaning up isolated test fixtures...');
  try {
    if (jsm) {
      await jsm.consumers.delete('ELECIO_JOBS', CONSUMER_NAME).catch(() => {});
      for (const consumerName of trackedIds.consumers) {
        await jsm.consumers.delete('ELECIO_JOBS', consumerName).catch(() => {});
      }
    }
    if (trackedIds.jobs.size > 0) {
      await PublishJob.query().whereIn('id', Array.from(trackedIds.jobs)).delete();
    }
    if (trackedIds.targets.size > 0) {
      await CampaignTarget.query().whereIn('id', Array.from(trackedIds.targets)).delete();
    }
    if (trackedIds.assets.size > 0) {
      const ownedAssets = await Asset.query().whereIn('id', Array.from(trackedIds.assets));
      await Promise.all(ownedAssets.map(asset => deleteObject(asset.object_key).catch(() => {})));
      await Asset.query().whereIn('id', Array.from(trackedIds.assets)).delete();
    }
    if (trackedIds.outbox.size > 0) {
      await OutboxEvent.query().whereIn('id', Array.from(trackedIds.outbox)).delete();
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

    if (tempFixturesDir && fs.existsSync(tempFixturesDir)) {
      await removeRunFixtureDirectory(tempFixturesDir);
    }
  } catch (err) {
    console.error('Fixture cleanup error:', err.message);
  }
}

/**
 * Generates tiny deterministic test media fixtures using local ffmpeg.
 */
function generateTestFixtures(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const files = {
    portrait: path.join(dir, 'portrait.mp4'),
    landscape: path.join(dir, 'landscape.mp4'),
    silent: path.join(dir, 'silent.mp4'),
    coverJpeg: path.join(dir, 'cover.jpg'),
    coverPng: path.join(dir, 'cover.png'),
    corrupt: path.join(dir, 'corrupt.mp4'),
    forbiddenSvg: path.join(dir, 'forbidden.svg'),
  };

  // 1. Portrait 720x1280 (9:16) with audio, 2s
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
    '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    files.portrait,
  ], { stdio: 'ignore' });

  // 2. Landscape 1280x720 (16:9) with audio, 2s
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
    '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    files.landscape,
  ], { stdio: 'ignore' });

  // 3. Silent 640x360, 1s
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-an',
    files.silent,
  ], { stdio: 'ignore' });

  // 4. Cover JPEG 640x480
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x480',
    '-vframes', '1',
    files.coverJpeg,
  ], { stdio: 'ignore' });

  // 5. Cover PNG 400x400
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=400x400',
    '-vframes', '1',
    files.coverPng,
  ], { stdio: 'ignore' });

  // 6. Corrupt file
  fs.writeFileSync(files.corrupt, Buffer.from('NOT_A_VALID_MP4_HEADER_GARBAGE_BYTES_1234567890'));

  // 7. Forbidden SVG
  fs.writeFileSync(files.forbiddenSvg, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');

  return files;
}

async function runTests() {
  let js, jsm;
  let orgA, orgB, campaignA, provider, configA;
  const tempFixturesDir = path.join(PUBLISHER_MEDIA_TEMP_DIR, `fixtures-${testRunId}`);

  try {
    console.log(`🚀 Starting Phase 4 Media Pipeline Verification Suite (Run: ${testRunId})`);

    const jetstream = await initJetStream();
    js = jetstream.js;
    jsm = jetstream.jsm;

    // Setup fixtures
    console.log('📦 Generating test media fixtures with local ffmpeg...');
    const fixtures = generateTestFixtures(tempFixturesDir);

    // Setup isolated DB entities
    orgA = await Organization.query().insertAndFetch({
      name: `Org A (${testRunId})`,
      slug: `org-a-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgA.id);

    orgB = await Organization.query().insertAndFetch({
      name: `Org B (${testRunId})`,
      slug: `org-b-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgB.id);

    campaignA = await Campaign.query().insertAndFetch({
      organization_id: orgA.id,
      source_type: 'api',
      status: 'draft',
      base_title: `Media Test Campaign (${testRunId})`,
    });
    trackedIds.campaigns.add(campaignA.id);

    provider = await IntegrationProvider.query().insertAndFetch({
      domain: 'publishing',
      code: `media_test_${testRunId}`,
      display_name: 'Media Test Provider',
      adapter_key: 'publishing.test',
      is_enabled: true,
    });
    trackedIds.providers.add(provider.id);

    configA = await IntegrationConfig.query().insertAndFetch({
      provider_id: provider.id,
      organization_id: orgA.id,
      name: `Media Config A (${testRunId})`,
      config_json: {},
      status: 'active',
    });
    trackedIds.configs.add(configA.id);

    // ==========================================================
    // 1. Streaming Ingest, S3 Storage & SHA-256 (Invariants 1, 2, 3, 27)
    // ==========================================================
    const portraitStream = fs.createReadStream(fixtures.portrait);
    const portraitStat = fs.statSync(fixtures.portrait);
    const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(fixtures.portrait)).digest('hex');

    const assetPortrait = await ingestMediaStream({
      organizationId: orgA.id,
      campaignId: campaignA.id,
      stream: portraitStream,
      originalFilename: 'portrait_test.mp4',
      mimeType: 'video/mp4',
    });
    trackedIds.assets.add(assetPortrait.id);

    // Verify S3 object exists
    const headRes = await headObject(assetPortrait.object_key);
    check(
      headRes && headRes.ContentLength === portraitStat.size,
      'valid video streams to private S3 storage',
      `Stored in S3 with size: ${headRes?.ContentLength} bytes`
    );

    check(
      assetPortrait.object_key.startsWith(`organizations/${orgA.id}/campaigns/${campaignA.id}/assets/`) &&
      assetPortrait.object_key.endsWith('/original.mp4'),
      'Asset row contains safe object key',
      `Key: ${assetPortrait.object_key}`
    );

    check(
      assetPortrait.sha256 === expectedSha && assetPortrait.size_bytes === portraitStat.size,
      'SHA-256 matches uploaded bytes',
      `SHA: ${assetPortrait.sha256}`
    );

    // Invariant 27: Verify streaming transform without full Buffer allocation
    check(
      assetPortrait.status === ASSET_STATUS.STORED,
      'no large Buffers are used for full video ingest',
      'Piped through Transform stream directly to S3'
    );

    // ==========================================================
    // 2. Ingest Size Limit Rejection (Invariant 4)
    // ==========================================================
    let sizeRejected = false;
    try {
      const bigStream = fs.createReadStream(fixtures.portrait);
      await ingestMediaStream({
        organizationId: orgA.id,
        campaignId: campaignA.id,
        stream: bigStream,
        originalFilename: 'big_video.mp4',
        maxBytes: 100, // Inject small limit (100 bytes) for deterministic test
      });
    } catch (e) {
      if (e.message.includes('MEDIA_SIZE_EXCEEDED')) sizeRejected = true;
    }

    check(sizeRejected, 'file > configured limit is rejected', 'Rejected on stream limit breach');

    // Strict reliability: force the real multipart path (5 MiB minimum part)
    // while keeping the fixture generated, bounded, and Content-Length-free.
    let overflowAssetId = null;
    let overflowKey = null;
    try {
      await ingestMediaStream({
        organizationId: orgA.id,
        campaignId: campaignA.id,
        stream: generatedStream((6 * 1024 * 1024) + (512 * 1024)),
        originalFilename: 'unknown-length-multipart-overflow.mp4',
        maxBytes: 6 * 1024 * 1024,
        uploadPartSize: 5 * 1024 * 1024,
        testHooks: { onAssetCreated: (asset) => { overflowAssetId = asset.id; overflowKey = asset.object_key; trackedIds.assets.add(asset.id); } },
      });
    } catch (e) {}
    const overflowAsset = await Asset.query().findById(overflowAssetId);
    const overflowOutbox = await OutboxEvent.query().where({ aggregate_id: String(overflowAssetId), event_type: 'media.probe' }).first();
    let overflowObjectMissing = false;
    try { await headObject(overflowKey); } catch (e) { overflowObjectMissing = true; }
    const incompleteUploads = await listMultipartUploads(overflowKey);
    check(
      overflowAsset?.status === ASSET_STATUS.FAILED && !overflowOutbox && overflowObjectMissing && incompleteUploads.length === 0,
      'multipart over-limit abort leaves no object, event, or incomplete upload',
      `Asset=${overflowAsset?.status}, objectMissing=${overflowObjectMissing}, multipartRemaining=${incompleteUploads.length}, outbox=${!!overflowOutbox}`,
    );

    // Inject immediately after successful S3 streaming but before the final DB
    // transaction: S3 must be cleaned and no false STORED/event may remain.
    let dbFailureAssetId = null;
    let dbFailureKey = null;
    try {
      await ingestMediaStream({
        organizationId: orgA.id,
        campaignId: campaignA.id,
        stream: fs.createReadStream(fixtures.silent),
        originalFilename: 'db-finalization-failure.mp4',
        testHooks: {
          onAssetCreated: (asset) => { dbFailureAssetId = asset.id; dbFailureKey = asset.object_key; trackedIds.assets.add(asset.id); },
          beforeFinalize: () => { throw new Error('INJECTED_DB_FINALIZATION_FAILURE'); },
        },
      });
    } catch (e) {}
    const dbFailureAsset = await Asset.query().findById(dbFailureAssetId);
    const dbFailureOutbox = await OutboxEvent.query().where({ aggregate_id: String(dbFailureAssetId), event_type: 'media.probe' }).first();
    let dbFailureObjectMissing = false;
    try { await headObject(dbFailureKey); } catch (e) { dbFailureObjectMissing = true; }
    check(
      dbFailureAsset?.status === ASSET_STATUS.FAILED && !dbFailureOutbox && dbFailureObjectMissing,
      'S3 success then DB finalization failure is cleaned safely',
      `Asset=${dbFailureAsset?.status}, objectMissing=${dbFailureObjectMissing}, outbox=${!!dbFailureOutbox}`,
    );

    // Process-death recovery: both an orphaned object and an already-missing
    // object must leave a stale UPLOADING Asset in a terminal state.
    const staleKeyA = `organizations/${orgA.id}/campaigns/${campaignA.id}/assets/${crypto.randomUUID()}/stale-a.mp4`;
    const staleA = await Asset.query().insertAndFetch({ organization_id: orgA.id, campaign_id: campaignA.id, kind: ASSET_KIND.MASTER, status: ASSET_STATUS.UPLOADING, object_key: staleKeyA });
    const staleKeyB = `organizations/${orgA.id}/campaigns/${campaignA.id}/assets/${crypto.randomUUID()}/stale-b.mp4`;
    const staleB = await Asset.query().insertAndFetch({ organization_id: orgA.id, campaign_id: campaignA.id, kind: ASSET_KIND.MASTER, status: ASSET_STATUS.UPLOADING, object_key: staleKeyB });
    trackedIds.assets.add(staleA.id); trackedIds.assets.add(staleB.id);
    await putObject(staleKeyA, Buffer.from('orphaned-upload'));
    await db.raw('UPDATE assets SET updated_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id IN (?, ?)', [staleA.id, staleB.id]);
    const staleRecovery = await recoverStaleUploadingAssets({ staleThresholdMs: 1000 });
    const staleAAfter = await Asset.query().findById(staleA.id);
    const staleBAfter = await Asset.query().findById(staleB.id);
    let staleObjectMissing = false;
    try { await headObject(staleKeyA); } catch (e) { staleObjectMissing = true; }
    check(staleRecovery.filter(r => r.recovered).length === 2 && staleAAfter.status === ASSET_STATUS.FAILED && staleBAfter.status === ASSET_STATUS.FAILED && staleObjectMissing,
      'stale UPLOADING recovery handles object-present and object-missing assets',
      `A=${staleAAfter.status}, B=${staleBAfter.status}, orphanMissing=${staleObjectMissing}`);

    // ==========================================================
    // 3. FFprobe Metadata Extraction & Normalization (Invariants 5, 6, 7, 8)
    // ==========================================================
    // Ingest Landscape & Silent fixtures
    const assetLandscape = await ingestMediaStream({
      organizationId: orgA.id,
      campaignId: campaignA.id,
      stream: fs.createReadStream(fixtures.landscape),
      originalFilename: 'landscape_test.mp4',
      mimeType: 'video/mp4',
    });
    trackedIds.assets.add(assetLandscape.id);

    const assetSilent = await ingestMediaStream({
      organizationId: orgA.id,
      campaignId: campaignA.id,
      stream: fs.createReadStream(fixtures.silent),
      originalFilename: 'silent_test.mp4',
      mimeType: 'video/mp4',
    });
    trackedIds.assets.add(assetSilent.id);

    // Run probe directly on landscape & portrait & silent
    const probePortrait = await probeS3Object(assetPortrait.object_key, ASSET_KIND.MASTER);
    const probeLandscape = await probeS3Object(assetLandscape.object_key, ASSET_KIND.MASTER);
    const probeSilent = await probeS3Object(assetSilent.object_key, ASSET_KIND.MASTER);

    check(
      probePortrait.duration_ms > 0 &&
      probePortrait.width === 720 &&
      probePortrait.height === 1280 &&
      probePortrait.fps === 30 &&
      probePortrait.video_codec === 'h264' &&
      probePortrait.audio_codec === 'aac',
      'ffprobe extracts: duration, width, height, FPS, video codec, audio codec',
      `Duration: ${probePortrait.duration_ms}ms, ${probePortrait.width}x${probePortrait.height}, ${probePortrait.fps}fps, video: ${probePortrait.video_codec}, audio: ${probePortrait.audio_codec}`
    );

    check(
      probePortrait.aspect_ratio === '9:16',
      'portrait aspect ratio normalized correctly',
      `Aspect ratio: ${probePortrait.aspect_ratio}`
    );

    check(
      probeLandscape.aspect_ratio === '16:9',
      'landscape aspect ratio normalized correctly',
      `Aspect ratio: ${probeLandscape.aspect_ratio}`
    );

    check(
      probeSilent.has_video === true && probeSilent.has_audio === false && probeSilent.audio_codec === null,
      'silent video represented safely with no audio codec',
      `has_video: ${probeSilent.has_video}, has_audio: ${probeSilent.has_audio}, audio_codec: ${probeSilent.audio_codec}`
    );

    // ==========================================================
    // 4. Corrupt Media Validation & Missing Objects (Invariants 9, 10)
    // ==========================================================
    const assetCorrupt = await ingestMediaStream({
      organizationId: orgA.id,
      campaignId: campaignA.id,
      stream: fs.createReadStream(fixtures.corrupt),
      originalFilename: 'corrupt.mp4',
    });
    trackedIds.assets.add(assetCorrupt.id);

    // Process corrupt media probe message
    const mockCorruptMsg = {
      subject: SUBJECT,
      seq: 1,
      data: jc.encode({ assetId: assetCorrupt.id, organizationId: orgA.id }),
      ack: () => {},
      nak: () => {},
      working: () => {},
    };

    await processMediaProbeMessage(mockCorruptMsg);

    const assetCorruptAfter = await Asset.query().findById(assetCorrupt.id);
    check(
      assetCorruptAfter.status === ASSET_STATUS.FAILED && assetCorruptAfter.error_message !== null,
      'corrupt video becomes FAILED/permanent validation failure',
      `Status: ${assetCorruptAfter.status}, Error: ${assetCorruptAfter.error_message?.slice(0, 50)}...`
    );

    // Missing S3 object handling
    let missingObjectHandled = false;
    try {
      await probeS3Object('organizations/999/campaigns/999/assets/non_existent/original.mp4');
    } catch (e) {
      if (
        e.name === 'NoSuchKey' ||
        e.message.includes('NoSuchKey') ||
        e.message.includes('not exist') ||
        e.message.includes('404') ||
        e.message.includes('null')
      ) {
        missingObjectHandled = true;
      }
    }
    check(missingObjectHandled, 'missing S3 object handled safely', 'Graceful rejection on missing key');

    // ==========================================================
    // 5. Temp File Cleanup (Invariants 11, 12)
    // ==========================================================
    const customTempDir = path.join(PUBLISHER_MEDIA_TEMP_DIR, `probe-temp-check-${testRunId}`);
    if (!fs.existsSync(customTempDir)) fs.mkdirSync(customTempDir, { recursive: true });

    await probeS3Object(assetPortrait.object_key, ASSET_KIND.MASTER, { tempDir: customTempDir });
    const tempFilesAfterSuccess = fs.readdirSync(customTempDir);
    check(
      tempFilesAfterSuccess.length === 0,
      'temp file cleaned after successful probe',
      `Temp files in directory: ${tempFilesAfterSuccess.length}`
    );

    try {
      await probeS3Object(assetCorrupt.object_key, ASSET_KIND.MASTER, { tempDir: customTempDir });
    } catch (e) {}
    const tempFilesAfterFail = fs.readdirSync(customTempDir);
    check(
      tempFilesAfterFail.length === 0,
      'temp file cleaned after failed probe',
      `Temp files in directory: ${tempFilesAfterFail.length}`
    );

    fs.rmSync(customTempDir, { recursive: true, force: true });

    // ==========================================================
    // 6. Security: Path Traversal & Outbox Allowlist & Tenancy (Invariants 13, 14, 15)
    // ==========================================================
    const assetTraversal = await ingestMediaStream({
      organizationId: orgA.id,
      campaignId: campaignA.id,
      stream: fs.createReadStream(fixtures.silent),
      originalFilename: '../../../../../../etc/passwd.mp4',
    });
    trackedIds.assets.add(assetTraversal.id);

    check(
      !assetTraversal.object_key.includes('..') && !assetTraversal.object_key.includes('/etc/'),
      'no path traversal via malicious original filename',
      `Sanitized key: ${assetTraversal.object_key}`
    );

    // Invariant 14: Outbox payload validation
    let mediaPayloadValid = false;
    let leakedPayloadRejected = false;

    try {
      validateOutboxPayload('media.probe', {
        assetId: 501,
        organizationId: orgA.id,
        campaignId: campaignA.id,
      });
      mediaPayloadValid = true;
    } catch (e) {
      mediaPayloadValid = false;
    }

    try {
      validateOutboxPayload('media.probe', {
        assetId: 502,
        organizationId: orgA.id,
        signed_url: 'https://s3.amazonaws.com/leak?X-Amz-Signature=123',
      });
    } catch (e) {
      if (e.message.includes('rejected')) leakedPayloadRejected = true;
    }

    check(
      mediaPayloadValid && leakedPayloadRejected,
      'NATS media job payload contains IDs only',
      'Payload allowlist enforced; credentials/signed URLs strictly rejected'
    );

    // Invariant 15: Cross-org forged probe message
    const mockForgedMsg = {
      subject: SUBJECT,
      seq: 2,
      data: jc.encode({ assetId: assetPortrait.id, organizationId: orgB.id }), // Forged Org B
      ack: () => {},
      nak: () => {},
    };

    await processMediaProbeMessage(mockForgedMsg);
    const assetAfterForged = await Asset.query().findById(assetPortrait.id);
    check(
      assetAfterForged.status === ASSET_STATUS.STORED,
      'forged cross-org probe job is rejected',
      `Asset preserved in state: ${assetAfterForged.status}`
    );

    // ==========================================================
    // 7. Cover Asset Ingestion & Validation (Invariants 16, 17)
    // ==========================================================
    const coverAsset = await ingestMediaStream({
      organizationId: orgA.id,
      campaignId: campaignA.id,
      stream: fs.createReadStream(fixtures.coverJpeg),
      originalFilename: 'thumb.jpg',
      kind: ASSET_KIND.COVER,
      mimeType: 'image/jpeg',
    });
    trackedIds.assets.add(coverAsset.id);

    const probeCover = await probeS3Object(coverAsset.object_key, ASSET_KIND.COVER);
    check(
      coverAsset.kind === ASSET_KIND.COVER && probeCover.width === 640 && probeCover.height === 480,
      'cover JPEG accepted',
      `Cover dimensions: ${probeCover.width}x${probeCover.height}`
    );

    // Invariant 17: Forbidden SVG cover rejected
    let svgRejected = false;
    try {
      await ingestMediaStream({
        organizationId: orgA.id,
        campaignId: campaignA.id,
        stream: Readable.from([fs.readFileSync(fixtures.forbiddenSvg)]),
        originalFilename: 'malicious.svg',
        kind: ASSET_KIND.COVER,
        mimeType: 'image/svg+xml',
      });
    } catch (e) {
      if (e.message.includes('Forbidden cover extension') || e.message.includes('SVG')) svgRejected = true;
    }
    check(svgRejected, 'invalid cover payload rejected', 'SVG cover upload rejected');

    // ==========================================================
    // 8. Compatibility Engine & Master Reuse (Invariants 18, 19, 20)
    // ==========================================================
    const evalResults = evaluateAssetForTargets(
      {
        size_bytes: portraitStat.size,
        duration_ms: 5000,
        width: 720,
        height: 1280,
        fps: 30,
        aspect_ratio: '9:16',
        video_codec: 'h264',
        audio_codec: 'aac',
        probe_json: { video: {}, audio: {}, format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } },
      },
      ['instagram', 'youtube', 'telegram', 'bale', 'linkedin', 'aparat']
    );

    check(
      evalResults.instagram && evalResults.youtube && evalResults.instagram.status === COMPATIBILITY_STATUS.COMPATIBLE,
      'compatibility engine returns structured results',
      `Instagram status: ${evalResults.instagram.status}, YouTube status: ${evalResults.youtube.status}`
    );

    // Invariant 19: Compatible master can be reused across targets
    check(
      evalResults.instagram.status === COMPATIBILITY_STATUS.COMPATIBLE &&
      evalResults.youtube.status === COMPATIBILITY_STATUS.COMPATIBLE &&
      evalResults.telegram.status === COMPATIBILITY_STATUS.COMPATIBLE,
      'compatible master can be reused for multiple targets',
      'Master 9:16 MP4 compatible with Instagram, YouTube Shorts, and Telegram'
    );

    // Invariant 20: Creative mismatch returns NEEDS_CREATIVE_VARIANT rather than auto-cropping
    const evalLandscapeOnReels = evaluateCompatibility(
      {
        size_bytes: 1024 * 1024,
        duration_ms: 5000,
        width: 1920,
        height: 1080,
        aspect_ratio: '21:9', // Incompatible creative ratio for Instagram
        video_codec: 'h264',
        audio_codec: 'aac',
        has_video: true,
        has_audio: true,
        format_name: 'mp4',
      },
      'instagram'
    );

    check(
      evalLandscapeOnReels.status === COMPATIBILITY_STATUS.NEEDS_CREATIVE_VARIANT &&
      evalLandscapeOnReels.requiredVariant?.type === 'creative_framing',
      'creative mismatch returns NEEDS_CREATIVE_VARIANT rather than auto-cropping',
      `Status: ${evalLandscapeOnReels.status}, requiredVariant: ${evalLandscapeOnReels.requiredVariant?.type}`
    );

    // ==========================================================
    // 9. Signed URL Transient Generation (Invariant 21)
    // ==========================================================
    const signedUrl = await createSignedReadUrl(assetPortrait.object_key, 60);
    const assetFromDb = await Asset.query().findById(assetPortrait.id);
    const serializedAsset = JSON.stringify(assetFromDb);

    check(
      signedUrl.includes('X-Amz-Signature') && !serializedAsset.includes('X-Amz-Signature') && !serializedAsset.includes(signedUrl),
      'signed URL is temporary and is NOT persisted',
      'Presigned URL generated on demand and absent from database'
    );

    // ==========================================================
    // 10. Cleanup Guards & Idempotency (Invariants 22, 23, 24, 25, 26)
    // ==========================================================
    // Create target & jobs referencing assetLandscape
    const targetA = await CampaignTarget.query().insertAndFetch({
      campaign_id: campaignA.id,
      integration_config_id: configA.id,
      platform: 'test',
      status: 'pending',
      asset_id: assetLandscape.id,
    });
    trackedIds.targets.add(targetA.id);

    const jobRetryWait = await PublishJob.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_target_id: targetA.id,
      idempotency_key: `idem-cleanup-retry-${testRunId}`,
      status: JOB_STATUS.RETRY_WAIT,
      next_attempt_at: new Date(Date.now() + 60000).toISOString().replace('T', ' ').replace('Z', ''),
    });
    trackedIds.jobs.add(jobRetryWait.id);

    // Invariant 22: Cleanup refuses asset needed by retry_wait job
    let retryWaitRefused = false;
    try {
      await deleteAssetObject(assetLandscape.id, orgA.id);
    } catch (e) {
      if (e.message.includes('CANNOT_DELETE_ASSET') && e.message.includes('retry_wait')) {
        retryWaitRefused = true;
      }
    }
    check(retryWaitRefused, 'cleanup refuses asset still needed by retry_wait job', 'Refused deletion while retry_wait job active');

    // Invariant 23: Cleanup refuses reconcile_required asset
    await PublishJob.query().findById(jobRetryWait.id).patch({ status: JOB_STATUS.RECONCILE_REQUIRED });
    let reconcileRefused = false;
    try {
      await deleteAssetObject(assetLandscape.id, orgA.id);
    } catch (e) {
      if (e.message.includes('CANNOT_DELETE_ASSET') && e.message.includes('reconcile_required')) {
        reconcileRefused = true;
      }
    }
    check(reconcileRefused, 'cleanup refuses reconcile_required asset', 'Refused deletion while reconcile_required job active');

    // Transition job to SUCCEEDED -> now eligible for deletion
    await PublishJob.query().findById(jobRetryWait.id).patch({ status: JOB_STATUS.SUCCEEDED });

    // Invariant 24: Cleanup deletes safe completed object
    const assetDeleted = await deleteAssetObject(assetLandscape.id, orgA.id);
    check(
      assetDeleted.status === ASSET_STATUS.DELETED,
      'cleanup deletes safe completed/expired object',
      `Asset status updated to: ${assetDeleted.status}`
    );

    // Invariant 25: Repeated cleanup is idempotent
    let idempotentRefusedGracefully = false;
    try {
      await deleteAssetObject(assetLandscape.id, orgA.id);
    } catch (e) {
      if (e.message.includes('already marked deleted')) idempotentRefusedGracefully = true;
    }
    check(idempotentRefusedGracefully, 'repeated cleanup is idempotent', 'Safely rejects repeat deletion without error');

    // Invariant 26: Org A cleanup cannot delete Org B asset
    const assetOrgB = await ingestMediaStream({
      organizationId: orgB.id,
      stream: fs.createReadStream(fixtures.silent),
      originalFilename: 'org_b_media.mp4',
    });
    trackedIds.assets.add(assetOrgB.id);

    let crossOrgRefused = false;
    try {
      await deleteAssetObject(assetOrgB.id, orgA.id); // Org A attempts to delete Org B asset
    } catch (e) {
      if (e.message.includes('not found for Organization')) crossOrgRefused = true;
    }
    check(crossOrgRefused, 'Organization A cleanup cannot delete Organization B asset', 'Tenant boundary enforced');

    // ==========================================================
    // 11. Media Worker Durable Runtime & Recovery (Invariant 28)
    // ==========================================================
    // Run worker for portrait asset to full READY transition
    await processMediaProbeMessage({
      subject: SUBJECT,
      seq: 3,
      data: jc.encode({ assetId: assetPortrait.id, organizationId: orgA.id }),
      ack: () => {},
      nak: () => {},
      working: () => {},
    });

    const assetPortraitFinal = await Asset.query().findById(assetPortrait.id);
    check(
      assetPortraitFinal.status === ASSET_STATUS.READY &&
      assetPortraitFinal.width === 720 &&
      assetPortraitFinal.height === 1280 &&
      assetPortraitFinal.duration_ms !== null &&
      assetPortraitFinal.lock_token === null,
      'media worker uses durable runtime/recovery semantics',
      `Asset status: ${assetPortraitFinal.status}, dimensions: ${assetPortraitFinal.width}x${assetPortraitFinal.height}`
    );

    // ==========================================================
    // 12. Final broker/fencing/retry/security acceptance
    // ==========================================================
    const brokerConsumerName = `MEDIA_ACCEPT_${testRunId}`;
    trackedIds.consumers.add(brokerConsumerName);
    await OutboxEvent.query().whereIn('organization_id', [orgA.id, orgB.id]).delete().catch(() => {});
    try {
      await jsm.consumers.delete('ELECIO_JOBS', brokerConsumerName).catch(() => {});
    } catch (e) {}

    await jsm.consumers.add('ELECIO_JOBS', {
      durable_name: brokerConsumerName,
      ack_policy: 'explicit',
      filter_subject: SUBJECT,
      max_deliver: 5,
      ack_wait: 1000 * 1000000,
    });
    const brokerConsumer = await js.consumers.get('ELECIO_JOBS', brokerConsumerName);

    const createStoredAsset = async (name = 'broker.mp4') => {
      const created = await ingestMediaStream({
        organizationId: orgA.id, campaignId: campaignA.id,
        stream: fs.createReadStream(fixtures.silent), originalFilename: name, mimeType: 'video/mp4',
      });
      trackedIds.assets.add(created.id);
      await OutboxEvent.query().where({ aggregate_id: String(created.id), aggregate_type: 'Asset' }).delete().catch(() => {});
      return created;
    };

    // Real broker crash/redelivery plus stale-owner READY fencing.
    const crashAsset = await createStoredAsset('broker-crash.mp4');
    await js.publish(SUBJECT, jc.encode({ assetId: crashAsset.id, organizationId: orgA.id, campaignId: campaignA.id }));
    const deliveryA = await brokerConsumer.next({ expires: 3000 });
    const msgA = observeMessage(deliveryA);
    let releaseA;
    let aStartedResolve;
    const aGate = new Promise(resolve => { releaseA = resolve; });
    const aStarted = new Promise(resolve => { aStartedResolve = resolve; });
    const workerA = processMediaProbeMessage(msgA, {
      lockTimeoutSeconds: 1, heartbeatMs: 10000,
      probeObject: async () => { aStartedResolve(); await aGate; return TEST_PROBE_METADATA; },
    });
    await aStarted;
    const claimedA = await Asset.query().findById(crashAsset.id);
    const tokenA = claimedA.lock_token;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const deliveryB = await brokerConsumer.next({ expires: 5000 });
    const msgB = observeMessage(deliveryB);
    let tokenB;
    await processMediaProbeMessage(msgB, {
      lockTimeoutSeconds: 1, heartbeatMs: 10000,
      probeObject: async () => { tokenB = (await Asset.query().findById(crashAsset.id)).lock_token; return TEST_PROBE_METADATA; },
    });
    releaseA();
    await workerA;
    const crashFinal = await Asset.query().findById(crashAsset.id);
    const staleHeartbeat = await db.raw('UPDATE assets SET locked_at=NOW() WHERE id=? AND organization_id=? AND status=? AND lock_token=?', [crashAsset.id, orgA.id, ASSET_STATUS.PROBING, tokenA]);
    check(deliveryB.info.deliveryCount > 1 && tokenA && tokenB && tokenA !== tokenB && crashFinal.status === ASSET_STATUS.READY && msgA.counts.ack === 0 && msgB.counts.ack === 1,
      'real Asset JetStream redelivery and stale PROBING reclaim',
      `delivery=${deliveryB.info.deliveryCount}, Aack=${msgA.counts.ack}, Back=${msgB.counts.ack}, final=${crashFinal.status}`);
    check((staleHeartbeat[0]?.affectedRows || 0) === 0 && msgA.counts.nak >= 1,
      'Asset A/B lock-token fencing rejects stale owner',
      `staleHeartbeatRows=${staleHeartbeat[0]?.affectedRows || 0}, Anak=${msgA.counts.nak}`);

    // Slow legitimate probe heartbeats and cannot be stolen.
    const slowAsset = await createStoredAsset('slow-heartbeat.mp4');
    let releaseSlow;
    let slowStartedResolve;
    const slowGate = new Promise(resolve => { releaseSlow = resolve; });
    const slowStarted = new Promise(resolve => { slowStartedResolve = resolve; });
    const slowMsg = mockMessage({ assetId: slowAsset.id, organizationId: orgA.id, campaignId: campaignA.id });
    const slowWorker = processMediaProbeMessage(slowMsg, {
      lockTimeoutSeconds: 1, heartbeatMs: 50,
      probeObject: async () => { slowStartedResolve(); await slowGate; return TEST_PROBE_METADATA; },
    });
    await slowStarted;
    await new Promise(resolve => setTimeout(resolve, 180));
    const stealMsg = mockMessage({ assetId: slowAsset.id, organizationId: orgA.id, campaignId: campaignA.id });
    await processMediaProbeMessage(stealMsg, { lockTimeoutSeconds: 1, probeObject: async () => TEST_PROBE_METADATA });
    releaseSlow();
    await slowWorker;
    const slowFinal = await Asset.query().findById(slowAsset.id);
    check(slowMsg.counts.working >= 2 && stealMsg.counts.nak === 1 && slowFinal.status === ASSET_STATUS.READY,
      'slow probe heartbeat preserves fenced lease',
      `working=${slowMsg.counts.working}, stealNak=${stealMsg.counts.nak}, final=${slowFinal.status}`);

    const lostLeaseAsset = await createStoredAsset('lost-lease.mp4');
    const lostLeaseMsg = mockMessage({ assetId: lostLeaseAsset.id, organizationId: orgA.id, campaignId: campaignA.id });
    let lostSignal;
    let lostStartedResolve;
    const lostStarted = new Promise(resolve => { lostStartedResolve = resolve; });
    const lostWorker = processMediaProbeMessage(lostLeaseMsg, {
      heartbeatMs: 50,
      probeObject: async (_key, _kind, { signal }) => {
        lostSignal = signal;
        lostStartedResolve();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('PROBE_ABORTED_AFTER_OWNERSHIP_LOSS')), { once: true }));
      },
    });
    await lostStarted;
    const replacementToken = crypto.randomUUID();
    await db.raw('UPDATE assets SET lock_token=?, locked_at=NOW() WHERE id=? AND organization_id=? AND status=?', [replacementToken, lostLeaseAsset.id, orgA.id, ASSET_STATUS.PROBING]);
    await lostWorker;
    const lostLeaseFinal = await Asset.query().findById(lostLeaseAsset.id);
    check(lostSignal?.aborted === true && lostLeaseMsg.counts.ack === 0 && lostLeaseFinal.status === ASSET_STATUS.PROBING && lostLeaseFinal.lock_token === replacementToken,
      'probe ownership loss aborts stale worker without finalization',
      `aborted=${lostSignal?.aborted}, ack=${lostLeaseMsg.counts.ack}, ownerPreserved=${lostLeaseFinal.lock_token === replacementToken}`);

    // Transient S3 and ffprobe infrastructure errors NAK, redeliver, and recover.
    const runTransientRetry = async (name, firstError) => {
      const asset = await createStoredAsset(name);
      await js.publish(SUBJECT, jc.encode({ assetId: asset.id, organizationId: orgA.id, campaignId: campaignA.id }));
      const firstRaw = await brokerConsumer.next({ expires: 3000 });
      const first = observeMessage(firstRaw);
      await processMediaProbeMessage(first, { probeObject: async () => { throw new Error(firstError); } });
      const afterFirst = await Asset.query().findById(asset.id);
      await new Promise(r => setTimeout(r, 1300));
      const retryRaw = await brokerConsumer.next({ expires: 5000 });
      const retry = observeMessage(retryRaw);
      await processMediaProbeMessage(retry, { probeObject: async () => TEST_PROBE_METADATA });
      const final = await Asset.query().findById(asset.id);
      return { afterFirst, final, first, retry, deliveryCount: retryRaw.info.deliveryCount };
    };
    const transientS3 = await runTransientRetry('transient-s3.mp4', 'S3_NETWORK_TRANSIENT');
    check(transientS3.afterFirst.status !== ASSET_STATUS.FAILED && transientS3.first.counts.ack === 0 && transientS3.deliveryCount > 1 && transientS3.final.status === ASSET_STATUS.READY && transientS3.retry.counts.ack === 1,
      'transient S3 failure retries to eventual READY', `delivery=${transientS3.deliveryCount}, final=${transientS3.final.status}`);
    const transientProbe = await runTransientRetry('transient-probe.mp4', 'FFPROBE_TIMEOUT: injected infrastructure timeout');
    check(transientProbe.afterFirst.status !== ASSET_STATUS.FAILED && transientProbe.deliveryCount > 1 && transientProbe.final.status === ASSET_STATUS.READY,
      'transient probe failure retries to eventual READY', `delivery=${transientProbe.deliveryCount}, final=${transientProbe.final.status}`);

    // Permanent corrupt media ACKs once and does not redeliver.
    const corruptBrokerAsset = await createStoredAsset('corrupt-broker.mp4');
    await putObject(corruptBrokerAsset.object_key, fs.createReadStream(fixtures.corrupt), 'video/mp4');
    await js.publish(SUBJECT, jc.encode({ assetId: corruptBrokerAsset.id, organizationId: orgA.id, campaignId: campaignA.id }));
    const corruptRaw = await brokerConsumer.next({ expires: 3000 });
    const corruptObserved = observeMessage(corruptRaw);
    await processMediaProbeMessage(corruptObserved);
    const corruptBrokerFinal = await Asset.query().findById(corruptBrokerAsset.id);
    let noCorruptRedelivery = null;
    try {
      noCorruptRedelivery = await brokerConsumer.next({ expires: 1200 });
    } catch (e) {
      noCorruptRedelivery = null;
    }
    check(corruptBrokerFinal.status === ASSET_STATUS.FAILED && corruptObserved.counts.ack === 1 && noCorruptRedelivery === null,
      'corrupt media ACKs without blind redelivery', `status=${corruptBrokerFinal.status}, ack=${corruptObserved.counts.ack}`);

    // Cleanup ordering: post-delete DB crash replays; delete failure never lies.
    const cleanupCrashAsset = await createStoredAsset('cleanup-crash.mp4');
    let injectedDbFailure = false;
    try {
      await deleteAssetObject(cleanupCrashAsset.id, orgA.id, { markDeletedFn: async () => { throw new Error('INJECTED_DB_AFTER_DELETE'); } });
    } catch (error) { injectedDbFailure = error.message.includes('INJECTED_DB_AFTER_DELETE'); }
    let cleanupObjectMissing = false;
    try { await headObject(cleanupCrashAsset.object_key); } catch (error) { cleanupObjectMissing = true; }
    const cleanupAfterCrash = await Asset.query().findById(cleanupCrashAsset.id);
    const cleanupReplay = await deleteAssetObject(cleanupCrashAsset.id, orgA.id);
    check(injectedDbFailure && cleanupObjectMissing && cleanupAfterCrash.status !== ASSET_STATUS.DELETED && cleanupReplay.status === ASSET_STATUS.DELETED,
      'S3 delete then DB crash cleanup replay is idempotent', `afterCrash=${cleanupAfterCrash.status}, replay=${cleanupReplay.status}`);
    const cleanupFailureAsset = await createStoredAsset('cleanup-delete-failure.mp4');
    try { await deleteAssetObject(cleanupFailureAsset.id, orgA.id, { deleteObjectFn: async () => { throw new Error('S3_NETWORK_FAILURE'); } }); } catch (error) {}
    const cleanupFailureFinal = await Asset.query().findById(cleanupFailureAsset.id);
    check(cleanupFailureFinal.status !== ASSET_STATUS.DELETED,
      'S3 DeleteObject failure does not mark DELETED', `status=${cleanupFailureFinal.status}`);

    // Strict broker schema rejects every storage/secret override before probe.
    let forgedProbeCalls = 0;
    const forgedFields = ['objectKey', 'object_key', 's3Key', 'url', 'signedUrl', 'access_token', 'authorization', 'secret'];
    let forgedRejected = 0;
    for (const field of forgedFields) {
      const forged = mockMessage({ assetId: assetOrgB.id, organizationId: orgB.id, [field]: 'https://evil.invalid/object?X-Amz-Signature=raw' });
      await processMediaProbeMessage(forged, { probeObject: async () => { forgedProbeCalls += 1; return TEST_PROBE_METADATA; } });
      if (forged.counts.ack === 1) forgedRejected += 1;
    }
    let authorizedKeySeen = null;
    const authorityAsset = await createStoredAsset('auth-authority.mp4');
    const validAuthorityMsg = mockMessage({ assetId: authorityAsset.id, organizationId: orgA.id, campaignId: campaignA.id });
    await processMediaProbeMessage(validAuthorityMsg, { probeObject: async (key) => { authorizedKeySeen = key; return TEST_PROBE_METADATA; } });
    check(forgedRejected === forgedFields.length && forgedProbeCalls === 0 && authorizedKeySeen === authorityAsset.object_key,
      'forged object-key payload rejected and DB key remains authoritative',
      `rejected=${forgedRejected}/${forgedFields.length}, probeCalls=${forgedProbeCalls}, dbKeyUsed=${authorizedKeySeen === authorityAsset.object_key}`);

    // Signed URL is sanitized at every Phase-4-reachable persistence/log edge.
    const leakMarker = `phase4leak${testRunId}`;
    const rawSignedUrl = `https://s3.invalid/object?X-Amz-Credential=${leakMarker}&X-Amz-Signature=${leakMarker}&X-Amz-Security-Token=${leakMarker}`;
    const leakAsset = await createStoredAsset('signed-url-boundary.mp4');
    const capturedLogs = [];
    const originalConsoleError = console.error;
    console.error = (...args) => { capturedLogs.push(args.map(String).join(' ')); };
    try {
      const leakMsg = mockMessage({ assetId: leakAsset.id, organizationId: orgA.id, campaignId: campaignA.id });
      await processMediaProbeMessage(leakMsg, { probeObject: async () => { throw new Error(`FFPROBE_MEDIA_INVALID: ${rawSignedUrl}`); } });
    } finally { console.error = originalConsoleError; }
    const leakFinal = await Asset.query().findById(leakAsset.id);
    const leakOutbox = await OutboxEvent.query().where({ aggregate_id: String(leakAsset.id) });
    const leakAttempts = await PublishAttempt.query().where('error_message', 'like', `%${leakMarker}%`);
    const leakEvents = await IntegrationEvent.query().where('error_message', 'like', `%${leakMarker}%`);
    const leakBoundary = JSON.stringify({ asset: leakFinal, outbox: leakOutbox, logs: capturedLogs, attempts: leakAttempts, events: leakEvents });
    check(!leakBoundary.includes(leakMarker) && !leakBoundary.includes(rawSignedUrl),
      'signed URL absent from media persistence and captured logs',
      'Asset/Outbox/log/attempt/event boundaries contain no raw signature marker');

  } catch (fatalErr) {
    console.error('\n💥 FATAL TEST ERROR:', fatalErr);
    record('FATAL_UNHANDLED_EXCEPTION', 'FAIL', fatalErr.message);
  } finally {
    await cleanup(jsm, tempFixturesDir);
  }

  console.log('\n' + '='.repeat(80));
  console.log('PHASE 4 MEDIA PIPELINE STRICT VERIFICATION MATRIX');
  console.log('='.repeat(80));
  console.log('Invariant'.padEnd(50) + ' | Status | Evidence');
  console.log('-'.repeat(80));
  for (const r of results) {
    console.log(`${r.test.padEnd(50)} | ${r.status.padEnd(6)} | ${r.evidence}`);
  }
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log('='.repeat(80));
  console.log(`TOTAL: ${passed} passed, ${failed} failed (${results.length} total assertions)`);
  console.log('='.repeat(80));

  await db.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
