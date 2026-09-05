import '../bootstrap.js';
import { startWorker } from '../publisher/worker.js';
import { instagramPublishHandler } from '../publisher/handlers/instagramPublishHandler.js';

const SUBJECT = 'jobs.publish.instagram';
const CONSUMER_NAME = 'WORKER_PUBLISH_INSTAGRAM';

const abortController = new AbortController();

process.on('SIGINT', () => {
  console.log('\n[InstagramWorker] Received SIGINT. Shutting down gracefully...');
  abortController.abort();
});

process.on('SIGTERM', () => {
  console.log('\n[InstagramWorker] Received SIGTERM. Shutting down gracefully...');
  abortController.abort();
});

async function main() {
  console.log('🚀 [InstagramWorker] Starting Instagram Publisher Worker Daemon...');
  console.log(`📡 Subject: ${SUBJECT}`);
  console.log(`👥 Consumer: ${CONSUMER_NAME}`);

  try {
    await startWorker(SUBJECT, CONSUMER_NAME, instagramPublishHandler, {
      signal: abortController.signal,
      lockTimeoutMs: 120000, // 2 minutes lock timeout for async Instagram upload
      heartbeatMs: 15000,
    });
    console.log('✅ [InstagramWorker] Worker stopped.');
    process.exit(0);
  } catch (err) {
    console.error('💥 [InstagramWorker] Fatal error:', err);
    process.exit(1);
  }
}

main();
