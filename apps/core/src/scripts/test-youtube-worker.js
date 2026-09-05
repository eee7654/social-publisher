import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import getDb from '../config/database.js';
import { initJetStream } from '../services/messaging/jetstream.js';
import { startWorker, processJob } from '../publisher/worker.js';
import { youtubePublishHandler } from '../publisher/handlers/youtubePublishHandler.js';
import { encryptConfigValue, decryptConfigValue } from '../integrations/secrets.js';
import { ASSET_STATUS, ASSET_KIND } from '../publisher/media/constants.js';

if (process.env.NODE_ENV === 'test' && !process.env.DB_NAME.endsWith('_test')) {
  process.env.DB_NAME = `${process.env.DB_NAME}_test`;
}

const db = getDb();
const testRunId = crypto.randomBytes(4).toString('hex');
const CONSUMER_NAME = `YT_WORKER_TEST_${testRunId}`;
const SUBJECT = 'jobs.publish.youtube.test';
const STREAM_NAME = 'ELECIO_JOBS';

const trackedIds = {
  orgs: new Set(),
  providers: new Set(),
  configs: new Set(),
  campaigns: new Set(),
  targets: new Set(),
  jobs: new Set(),
  outbox: new Set(),
  assets: new Set()
};

async function cleanup(jsm) {
  try {
    if (jsm) await jsm.consumers.delete(STREAM_NAME, CONSUMER_NAME).catch(() => {});
    const { default: OutboxEvent } = await import('../db/models/core/OutboxEvent.js');
    const { default: PublishAttempt } = await import('../db/models/core/PublishAttempt.js');
    const { default: PublishJob } = await import('../db/models/core/PublishJob.js');
    const { default: Asset } = await import('../db/models/core/Asset.js');
    const { default: CampaignTarget } = await import('../db/models/core/CampaignTarget.js');
    const { default: Campaign } = await import('../db/models/core/Campaign.js');
    const { default: IntegrationConfig } = await import('../db/models/core/IntegrationConfig.js');
    const { default: IntegrationProvider } = await import('../db/models/core/IntegrationProvider.js');
    const { default: Organization } = await import('../db/models/core/Organization.js');
    const { default: User } = await import('../db/models/core/User.js');
    
    OutboxEvent.knex(db); PublishAttempt.knex(db); PublishJob.knex(db); Asset.knex(db); CampaignTarget.knex(db); Campaign.knex(db); IntegrationConfig.knex(db); IntegrationProvider.knex(db); Organization.knex(db); User.knex(db);
    
    if (trackedIds.attempts?.size > 0) await PublishAttempt.query().whereIn('id', Array.from(trackedIds.attempts)).delete();
    if (trackedIds.outbox.size > 0) await OutboxEvent.query().whereIn('id', Array.from(trackedIds.outbox)).delete();
    if (trackedIds.jobs.size > 0) await PublishJob.query().whereIn('id', Array.from(trackedIds.jobs)).delete();
    if (trackedIds.assets.size > 0) await Asset.query().whereIn('id', Array.from(trackedIds.assets)).delete();
    if (trackedIds.targets.size > 0) await CampaignTarget.query().whereIn('id', Array.from(trackedIds.targets)).delete();
    if (trackedIds.campaigns.size > 0) await Campaign.query().whereIn('id', Array.from(trackedIds.campaigns)).delete();
    if (trackedIds.configs.size > 0) await IntegrationConfig.query().whereIn('id', Array.from(trackedIds.configs)).delete();
    if (trackedIds.providers.size > 0) await IntegrationProvider.query().whereIn('id', Array.from(trackedIds.providers)).delete();
    if (trackedIds.orgs.size > 0) await Organization.query().whereIn('id', Array.from(trackedIds.orgs)).delete();
    await db('user').where('id', `test-user-yt-${testRunId}`).delete();
  } catch (err) {}
}

const tests = [];
async function test(name, fn) { try { await fn(); tests.push([name, true]); } catch (e) { tests.push([name, false, e.stack]); } }

