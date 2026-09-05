export const TELEGRAM_PROVIDER_CODE = 'telegram';
export const TELEGRAM_ADAPTER_KEY = 'publishing.telegram';
export const TELEGRAM_CONNECTION_PURPOSE = 'channel_publishing';

export const TELEGRAM_CONNECTION_SOURCE = Object.freeze({
  TELEGRAM: 'telegram_bot',
});

export const TELEGRAM_INTENT_STATUS = Object.freeze({
  PENDING: 'pending',
  VERIFIED_PENDING_CONFIRMATION: 'verified_pending_confirmation',
  CONSUMED: 'consumed',
  CANCELLED: 'cancelled',
});

export const TELEGRAM_CONNECTION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export const TELEGRAM_SUBJECT = 'jobs.publish.telegram';
export const TELEGRAM_WORKER_NAME = 'publisher-telegram-worker';
