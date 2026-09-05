import '../bootstrap.js';
import { startWorker } from '../publisher/worker.js';
import { aparatPublishHandler } from '../publisher/handlers/aparatPublishHandler.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';

// Worker configuration
const WORKER_NAME = 'WORKER_PUBLISH_APARAT';
const STREAM_NAME = 'ELECIO_JOBS';
const SUBJECT = 'jobs.publish.aparat';

async function main() {
  console.log(`Starting ${WORKER_NAME} on stream ${STREAM_NAME} subject ${SUBJECT}`);
  const controller = createShutdownController(WORKER_NAME);

  await startWorker(SUBJECT, WORKER_NAME, aparatPublishHandler, {
    streamName: STREAM_NAME,
    concurrency: 1, // Single concurrency to strictly enforce sequential resumable uploads per process
    signal: controller.signal,
  });
  await closeProcessResources(WORKER_NAME);
}

main().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
