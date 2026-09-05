import '../bootstrap.js';
import { runDispatcherLoop } from '../publisher/dispatcher.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';

async function main() {
  console.log('Starting Outbox Dispatcher...');
  const controller = createShutdownController('OutboxDispatcher');

  await runDispatcherLoop(controller.signal);
  await closeProcessResources('OutboxDispatcher');
}

main().catch(err => {
  console.error('Fatal Outbox error:', err);
  process.exit(1);
});
