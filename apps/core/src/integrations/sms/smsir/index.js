import axios from "axios";
import {
  IntegrationConfigError,
  IntegrationProviderError,
} from "../../integrationErrors.js";
import { INTEGRATION_DOMAINS } from "../../types.js";

export const SMSIR_ADAPTER_KEY = "sms.smsir";

const PROVIDER_CODE = "smsir";
const DEFAULT_BASE_URL = "https://api.sms.ir";

/**
 * SMS.ir adapter for provider-managed verification templates.
 * OTP generation, throttling, persistence, and delivery records belong to
 * domain services; this class only maps and sends the provider request.
 */
export class SmsirSmsAdapter {
  /**
   * @param {object} config Already-decrypted integration config JSON.
   * @param {object} [meta]
   * @param {number|string|null} [meta.configId]
   * @param {string|null} [meta.providerCode]
   * @param {{ post: Function }} [meta.httpClient] Test/client override.
   */
  constructor(config, meta = {}) {
    this.domain = INTEGRATION_DOMAINS.SMS;
    this.providerCode = meta.providerCode ?? PROVIDER_CODE;
    this.configId = meta.configId ?? null;
    this.settings = normalizeSmsirConfig(config, {
      configId: this.configId,
      providerCode: this.providerCode,
    });

    this.client = meta.httpClient ?? axios.create({
      baseURL: this.settings.base_url,
      headers: {
        "X-API-KEY": this.settings.api_key,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * @param {object} params
   * @param {string} params.to Recipient mobile number.
   * @param {number|string} [params.patternCode] SMS.ir template id.
   * @param {string} [params.patternKey] Configured pattern key (for example `otp`).
   * @param {Record<string, unknown>|Array<{name: string, value: unknown}>} params.params
   * @returns {Promise<{success: true, providerMessageId: string|null, providerPayload: unknown}>}
   */
  async sendVerifyCode({
    to,
    patternCode,
    patternKey,
    params = {},
  } = {}) {
    const mobile = requireNonEmptyString(to, "to", this);
    const pattern = resolvePattern(this.settings, { patternCode, patternKey }, this);
    const parameters = mapParameters(params, pattern.paramNames, this);

    try {
      const response = await this.client.post("/v1/send/verify/", {
        Mobile: mobile,
        TemplateId: pattern.patternCode,
        Parameters: parameters,
      });
      const payload = response?.data;

      if (Number(payload?.status) !== 1) {
        throw new IntegrationProviderError({
          code: "INTEGRATION_SMS_SEND_FAILED",
          message: "SMS.ir rejected the verification message",
          retryable: false,
          domain: this.domain,
          providerCode: this.providerCode,
          configId: this.configId,
          details: {
            httpStatusCode: response?.status ?? null,
            providerStatus: payload?.status ?? null,
          },
        });
      }

      return {
        success: true,
        providerMessageId: extractProviderMessageId(payload),
        providerPayload: payload,
      };
    } catch (error) {
      if (error instanceof IntegrationProviderError) {
        throw error;
      }
      throw mapSmsirError(error, this);
    }
  }

  /**
   * Convenience wrapper for the configured OTP pattern.
   * @param {{ to: string, params: Record<string, unknown>|Array<{name: string, value: unknown}> }} input
   */
  async sendOtp({ to, params = {} } = {}) {
    return this.sendVerifyCode({ to, params });
  }
}

/**
 * Factory used by the integration registry.
 * @param {{ providerConfig?: object, provider?: object, integrationConfig?: object }} context
 */
export function createSmsirSmsAdapter({
  providerConfig = {},
  provider,
  integrationConfig,
} = {}) {
  return new SmsirSmsAdapter(providerConfig, {
    configId: integrationConfig?.id ?? null,
    providerCode: provider?.code ?? PROVIDER_CODE,
  });
}

function normalizeSmsirConfig(config, meta) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw configError("SMS.ir config must be an object", meta);
  }

  const apiKey = requireConfigString(config.api_key, "api_key", meta);
  const patterns = normalizePatterns(config.patterns, meta);

  return {
    api_key: apiKey,
    line_number: config.line_number == null ? null : String(config.line_number),
    base_url:
      typeof config.base_url === "string" && config.base_url.trim() !== ""
        ? config.base_url.trim().replace(/\/+$/, "")
        : DEFAULT_BASE_URL,
    patterns,
    default_otp_pattern_key:
      typeof config.defaults?.otp_pattern_key === "string" &&
      config.defaults.otp_pattern_key.trim() !== ""
        ? config.defaults.otp_pattern_key.trim()
        : "otp",
  };
}

function normalizePatterns(value, meta) {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw configError("SMS.ir patterns must be an object", meta);
  }

  const patterns = {};
  for (const [key, pattern] of Object.entries(value)) {
    if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) {
      throw configError(`SMS.ir pattern '${key}' must be an object`, meta);
    }
    patterns[key] = {
      pattern_code: normalizePatternCode(pattern.pattern_code, meta),
      params: normalizeParamNames(pattern.params, meta, key),
    };
  }
  return patterns;
}