async function runTests() {
  let js, jsm;
  const { default: OutboxEvent } = await import('../db/models/core/OutboxEvent.js');
  const { default: PublishJob } = await import('../db/models/core/PublishJob.js');
  const { default: Asset } = await import('../db/models/core/Asset.js');
  const { default: CampaignTarget } = await import('../db/models/core/CampaignTarget.js');
  const { default: Campaign } = await import('../db/models/core/Campaign.js');
  const { default: IntegrationConfig } = await import('../db/models/core/IntegrationConfig.js');
  const { default: IntegrationProvider } = await import('../db/models/core/IntegrationProvider.js');
  const { default: Organization } = await import('../db/models/core/Organization.js');
  const { default: User } = await import('../db/models/core/User.js');
  const { putObject } = await import('../services/storage/s3.js');
  const { dispatchBatch } = await import('../publisher/dispatcher.js');
  const { JSONCodec } = await import('nats');
  const jc = JSONCodec();
  
  OutboxEvent.knex(db); PublishJob.knex(db); Asset.knex(db); CampaignTarget.knex(db); Campaign.knex(db); IntegrationConfig.knex(db); IntegrationProvider.knex(db); Organization.knex(db); User.knex(db);

  try {
    await test('Worker entrypoint uses YouTube context-loading handler', async () => {
      const candidatePaths = [
        path.join(process.cwd(), 'src/scripts/publisher-youtube-worker.js'),
        path.join(process.cwd(), 'apps/core/src/scripts/publisher-youtube-worker.js'),
      ];
      let entrypoint = null;
      for (const p of candidatePaths) {
        try {
          entrypoint = await fs.readFile(p, 'utf8');
          break;
        } catch {}
      }
      assert.ok(entrypoint, 'publisher-youtube-worker.js entrypoint file must be found');
      assert.ok(entrypoint.includes("import { youtubePublishHandler } from '../publisher/handlers/youtubePublishHandler.js';"));
      assert.ok(entrypoint.includes('startWorker(SUBJECT, WORKER_NAME, youtubePublishHandler'));
      assert.equal(entrypoint.includes("import { publishToYouTube } from '../publisher/platforms/youtube/adapter.js';"), false);
    });

    const jetstream = await initJetStream();
    js = jetstream.js;
    jsm = jetstream.jsm;

    await jsm.consumers.add(STREAM_NAME, {
      durable_name: CONSUMER_NAME,
      ack_policy: 'explicit',
      deliver_policy: 'all',
      filter_subject: SUBJECT,
      max_deliver: 10,
      ack_wait: 500 * 1000000,
    });

    const org = await Organization.query().insertAndFetch({ name: `Org YT (${testRunId})`, slug: `org-yt-${testRunId}`, is_active: true }); trackedIds.orgs.add(org.id);
    const admin = await db('roles').where({ name: 'admin' }).first();
    await db('user').insert({ id: `test-user-yt-${testRunId}`, name: 'YT Test', email: `yttest${testRunId}@example.com`, emailVerified: false, role_id: admin ? admin.id : null, createdAt: new Date(), updatedAt: new Date() });
    const provider = await IntegrationProvider.query().insertAndFetch({ domain: 'publishing', code: `yt_test_${testRunId}`, display_name: 'YT Test', adapter_key: 'publishing.youtube', is_enabled: true }); trackedIds.providers.add(provider.id);
    const config = await IntegrationConfig.query().insertAndFetch({ provider_id: provider.id, organization_id: org.id, name: `YT Config (${testRunId})`, config_json: { refresh_token: encryptConfigValue('mock_refresh_token') }, status: 'active' }); trackedIds.configs.add(config.id);
    const campaign = await Campaign.query().insertAndFetch({ organization_id: org.id, source_type: 'api', status: 'ready', base_title: `YT Campaign (${testRunId})`, created_by: `test-user-yt-${testRunId}` }); trackedIds.campaigns.add(campaign.id);
    const target = await CampaignTarget.query().insertAndFetch({ campaign_id: campaign.id, integration_config_id: config.id, platform: 'youtube', status: 'pending', settings_json: { youtube_mode: 'SHORT' } }); trackedIds.targets.add(target.id);
    
    // Create a real small mock asset in S3
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-test-'));
    const dummyVideoPath = path.join(tempDir, 'dummy.mp4');
    await fs.writeFile(dummyVideoPath, 'dummy video content 100 bytes'.padEnd(100, '0'));
    const objectKey = `test/youtube_worker_${testRunId}.mp4`;
    await putObject(objectKey, (await import('fs')).createReadStream(dummyVideoPath), 'video/mp4');
    const asset = await Asset.query().insertAndFetch({ organization_id: org.id, campaign_id: campaign.id, kind: ASSET_KIND.VARIANT, status: ASSET_STATUS.READY, object_key: objectKey, mime_type: 'video/mp4', size_bytes: 100, width: 1080, height: 1920, aspect_ratio: '9:16', duration_ms: 5000 }); trackedIds.assets.add(asset.id);
    await target.$query().patch({ asset_id: asset.id });

    // Mock fetch for all test suites
    let fetchCalls = [];
    const originalFetch = global.fetch;
    let mockFetchState = 'normal';

    global.fetch = async (url, init) => {
      fetchCalls.push({ url, init });
      if (url === 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status') {
        const body = JSON.parse(init.body);
        assert.equal(body.status?.privacyStatus, 'private');
        assert.equal(body.status?.selfDeclaredMadeForKids, false);
        return new Response('', { headers: { location: 'https://mock/youtube/session' } });
      }
      if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/thumbnails/set')) {
        return new Response(JSON.stringify({ items: [{ default: { url: 'https://mock/thumb.jpg' } }] }), { status: 200 });
      }
      if (url.startsWith('https://www.googleapis.com/youtube/v3/videos')) {
        return new Response(JSON.stringify({ items: [{ id: 'test_video_id', contentDetails: { hasCustomThumbnail: true } }] }), { status: 200 });
      }
      if (url === 'https://mock/youtube/session' && init.method === 'PUT') {
        if (mockFetchState === 'crash_before_upload') {
          throw new Error('simulated_worker_crash');
        }
        if (init.headers['Content-Range']?.startsWith('bytes */')) {
          // Status check
          if (mockFetchState === 'expired_session') {
            return new Response('Gone', { status: 404 });
          }
          if (mockFetchState === 'ambiguous_chunk_completed') {
            return new Response(JSON.stringify({ id: 'ambiguous_video_id' }), { status: 200 });
          }
          if (mockFetchState === 'ambiguous_chunk_incomplete') {
            return new Response('', { status: 308, headers: { range: 'bytes=0-49' } });
          }
          return new Response('', { status: 308, headers: { range: 'bytes=0-49' } });
        }

        assert.equal(init.duplex, 'half');
        
        if (init.headers['Content-Range']?.startsWith('bytes 0-99')) {
          return new Response(JSON.stringify({ id: 'test_video_id_123' }), { status: 200 });
        } else if (init.headers['Content-Range']?.startsWith('bytes 50-99')) {
          return new Response(JSON.stringify({ id: 'test_video_id_456' }), { status: 200 });
        }
      }
      return new Response('', { status: 500 });
    };

    const { YouTubeApiClient } = await import('../publisher/platforms/youtube/api.js');
    const originalGetAccessToken = YouTubeApiClient.prototype.getAccessToken;
    YouTubeApiClient.prototype.getAccessToken = async function() { return 'mock_access_token'; };

    const makeJob = async () => {
      const job = await PublishJob.query().insertAndFetch({
        organization_id: org.id,
        idempotency_key: `test-job-yt-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
        campaign_target_id: target.id,
        status: 'queued',
        attempt_count: 0,
        max_attempts: 3,
        external_stage: 'NEW'
      });
      trackedIds.jobs.add(job.id);
      return job;
    };

    await test('Crash/Reclaim Mocked Worker with S3 bounded range', async () => {
      const job = await makeJob();
      
      // Inject outbox event and run dispatcher
      const outbox = await OutboxEvent.query().insertAndFetch({
        organization_id: org.id,
        aggregate_type: 'PublishJob',
        aggregate_id: String(job.id),
        event_type: SUBJECT,
        payload_json: { jobId: job.id, organizationId: org.id, campaignTargetId: target.id },
        status: 'pending'
      });
      trackedIds.outbox.add(outbox.id);
      
      await dispatchBatch(js); // Send to JetStream
      
      // We will manually process the job in a mock worker context to simulate the crash.
      // Worker A
      fetchCalls = [];
      mockFetchState = 'crash_before_upload';
      try {
        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: target.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);
      } catch (err) {}
      
      // Manually reset DB to simulate a hard crash (worker died before updating DB to failed)
      await PublishJob.knex().raw('UPDATE publish_jobs SET status = "running", last_error_message = NULL, locked_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?', [job.id]);
      
      const jobAfterCrash = await PublishJob.query().findById(job.id);
      console.log('CRASHED JOB RAW DB ROW:', jobAfterCrash);
      if (jobAfterCrash.external_stage !== 'UPLOADING') console.error('First test failed with:', jobAfterCrash.last_error_message);
      assert.equal(jobAfterCrash.external_stage, 'UPLOADING'); // Usually it's UPLOADING or SESSION_CREATED
      const sessionUri = decryptConfigValue(jobAfterCrash.sensitive_external_state_json.youtube.resumable_session_uri);
      assert.equal(sessionUri, 'https://mock/youtube/session');
      assert.equal(fetchCalls.filter(c => c.url.includes('uploadType=resumable')).length, 1);
      
      // Worker B reclaims
      fetchCalls = [];
      mockFetchState = 'normal';
      
      // Let's use the actual startWorker to consume the message, but it will process the job normally
      const ctrl = new AbortController();
      const workerPromise = startWorker(SUBJECT, CONSUMER_NAME, youtubePublishHandler, { signal: ctrl.signal });
      
      await new Promise(r => setTimeout(r, 1000)); // Wait for JetStream delivery
      ctrl.abort();
      await workerPromise.catch(() => {});
      
      const jobAfterReclaim = await PublishJob.query().findById(job.id);
      if (jobAfterReclaim.status !== 'succeeded') console.error('First test reclaim failed with:', jobAfterReclaim.last_error_message);
      assert.equal(jobAfterReclaim.status, 'succeeded');
      assert.equal(jobAfterReclaim.external_media_id, 'test_video_id_456');
      
      // Assert it didn't create a new session
      assert.equal(fetchCalls.filter(c => c.url.includes('uploadType=resumable')).length, 0);
      // Assert it queried status
      const statusCall = fetchCalls.find(c => c.init.headers['Content-Range']?.startsWith('bytes */'));
      assert.ok(statusCall);
      // Assert S3 Range bounded read by checking the Content-Range it sent
      const uploadCall = fetchCalls.find(c => c.init.headers['Content-Range']?.startsWith('bytes 50-99/100'));
      assert.ok(uploadCall);
    });

    await test('Ambiguous Final Chunk (completed in background)', async () => {
      const job = await makeJob();
      await job.$query().patch({ 
        external_stage: 'UPLOADING', 
        sensitive_external_state_json: { youtube: { resumable_session_uri: encryptConfigValue('https://mock/youtube/session') } } 
      });
      fetchCalls = [];
      mockFetchState = 'ambiguous_chunk_completed';
      
      const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: target.id }), ack: () => {}, nak: () => {}, working: () => {} };
      await processJob(mockMsg, youtubePublishHandler);
      const finalJob = await PublishJob.query().findById(job.id);
      if (finalJob.status !== 'succeeded') console.error('Ambiguous chunk failed with:', finalJob.last_error_message);
      assert.equal(finalJob.status, 'succeeded');
      assert.equal(finalJob.external_media_id, 'ambiguous_video_id');
      assert.equal(finalJob.sensitive_external_state_json, null);
    });

    await test('Expired Session Recovery safely aborts to RECONCILE_REQUIRED', async () => {
      const job = await makeJob();
      await job.$query().patch({ 
        external_stage: 'UPLOADING', 
        sensitive_external_state_json: { youtube: { resumable_session_uri: encryptConfigValue('https://mock/youtube/session') } } 
      });
      fetchCalls = [];
      mockFetchState = 'expired_session';
      
      try {
        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: target.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);
      } catch (err) {}
      const finalJob = await PublishJob.query().findById(job.id);
      if (finalJob.status !== 'reconcile_required') console.error('Third test failed with:', finalJob.last_error_message, finalJob.last_error_code);
      assert.ok(finalJob.last_error_message.includes('YouTube resumable session expired'));
      assert.equal(finalJob.last_error_code, 'YOUTUBE_RESUMABLE_SESSION_EXPIRED');
      // processJob sets it to reconcile_required
      assert.equal(finalJob.status, 'reconcile_required');
    });

    await test('Multi-chunk Byte-Exact Upload (SHA-256, Content-Type, Content-Length string, 256 KiB alignment, no gap/overlap)', async () => {
      const prevChunkEnv = process.env.YOUTUBE_UPLOAD_CHUNK_BYTES;
      process.env.YOUTUBE_UPLOAD_CHUNK_BYTES = String(256 * 1024);
      const chunkSize = 256 * 1024;
      const originalMcFetch = global.fetch;

      try {
        const totalSize = chunkSize * 2 + 17532; // 3 chunks: 2 full + 1 smaller final chunk
        const deterministicBuffer = Buffer.alloc(totalSize);
        for (let i = 0; i < totalSize; i++) {
          deterministicBuffer[i] = (i * 31 + 17) % 256;
        }
        const sourceSha256 = crypto.createHash('sha256').update(deterministicBuffer).digest('hex');

        const multiChunkFile = path.join(tempDir, 'multichunk.mp4');
        await fs.writeFile(multiChunkFile, deterministicBuffer);
        const multiObjectKey = `test/yt_multichunk_${testRunId}.mp4`;
        await putObject(multiObjectKey, (await import('fs')).createReadStream(multiChunkFile), 'video/mp4');

        const multiAsset = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.VARIANT,
          status: ASSET_STATUS.READY,
          object_key: multiObjectKey,
          mime_type: 'video/mp4',
          size_bytes: totalSize,
          width: 1080,
          height: 1920,
          aspect_ratio: '9:16',
          duration_ms: 5000
        });
        trackedIds.assets.add(multiAsset.id);

        const multiTarget = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: multiAsset.id,
          settings_json: { youtube_mode: 'SHORT' }
        });
        trackedIds.targets.add(multiTarget.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-mc-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: multiTarget.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        const receivedPutChunks = [];
        const recordedPuts = [];

        global.fetch = async (url, init) => {
          if (url === 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status') {
            assert.equal(init.method, 'POST');
            assert.equal(init.headers['X-Upload-Content-Type'], 'video/mp4');
            assert.equal(typeof init.headers['X-Upload-Content-Length'], 'string');
            assert.equal(init.headers['X-Upload-Content-Length'], String(totalSize));
            return new Response('', { headers: { location: 'https://mock/youtube/session_mc' } });
          }

          if (url === 'https://mock/youtube/session_mc' && init.method === 'PUT') {
            assert.equal(init.duplex, 'half');
            assert.equal(init.headers['Content-Type'], 'video/mp4');
            assert.equal(typeof init.headers['Content-Length'], 'string');

            const contentRange = init.headers['Content-Range'];
            assert.ok(contentRange, 'Content-Range header must be present');
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
            assert.ok(match, `Invalid Content-Range format: ${contentRange}`);
            const start = Number(match[1]);
            const end = Number(match[2]);
            const total = Number(match[3]);
            assert.equal(total, totalSize);
            const expectedChunkLen = end - start + 1;
            assert.equal(init.headers['Content-Length'], String(expectedChunkLen));

            if (end < totalSize - 1) {
              assert.equal(expectedChunkLen % (256 * 1024), 0, `Non-final chunk ${start}-${end} must be aligned to 256 KiB`);
            }

            const streamChunks = [];
            for await (const chunk of init.body) {
              streamChunks.push(chunk);
            }
            const chunkBuffer = Buffer.concat(streamChunks);
            assert.equal(chunkBuffer.length, expectedChunkLen, `Stream emitted ${chunkBuffer.length} bytes, expected ${expectedChunkLen}`);

            receivedPutChunks.push({ start, end, buffer: chunkBuffer });
            recordedPuts.push({ start, end, length: chunkBuffer.length });

            if (end === totalSize - 1) {
              return new Response(JSON.stringify({ id: 'video_mc_success' }), { status: 200 });
            } else {
              return new Response('', { status: 308, headers: { range: `bytes=0-${end}` } });
            }
          }

          return new Response('', { status: 500 });
        };

        const mockMsg = {
          data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: multiTarget.id }),
          ack: () => {},
          nak: () => {},
          working: () => {}
        };
        await processJob(mockMsg, youtubePublishHandler);

        const completedJob = await PublishJob.query().findById(job.id);
        assert.equal(completedJob.status, 'succeeded');
        assert.equal(completedJob.external_media_id, 'video_mc_success');

        assert.equal(receivedPutChunks.length, 3, `Expected 3 chunks, got ${receivedPutChunks.length}`);
        assert.deepEqual(
          recordedPuts.map(p => ({ start: p.start, end: p.end })),
          [
            { start: 0, end: chunkSize - 1 },
            { start: chunkSize, end: chunkSize * 2 - 1 },
            { start: chunkSize * 2, end: totalSize - 1 }
          ]
        );

        const reconstructedBuffer = Buffer.concat(receivedPutChunks.map(c => c.buffer));
        assert.equal(reconstructedBuffer.length, totalSize);
        const reconstructedSha256 = crypto.createHash('sha256').update(reconstructedBuffer).digest('hex');
        assert.equal(reconstructedSha256, sourceSha256, 'Reconstructed uploaded bytes SHA256 must match source S3 object exactly');
        assert.ok(reconstructedBuffer.equals(deterministicBuffer), 'Reconstructed uploaded bytes must equal source buffer');
      } finally {
        global.fetch = originalMcFetch;
        if (prevChunkEnv !== undefined) process.env.YOUTUBE_UPLOAD_CHUNK_BYTES = prevChunkEnv;
        else delete process.env.YOUTUBE_UPLOAD_CHUNK_BYTES;
      }
    });

    await test('Multi-chunk Crash / Resume Byte Exactness (Worker A crash on chunk 2, Worker B resumes)', async () => {
      const prevChunkEnv = process.env.YOUTUBE_UPLOAD_CHUNK_BYTES;
      process.env.YOUTUBE_UPLOAD_CHUNK_BYTES = String(256 * 1024);
      const chunkSize = 256 * 1024;
      const originalCrashFetch = global.fetch;

      try {
        const totalSize = chunkSize * 2 + 12000; // 3 chunks
        const deterministicBuffer = Buffer.alloc(totalSize);
        for (let i = 0; i < totalSize; i++) {
          deterministicBuffer[i] = (i * 47 + 101) % 256;
        }
        const sourceSha256 = crypto.createHash('sha256').update(deterministicBuffer).digest('hex');

        const multiChunkFile = path.join(tempDir, 'crash_resume.mp4');
        await fs.writeFile(multiChunkFile, deterministicBuffer);
        const multiObjectKey = `test/yt_crash_${testRunId}.mp4`;
        await putObject(multiObjectKey, (await import('fs')).createReadStream(multiChunkFile), 'video/mp4');

        const multiAsset = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.VARIANT,
          status: ASSET_STATUS.READY,
          object_key: multiObjectKey,
          mime_type: 'video/mp4',
          size_bytes: totalSize,
          width: 1080,
          height: 1920,
          aspect_ratio: '9:16',
          duration_ms: 5000
        });
        trackedIds.assets.add(multiAsset.id);

        const multiTarget = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: multiAsset.id,
          settings_json: { youtube_mode: 'SHORT' }
        });
        trackedIds.targets.add(multiTarget.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-crash-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: multiTarget.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        const allReceivedBytes = new Map();
        let simulateCrashOnChunk2 = true;

        global.fetch = async (url, init) => {
          if (url === 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status') {
            return new Response('', { headers: { location: 'https://mock/youtube/session_crash' } });
          }

          if (url === 'https://mock/youtube/session_crash' && init.method === 'PUT') {
            if (init.headers['Content-Range']?.startsWith('bytes */')) {
              return new Response('', { status: 308, headers: { range: `bytes=0-${chunkSize - 1}` } });
            }

            const contentRange = init.headers['Content-Range'];
            const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
            const start = Number(match[1]);
            const end = Number(match[2]);

            if (start === chunkSize && simulateCrashOnChunk2) {
              simulateCrashOnChunk2 = false;
              throw new Error('simulated network failure during chunk 2');
            }

            const streamChunks = [];
            for await (const chunk of init.body) {
              streamChunks.push(chunk);
            }
            const chunkBuffer = Buffer.concat(streamChunks);
            allReceivedBytes.set(start, chunkBuffer);

            if (end === totalSize - 1) {
              return new Response(JSON.stringify({ id: 'video_crash_resumed_ok' }), { status: 200 });
            } else {
              return new Response('', { status: 308, headers: { range: `bytes=0-${end}` } });
            }
          }

          return new Response('', { status: 500 });
        };

        const mockMsg = {
          data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: multiTarget.id }),
          ack: () => {},
          nak: () => {},
          working: () => {}
        };
        try {
          await processJob(mockMsg, youtubePublishHandler);
        } catch (e) {}

        const jobAfterCrash = await PublishJob.query().findById(job.id);
        assert.equal(jobAfterCrash.status, 'retry_wait');
        assert.ok(jobAfterCrash.sensitive_external_state_json?.youtube?.resumable_session_uri);

        await PublishJob.knex().raw('UPDATE publish_jobs SET status = "queued", lock_token = NULL, locked_at = NULL WHERE id = ?', [job.id]);

        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        assert.equal(finalJob.status, 'succeeded');
        assert.equal(finalJob.external_media_id, 'video_crash_resumed_ok');

        const sortedOffsets = Array.from(allReceivedBytes.keys()).sort((a, b) => a - b);
        assert.deepEqual(sortedOffsets, [0, chunkSize, chunkSize * 2]);
        const reconstructed = Buffer.concat(sortedOffsets.map(offset => allReceivedBytes.get(offset)));
        assert.equal(reconstructed.length, totalSize);
        const reconstructedSha = crypto.createHash('sha256').update(reconstructed).digest('hex');
        assert.equal(reconstructedSha, sourceSha256, 'Crash/resume reconstructed SHA256 must match source exactly (no duplicate or missing bytes)');
      } finally {
        global.fetch = originalCrashFetch;
        if (prevChunkEnv !== undefined) process.env.YOUTUBE_UPLOAD_CHUNK_BYTES = prevChunkEnv;
        else delete process.env.YOUTUBE_UPLOAD_CHUNK_BYTES;
      }
    });

    await test('Final chunk requires Google completion acknowledgement (reconcile_required if not acknowledged)', async () => {
      const job = await makeJob();

      const originalUnackFetch = global.fetch;
      try {
        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_final_unack' } });
          }
          if (url === 'https://mock/youtube/session_final_unack') {
            return new Response('', { status: 308, headers: { range: 'bytes=0-99' } });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg = {
          data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: target.id }),
          ack: () => {},
          nak: () => {},
          working: () => {}
        };
        try {
          await processJob(mockMsg, youtubePublishHandler);
        } catch (err) {}

        const finalJob = await PublishJob.query().findById(job.id);
        assert.notEqual(finalJob.status, 'succeeded');
        assert.equal(finalJob.status, 'reconcile_required');
        assert.equal(finalJob.external_media_id, null);
      } finally {
        global.fetch = originalUnackFetch;
      }
    });

    await test('YouTube Audience: session init includes selfDeclaredMadeForKids false by default and honors true override', async () => {
      const originalAudienceFetch = global.fetch;
      try {
        let capturedSessionBodies = [];

        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            capturedSessionBodies.push(JSON.parse(init.body));
            return new Response('', { headers: { location: 'https://mock/youtube/session_aud' } });
          }
          if (url === 'https://mock/youtube/session_aud') {
            return new Response(JSON.stringify({ id: 'video_aud_1' }), { status: 200 });
          }
          return new Response('', { status: 500 });
        };

        // 1. Default (false)
        const job1 = await makeJob();
        const mockMsg1 = { data: jc.encode({ jobId: job1.id, organizationId: org.id, campaignTargetId: target.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg1, youtubePublishHandler);
        assert.equal(capturedSessionBodies[0].status?.selfDeclaredMadeForKids, false);
        assert.equal(capturedSessionBodies[0].status?.privacyStatus, 'private');

        // 2. Explicit true override
        const targetTrue = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: asset.id,
          settings_json: { youtube_mode: 'SHORT', made_for_kids: true }
        });
        trackedIds.targets.add(targetTrue.id);

        const job2 = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-aud-true-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: targetTrue.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job2.id);

        const mockMsg2 = { data: jc.encode({ jobId: job2.id, organizationId: org.id, campaignTargetId: targetTrue.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg2, youtubePublishHandler);
        assert.equal(capturedSessionBodies[1].status?.selfDeclaredMadeForKids, true);
        assert.equal(capturedSessionBodies[1].status?.privacyStatus, 'private');
      } finally {
        global.fetch = originalAudienceFetch;
      }
    });

    await test('Thumbnail: missing cover -> no thumbnail call made, video succeeds', async () => {
      const originalThumbFetch = global.fetch;
      try {
        let thumbnailCallCount = 0;
        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_no_thumb' } });
          }
          if (url === 'https://mock/youtube/session_no_thumb') {
            return new Response(JSON.stringify({ id: 'video_no_thumb' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            thumbnailCallCount++;
            return new Response('', { status: 200 });
          }
          return new Response('', { status: 500 });
        };

        const job = await makeJob();
        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: target.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        assert.equal(finalJob.status, 'succeeded');
        assert.equal(finalJob.external_media_id, 'video_no_thumb');
        assert.equal(thumbnailCallCount, 0, 'No thumbnails.set should be called when cover is missing');
      } finally {
        global.fetch = originalThumbFetch;
      }
    });

    await test('Thumbnail: valid JPEG <= 2MB -> thumbnails.set called once with exact stream', async () => {
      const originalThumbFetch = global.fetch;
      try {
        const coverBytes = Buffer.alloc(45000, 0xAA);
        const coverKey = `test/thumb_jpeg_${testRunId}.jpg`;
        await putObject(coverKey, coverBytes, 'image/jpeg');

        const coverAsset = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.COVER,
          status: ASSET_STATUS.READY,
          object_key: coverKey,
          mime_type: 'image/jpeg',
          size_bytes: coverBytes.length,
          width: 720,
          height: 1280,
          aspect_ratio: '9:16'
        });
        trackedIds.assets.add(coverAsset.id);

        const targetWithCover = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: asset.id,
          cover_asset_id: coverAsset.id,
          settings_json: { youtube_mode: 'SHORT' }
        });
        trackedIds.targets.add(targetWithCover.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-jpeg-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: targetWithCover.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        let capturedThumbnailHeaders = null;
        let capturedThumbnailBytes = null;
        let thumbnailCallCount = 0;

        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_thumb_jpeg' } });
          }
          if (url === 'https://mock/youtube/session_thumb_jpeg') {
            return new Response(JSON.stringify({ id: 'video_thumb_jpeg_1' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            thumbnailCallCount++;
            capturedThumbnailHeaders = init.headers;
            assert.equal(init.duplex, 'half');
            const streamChunks = [];
            for await (const chunk of init.body) {
              streamChunks.push(chunk);
            }
            capturedThumbnailBytes = Buffer.concat(streamChunks);
            return new Response(JSON.stringify({ items: [{ default: { url: 'https://mock/thumb.jpg' } }] }), { status: 200 });
          }
          if (url.includes('youtube/v3/videos')) {
            return new Response(JSON.stringify({ items: [{ id: 'video_thumb_jpeg_1', contentDetails: { hasCustomThumbnail: true } }] }), { status: 200 });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: targetWithCover.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        assert.equal(finalJob.status, 'succeeded');
        assert.equal(finalJob.external_media_id, 'video_thumb_jpeg_1');
        assert.equal(thumbnailCallCount, 1, 'thumbnails.set must be called exactly once');
        assert.equal(capturedThumbnailHeaders['Content-Type'], 'image/jpeg');
        assert.equal(capturedThumbnailHeaders['Content-Length'], String(coverBytes.length));
        assert.equal(capturedThumbnailBytes.length, coverBytes.length);
        assert.ok(capturedThumbnailBytes.equals(coverBytes));
      } finally {
        global.fetch = originalThumbFetch;
      }
    });

    await test('Thumbnail: valid PNG <= 2MB -> thumbnails.set called with image/png', async () => {
      const originalThumbFetch = global.fetch;
      try {
        const coverBytes = Buffer.alloc(32000, 0xBB);
        const coverKey = `test/thumb_png_${testRunId}.png`;
        await putObject(coverKey, coverBytes, 'image/png');

        const coverAsset = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.COVER,
          status: ASSET_STATUS.READY,
          object_key: coverKey,
          mime_type: 'image/png',
          size_bytes: coverBytes.length,
          width: 720,
          height: 1280,
          aspect_ratio: '9:16'
        });
        trackedIds.assets.add(coverAsset.id);

        const targetWithPng = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: asset.id,
          cover_asset_id: coverAsset.id,
          settings_json: { youtube_mode: 'SHORT' }
        });
        trackedIds.targets.add(targetWithPng.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-png-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: targetWithPng.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        let capturedMime = null;
        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_thumb_png' } });
          }
          if (url === 'https://mock/youtube/session_thumb_png') {
            return new Response(JSON.stringify({ id: 'video_thumb_png_1' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            capturedMime = init.headers['Content-Type'];
            return new Response(JSON.stringify({ items: [{ default: { url: 'https://mock/thumb.png' } }] }), { status: 200 });
          }
          if (url.includes('youtube/v3/videos')) {
            return new Response(JSON.stringify({ items: [{ id: 'video_thumb_png_1', contentDetails: { hasCustomThumbnail: true } }] }), { status: 200 });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: targetWithPng.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        assert.equal(finalJob.status, 'succeeded');
        assert.equal(capturedMime, 'image/png');
      } finally {
        global.fetch = originalThumbFetch;
      }
    });

    await test('Thumbnail: oversized cover (> 2 MB) -> generates technical normalized derivative <= 2 MB', async () => {
      const originalThumbFetch = global.fetch;
      const tempDir = await (await import('fs/promises')).mkdtemp(path.join((await import('os')).tmpdir(), 'yt-oversize-'));
      const testImgPath = path.join(tempDir, 'source.jpg');
      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const exec = promisify(execFile);
        // Create valid 2000x2000 test JPEG
        await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=2000x2000:rate=1', '-frames:v', '1', testImgPath], { windowsHide: true });
        const imgBuffer = await (await import('fs/promises')).readFile(testImgPath);

        const coverKey = `test/thumb_oversize_${testRunId}.jpg`;
        await putObject(coverKey, imgBuffer, 'image/jpeg');

        // Set size_bytes in DB to 3 MB to trigger the oversized threshold (> 2 MB)
        const coverAsset = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.COVER,
          status: ASSET_STATUS.READY,
          object_key: coverKey,
          mime_type: 'image/jpeg',
          size_bytes: 3 * 1024 * 1024,
          width: 2000,
          height: 2000,
          aspect_ratio: '1:1'
        });
        trackedIds.assets.add(coverAsset.id);

        const targetOversize = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: asset.id,
          cover_asset_id: coverAsset.id,
          settings_json: { youtube_mode: 'SHORT' }
        });
        trackedIds.targets.add(targetOversize.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-oversize-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: targetOversize.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        let capturedThumbnailBytes = null;
        let capturedMime = null;
        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_thumb_oversize' } });
          }
          if (url === 'https://mock/youtube/session_thumb_oversize') {
            return new Response(JSON.stringify({ id: 'video_thumb_oversize_1' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            capturedMime = init.headers['Content-Type'];
            const streamChunks = [];
            for await (const chunk of init.body) {
              streamChunks.push(chunk);
            }
            capturedThumbnailBytes = Buffer.concat(streamChunks);
            return new Response(JSON.stringify({ items: [{ default: { url: 'https://mock/thumb.jpg' } }] }), { status: 200 });
          }
          if (url.includes('youtube/v3/videos')) {
            return new Response(JSON.stringify({ items: [{ id: 'video_thumb_oversize_1', contentDetails: { hasCustomThumbnail: true } }] }), { status: 200 });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: targetOversize.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        assert.equal(finalJob.status, 'succeeded');
        assert.equal(capturedMime, 'image/jpeg');
        assert.ok(capturedThumbnailBytes.length > 0 && capturedThumbnailBytes.length <= 2 * 1024 * 1024, 'Thumbnail variant must be <= 2 MB');

        // Check variant asset was created in database
        const variant = await Asset.query().where({
          organization_id: org.id,
          parent_asset_id: coverAsset.id,
          kind: ASSET_KIND.VARIANT
        }).first();
        assert.ok(variant, 'Variant asset must be created');
        assert.equal(variant.mime_type, 'image/jpeg');
        assert.deepEqual([variant.width, variant.height], [1080, 1920]);
        trackedIds.assets.add(variant.id);
      } finally {
        global.fetch = originalThumbFetch;
        await (await import('fs/promises')).rm(tempDir, { recursive: true, force: true });
      }
    });

    await test('Thumbnail: 403 forbidden / unexpectedEligibility is secondary warning; video remains succeeded', async () => {
      const originalThumbFetch = global.fetch;
      try {
        const coverBytes = Buffer.alloc(10000, 0xCC);
        const coverKey = `test/thumb_403_${testRunId}.jpg`;
        await putObject(coverKey, coverBytes, 'image/jpeg');

        const coverAsset = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.COVER,
          status: ASSET_STATUS.READY,
          object_key: coverKey,
          mime_type: 'image/jpeg',
          size_bytes: coverBytes.length,
          width: 720,
          height: 1280,
          aspect_ratio: '9:16'
        });
        trackedIds.assets.add(coverAsset.id);

        const targetWith403 = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: asset.id,
          cover_asset_id: coverAsset.id,
          settings_json: { youtube_mode: 'SHORT' }
        });
        trackedIds.targets.add(targetWith403.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-403-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: targetWith403.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_thumb_403' } });
          }
          if (url === 'https://mock/youtube/session_thumb_403') {
            return new Response(JSON.stringify({ id: 'video_thumb_403_success' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            return new Response(JSON.stringify({ error: { message: 'unexpectedEligibility', errors: [{ reason: 'unexpectedEligibility' }] } }), { status: 403 });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: targetWith403.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        // CRITICAL ASSERTION: Video must succeed even if thumbnail fails with 403
        assert.equal(finalJob.status, 'succeeded');
        assert.equal(finalJob.external_media_id, 'video_thumb_403_success');

        const attempts = await db('publish_attempts').where({ job_id: job.id });
        assert.equal(attempts.length, 1);
        const meta = typeof attempts[0].metadata_json === 'string' ? JSON.parse(attempts[0].metadata_json) : attempts[0].metadata_json;
        assert.equal(meta?.thumbnail?.status, 'warning');
        assert.equal(meta?.thumbnail?.warningCategory, 'THUMBNAIL_PERMISSION_DENIED');
      } finally {
        global.fetch = originalThumbFetch;
      }
    });

    await test('Thumbnail: 429 rate limit is secondary warning; video remains succeeded and does not duplicate', async () => {
      const originalThumbFetch = global.fetch;
      try {
        const coverBytes = Buffer.alloc(10000, 0xDD);
        const coverKey = `test/thumb_429_${testRunId}.jpg`;
        await putObject(coverKey, coverBytes, 'image/jpeg');

        const coverAsset = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.COVER,
          status: ASSET_STATUS.READY,
          object_key: coverKey,
          mime_type: 'image/jpeg',
          size_bytes: coverBytes.length,
          width: 720,
          height: 1280,
          aspect_ratio: '9:16'
        });
        trackedIds.assets.add(coverAsset.id);

        const targetWith429 = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'pending',
          asset_id: asset.id,
          cover_asset_id: coverAsset.id,
          settings_json: { youtube_mode: 'SHORT' }
        });
        trackedIds.targets.add(targetWith429.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-429-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: targetWith429.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_thumb_429' } });
          }
          if (url === 'https://mock/youtube/session_thumb_429') {
            return new Response(JSON.stringify({ id: 'video_thumb_429_success' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            return new Response(JSON.stringify({ error: { message: 'uploadRateLimitExceeded' } }), { status: 429 });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: targetWith429.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        assert.equal(finalJob.status, 'succeeded');
        assert.equal(finalJob.external_media_id, 'video_thumb_429_success');
      } finally {
        global.fetch = originalThumbFetch;
      }
    });

    await test('Thumbnail: REGULAR + valid 16:9 JPEG <= 2MB -> uses original cover directly', async () => {
      const originalThumbFetch = global.fetch;
      try {
        const coverBytes = Buffer.alloc(25000, 0xEE);
        const coverKey = `test/thumb_reg_16x9_${testRunId}.jpg`;
        await putObject(coverKey, coverBytes, 'image/jpeg');

        const cover16x9 = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.COVER,
          status: ASSET_STATUS.READY,
          object_key: coverKey,
          mime_type: 'image/jpeg',
          size_bytes: coverBytes.length,
          width: 1280,
          height: 720,
          aspect_ratio: '16:9'
        });
        trackedIds.assets.add(cover16x9.id);

        const regVideoKey1 = `test/yt_reg_video_${testRunId}_1.mp4`;
        await putObject(regVideoKey1, Buffer.alloc(100, '0'), 'video/mp4');
        const regVideoAsset1 = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.VARIANT,
          status: ASSET_STATUS.READY,
          object_key: regVideoKey1,
          mime_type: 'video/mp4',
          size_bytes: 100,
          width: 1920,
          height: 1080,
          aspect_ratio: '16:9',
          duration_ms: 5000,
          probe_json: {
            variant_provenance: {
              profile: 'elecio_horizontal_v1',
              layout_revision: 2,
              background_sha256: 'a6aca169e9f3fb9fd7bf64cf84af759e4d8c93478d3682737f17c98a7a675e4a',
            },
          },
        });
        trackedIds.assets.add(regVideoAsset1.id);

        const target16x9 = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'ready',
          asset_id: regVideoAsset1.id,
          cover_asset_id: cover16x9.id,
          settings_json: { youtube_mode: 'REGULAR' }
        });
        trackedIds.targets.add(target16x9.id);

        const job = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-reg-16x9-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: target16x9.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job.id);

        let capturedThumbnailBytes = null;
        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_thumb_reg_16x9' } });
          }
          if (url === 'https://mock/youtube/session_thumb_reg_16x9') {
            return new Response(JSON.stringify({ id: 'video_thumb_reg_16x9' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            assert.ok(url.includes('uploadType=media'), 'URL must include uploadType=media');
            const streamChunks = [];
            for await (const chunk of init.body) streamChunks.push(chunk);
            capturedThumbnailBytes = Buffer.concat(streamChunks);
            return new Response(JSON.stringify({ items: [{ default: { url: 'https://mock/thumb.jpg' } }] }), { status: 200 });
          }
          if (url.includes('youtube/v3/videos')) {
            return new Response(JSON.stringify({ items: [{ id: 'video_thumb_reg_16x9', contentDetails: { hasCustomThumbnail: true } }] }), { status: 200 });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg = { data: jc.encode({ jobId: job.id, organizationId: org.id, campaignTargetId: target16x9.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg, youtubePublishHandler);

        const finalJob = await PublishJob.query().findById(job.id);
        assert.equal(finalJob.status, 'succeeded');
        assert.ok(capturedThumbnailBytes.equals(coverBytes), 'Original 16:9 cover bytes must be uploaded directly');

        // Verify NO variant asset was created
        const variants = await Asset.query().where({ organization_id: org.id, parent_asset_id: cover16x9.id, kind: ASSET_KIND.VARIANT });
        assert.equal(variants.length, 0, 'No variant should be created when cover is already 16:9');
      } finally {
        global.fetch = originalThumbFetch;
      }
    });

    await test('Thumbnail: REGULAR + 9:16 cover -> generates elecio_thumbnail_16x9_v1 (1280x720) and reuses it on repeat', async () => {
      const originalThumbFetch = global.fetch;
      try {
        const tempDir = await (await import('fs/promises')).mkdtemp(path.join((await import('os')).tmpdir(), 'yt-cov-9x16-'));
        const localCover = path.join(tempDir, 'cover.jpg');
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const exec = promisify(execFile);
        await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=1', '-frames:v', '1', localCover], { windowsHide: true });
        const coverBytes = await (await import('fs/promises')).readFile(localCover);
        await (await import('fs/promises')).rm(tempDir, { recursive: true, force: true });

        const coverKey = `test/thumb_reg_9x16_${testRunId}.jpg`;
        await putObject(coverKey, coverBytes, 'image/jpeg');

        const cover9x16 = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.COVER,
          status: ASSET_STATUS.READY,
          object_key: coverKey,
          mime_type: 'image/jpeg',
          size_bytes: coverBytes.length,
          width: 720,
          height: 1280,
          aspect_ratio: '9:16'
        });
        trackedIds.assets.add(cover9x16.id);

        const regVideoKey2 = `test/yt_reg_video_${testRunId}_2.mp4`;
        await putObject(regVideoKey2, Buffer.alloc(100, '0'), 'video/mp4');
        const regVideoAsset2 = await Asset.query().insertAndFetch({
          organization_id: org.id,
          campaign_id: campaign.id,
          kind: ASSET_KIND.VARIANT,
          status: ASSET_STATUS.READY,
          object_key: regVideoKey2,
          mime_type: 'video/mp4',
          size_bytes: 100,
          width: 1920,
          height: 1080,
          aspect_ratio: '16:9',
          duration_ms: 5000,
          probe_json: {
            variant_provenance: {
              profile: 'elecio_horizontal_v1',
              layout_revision: 2,
              background_sha256: 'a6aca169e9f3fb9fd7bf64cf84af759e4d8c93478d3682737f17c98a7a675e4a',
            },
          },
        });
        trackedIds.assets.add(regVideoAsset2.id);

        const target1 = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'ready',
          asset_id: regVideoAsset2.id,
          cover_asset_id: cover9x16.id,
          settings_json: { youtube_mode: 'REGULAR' }
        });
        trackedIds.targets.add(target1.id);

        const job1 = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-reg-gen-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: target1.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job1.id);

        let capturedThumbnailBytes = null;
        global.fetch = async (url, init) => {
          if (url.includes('uploadType=resumable')) {
            return new Response('', { headers: { location: 'https://mock/youtube/session_thumb_reg_gen' } });
          }
          if (url === 'https://mock/youtube/session_thumb_reg_gen') {
            return new Response(JSON.stringify({ id: 'video_thumb_reg_gen_1' }), { status: 200 });
          }
          if (url.includes('thumbnails/set')) {
            assert.ok(url.includes('uploadType=media'), 'URL must include uploadType=media');
            const streamChunks = [];
            for await (const chunk of init.body) streamChunks.push(chunk);
            capturedThumbnailBytes = Buffer.concat(streamChunks);
            return new Response(JSON.stringify({ items: [{ default: { url: 'https://mock/thumb.jpg' } }] }), { status: 200 });
          }
          if (url.includes('youtube/v3/videos')) {
            return new Response(JSON.stringify({ items: [{ id: 'video_thumb_reg_gen_1', contentDetails: { hasCustomThumbnail: true } }] }), { status: 200 });
          }
          return new Response('', { status: 500 });
        };

        const mockMsg1 = { data: jc.encode({ jobId: job1.id, organizationId: org.id, campaignTargetId: target1.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg1, youtubePublishHandler);

        const finalJob1 = await PublishJob.query().findById(job1.id);
        assert.equal(finalJob1.status, 'succeeded');

        // Check variant asset in DB
        const variantsAfter1 = await Asset.query().where({ organization_id: org.id, parent_asset_id: cover9x16.id, kind: ASSET_KIND.VARIANT });
        assert.equal(variantsAfter1.length, 1, 'Exactly one thumbnail variant must be created');
        const variant1 = variantsAfter1[0];
        assert.equal(variant1.probe_json?.variant_provenance?.profile, 'elecio_thumbnail_16x9_v1');
        assert.equal(variant1.width, 1280);
        assert.equal(variant1.height, 720);
        trackedIds.assets.add(variant1.id);

        // Job 2: Second target with same 9:16 cover reuses the variant
        const target2 = await CampaignTarget.query().insertAndFetch({
          campaign_id: campaign.id,
          integration_config_id: config.id,
          platform: 'youtube',
          status: 'ready',
          asset_id: regVideoAsset2.id,
          cover_asset_id: cover9x16.id,
          settings_json: { youtube_mode: 'REGULAR' }
        });
        trackedIds.targets.add(target2.id);

        const job2 = await PublishJob.query().insertAndFetch({
          organization_id: org.id,
          idempotency_key: `test-thumb-reg-reuse-${testRunId}-${crypto.randomBytes(4).toString('hex')}`,
          campaign_target_id: target2.id,
          status: 'queued',
          attempt_count: 0,
          max_attempts: 3,
          external_stage: 'NEW'
        });
        trackedIds.jobs.add(job2.id);

        const mockMsg2 = { data: jc.encode({ jobId: job2.id, organizationId: org.id, campaignTargetId: target2.id }), ack: () => {}, nak: () => {}, working: () => {} };
        await processJob(mockMsg2, youtubePublishHandler);

        const variantsAfter2 = await Asset.query().where({ organization_id: org.id, parent_asset_id: cover9x16.id, kind: ASSET_KIND.VARIANT });
        assert.equal(variantsAfter2.length, 1, 'Variant must be reused without duplicate creation');
        assert.equal(variantsAfter2[0].id, variant1.id);
      } finally {
        global.fetch = originalThumbFetch;
      }
    });

    await test('MOCKED END-TO-END RUNTIME', async () => {
      const job = await makeJob(); // makeJob creates it as 'queued'
      
      const outbox = await OutboxEvent.query().insertAndFetch({
        organization_id: org.id,
        aggregate_type: 'PublishJob',
        aggregate_id: String(job.id),
        event_type: SUBJECT,
        payload_json: { jobId: job.id, organizationId: org.id, campaignTargetId: target.id },
        status: 'pending'
      });
      trackedIds.outbox.add(outbox.id);
      
      const { dispatchBatch } = await import('../publisher/dispatcher.js');
      await dispatchBatch(js);

      fetchCalls = [];
      mockFetchState = 'normal';
      
      let capturedLogs = [];
      const originalConsoleLog = console.log;
      console.log = (...args) => {
        capturedLogs.push(args.join(' '));
        originalConsoleLog(...args);
      };

      const ctrl = new AbortController();
      const workerPromise = startWorker(SUBJECT, CONSUMER_NAME, youtubePublishHandler, { signal: ctrl.signal });
      
      await new Promise(r => setTimeout(r, 1000));
      ctrl.abort();
      await workerPromise.catch(() => {});
      console.log = originalConsoleLog;

      const finalJob = await PublishJob.query().findById(job.id);
      assert.equal(finalJob.status, 'succeeded');
      assert.equal(finalJob.external_media_id, 'test_video_id_123'); // Normal fetch bytes 0-99 yields 123
      
      const attempts = await db('publish_attempts').where('job_id', job.id);
      
      const outboxAfter = await db('outbox_events').where('id', outbox.id).first();
      assert.strictEqual(outboxAfter.status, 'dispatched');
      
      const leakStr = JSON.stringify(attempts);
      assert.strictEqual(leakStr.includes('mock-access-token'), false);
      assert.ok(!JSON.stringify(outboxAfter).includes('mock_access_token'));
      
      const logsStr = capturedLogs.join('\n');
      assert.ok(!logsStr.includes('mock_access_token'));
      assert.ok(!logsStr.includes('enc:'));
      
      assert.equal(fetchCalls.filter(c => c.url.includes('uploadType=resumable')).length, 1); // 1 session
    });

    await test('Defensive Worker: WAITING_MEDIA_READY target fails safely with TARGET_NOT_READY and no Google API calls', async () => {
      const regularTarget = await CampaignTarget.query().insertAndFetch({
        campaign_id: campaign.id,
        integration_config_id: config.id,
        platform: 'youtube',
        status: 'waiting_media_ready',
        title_override: 'Defensive Test',
        asset_id: asset.id,
        settings_json: { youtube_mode: 'REGULAR', privacy: 'private' },
      });

      const unreadyJob = await PublishJob.query().insertAndFetch({
        organization_id: org.id,
        idempotency_key: `defensive-unready-${crypto.randomUUID()}`,
        campaign_target_id: regularTarget.id,
        status: 'queued',
        attempt_count: 0,
        max_attempts: 3,
      });

      const fetchCountBefore = fetchCalls.length;
      const mockMsg = {
        data: jc.encode({ jobId: unreadyJob.id, organizationId: org.id, campaignTargetId: regularTarget.id }),
        ack: () => {},
        nak: () => {},
        working: () => {},
      };

      await processJob(mockMsg, youtubePublishHandler);

      const finalJob = await PublishJob.query().findById(unreadyJob.id);
      assert.equal(finalJob.status, 'failed', 'Unready target must transition job directly to FAILED (not retry_wait)');
      assert.equal(finalJob.last_error_code, 'TARGET_NOT_READY');
      assert.ok(finalJob.last_error_message.includes('WAITING_MEDIA_READY'));
      assert.equal(fetchCalls.length, fetchCountBefore, 'Zero Google API calls must be made');

      await PublishJob.query().deleteById(unreadyJob.id);
      await CampaignTarget.query().deleteById(regularTarget.id);
    });

    await test('Target Auto-Reconciliation: variant becoming READY automatically reconciles target to READY with variant asset_id', async () => {
      const { reconcileTargetsForVariant } = await import('../publisher/media/reconcileTargets.js');
      const { ELECIO_HORIZONTAL_BACKGROUND_SHA256 } = await import('../publisher/media/technicalLayout.js');

      const variantAsset = await Asset.query().insertAndFetch({
        organization_id: org.id,
        campaign_id: campaign.id,
        parent_asset_id: asset.id,
        kind: 'variant',
        status: 'ready',
        object_key: `variants/test-${crypto.randomUUID()}.mp4`,
        mime_type: 'video/mp4',
        width: 1920,
        height: 1080,
        probe_json: {
          variant_provenance: {
            profile: 'elecio_horizontal_v1',
            layout_revision: 2,
            background_sha256: ELECIO_HORIZONTAL_BACKGROUND_SHA256,
            source_asset_id: asset.id,
            output_width: 1920,
            output_height: 1080,
          },
        },
      });

      const waitingTarget = await CampaignTarget.query().insertAndFetch({
        campaign_id: campaign.id,
        integration_config_id: config.id,
        platform: 'youtube',
        status: 'waiting_media_ready',
        title_override: 'Reconciliation Test',
        asset_id: asset.id,
        settings_json: { youtube_mode: 'REGULAR', privacy: 'private' },
      });

      const reconciledIds = await reconcileTargetsForVariant({ variantAsset, organizationId: org.id });
      assert.ok(reconciledIds.includes(waitingTarget.id));

      const updatedTarget = await CampaignTarget.query().findById(waitingTarget.id);
      assert.equal(updatedTarget.status, 'ready');
      assert.equal(updatedTarget.asset_id, variantAsset.id);

      await CampaignTarget.query().deleteById(waitingTarget.id);
      await Asset.query().deleteById(variantAsset.id);
    });

    global.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    const { YouTubeApiClient } = await import('../publisher/platforms/youtube/api.js');
    if (typeof originalGetAccessToken !== 'undefined') {
      YouTubeApiClient.prototype.getAccessToken = originalGetAccessToken;
    }
    await cleanup(jsm);
  }

  for (const [name, ok, detail] of tests) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n${detail}` : ''}`);
  const failed = tests.filter(([, ok]) => !ok);
  console.log(`YouTube Mock Worker Checks: ${tests.length - failed.length}/${tests.length} PASS (MySQL authoritative state proven)`);
  if (failed.length) throw new Error('Worker tests failed');
}

runTests().then(() => process.exit(0)).catch(() => process.exit(1));
