import '../bootstrap.js';
import { startWorker } from '../publisher/worker.js';
import { telegramPublishHandler } from '../publisher/handlers/telegramPublishHandler.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';
import {
  TELEGRAM_SUBJECT,
  TELEGRAM_WORKER_NAME,
} from '../publisher/platforms/telegram/constants.js';

const STREAM_NAME = 'ELECIO_JOBS';

async function main() {
  console.log(`Starting ${TELEGRAM_WORKER_NAME} on stream ${STREAM_NAME} subject ${TELEGRAM_SUBJECT}`);
  const controller = createShutdownController(TELEGRAM_WORKER_NAME);

  await startWorker(TELEGRAM_SUBJECT, TELEGRAM_WORKER_NAME, telegramPublishHandler, {
    streamName: STREAM_NAME,
    concurrency: 1,
    signal: controller.signal,
  });
  await closeProcessResources(TELEGRAM_WORKER_NAME);
}

main().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
