/**
 * Integration kernel errors.
 * Codes are machine-stable; do not put user-facing translated prose here.
 */

export class IntegrationError extends Error {
  /**
   * @param {object} [options]
   * @param {string} [options.code]
   * @param {string} [options.message]
   * @param {boolean} [options.retryable]
   * @param {string|null} [options.domain]
   * @param {string|null} [options.providerCode]
   * @param {number|string|null} [options.configId]
   * @param {unknown} [options.cause]
   * @param {unknown} [options.details]
   */
  constructor({
    code = "INTEGRATION_ERROR",
    message,
    retryable = false,
    domain = null,
    providerCode = null,
    configId = null,
    cause = null,
    details = null,
  } = {}) {
    super(message || code);
    this.name = "IntegrationError";
    this.code = code;
    this.retryable = Boolean(retryable);
    this.domain = domain ?? null;
    this.providerCode = providerCode ?? null;
    this.configId = configId ?? null;
    this.details = details ?? null;
    if (cause !== undefined && cause !== null) {
      this.cause = cause;
    }
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class IntegrationConfigError extends IntegrationError {
  /**
   * @param {ConstructorParameters<typeof IntegrationError>[0]} [options]
   */
  constructor(options = {}) {
    super({
      retryable: false,
      ...options,
      code: options.code || "INTEGRATION_CONFIG_ERROR",
    });
    this.name = "IntegrationConfigError";
  }
}

export class IntegrationProviderError extends IntegrationError {
  /**
   * @param {ConstructorParameters<typeof IntegrationError>[0]} [options]
   */
  constructor(options = {}) {
    super({
      ...options,
      code: options.code || "INTEGRATION_PROVIDER_ERROR",
    });
    this.name = "IntegrationProviderError";
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableIntegrationError(error) {
  return Boolean(error instanceof IntegrationError && error.retryable);
}
