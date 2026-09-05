#!/usr/bin/env node
import '../../apps/core/src/bootstrap.js';
import { execFileSync } from 'node:child_process';
import getDb from '../../apps/core/src/config/database.js';
import { closeNats, connectNats } from '../../apps/core/src/services/messaging/nats.js';
import { checkBucketAccess } from '../../apps/core/src/services/storage/s3.js';
import { checkTelegramHealth } from '../../apps/core/src/publisher/telegram/api.js';

const mutating = process.argv.includes('--mutating');
if (mutating && process.env.CONFIRM_MUTATING_SMOKE !== 'I_UNDERSTAND_THIS_CAN_PUBLISH') {
  console.error('Refusing mutating smoke test without CONFIRM_MUTATING_SMOKE=I_UNDERSTAND_THIS_CAN_PUBLISH');
  process.exit(1);
}

const expectedPm2 = [
  'elecio-api',
  'elecio-panel',
  'elecio-telegram-bot',
  'elecio-outbox',
  'elecio-retry',
  'elecio-media',
  'elecio-cleanup',
  'elecio-youtube',
  'elecio-linkedin',
  'elecio-telegram-publisher',
  'elecio-aparat',
];

const results = [];
let exitCode = 0;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

async function main() {
  const db = getDb();
  try {
    await db.raw('SELECT 1');
    record('mysql', true);
  } catch (err) {
    record('mysql', false, err.message);
  }

  try {
    const nc = await connectNats();
    if (!nc) throw new Error('NATS unavailable');
    const jsm = await nc.jetstreamManager();
    await jsm.streams.info('ELECIO_JOBS');
    await jsm.streams.info('ELECIO_EVENTS');
    record('nats_jetstream', true);
  } catch (err) {
    record('nats_jetstream', false, err.message);
  }

  try {
    record('s3_bucket', await checkBucketAccess());
  } catch (err) {
    record('s3_bucket', false, err.message);
  }

  if (process.env.PUBLIC_BASE_URL) {
    try {
      const response = await fetch(`${process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/v1/health`);
      record('api_health', response.ok, `HTTP ${response.status}`);
    } catch (err) {
      record('api_health', false, err.message);
    }
  } else {
    record('api_health', false, 'PUBLIC_BASE_URL missing');
  }

  if (process.env.TELEGRAM_BOT_API_MODE === 'local') {
    const health = await checkTelegramHealth();
    record('telegram_local_getMe', health.telegram_local_api === 'healthy' && health.telegram_bot === 'authenticated', `${health.telegram_local_api}/${health.telegram_bot}`);
  } else {
    record('telegram_local_getMe', true, 'not_applicable');
  }

  try {
    const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8' });
    const names = JSON.parse(raw).map((app) => app.name);
    const missing = expectedPm2.filter((name) => !names.includes(name));
    record('pm2_expected_processes', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${expectedPm2.length} expected processes visible`);
  } catch (err) {
    record('pm2_expected_processes', false, err.message);
  }

  await closeNats().catch(() => {});
  await db.destroy().catch(() => {});

  console.log('PRODUCTION SMOKE TEST');
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
  }
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error(`FAIL smoke-test - ${err.message}`);
  await closeNats().catch(() => {});
  await getDb().destroy().catch(() => {});
  process.exit(1);
});
