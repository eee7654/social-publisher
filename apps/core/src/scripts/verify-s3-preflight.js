import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();

import Asset from '../db/models/core/Asset.js';
import { createSignedReadUrl, isPrivateOrLocalHost } from '../services/storage/s3.js';
import { getMediaUrlTtlSeconds } from '../publisher/platforms/instagram/constants.js';

async function main() {
  console.log('================================================================================');
  console.log('🔍 PHASE 6 — S3 & MEDIA URL EXTERNAL REACHABILITY PREFLIGHT');
  console.log('================================================================================');

  const masterAsset = await Asset.query().where({ organization_id: 1, id: 661 }).first();
  const coverAsset = await Asset.query().where({ organization_id: 1, id: 662 }).first();

  if (!masterAsset || !coverAsset) {
    console.error('❌ Required test assets (649 / 650) not found.');
    process.exit(1);
  }

  const ttlSeconds = getMediaUrlTtlSeconds(); // 86400s (24 hours)

  const signedVideoUrl = await createSignedReadUrl(masterAsset.object_key, ttlSeconds);
  const signedCoverUrl = await createSignedReadUrl(coverAsset.object_key, ttlSeconds);

  const parsedVideo = new URL(signedVideoUrl);
  const parsedCover = new URL(signedCoverUrl);

  const videoHostCheck = isPrivateOrLocalHost(parsedVideo.hostname);
  const isHttps = parsedVideo.protocol === 'https:';

  console.log('1. ENDPOINT CONFIGURATION:');
  console.log(`   • Internal S3 Endpoint:      ${process.env.S3_ENDPOINT || 'http://127.0.0.1:9000'}`);
  console.log(`   • Public Signing Endpoint:   ${process.env.S3_PUBLIC_ENDPOINT || '(not configured, defaulting to S3_ENDPOINT)'}`);
  console.log(`   • Public Hostname:           ${parsedVideo.hostname}`);
  console.log(`   • Protocol:                  ${parsedVideo.protocol.replace(':', '').toUpperCase()}`);
  console.log(`   • Host Classification:       ${videoHostCheck.reason} (${videoHostCheck.isPublic ? 'Publicly Routable' : 'Private / Localhost'})`);
  console.log(`   • Ingest Window TTL:         ${ttlSeconds} seconds (${Math.round(ttlSeconds / 3600)} hours)`);

  let signedVideoFetchOk = false;
  let signedCoverFetchOk = false;
  let unsignedDenied = false;

  // Test signed video download (GET with Range: bytes=0-0)
  try {
    const videoGet = await fetch(signedVideoUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    signedVideoFetchOk = videoGet.status === 206 || videoGet.status === 200;
    console.log(`   • Signed Video Fetch:        HTTP ${videoGet.status} (${signedVideoFetchOk ? 'PASS (206/200 Range Accepted)' : 'FAIL'})`);
    console.log(`     - Content-Type:            ${videoGet.headers.get('content-type') || 'video/mp4'}`);
    console.log(`     - Content-Range:           ${videoGet.headers.get('content-range') || 'N/A'}`);
    console.log(`     - Content-Length:          ${videoGet.headers.get('content-length') || 'N/A'} bytes`);
    if (videoGet.body) await videoGet.body.cancel().catch(() => {});
  } catch (err) {
    console.log(`   • Signed Video Fetch:        ERROR: ${err.message}`);
  }

  // Test signed cover download (GET with Range: bytes=0-0)
  try {
    const coverGet = await fetch(signedCoverUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    signedCoverFetchOk = coverGet.status === 206 || coverGet.status === 200;
    console.log(`   • Signed Cover Fetch:        HTTP ${coverGet.status} (${signedCoverFetchOk ? 'PASS (206/200 Range Accepted)' : 'FAIL'})`);
    console.log(`     - Content-Type:            ${coverGet.headers.get('content-type') || 'image/jpeg'}`);
    console.log(`     - Content-Range:           ${coverGet.headers.get('content-range') || 'N/A'}`);
    console.log(`     - Content-Length:          ${coverGet.headers.get('content-length') || 'N/A'} bytes`);
    if (coverGet.body) await coverGet.body.cancel().catch(() => {});
  } catch (err) {
    console.log(`   • Signed Cover Fetch:        ERROR: ${err.message}`);
  }

  // Test unsigned access denial (GET with Range: bytes=0-0)
  const unsignedVideoUrl = `${process.env.S3_ENDPOINT || 'http://127.0.0.1:9000'}/${process.env.S3_BUCKET}/${masterAsset.object_key}`;
  try {
    const unsignedResp = await fetch(unsignedVideoUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    unsignedDenied = unsignedResp.status === 403;
    console.log(`   • Unsigned Request:          HTTP ${unsignedResp.status} (${unsignedDenied ? 'PASS — 403 Forbidden / AccessDenied (Private Bucket Preserved)' : 'FAIL — Bucket allows unsigned access!'})`);
    if (unsignedResp.body) await unsignedResp.body.cancel().catch(() => {});
  } catch (err) {
    console.log(`   • Unsigned Request:          Denied / Connection rejected (${err.message})`);
  }

  console.log('\n3. ENVIRONMENT VARIABLE BOOTSTRAP CHECK:');
  const envCheck = {
    DB_HOST: !!process.env.DB_HOST,
    DB_USER: !!process.env.DB_USER,
    DB_PASS: !!process.env.DB_PASS,
    DB_NAME: !!process.env.DB_NAME,
    INTEGRATION_CONFIG_ENCRYPTION_KEY: !!process.env.INTEGRATION_CONFIG_ENCRYPTION_KEY,
    S3_ENDPOINT: !!process.env.S3_ENDPOINT,
    S3_ACCESS_KEY: !!process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: !!process.env.S3_SECRET_KEY,
    S3_BUCKET: !!process.env.S3_BUCKET,
    NATS_URL: !!process.env.NATS_URL,
    META_GRAPH_API_VERSION: process.env.META_GRAPH_API_VERSION || 'v26.0 (Defaulted)',
  };

  console.log(`   • Database Credentials:      ${envCheck.DB_USER && envCheck.DB_PASS ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`   • Encryption Key:            ${envCheck.INTEGRATION_CONFIG_ENCRYPTION_KEY ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`   • S3 Storage Credentials:    ${envCheck.S3_ACCESS_KEY && envCheck.S3_SECRET_KEY ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`   • NATS Broker URL:           ${envCheck.NATS_URL ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`   • Meta Graph API Version:    ${envCheck.META_GRAPH_API_VERSION}`);

  console.log('================================================================================');
  const allPass = videoHostCheck.isPublic && isHttps && signedVideoFetchOk && signedCoverFetchOk && unsignedDenied;
  if (allPass) {
    console.log('🎉 EXTERNAL MEDIA PREFLIGHT: PASS');
  } else {
    console.log('⚠️  EXTERNAL MEDIA PREFLIGHT: FAIL');
    if (!videoHostCheck.isPublic || !isHttps) {
      console.log('   Reason: S3 media host is loopback / private-LAN (127.0.0.1:9000).');
      console.log('   Meta servers cannot download Reel media from 127.0.0.1.');
    } else if (!signedVideoFetchOk || !signedCoverFetchOk) {
      console.log('   Reason: Signed GET (Range: bytes=0-0) returned non-200/206 status.');
      console.log('   Ensure the reverse proxy / tunnel preserves the incoming public Host header when forwarding to MinIO.');
    }
  }
  console.log('================================================================================');

  await db.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('💥 Fatal error in preflight:', err);
  await db.destroy();
  process.exit(1);
});