function normalizeParamNames(value, meta, patternKey) {
  if (value == null) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || name.trim() === "")
  ) {
    throw configError(
      `SMS.ir pattern '${patternKey}' params must be an array of names`,
      meta,
    );
  }
  return value.map((name) => name.trim());
}

function resolvePattern(settings, selector, adapter) {
  let configuredPattern = null;
  let selectedKey = selector.patternKey;

  if (selectedKey == null && selector.patternCode == null) {
    selectedKey = settings.default_otp_pattern_key;
  }

  if (selectedKey != null) {
    const key = requireNonEmptyString(selectedKey, "patternKey", adapter);
    configuredPattern = settings.patterns[key];
    if (!configuredPattern) {
      throw adapterConfigError(
        `SMS.ir pattern '${key}' is not configured`,
        adapter,
      );
    }
  }

  return {
    patternCode: normalizePatternCode(
      selector.patternCode ?? configuredPattern?.pattern_code,
      adapter,
    ),
    paramNames: configuredPattern?.params ?? [],
  };
}

function mapParameters(params, expectedNames, adapter) {
  if (Array.isArray(params)) {
    return params.map((param, index) => {
      if (!param || typeof param !== "object") {
        throw adapterConfigError(
          `SMS.ir parameter at index ${index} must be an object`,
          adapter,
        );
      }
      return {
        name: requireNonEmptyString(param.name, `params[${index}].name`, adapter),
        value: param.value == null ? "" : String(param.value),
      };
    });
  }

  if (!params || typeof params !== "object") {
    throw adapterConfigError("SMS.ir params must be an object or array", adapter);
  }

  const names = expectedNames.length > 0 ? expectedNames : Object.keys(params);
  return names.map((name) => ({
    name,
    value: params[name] == null ? "" : String(params[name]),
  }));
}

function normalizePatternCode(value, meta) {
  const code = Number(value);
  if (!Number.isSafeInteger(code) || code <= 0) {
    if (meta instanceof SmsirSmsAdapter) {
      throw adapterConfigError(
        "SMS.ir patternCode must be a positive integer",
        meta,
      );
    }
    throw configError("SMS.ir pattern_code must be a positive integer", meta);
  }
  return code;
}

function extractProviderMessageId(payload) {
  const value =
    payload?.data?.messageId ??
    payload?.data?.message_id ??
    payload?.data?.id ??
    payload?.messageId ??
    null;
  return value == null ? null : String(value);
}

function mapSmsirError(error, adapter) {
  const status = error?.response?.status ?? null;
  const providerStatus = error?.response?.data?.status ?? null;
  const retryable =
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    (status == null && ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(error?.code));

  return new IntegrationProviderError({
    code: "INTEGRATION_SMS_SEND_FAILED",
    message: "Failed to send SMS.ir verification message",
    retryable,
    domain: adapter.domain,
    providerCode: adapter.providerCode,
    configId: adapter.configId,
    cause: error,
    details: {
      httpStatusCode: status,
      providerStatus,
      providerErrorCode: error?.code ?? null,
    },
  });
}

function requireConfigString(value, field, meta) {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`SMS.ir config missing required field: ${field}`, meta);
  }
  return value.trim();
}

function requireNonEmptyString(value, field, adapter) {
  if (typeof value !== "string" || value.trim() === "") {
    throw adapterConfigError(`${field} must be a non-empty string`, adapter);
  }
  return value.trim();
}

function configError(message, meta) {
  return new IntegrationConfigError({
    code: "INTEGRATION_SMS_CONFIG_INVALID",
    message,
    domain: INTEGRATION_DOMAINS.SMS,
    providerCode: meta?.providerCode ?? PROVIDER_CODE,
    configId: meta?.configId ?? null,
  });
}

function adapterConfigError(message, adapter) {
  return new IntegrationConfigError({
    code: "INTEGRATION_SMS_REQUEST_INVALID",
    message,
    domain: adapter.domain,
    providerCode: adapter.providerCode,
    configId: adapter.configId,
  });
}
