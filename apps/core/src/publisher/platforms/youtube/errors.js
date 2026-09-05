import { ERROR_CATEGORY } from '../../constants.js';

export class YouTubeAdapterError extends Error {
  constructor(category, message, cause = null) {
    super(message);
    this.name = 'YouTubeAdapterError';
    this.category = category;
    if (cause) {
      this.cause = cause;
      this.code = cause.code;
    }
  }
}

function googleErrorCode(err) {
  const data = err?.response?.data;
  const value = data?.error;
  if (typeof value === 'string') return value;
  return value?.code || err?.code || err?.name || null;
}

function googleErrorReason(err) {
  const details = err?.response?.data?.error?.errors;
  return Array.isArray(details) ? details[0]?.reason : null;
}

function googleErrorMessage(err) {
  const data = err?.response?.data;
  return data?.error_description ||
    data?.error?.message ||
    err?.message ||
    'An unknown YouTube error occurred';
}

function isGoogleAuthError(err, msg) {
  const code = String(googleErrorCode(err) || '').toLowerCase();
  const reason = String(googleErrorReason(err) || '').toLowerCase();
  const text = msg.toLowerCase();
  return [
    code,
    reason,
    text,
  ].some(value =>
    value.includes('invalid_request') ||
    value.includes('invalid_client') ||
    value.includes('invalid_grant') ||
    value.includes('revoked') ||
    value.includes('insufficientpermissions') ||
    value.includes('insufficient authentication scopes')
  );
}

export function categorizeYouTubeError(err) {
  if (err instanceof YouTubeAdapterError) return err;
  const msg = googleErrorMessage(err);
  
  if (isGoogleAuthError(err, msg)) {
    return new YouTubeAdapterError(ERROR_CATEGORY.AUTH_REQUIRED, `YouTube Auth Error: ${msg}`, err);
  }
  
  if (msg.includes('quotaExceeded') || msg.includes('dailyLimitExceeded') || msg.includes('429')) {
    return new YouTubeAdapterError(ERROR_CATEGORY.RATE_LIMIT, `YouTube Rate Limit: ${msg}`, err);
  }
  
  if (msg.includes('400') || msg.includes('validation')) {
    return new YouTubeAdapterError(ERROR_CATEGORY.VALIDATION, `YouTube Validation Error: ${msg}`, err);
  }
  
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('network') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
    return new YouTubeAdapterError(ERROR_CATEGORY.TRANSIENT_NETWORK, `YouTube Transient Error: ${msg}`, err);
  }
  
  return new YouTubeAdapterError(ERROR_CATEGORY.PERMANENT, `YouTube Unknown Error: ${msg}`, err);
}
