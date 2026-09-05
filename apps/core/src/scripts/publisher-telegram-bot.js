import '../bootstrap.js';
import { startTelegramPolling } from '../publisher/telegram/polling.js';
import { closeProcessResources, createShutdownController } from './process-lifecycle.js';

async function main() {
  console.log('Starting Publisher Telegram Bot Daemon...');
  const controller = createShutdownController('TelegramBot');

  try {
    await startTelegramPolling({ signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('💥 Fatal Telegram Bot Error:', err);
    process.exit(1);
  } finally {
    await closeProcessResources('TelegramBot');
    console.log('[TelegramBot] Process finished.');
  }
}

if (process.argv[1]?.endsWith('publisher-telegram-bot.js')) {
  main();
}
