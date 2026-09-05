import IntegrationEvent from "../db/models/core/IntegrationEvent.js";
import { IntegrationError } from "./integrationErrors.js";
import { maskPayload } from "./secrets.js";
import { INTEGRATION_EVENT_STATUS } from "./types.js";

function normalizeEventErrorCode(value, fallback = "INTEGRATION_EVENT_FAILED") {
  const code = String(value || fallback);
  return /^[A-Za-z0-9_.-]{1,255}$/.test(code) ? code : fallback;
}

function normalizeStoredError(errorCode, errorMessage) {
  if (errorCode == null && errorMessage == null) {
    return { code: null, message: null };
  }

  const code = normalizeEventErrorCode(errorCode);
  return {
    code,
    message: `Integration failure (${code})`,
  };
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
function normalizeEventError(error) {
  if (error instanceof IntegrationError) {
    const code = normalizeEventErrorCode(error.code, "INTEGRATION_ERROR");
    return {
      code,
      message: `Integration failure (${code})`,
    };
  }

  if (error && typeof error === "object") {
    const code = normalizeEventErrorCode(
      /** @type {{ code?: unknown, errorCode?: unknown }} */ (error).code ||
        /** @type {{ errorCode?: unknown }} */ (error).errorCode,
    );
    return {
      code,
      message: "Integration event failed",
    };
  }

  return {
    code: "INTEGRATION_EVENT_FAILED",
    message: "Integration event failed",
  };
}

/**
 * @param {object} data
 * @param {number|string} data.providerId
 * @param {number|string|null} [data.configId]
 * @param {string} data.eventType
 * @param {string} data.direction
 * @param {string} [data.status]
 * @param {unknown} [data.requestJson]
 * @param {unknown} [data.responseJson]
 * @param {string|null} [data.errorCode]
 * @param {string|null} [data.errorMessage]
 * @param {string|null} [data.referenceType]
 * @param {number|string|null} [data.referenceId]
 * @param {import('objection').TransactionOrKnex} [data.trx]
 */
export async function createIntegrationEvent(data) {
  const {
    providerId,
    configId = null,
    eventType,
    direction,
    status = INTEGRATION_EVENT_STATUS.PENDING,
    requestJson = null,
    responseJson = null,
    errorCode = null,
    errorMessage = null,
    referenceType = null,
    referenceId = null,
    trx,
  } = data;

  if (providerId == null || !eventType || !direction) {
    throw new IntegrationError({
      code: "INTEGRATION_EVENT_INVALID",
      message: "providerId, eventType, and direction are required",
      configId,
    });
  }

  const normalizedError = normalizeStoredError(errorCode, errorMessage);

  return IntegrationEvent.query(trx).insertAndFetch({
    provider_id: providerId,
    config_id: configId,
    event_type: eventType,
    direction,
    status,
    request_json: maskPayload(requestJson),
    response_json: maskPayload(responseJson),
    error_code: normalizedError.code,
    error_message: normalizedError.message,
    reference_type: referenceType,
    reference_id: referenceId,
  });
}

/**
 * @param {number|string} eventId
 * @param {unknown} [responseJson]
 * @param {import('objection').TransactionOrKnex} [trx]
 */
export async function markIntegrationEventSuccess(
  eventId,
  responseJson = null,
  trx,
) {
  return IntegrationEvent.query(trx).patchAndFetchById(eventId, {
    status: INTEGRATION_EVENT_STATUS.SUCCESS,
    response_json: maskPayload(responseJson),
    error_code: null,
    error_message: null,
  });
}

/**
 * @param {number|string} eventId
 * @param {unknown} error
 * @param {unknown} [responseJson]
 * @param {import('objection').TransactionOrKnex} [trx]
 */
export async function markIntegrationEventFailed(
  eventId,
  error,
  responseJson = null,
  trx,
) {
  const normalized = normalizeEventError(error);
  return IntegrationEvent.query(trx).patchAndFetchById(eventId, {
    status: INTEGRATION_EVENT_STATUS.FAILED,
    response_json: maskPayload(responseJson),
    error_code: normalized.code,
    error_message: normalized.message,
  });
}

/**
 * Create a pending event, run `fn`, then mark success or failed.
 * Errors from `fn` are never swallowed.
 *
 * @param {Parameters<typeof createIntegrationEvent>[0]} data
 * @param {(event: object) => Promise<unknown> | unknown} fn
 */
export async function withIntegrationEvent(data, fn) {
  const event = await createIntegrationEvent({
    ...data,
    status: INTEGRATION_EVENT_STATUS.PENDING,
  });

  try {
    const result = await fn(event);
    const responseJson =
      result &&
      typeof result === "object" &&
      Object.prototype.hasOwnProperty.call(result, "responseJson")
        ? /** @type {{ responseJson?: unknown }} */ (result).responseJson
        : null;
    await markIntegrationEventSuccess(event.id, responseJson, data.trx);
    return result;
  } catch (error) {
    const responseJson =
      error &&
      typeof error === "object" &&
      Object.prototype.hasOwnProperty.call(error, "responseJson")
        ? /** @type {{ responseJson?: unknown }} */ (error).responseJson
        : null;

    try {
      await markIntegrationEventFailed(event.id, error, responseJson, data.trx);
    } catch (logError) {
      if (error && typeof error === "object") {
        try {
          Object.defineProperty(error, "integrationEventLogError", {
            configurable: true,
            enumerable: false,
            value: logError,
          });
        } catch {
          // Preserve the original integration failure even for frozen errors.
        }
      }
    }

    throw error;
  }
}
