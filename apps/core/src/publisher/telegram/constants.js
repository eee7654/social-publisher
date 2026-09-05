export const COMPOSER_STATE = Object.freeze({
  IDLE: 'idle',
  WAITING_MEDIA: 'waiting_media',
  WAITING_MEDIA_READY: 'waiting_media_ready',
  WAITING_COVER: 'waiting_cover',
  WAITING_COVER_READY: 'waiting_cover_ready',
  WAITING_TARGET_CONFIRMATION: 'waiting_target_confirmation',
  WAITING_COMMON_METADATA: 'waiting_common_metadata',
  WAITING_TARGET_METADATA: 'waiting_target_metadata',
  REVIEW: 'review',
  READY: 'ready',
  CANCELLED: 'cancelled',
  ERROR: 'error',
});

export const RECEIPT_STATUS = Object.freeze({
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
});

export const BOT_COMMANDS = Object.freeze({
  START: '/start',
  NEWPOST: '/newpost',
  CANCEL: '/cancel',
  CONNECTIONS: '/connections',
  STATUS: '/status',
  HELP: '/help',
});

export const CALLBACK_ACTIONS = Object.freeze({
  RESUME_DRAFT: 'resume',
  CANCEL_START_NEW: 'restart',
  TOGGLE_TARGET: 'tgt_tog',
  CONFIRM_TARGETS: 'tgt_ok',
  SKIP_METADATA: 'meta_skip',
  YOUTUBE_MODE: 'yt_mode',
  FINAL_CONFIRM: 'final_ok',
  CANCEL_COMPOSITION: 'cancel',
});

export const RECEIPT_LEASE_TIMEOUT_SECONDS = 60;
export const TELEGRAM_SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_TELEGRAM_FILE_BYTES = 300 * 1024 * 1024; // 300 MB
