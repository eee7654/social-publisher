import '../bootstrap.js';
import { startWorker } from '../publisher/worker.js';
import { fakePublisherHandler } from '../publisher/handlers/fakePublisher.js';
import getDb from '../config/database.js';
const db = getDb();
import { connectNats } from '../services/messaging/nats.js';

async function main() {
  console.log('Starting Fake Publisher Worker...');
  const controller = new AbortController();

  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Shutting down worker...');
    controller.abort();
    
    setTimeout(async () => {
      await db.destroy();
      const nc = await connectNats();
      await nc.drain();
      process.exit(0);
    }, 500);
  });

  const subject = 'jobs.publish.test';
  const consumerName = 'WORKER_FAKE_PUBLISHER';

  await startWorker(subject, consumerName, fakePublisherHandler, { signal: controller.signal });
}

main().catch(err => {
  console.error('Fatal Worker error:', err);
  process.exit(1);
});
