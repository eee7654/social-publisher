#!/usr/bin/env node
import '../../apps/core/src/bootstrap.js';
import { execFileSync } from 'node:child_process';
import { checkTelegramHealth } from '../../apps/core/src/publisher/telegram/api.js';

async function main() {
  console.log('ELECIO PRODUCTION STATUS');
  try {
    const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8' });
    const apps = JSON.parse(raw)
      .filter((app) => app.pm2_env?.namespace === 'elecio-publisher')
      .map((app) => ({
        name: app.name,
        status: app.pm2_env?.status,
        restarts: app.pm2_env?.restart_time,
        memoryMb: Math.round((app.monit?.memory || 0) / 1024 / 1024),
      }));
    for (const app of apps) {
      console.log(`${app.name}: ${app.status} restarts=${app.restarts} memoryMb=${app.memoryMb}`);
    }
  } catch (err) {
    console.log(`PM2: unavailable (${err.message})`);
  }

  if (process.env.PUBLIC_BASE_URL) {
    try {
      const response = await fetch(`${process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/v1/health`);
      const body = await response.json().catch(() => ({}));
      console.log(`API health: HTTP ${response.status} mysql=${body.mysql} nats=${body.nats} objectStorage=${body.objectStorage}`);
    } catch (err) {
      console.log(`API health: unavailable (${err.message})`);
    }
  }

  const telegram = await checkTelegramHealth().catch((err) => ({ telegram_local_api: 'unhealthy', telegram_bot: 'unavailable', error: err.message }));
  console.log(`Telegram: local_api=${telegram.telegram_local_api} bot=${telegram.telegram_bot}`);
}

main().catch((err) => {
  console.error(`Status failed: ${err.message}`);
  process.exit(1);
});

