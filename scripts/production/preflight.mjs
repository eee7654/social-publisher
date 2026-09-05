#!/usr/bin/env node
import '../../apps/core/src/bootstrap.js';
import fs from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import getDb from '../../apps/core/src/config/database.js';
import { closeNats, connectNats } from '../../apps/core/src/services/messaging/nats.js';
import { checkBucketAccess } from '../../apps/core/src/services/storage/s3.js';
import { checkTelegramHealth } from '../../apps/core/src/publisher/telegram/api.js';
import { decryptConfigValue, encryptConfigValue, isEncryptedConfigValue } from '../../apps/core/src/integrations/secrets.js';

const required = [
  'NODE_ENV',
  'PUBLIC_BASE_URL',
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'NATS_URL',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'INTEGRATION_CONFIG_ENCRYPTION_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_API_MODE',
  'TELEGRAM_BOT_API_BASE_URL',
];

if (process.env.TELEGRAM_BOT_API_MODE === 'local') {
  required.push('TELEGRAM_LOCAL_FILES_DIR');
}

const results = [];
let exitCode = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}

function commandVersion(command, args) {
  const res = spawnSync(command, args, { encoding: 'utf8' });
  return res.status === 0;
}

function readPnpmVersion() {
  for (const command of ['pnpm', 'pnpm.cmd']) {
    try {
      return execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
    } catch {}
  }
  if (process.env.npm_execpath?.toLowerCase().includes('pnpm')) {
    try {
      return execFileSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8' }).trim();
    } catch {}
  }
  const userAgent = process.env.npm_config_user_agent || '';
  const match = userAgent.match(/pnpm\/([^\s]+)/);
  return match?.[1] || '';
}

function findEncryptedValue(value) {
  if (isEncryptedConfigValue(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findEncryptedValue(entry);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      const found = findEncryptedValue(entry);
      if (found) return found;
    }
  }
  return null;
}

async function checkEncryption(db) {
  const roundTrip = 'preflight-roundtrip';
  if (decryptConfigValue(encryptConfigValue(roundTrip)) !== roundTrip) {
    throw new Error('encryption round-trip failed');
  }

  const rows = await db('integration_configs').select('id', 'config_json').limit(250);
  for (const row of rows) {
    const config = typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json;
    const encrypted = findEncryptedValue(config);
    if (encrypted) {
      decryptConfigValue(encrypted);
      return 'existing encrypted record decrypted';
    }
  }
  return 'round-trip only; no encrypted IntegrationConfig sample found';
}

async function main() {
  record('node', Number(process.versions.node.split('.')[0]) >= 18, process.versions.node);
  const pnpmVersion = readPnpmVersion();
  record('pnpm', pnpmVersion.length > 0, pnpmVersion || 'pnpm unavailable');

  const missing = required.filter((name) => !process.env[name]);
  record('required_env', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'present');

  const db = getDb();
  try {
    await db.raw('SELECT 1');
    record('mysql', true, 'SELECT 1');
  } catch (err) {
    record('mysql', false, err.message);
  }

  try {
    const nc = await connectNats();
    if (!nc) throw new Error('NATS unavailable');
    const jsm = await nc.jetstreamManager();
    for (const stream of ['ELECIO_JOBS', 'ELECIO_EVENTS']) {
      await jsm.streams.info(stream);
    }
    record('nats_jetstream', true, 'ELECIO_JOBS and ELECIO_EVENTS verified');
  } catch (err) {
    record('nats_jetstream', false, err.message);
  }

  try {
    record('s3_bucket', await checkBucketAccess(), 'bucket access');
  } catch (err) {
    record('s3_bucket', false, err.message);
  }

  record('ffmpeg', commandVersion(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']), process.env.FFMPEG_BIN || 'ffmpeg');
  record('ffprobe', commandVersion(process.env.FFPROBE_BIN || 'ffprobe', ['-version']), process.env.FFPROBE_BIN || 'ffprobe');

  if (process.env.TELEGRAM_BOT_API_MODE === 'local') {
    const health = await checkTelegramHealth();
    record('telegram_local_api', health.telegram_local_api === 'healthy', health.telegram_local_api);
    record('telegram_bot', health.telegram_bot === 'authenticated', health.telegram_bot);
  } else {
    record('telegram_local_api', true, 'not_applicable');
  }

  try {
    if (process.env.TELEGRAM_LOCAL_FILES_DIR) {
      await access(process.env.TELEGRAM_LOCAL_FILES_DIR, fsConstants.R_OK);
    }
    const tempDir = process.env.PUBLISHER_MEDIA_TEMP_DIR || '/tmp';
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    await access(tempDir, fsConstants.R_OK | fsConstants.W_OK);
    record('directories', true, 'read/write checks passed');
  } catch (err) {
    record('directories', false, err.message);
  }

  try {
    const detail = await checkEncryption(db);
    record('integration_encryption', true, detail);
  } catch (err) {
    record('integration_encryption', false, err.message);
  }

  await closeNats().catch(() => {});
  await db.destroy().catch(() => {});

  console.log('PRODUCTION PREFLIGHT');
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
  }
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error(`FAIL preflight - ${err.message}`);
  await closeNats().catch(() => {});
  await getDb().destroy().catch(() => {});
  process.exit(1);
});
