import { ERROR_CATEGORY } from '../../constants.js';

export function normalizeTelegramError(rawError, options = {}) {
  if (rawError?.category && !options.isAmbiguous) {
    return rawError;
  }

  const status = rawError.status || rawError.error_code || rawError.response?.status || rawError.statusCode;
  const message = rawError.description || rawError.message || 'Telegram API request failed';

  if (options.isAmbiguous) {
    const error = new Error(`Ambiguous Telegram request outcome: ${message}`);
    error.code = 'TELEGRAM_AMBIGUOUS_STATE';
    error.category = ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE;
    error.safeMetadata = { status, originalMessage: message };
    return error;
  }

  if (rawError.code === 'TELEGRAM_FILE_TOO_LARGE') {
    const error = new Error(`Telegram file size limit exceeded: ${message}`);
    error.code = 'TELEGRAM_FILE_TOO_LARGE';
    error.category = ERROR_CATEGORY.VALIDATION;
    error.safeMetadata = { status };
    return error;
  }

  if (status === 401) {
    const error = new Error(`Telegram bot token unauthorized or revoked: ${message}`);
    error.code = 'TELEGRAM_AUTH_REQUIRED';
    error.category = ERROR_CATEGORY.AUTH_REQUIRED;
    error.safeMetadata = { status };
    return error;
  }

  if (status === 403) {
    const error = new Error(`Telegram channel permission denied or bot kicked: ${message}`);
    error.code = 'TELEGRAM_PERMISSION_DENIED';
    error.category = ERROR_CATEGORY.AUTH_REQUIRED;
    error.safeMetadata = { status };
    return error;
  }

  if (status === 429) {
    const retryAfter = rawError.parameters?.retry_after || rawError.headers?.get?.('retry-after') || rawError.retryAfter;
    let retryAfterMs = 30000;
    if (retryAfter) {
      const parsedSeconds = Number(retryAfter);
      if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
        retryAfterMs = parsedSeconds * 1000;
      }
    }
    const error = new Error(`Telegram rate limit exceeded: ${message}`);
    error.code = 'TELEGRAM_RATE_LIMIT';
    error.category = ERROR_CATEGORY.RATE_LIMIT;
    error.retryAfterMs = retryAfterMs;
    error.safeMetadata = { status, retryAfterMs };
    return error;
  }

  if (status === 400 || status === 422) {
    const error = new Error(`Telegram content or request validation failure: ${message}`);
    error.code = 'TELEGRAM_VALIDATION_ERROR';
    error.category = ERROR_CATEGORY.VALIDATION;
    error.safeMetadata = { status };
    return error;
  }

  if (typeof status === 'number' && status >= 500) {
    const error = new Error(`Telegram platform 5xx server error (${status}): ${message}`);
    error.code = 'TELEGRAM_SERVER_ERROR';
    error.category = ERROR_CATEGORY.PLATFORM_5XX;
    error.safeMetadata = { status };
    return error;
  }

  if (rawError.name === 'AbortError' || rawError.code === 'ECONNRESET' || rawError.code === 'ETIMEDOUT') {
    const error = new Error(`Telegram network failure: ${message}`);
    error.code = 'TELEGRAM_NETWORK_TRANSIENT';
    error.category = ERROR_CATEGORY.TRANSIENT_NETWORK;
    error.safeMetadata = { code: rawError.code };
    return error;
  }

  const genericError = new Error(`Telegram unexpected error: ${message}`);
  genericError.code = rawError.code || 'TELEGRAM_UNKNOWN_ERROR';
  genericError.category = rawError.category || ERROR_CATEGORY.PERMANENT;
  genericError.safeMetadata = { status, rawCode: rawError.code };
  return genericError;
}
