import { ERROR_CATEGORY } from '../../constants.js';

export function normalizeLinkedInError(rawError, options = {}) {
  if (rawError?.category && !options.isAmbiguous) {
    return rawError;
  }

  const status = rawError.status || rawError.response?.status || rawError.statusCode;
  const message = rawError.message || 'LinkedIn request failed';

  if (options.isAmbiguous) {
    const error = new Error(`Ambiguous LinkedIn request outcome: ${message}`);
    error.code = 'LINKEDIN_AMBIGUOUS_STATE';
    error.category = ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE;
    error.safeMetadata = { status, originalMessage: message };
    return error;
  }

  if (status === 401) {
    const error = new Error(`LinkedIn token expired or unauthorized: ${message}`);
    error.code = 'LINKEDIN_AUTH_REQUIRED';
    error.category = ERROR_CATEGORY.AUTH_REQUIRED;
    error.safeMetadata = { status };
    return error;
  }

  if (status === 403) {
    const error = new Error(`LinkedIn organization permission denied: ${message}`);
    error.code = 'LINKEDIN_PERMISSION_DENIED';
    error.category = ERROR_CATEGORY.AUTH_REQUIRED;
    error.safeMetadata = { status };
    return error;
  }

  if (status === 429) {
    const retryAfterHeader = rawError.headers?.get?.('retry-after') || rawError.retryAfter;
    let retryAfterMs = 60000;
    if (retryAfterHeader) {
      const parsedSeconds = Number(retryAfterHeader);
      if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
        retryAfterMs = parsedSeconds * 1000;
      }
    }
    const error = new Error(`LinkedIn rate limit exceeded: ${message}`);
    error.code = 'LINKEDIN_RATE_LIMIT';
    error.category = ERROR_CATEGORY.RATE_LIMIT;
    error.retryAfterMs = retryAfterMs;
    error.safeMetadata = { status, retryAfterMs };
    return error;
  }

  if (status === 400 || status === 422) {
    const error = new Error(`LinkedIn content validation failure: ${message}`);
    error.code = 'LINKEDIN_VALIDATION_ERROR';
    error.category = ERROR_CATEGORY.VALIDATION;
    error.safeMetadata = { status, details: rawError.data || null };
    return error;
  }

  if (typeof status === 'number' && status >= 500) {
    const error = new Error(`LinkedIn platform 5xx error (${status}): ${message}`);
    error.code = 'LINKEDIN_SERVER_ERROR';
    error.category = ERROR_CATEGORY.PLATFORM_5XX;
    error.safeMetadata = { status };
    return error;
  }

  if (rawError.name === 'AbortError' || rawError.code === 'ECONNRESET' || rawError.code === 'ETIMEDOUT') {
    const error = new Error(`LinkedIn network failure: ${message}`);
    error.code = 'LINKEDIN_NETWORK_TRANSIENT';
    error.category = ERROR_CATEGORY.TRANSIENT_NETWORK;
    error.safeMetadata = { code: rawError.code };
    return error;
  }

  const genericError = new Error(`LinkedIn unexpected error: ${message}`);
  genericError.code = rawError.code || 'LINKEDIN_UNKNOWN_ERROR';
  genericError.category = rawError.category || ERROR_CATEGORY.PERMANENT;
  genericError.safeMetadata = { status, rawCode: rawError.code };
  return genericError;
}
