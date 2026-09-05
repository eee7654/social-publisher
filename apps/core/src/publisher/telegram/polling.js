import { getTelegramClient } from './api.js';
import { processTelegramUpdate } from './composer.js';
import { reconcileComposerSessions } from './reconciler.js';

/**
 * Long-polling runner for the Telegram Bot Composer.
 */
export async function startTelegramPolling(options = {}) {
  const telegramClient = options.telegramClient || getTelegramClient();
  const signal = options.signal;
  const pollTimeoutSeconds = options.pollTimeoutSeconds || 20;
  const reconcilerIntervalMs = options.reconcilerIntervalMs || 3000;

  let offset = 0;
  let isRunning = true;

  if (signal) {
    signal.addEventListener('abort', () => {
      isRunning = false;
      console.log('[TelegramPolling] Shutdown signal received. Stopping poll loop...');
    }, { once: true });
  }

  // Periodic reconciler timer
  const reconcilerTimer = setInterval(async () => {
    if (!isRunning) return;
    try {
      await reconcileComposerSessions({ telegramClient });
    } catch (err) {
      console.error('[TelegramPolling] Reconciler error:', err.message);
    }
  }, reconcilerIntervalMs);

  console.log('[TelegramPolling] Telegram Bot long-polling started...');

  while (isRunning) {
    try {
      const updates = await telegramClient.getUpdates({
        offset,
        limit: 50,
        timeout: pollTimeoutSeconds,
      });

      if (!isRunning) break;

      if (Array.isArray(updates) && updates.length > 0) {
        // Process sequentially in update_id order
        for (const update of updates) {
          if (!isRunning) break;

          try {
            await processTelegramUpdate(update, { telegramClient, ...options });
          } catch (updateErr) {
            console.error(`[TelegramPolling] Error processing update ${update.update_id}:`, updateErr.message);
          }

          offset = Math.max(offset, update.update_id + 1);
        }
      }
    } catch (pollErr) {
      if (!isRunning) break;
      console.error('[TelegramPolling] getUpdates poll error:', pollErr.message);
      // Backoff briefly on error before retrying
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  clearInterval(reconcilerTimer);
  console.log('[TelegramPolling] Telegram Bot polling stopped.');
}
