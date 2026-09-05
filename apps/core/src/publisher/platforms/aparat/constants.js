export const APARAT_DEFAULT_BASE_URL = 'https://www.aparat.com';
export const APARAT_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const APARAT_PROVIDER_KEY = 'publishing.aparat';
export const APARAT_PROVIDER_CODE = 'aparat';
export const APARAT_AUTH_MODE = 'aparat_web_session_v1';

export const APARAT_CONNECTION_PURPOSE = 'aparat_connection';

export const APARAT_CONNECTION_SOURCE = Object.freeze({
  TELEGRAM: 'telegram',
});

export const APARAT_INTENT_STATUS = Object.freeze({
  PENDING: 'pending',
  VERIFIED_PENDING_CONFIRMATION: 'verified_pending_confirmation',
  CONSUMED: 'consumed',
  CANCELLED: 'cancelled',
});

export const APARAT_CONNECTION_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Upload and media constants
export const APARAT_CHUNK_BYTES = 3_000_000; // Exactly 3 MB chunks
export const APARAT_MAX_COVER_BYTES = 4_000_000; // 4 MB cover upload limit
export const APARAT_MAX_TITLE_CHARS = 100;
export const APARAT_MIN_TAGS = 3;
export const APARAT_MAX_TAGS = 5;
export const APARAT_DEFAULT_CATEGORY_ID = '16'; // Business / کسب و کار fallback default
