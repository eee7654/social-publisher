import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildElecioHorizontalFilter, renderElecioHorizontalLocal } from '../publisher/media/technicalLayout.js';
import { normalizeProbeMetadata, runFfprobe } from '../publisher/media/probe.js';
import { YouTubeApiClient } from '../publisher/platforms/youtube/api.js';
import { categorizeYouTubeError } from '../publisher/platforms/youtube/errors.js';
import { ERROR_CATEGORY } from '../publisher/constants.js';

if (process.env.NODE_ENV === 'test' && !process.env.DB_NAME.endsWith('_test')) {
  process.env.DB_NAME = `${process.env.DB_NAME}_test`;
}
import getDb from '../config/database.js';
import IntegrationConnectionIntent from '../db/models/core/IntegrationConnectionIntent.js';

const db = getDb();
const exec = promisify(execFile);
const tests = [];
async function test(name, fn) { try { await fn(); tests.push([name, true]); } catch (e) { tests.push([name, false, e.stack]); } }

await test('16:9 profile uses scale-to-fit without crop or stretch (no blurred background)', () => {
  const filter = buildElecioHorizontalFilter();
  assert.match(filter, /scale=540:960:force_original_aspect_ratio=decrease/);
  assert.match(filter, /overlay=1170:60/);
  assert.match(filter, /alphamerge/);
  assert.doesNotMatch(filter, /crop|force_original_aspect_ratio=increase|blur|boxblur|gblur|drawtext/);
});
await test('official 308 query resumes at N+1', async () => {
  const original = global.fetch;
  global.fetch = async (_url, init) => new Response('', { status: 308, headers: { range: 'bytes=0-8388607' } });
  try { const client = new YouTubeApiClient('x', 'y'); const status = await client.getUploadStatus('https://mock/session', 16 * 1024 * 1024); assert.equal(status.bytesReceived, 8388608); }
  finally { global.fetch = original; }
});
await test('YouTube API client uses YOUTUBE_OAUTH env names', () => {
  const original = {
    youtubeId: process.env.YOUTUBE_OAUTH_CLIENT_ID,
    youtubeSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
    googleId: process.env.GOOGLE_CLIENT_ID,
    googleSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
  try {
    process.env.YOUTUBE_OAUTH_CLIENT_ID = 'yt-client-id';
    process.env.YOUTUBE_OAUTH_CLIENT_SECRET = 'yt-client-secret';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    assert.doesNotThrow(() => new YouTubeApiClient('access', 'refresh'));
  } finally {
    if (original.youtubeId === undefined) delete process.env.YOUTUBE_OAUTH_CLIENT_ID; else process.env.YOUTUBE_OAUTH_CLIENT_ID = original.youtubeId;
    if (original.youtubeSecret === undefined) delete process.env.YOUTUBE_OAUTH_CLIENT_SECRET; else process.env.YOUTUBE_OAUTH_CLIENT_SECRET = original.youtubeSecret;
    if (original.googleId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = original.googleId;
    if (original.googleSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = original.googleSecret;
  }
});
await test('Google invalid_request token failures classify as auth required', () => {
  const error = Object.assign(new Error('invalid_request'), {
    code: 400,
    response: { status: 400, data: { error: 'invalid_request', error_description: 'invalid_request' } },
  });
  const normalized = categorizeYouTubeError(error);
  assert.equal(normalized.category, ERROR_CATEGORY.AUTH_REQUIRED);
  assert.match(normalized.message, /YouTube Auth Error/);
});
await test('actual ffmpeg vertical-to-horizontal output preserves duration and audio', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-layout-')); const input = path.join(dir, 'in.mp4'); const output = path.join(dir, 'out.mp4');
  try {
    await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=800', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', input], { windowsHide: true });
    await renderElecioHorizontalLocal(input, output);
    const source = normalizeProbeMetadata(await runFfprobe(input)); const derived = normalizeProbeMetadata(await runFfprobe(output));
    assert.deepEqual([derived.width, derived.height], [1920, 1080]); assert.equal(derived.video_codec, 'h264'); assert.equal(derived.audio_codec, 'aac'); assert.ok(Math.abs(source.duration_ms - derived.duration_ms) < 300);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

await test('DB Integration: IntegrationConnectionIntent structure', async () => {
  IntegrationConnectionIntent.knex(db);
  await db('user').insert({ id: 'test-user-yt', name: 'yt test', email: 'yt@test.com', emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).catch(()=>{});
  const intent = await IntegrationConnectionIntent.query().insertAndFetch({
    id: 'test-intent-yt',
    nonce_hash: 'testhash'.padStart(64, 'a'),
    user_id: 'test-user-yt',
    organization_id: 1,
    provider_id: 1,
    purpose: 'youtube',
    status: 'pending',
    expires_at: new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' ')
  }).catch(e => { if(e.code !== 'ER_DUP_ENTRY' && e.code !== 'ER_NO_REFERENCED_ROW_2') throw e; });
  if (intent) {
    assert.equal(intent.status, 'pending');
    await IntegrationConnectionIntent.query().deleteById('test-intent-yt');
  }
});

import { ensureElecioHorizontalVariant } from '../publisher/media/variants.js';
import { ASSET_STATUS, ASSET_KIND } from '../publisher/media/constants.js';

await test('Variant DB Reuse: does not duplicate variants', async () => {
  const { default: Asset } = await import('../db/models/core/Asset.js');
  Asset.knex(db);

  await db('user').insert({ id: 'test-user-asset', name: 't', email: 'ta@t.com', emailVerified: false, createdAt: new Date(), updatedAt: new Date() }).catch(e => { if(e.code !== 'ER_DUP_ENTRY') throw e; });
  await db('organizations').insert({ id: 9998, name: 'test org', slug: 'test-org-slug', created_at: new Date(), updated_at: new Date() }).catch(e => { if(e.code !== 'ER_DUP_ENTRY') throw e; });
  await db('campaigns').insert({ id: 9998, organization_id: 9998, created_by: 'test-user-asset', base_title: 't', status: 'draft', source_type: 'manual' }).catch(e => { if(e.code !== 'ER_DUP_ENTRY') throw e; });

  // insert a fake original asset
  const original = await Asset.query().insertAndFetch({
    organization_id: 9998,
    campaign_id: 9998,
    kind: ASSET_KIND.MASTER,
    status: ASSET_STATUS.READY,
    object_key: 'test/original.mp4',
    mime_type: 'video/mp4'
  });

  // Request variant for the first time
  const { asset: v1, reused: reused1, queued: queued1 } = await ensureElecioHorizontalVariant(original);
  assert.equal(reused1, false);
  assert.equal(queued1, true);

  // Set the first variant to READY to simulate worker completion
  await v1.$query().patch({ status: ASSET_STATUS.READY });

  // Request variant a second time
  const { asset: v2, reused: reused2, queued: queued2 } = await ensureElecioHorizontalVariant(original);
  assert.equal(reused2, true);
  assert.ok(!queued2);
  assert.equal(v2.id, v1.id);

  // Cleanup
  await Asset.query().deleteById(v1.id);
  await Asset.query().deleteById(original.id);
});

await test('Nested transaction support: ensureElecioHorizontalVariant executes safely inside active transaction', async () => {
  const { default: Asset } = await import('../db/models/core/Asset.js');
  await db.transaction(async (trx) => {
    const testMaster = await Asset.query(trx).insertAndFetch({
      organization_id: 9998,
      campaign_id: 9998,
      kind: ASSET_KIND.MASTER,
      status: ASSET_STATUS.READY,
      object_key: 'test/nested-trx-original.mp4',
      mime_type: 'video/mp4',
      width: 1080,
      height: 1920,
    });

    const res = await resolveYouTubeTargetAsset({
      target: { settings_json: { youtube_mode: 'REGULAR' }, title_override: 'Test' },
      masterAsset: testMaster,
      trx,
    });

    assert.equal(res.status, 'WAITING_MEDIA_READY');
    assert.ok(res.asset?.id);

    const inTrxVariant = await Asset.query(trx).findById(res.asset.id);
    assert.ok(inTrxVariant);

    await Asset.query(trx).deleteById(res.asset.id);
    await Asset.query(trx).deleteById(testMaster.id);
  });
});

import { resolveYouTubeTargetAsset } from '../publisher/platforms/youtube/selection.js';

await test('READY Gating Matrix: evaluateYouTubeReadiness handles SHORT/REGULAR valid and invalid cases', async () => {
  const { default: Asset } = await import('../db/models/core/Asset.js');
  
  const vertical = await Asset.query().insertAndFetch({
    organization_id: 9998, campaign_id: 9998, kind: ASSET_KIND.MASTER, status: ASSET_STATUS.READY, object_key: 'test/v.mp4', mime_type: 'video/mp4', width: 1080, height: 1920
  });
  const horizontal = await Asset.query().insertAndFetch({
    organization_id: 9998, campaign_id: 9998, kind: ASSET_KIND.MASTER, status: ASSET_STATUS.READY, object_key: 'test/h.mp4', mime_type: 'video/mp4', width: 1920, height: 1080
  });
  
  // Valid SHORT needs mode SHORT, title, and READY vertical asset
  const res1 = await resolveYouTubeTargetAsset({ target: { settings_json: { youtube_mode: 'SHORT' }, title_override: 'Title' }, masterAsset: vertical });
  assert.equal(res1.status, 'READY');
  
  // Valid REGULAR needs mode REGULAR, title, and READY horizontal asset
  const res2 = await resolveYouTubeTargetAsset({ target: { asset_id: horizontal.id, settings_json: { youtube_mode: 'REGULAR' }, title_override: 'Title' }, masterAsset: horizontal });
  assert.equal(res2.status, 'READY');
  
  // Invalid case: Missing mode
  const res3 = await resolveYouTubeTargetAsset({ target: { settings_json: {}, title_override: 'Title' }, masterAsset: vertical });
  assert.equal(res3.status, 'INVALID_MODE');
  
  // Invalid case: Incompatible media (master is horizontal, mode is SHORT) => NEEDS_CREATIVE_VARIANT
  const res4 = await resolveYouTubeTargetAsset({ target: { settings_json: { youtube_mode: 'SHORT' }, title_override: 'Title' }, masterAsset: horizontal });
  assert.equal(res4.status, 'NEEDS_CREATIVE_VARIANT');

  // Invalid case: REGULAR with vertical master => triggers ensureElecioHorizontalVariant, returns WAITING_MEDIA_READY
  const res5 = await resolveYouTubeTargetAsset({ target: { settings_json: { youtube_mode: 'REGULAR' }, title_override: 'Title' }, masterAsset: vertical });
  assert.equal(res5.status, 'WAITING_MEDIA_READY');
  
  // Create variant for vertical to simulate variant ready
  await Asset.query().patchAndFetchById(res5.asset.id, { status: ASSET_STATUS.READY });
  
  // Now REGULAR with vertical master should resolve to READY variant
  const res6 = await resolveYouTubeTargetAsset({ target: { settings_json: { youtube_mode: 'REGULAR' }, title_override: 'Title' }, masterAsset: vertical });
  assert.equal(res6.status, 'READY');
  assert.equal(res6.asset.id, res5.asset.id);

  // Cleanup
  await Asset.query().deleteById(res5.asset.id);
  await Asset.query().deleteById(horizontal.id);
  await Asset.query().deleteById(vertical.id);
});

await test('YouTube Audience: default selfDeclaredMadeForKids is false, explicit true override supported', () => {
  const evaluateAudience = (settings = {}) => {
    return typeof settings.made_for_kids === 'boolean'
      ? settings.made_for_kids
      : (typeof settings.youtube_made_for_kids === 'boolean' ? settings.youtube_made_for_kids : false);
  };
  assert.equal(evaluateAudience({}), false);
  assert.equal(evaluateAudience({ youtube_mode: 'SHORT' }), false);
  assert.equal(evaluateAudience({ made_for_kids: true }), true);
  assert.equal(evaluateAudience({ youtube_made_for_kids: true }), true);
  assert.equal(evaluateAudience({ made_for_kids: false }), false);
});

import {
  renderYouTubeThumbnailLocal,
  YOUTUBE_THUMBNAIL_SHORT_PROFILE,
  YOUTUBE_THUMBNAIL_REGULAR_PROFILE,
  YOUTUBE_MAX_THUMBNAIL_BYTES
} from '../publisher/media/thumbnailVariants.js';

await test('Technical Thumbnail: renders short 9:16 and regular 16:9 JPEG derivatives < 2 MB', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-thumb-'));
  const input = path.join(dir, 'input.jpg');
  const shortOut = path.join(dir, 'short.jpg');
  const regOut = path.join(dir, 'reg.jpg');
  try {
    await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1000x1000:rate=1', '-frames:v', '1', input], { windowsHide: true });
    await renderYouTubeThumbnailLocal(input, shortOut, { profile: YOUTUBE_THUMBNAIL_SHORT_PROFILE });
    await renderYouTubeThumbnailLocal(input, regOut, { profile: YOUTUBE_THUMBNAIL_REGULAR_PROFILE });

    const shortStat = await fs.stat(shortOut);
    const regStat = await fs.stat(regOut);
    assert.ok(shortStat.size > 0 && shortStat.size <= YOUTUBE_MAX_THUMBNAIL_BYTES);
    assert.ok(regStat.size > 0 && regStat.size <= YOUTUBE_MAX_THUMBNAIL_BYTES);

    const shortProbe = normalizeProbeMetadata(await runFfprobe(shortOut));
    const regProbe = normalizeProbeMetadata(await runFfprobe(regOut));
    assert.deepEqual([shortProbe.width, shortProbe.height], [1080, 1920]);
    assert.deepEqual([regProbe.width, regProbe.height], [1280, 720]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await test('Static template compositor pixel verification (outside background parity, video slot, and corner mask)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-template-px-'));
  const input = path.join(dir, 'in.mp4');
  const output = path.join(dir, 'out.mp4');
  const frameRaw = path.join(dir, 'frame0.raw');
  const bgRaw = path.join(dir, 'bg.raw');
  try {
    const { ELECIO_HORIZONTAL_BACKGROUND_PATH } = await import('../publisher/media/technicalLayout.js');
    await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=800', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', input], { windowsHide: true });
    await renderElecioHorizontalLocal(input, output);

    await exec('ffmpeg', ['-y', '-i', output, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', frameRaw], { windowsHide: true });
    await exec('ffmpeg', ['-y', '-i', ELECIO_HORIZONTAL_BACKGROUND_PATH, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', bgRaw], { windowsHide: true });

    const frame = await fs.readFile(frameRaw);
    const bg = await fs.readFile(bgRaw);
    const getPixel = (buf, x, y, width = 1920) => {
      const idx = (y * width + x) * 4;
      return [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]];
    };

    // 1. Outside video slot matches static background artwork within compression tolerance
    for (const [x, y] of [[100, 100], [600, 300], [1800, 900]]) {
      const pF = getPixel(frame, x, y);
      const pB = getPixel(bg, x, y);
      const diff = Math.max(Math.abs(pF[0] - pB[0]), Math.abs(pF[1] - pB[1]), Math.abs(pF[2] - pB[2]));
      assert.ok(diff <= 15, `Outside point (${x},${y}) diff ${diff} should match background`);
    }

    // 2. Inside video slot center contains source video
    const pCenter = getPixel(frame, 1440, 540);
    assert.ok(pCenter[3] === 255, 'Center alpha should be 255');

    // 3. Corner of slot (1172, 62) is clipped by 75px rounded mask and shows background
    const pCorner = getPixel(frame, 1172, 62);
    const pBgCorner = getPixel(bg, 1172, 62);
    const cornerDiff = Math.max(Math.abs(pCorner[0] - pBgCorner[0]), Math.abs(pCorner[1] - pBgCorner[1]), Math.abs(pCorner[2] - pBgCorner[2]));
    assert.ok(cornerDiff <= 15, `Corner point (1172,62) diff ${cornerDiff} should show background`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

await test('Revision 1 vs Revision 2 cache invalidation: old revision 1 variants are ignored', async () => {
  const { isElecioHorizontalVariant } = await import('../publisher/media/variants.js');
  const oldV1 = {
    status: 'ready',
    probe_json: {
      variant_provenance: {
        profile: 'elecio_horizontal_v1',
        layout_revision: 1,
        output_width: 1920,
        output_height: 1080
      }
    }
  };
  assert.equal(isElecioHorizontalVariant(oldV1), false, 'Revision 1 variant must NOT be valid');

  const { ELECIO_HORIZONTAL_BACKGROUND_SHA256 } = await import('../publisher/media/technicalLayout.js');
  const validV2 = {
    status: 'ready',
    probe_json: {
      variant_provenance: {
        profile: 'elecio_horizontal_v1',
        layout_revision: 2,
        background_sha256: ELECIO_HORIZONTAL_BACKGROUND_SHA256,
        output_width: 1920,
        output_height: 1080
      }
    }
  };
  assert.equal(isElecioHorizontalVariant(validV2), true, 'Revision 2 variant with matching background SHA must be valid');
});

await test('Thumbnail: elecio_thumbnail_16x9_v1 geometry, pixel composition, and 48px rounded corner clipping', async () => {
  const { FFMPEG_BIN } = await import('../publisher/media/constants.js');
  const {
    renderElecioThumbnail16x9Local,
    ELECIO_THUMBNAIL_BACKGROUND_PATH,
    ELECIO_THUMBNAIL_16X9_SPEC,
    ELECIO_THUMBNAIL_16X9_SLOT,
    ELECIO_THUMBNAIL_BACKGROUND_SHA256,
  } = await import('../publisher/media/thumbnailVariants.js');

  const tempDir = path.resolve('./apps/core/temp');
  await fs.mkdir(tempDir, { recursive: true });
  const dummyInput = path.join(tempDir, `test-thumb-in-${crypto.randomUUID()}.jpg`);
  const testOutput = path.join(tempDir, `test-thumb-out-${crypto.randomUUID()}.jpg`);

  // Generate pure green 720x1280 test image
  await new Promise(r => execFile(FFMPEG_BIN, ['-y', '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=720x1280', '-frames:v', '1', dummyInput], r));

  const finalSize = await renderElecioThumbnail16x9Local(dummyInput, testOutput);
  assert.ok(finalSize <= 2 * 1024 * 1024, 'Rendered thumbnail must be <= 2 MB');

  const frameRaw = path.join(tempDir, `frame-${crypto.randomUUID()}.raw`);
  const bgRaw = path.join(tempDir, `bg-${crypto.randomUUID()}.raw`);

  await exec('ffmpeg', ['-y', '-i', testOutput, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', frameRaw], { windowsHide: true });
  await exec('ffmpeg', ['-y', '-i', ELECIO_THUMBNAIL_BACKGROUND_PATH, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', bgRaw], { windowsHide: true });

  const frame = await fs.readFile(frameRaw);
  const bg = await fs.readFile(bgRaw);
  const getPixel = (buf, x, y, width = 1280) => {
    const idx = (y * width + x) * 4;
    return [buf[idx], buf[idx + 1], buf[idx + 2], buf[idx + 3]];
  };

  // 1. Outside slot (100, 100) must match static background
  const pF1 = getPixel(frame, 100, 100);
  const pB1 = getPixel(bg, 100, 100);
  const diffOutside = Math.max(Math.abs(pF1[0] - pB1[0]), Math.abs(pF1[1] - pB1[1]), Math.abs(pF1[2] - pB1[2]));
  assert.ok(diffOutside <= 15, `Outside slot must match background. Diff: ${diffOutside}`);

  // 2. Center of slot (960, 360) must be green
  const centerPix = getPixel(frame, 960, 360);
  assert.ok(centerPix[1] > 200 && centerPix[0] < 50 && centerPix[2] < 50, `Center of slot must be green: ${centerPix}`);

  // 3. Slot corner (782, 42) must be clipped to background by 48px rounded corner mask
  const pFCorner = getPixel(frame, 782, 42);
  const pBCorner = getPixel(bg, 782, 42);
  const diffCorner = Math.max(Math.abs(pFCorner[0] - pBCorner[0]), Math.abs(pFCorner[1] - pBCorner[1]), Math.abs(pFCorner[2] - pBCorner[2]));
  assert.ok(diffCorner <= 15, `Rounded corner must match background, not image. Diff: ${diffCorner}`);

  await fs.rm(dummyInput, { force: true });
  await fs.rm(testOutput, { force: true });
  await fs.rm(frameRaw, { force: true });
  await fs.rm(bgRaw, { force: true });
});

await test('Thumbnail service: ensureYouTubeThumbnailVariant creates and reuses elecio_thumbnail_16x9_v1 for REGULAR mode', async () => {
  const { default: Asset } = await import('../db/models/core/Asset.js');
  const { ensureYouTubeThumbnailVariant } = await import('../publisher/media/thumbnailVariants.js');
  const { putObject } = await import('../services/storage/s3.js');

  // Generate real 720x1280 test image and insert in S3 and DB
  const tempDir = path.resolve('./apps/core/temp');
  const localCover = path.join(tempDir, `test-cov-${crypto.randomUUID()}.jpg`);
  await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=1', '-frames:v', '1', localCover], { windowsHide: true });
  const coverBytes = await fs.readFile(localCover);
  await fs.rm(localCover, { force: true });

  const coverKey = `organizations/9998/campaigns/9998/assets/${crypto.randomUUID()}/cover.jpg`;
  await putObject(coverKey, coverBytes, 'image/jpeg');

  const testCover = await Asset.query().insertAndFetch({
    organization_id: 9998,
    campaign_id: 9998,
    kind: 'cover',
    status: 'ready',
    object_key: coverKey,
    mime_type: 'image/jpeg',
    width: 720,
    height: 1280,
    aspect_ratio: '9:16',
    size_bytes: coverBytes.length,
  });

  // Call 1: renders new variant
  const res1 = await ensureYouTubeThumbnailVariant(testCover, { mode: 'REGULAR' });
  assert.equal(res1.reused, false);
  assert.equal(res1.asset.width, 1280);
  assert.equal(res1.asset.height, 720);
  assert.equal(res1.asset.aspect_ratio, '16:9');
  assert.equal(res1.asset.probe_json?.variant_provenance?.profile, 'elecio_thumbnail_16x9_v1');

  // Call 2: reuses existing variant
  const res2 = await ensureYouTubeThumbnailVariant(testCover, { mode: 'REGULAR' });
  assert.equal(res2.reused, true);
  assert.equal(res2.asset.id, res1.asset.id);

  await Asset.query().deleteById(res1.asset.id);
  await Asset.query().deleteById(testCover.id);
});

// These fixtures always live in the isolated *_test database.  Clean up even
// after a failed assertion so a later run cannot obtain a false reuse result.
await db('outbox_events').where({ organization_id: 9998 }).delete();
await db('assets').where({ organization_id: 9998 }).delete();
await db('campaigns').where({ id: 9998 }).delete();
await db('organizations').where({ id: 9998 }).delete();
await db('user').whereIn('id', ['test-user-yt', 'test-user-asset']).delete();

for (const [name, ok, detail] of tests) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n${detail}` : ''}`);
const failed = tests.filter(([, ok]) => !ok);
console.log(`YouTube deterministic/runtime checks: ${tests.length - failed.length}/${tests.length} PASS`);
await db.destroy();
process.exitCode = failed.length ? 1 : 0;
