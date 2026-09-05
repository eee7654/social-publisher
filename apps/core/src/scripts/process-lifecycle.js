import getDb from '../config/database.js';
import { closeNats } from '../services/messaging/nats.js';

export function createShutdownController(name) {
  const controller = new AbortController();
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${name}] Shutdown signal received. Draining...`);
    controller.abort();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return controller;
}

export async function closeProcessResources(name) {
  try {
    await closeNats();
  } catch (err) {
    console.error(`[${name}] NATS close error:`, err.message || err);
  }

  try {
    await getDb().destroy();
  } catch (err) {
    console.error(`[${name}] Database close error:`, err.message || err);
  }
}

