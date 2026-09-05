import '../bootstrap.js';
import { runSchedulerLoop } from '../publisher/scheduler.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';

async function main() {
  console.log('Starting Retry Scheduler...');
  const controller = createShutdownController('RetryScheduler');

  await runSchedulerLoop(controller.signal);
  await closeProcessResources('RetryScheduler');
}

main().catch(err => {
  console.error('Fatal Scheduler error:', err);
  process.exit(1);
});
