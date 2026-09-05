import { ERROR_CATEGORY } from '../../constants.js';
import { INSTAGRAM_STAGE } from './constants.js';

export class InstagramAdapterError extends Error {
  constructor({
    message,
    category = ERROR_CATEGORY.PERMANENT,
    code = 'INSTAGRAM_ERROR',
    status = null,
    retryAfterMs = null,
    safeMetadata = {},
    cause = null,
  }) {
    super(message);
    this.name = 'InstagramAdapterError';
    this.isNormalized = true;
    this.category = category;
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.safeMetadata = safeMetadata;
    if (cause) this.cause = cause;
  }
}

/**
 * Classifies Meta Graph API responses and network/transport exceptions
 * into the project's standard error categories.
 *
 * @param {Error|Object} errOrResponse
 * @param {Object} [context]
 * @param {string} [context.stage] - current INSTAGRAM_STAGE
 * @returns {InstagramAdapterError}
 */
export function classifyMetaError(errOrResponse, context = {}) {
  const stage = context.stage || null;

  if (errOrResponse instanceof InstagramAdapterError) {
    return errOrResponse;
  }

  // Check if it's already a normalized error object
  if (errOrResponse && errOrResponse.isNormalized) {
    return errOrResponse;
  }

  // 1. Network / Transport Error (fetch/httpx/socket)
  const isNetworkError =
    errOrResponse?.name === 'FetchError' ||
    errOrResponse?.name === 'AbortError' ||
    errOrResponse?.code === 'ECONNRESET' ||
    errOrResponse?.code === 'ETIMEDOUT' ||
    errOrResponse?.code === 'ENOTFOUND' ||
    errOrResponse?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    errOrResponse?.message?.includes('network') ||
    errOrResponse?.message?.includes('timeout') ||
    errOrResponse?.message?.includes('fetch failed');

  if (isNetworkError) {
    if (stage === INSTAGRAM_STAGE.PUBLISH_REQUESTED) {
      return new InstagramAdapterError({
        message: 'Network failure while awaiting media_publish response. External state is ambiguous.',
        category: ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE,
        code: 'META_PUBLISH_AMBIGUOUS_TIMEOUT',
        safeMetadata: { stage, reason: 'NETWORK_TIMEOUT_POST_PUBLISH' },
        cause: errOrResponse,
      });
    }

    return new InstagramAdapterError({
      message: `Meta network transport failure: ${errOrResponse.message || 'connection timeout'}`,
      category: ERROR_CATEGORY.TRANSIENT_NETWORK,
      code: 'META_NETWORK_FAILURE',
      safeMetadata: { stage },
      cause: errOrResponse,
    });
  }

  // 2. Extract Meta API error body if present
  const status = errOrResponse?.status || errOrResponse?.statusCode || null;
  const metaError = errOrResponse?.error || (errOrResponse?.responseBody?.error) || null;
  const errorCode = metaError?.code || null;
  const errorSubcode = metaError?.error_subcode || null;
  const errorType = metaError?.type || '';
  const errorMessage = metaError?.message || errOrResponse?.message || 'Meta API error';

  const safeMetadata = {
    httpStatus: status,
    metaCode: errorCode,
    metaSubcode: errorSubcode,
    metaType: errorType,
    fbtraceId: metaError?.fbtrace_id || null,
    stage,
  };

  // 3. Auth Required: 401 or OAuthException / token expired / invalid permissions
  const isAuthError =
    status === 401 ||
    errorCode === 190 || // Invalid OAuth 2.0 Access Token
    errorCode === 102 || // Session key invalid
    errorCode === 10 || // Permission denied
    errorCode === 200 || // Permission error
    errorType.includes('OAuthException') ||
    errorMessage.toLowerCase().includes('access token') ||
    errorMessage.toLowerCase().includes('session has expired') ||
    errorMessage.toLowerCase().includes('permissions');

  if (isAuthError) {
    return new InstagramAdapterError({
      message: `Meta authentication / permission error: ${errorMessage}`,
      category: ERROR_CATEGORY.AUTH_REQUIRED,
      code: 'META_AUTH_REQUIRED',
      status,
      safeMetadata,
    });
  }

  // 4. Rate Limit: 429 or Meta rate limit codes
  const isRateLimit =
    status === 429 ||
    errorCode === 4 || // Application request limit reached
    errorCode === 17 || // User request limit reached
    errorCode === 32 || // Page request limit reached
    errorCode === 613 || // Custom rate limit
    errorMessage.toLowerCase().includes('rate limit') ||
    errorMessage.toLowerCase().includes('too many calls');

  if (isRateLimit) {
    let retryAfterMs = 60000;
    if (errOrResponse?.headers && typeof errOrResponse.headers.get === 'function') {
      const retryHeader = errOrResponse.headers.get('retry-after');
      if (retryHeader) {
        const sec = parseInt(retryHeader, 10);
        if (Number.isFinite(sec) && sec > 0) retryAfterMs = sec * 1000;
      }
    }

    return new InstagramAdapterError({
      message: `Meta rate limit reached: ${errorMessage}`,
      category: ERROR_CATEGORY.RATE_LIMIT,
      code: 'META_RATE_LIMIT',
      status: 429,
      retryAfterMs,
      safeMetadata,
    });
  }

  // 5. Meta 5xx Server Errors (Transient)
  if (status && status >= 500 && status < 600) {
    if (stage === INSTAGRAM_STAGE.PUBLISH_REQUESTED) {
      return new InstagramAdapterError({
        message: 'Meta 5xx response received after media_publish was dispatched. External state is ambiguous.',
        category: ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE,
        code: 'META_PUBLISH_5XX_AMBIGUOUS',
        status,
        safeMetadata,
      });
    }

    return new InstagramAdapterError({
      message: `Meta platform 5xx error (${status}): ${errorMessage}`,
      category: ERROR_CATEGORY.PLATFORM_5XX,
      code: 'META_5XX_ERROR',
      status,
      safeMetadata,
    });
  }

  // 6. Validation / Parameter Errors (400, code 100, invalid media / aspect ratio / caption)
  const isValidation =
    status === 400 ||
    errorCode === 100 ||
    errorMessage.toLowerCase().includes('invalid parameter') ||
    errorMessage.toLowerCase().includes('aspect ratio') ||
    errorMessage.toLowerCase().includes('video format') ||
    errorMessage.toLowerCase().includes('media');

  if (isValidation) {
    return new InstagramAdapterError({
      message: `Meta parameter validation failure: ${errorMessage}`,
      category: ERROR_CATEGORY.VALIDATION,
      code: 'META_VALIDATION_ERROR',
      status,
      safeMetadata,
    });
  }

  // 7. General Fallback
  if (stage === INSTAGRAM_STAGE.PUBLISH_REQUESTED) {
    return new InstagramAdapterError({
      message: `Ambiguous error during media_publish: ${errorMessage}`,
      category: ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE,
      code: 'META_AMBIGUOUS_ERROR',
      status,
      safeMetadata,
    });
  }

  return new InstagramAdapterError({
    message: `Meta API error: ${errorMessage}`,
    category: ERROR_CATEGORY.PERMANENT,
    code: 'META_PERMANENT_ERROR',
    status,
    safeMetadata,
  });
}
