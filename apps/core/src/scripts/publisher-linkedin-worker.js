import '../bootstrap.js';
import { startWorker } from '../publisher/worker.js';
import { linkedinPublishHandler } from '../publisher/handlers/linkedinPublishHandler.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';
import {
  LINKEDIN_SUBJECT,
  LINKEDIN_WORKER_NAME,
} from '../publisher/platforms/linkedin/constants.js';

const STREAM_NAME = 'ELECIO_JOBS';

async function main() {
  console.log(`Starting ${LINKEDIN_WORKER_NAME} on stream ${STREAM_NAME} subject ${LINKEDIN_SUBJECT}`);
  const controller = createShutdownController(LINKEDIN_WORKER_NAME);

  await startWorker(LINKEDIN_SUBJECT, LINKEDIN_WORKER_NAME, linkedinPublishHandler, {
    streamName: STREAM_NAME,
    concurrency: 1,
    signal: controller.signal,
  });
  await closeProcessResources(LINKEDIN_WORKER_NAME);
}

main().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
