import {
  IntegrationConfigError,
  IntegrationProviderError,
} from '../../integrationErrors.js';
import { INTEGRATION_DOMAINS } from '../../types.js';

export const ZARINPAL_ADAPTER_KEY = 'payment.zarinpal';

const PROVIDER_CODE = 'zarinpal';
const MERCHANT_ID_LENGTH = 36;
const SUCCESS_STATUSES = new Set([100, 101]);
const PRODUCTION_BASE = 'https://www.zarinpal.com/pg/rest/WebGate/';
const SANDBOX_BASE = 'https://sandbox.zarinpal.com/pg/rest/WebGate/';
const PRODUCTION_PG = 'https://www.zarinpal.com/pg/StartPay/';
const SANDBOX_PG = 'https://sandbox.zarinpal.com/pg/StartPay/';

/**
 * Zarinpal payment adapter.
 * Receives already-decrypted providerConfig. Does not own payment state.
 */
export class ZarinpalPaymentAdapter {
  /**
   * @param {object} providerConfig
   * @param {object} [meta]
   * @param {number|string|null} [meta.configId]
   * @param {string|null} [meta.providerCode]
   */
  constructor(providerConfig, meta = {}) {
    this.domain = INTEGRATION_DOMAINS.PAYMENT;
    this.providerCode = meta.providerCode ?? PROVIDER_CODE;
    this.configId = meta.configId ?? null;
    this.settings = normalizeZarinpalConfig(providerConfig, {
      configId: this.configId,
      providerCode: this.providerCode,
    });
  }

  /**
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} [params.currency]
   * @param {string} [params.description]
   * @param {string} params.callbackUrl
   * @param {object} [params.metadata]
   * @param {string} [params.metadata.email]
   * @param {string} [params.metadata.mobile]
   * @param {string} [params.metadata.orderId]
   * @returns {Promise<object>}
   */
  async createPayment({
    amount,
    currency,
    description,
    callbackUrl,
    metadata = {},
  } = {}) {
    if (callbackUrl == null || String(callbackUrl).trim() === '') {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_CALLBACK_URL_REQUIRED',
        message: 'Zarinpal createPayment requires callbackUrl',
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    const providerAmount = applyAmountDivisor(amount, this.settings.amount_divisor, this);
    const payload = {
      MerchantID: this.settings.merchant_id,
      Amount: providerAmount,
      CallbackURL: String(callbackUrl),
      Description: description ?? '',
    };

    if (metadata.email) {
      payload.Email = String(metadata.email);
    }
    if (metadata.mobile) {
      payload.Mobile = String(metadata.mobile);
    }

    let response;
    try {
      response = await zarinpalRequest(this.settings, 'PaymentRequest.json', payload);
    } catch (error) {
      throw mapProviderError(error, this, {
        code: 'INTEGRATION_PAYMENT_CREATE_FAILED',
        message: 'Zarinpal PaymentRequest failed',
      });
    }

    const status = response?.status;
    const authority = response?.authority ? String(response.authority) : null;

    if (SUCCESS_STATUSES.has(status) && authority) {
      return {
        success: true,
        authority,
        redirectUrl: `${this.settings.pgBase}${authority}`,
        providerTransactionId: null,
        referenceNumber: null,
        raw: { status, authority },
      };
    }

    return {
      success: false,
      authority,
      errorCode: `ZARINPAL_CREATE_${status == null ? 'NO_STATUS' : status}`,
      errorMessage: response?.message || 'Zarinpal PaymentRequest rejected',
      raw: response,
    };
  }

  /**
   * @param {object|import('node:url').URLSearchParams} callbackData
   * @returns {{ authority: string|null, statusHint: 'ok'|'nok'|'unknown', raw: object }}
   */
  parseCallback(callbackData = {}) {
    const raw = normalizeCallbackData(callbackData);
    const status = pickStatus(raw);
    const authority = pickAuthority(raw);

    let statusHint = 'unknown';
    if (status != null) {
      statusHint = String(status).toUpperCase() === 'NOK' ? 'nok' : 'ok';
    } else if (authority) {
      statusHint = 'ok';
    }

    return { authority, statusHint, raw };
  }

  /**
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} [params.currency]
   * @param {string} [params.authority]
   * @param {string} [params.token]
   * @param {object} [params.callbackData]
   * @returns {Promise<object>}
   */
  async verifyPayment({
    amount,
    currency,
    authority,
    token,
    callbackData,
  } = {}) {
    const authorityValue = authority ?? token ?? pickAuthority(normalizeCallbackData(callbackData));

    if (!authorityValue) {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_AUTHORITY_REQUIRED',
        message: 'Zarinpal verifyPayment requires authority or token',
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    const providerAmount = applyAmountDivisor(amount, this.settings.amount_divisor, this);
    const payload = {
      MerchantID: this.settings.merchant_id,
      Amount: providerAmount,
      Authority: String(authorityValue),
    };

    let response;
    try {
      response = await zarinpalRequest(this.settings, 'PaymentVerification.json', payload);
    } catch (error) {
      throw mapProviderError(error, this, {
        code: 'INTEGRATION_PAYMENT_VERIFY_FAILED',
        message: 'Zarinpal PaymentVerification failed',
      });
    }

    const status = response?.status;
    const refId = response?.RefID != null ? String(response.RefID) : null;

    if (SUCCESS_STATUSES.has(status) && refId) {
      return {
        success: true,
        authority: String(authorityValue),
        providerTransactionId: refId,
        referenceNumber: refId,
        providerStatusCode: String(status),
        // Zarinpal's PaymentVerification response carries only `status` and
        // `RefID` — it never echoes back an amount or a currency, so there is
        // no provider-confirmed value to report and none is fabricated. The
        // verification is still amount-bound: the request above submits the
        // service-supplied expected amount and Zarinpal rejects a mismatch.
        providerVerifiedAmount: null,
        providerVerifiedCurrency: null,
        raw: { status, RefID: response.RefID },
      };
    }

    return {
      success: false,
      // A resolved HTTP response with a non-success status IS Zarinpal's
      // definitive answer — never fabricated finality for an unresolved case,
      // since an unresolved transport/HTTP failure throws above instead.
      terminal: true,
      authority: String(authorityValue),
      providerStatusCode: status == null ? null : String(status),
      providerVerifiedAmount: null,
      providerVerifiedCurrency: null,
      errorCode: `ZARINPAL_VERIFY_${status == null ? 'NO_STATUS' : status}`,
      errorMessage: response?.message || 'Zarinpal PaymentVerification rejected',
      raw: response,
    };
  }
}

/**
 * Factory for the integration registry.
 *
 * @param {{ providerConfig?: object, provider?: object, integrationConfig?: object }} context
 * @returns {ZarinpalPaymentAdapter}
 */
export function createZarinpalPaymentAdapter({
  providerConfig = {},
  provider,
  integrationConfig,
} = {}) {
  return new ZarinpalPaymentAdapter(providerConfig, {
    configId: integrationConfig?.id ?? null,
    providerCode: provider?.code ?? PROVIDER_CODE,
  });
}

/**
 * @param {object} config
 * @param {{ configId: number|string|null, providerCode: string }} meta
 */
function normalizeZarinpalConfig(config, meta) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PAYMENT_ZARINPAL_CONFIG_INVALID',
      message: 'Zarinpal config must be an object',
      domain: INTEGRATION_DOMAINS.PAYMENT,
      providerCode: meta.providerCode,
      configId: meta.configId,
    });
  }

  if (
    typeof config.merchant_id !== 'string' ||
    config.merchant_id.length !== MERCHANT_ID_LENGTH
  ) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PAYMENT_ZARINPAL_CONFIG_INVALID',
      message: `Zarinpal merchant_id must be a ${MERCHANT_ID_LENGTH}-character string`,
      domain: INTEGRATION_DOMAINS.PAYMENT,
      providerCode: meta.providerCode,
      configId: meta.configId,
    });
  }

  const sandbox = config.sandbox === true;
  const amountDivisor = resolveAmountDivisor(config.amount_divisor, meta);

  return {
    merchant_id: config.merchant_id,
    sandbox,
    apiBase: sandbox ? SANDBOX_BASE : PRODUCTION_BASE,
    pgBase: sandbox ? SANDBOX_PG : PRODUCTION_PG,
    currency_unit: typeof config.currency_unit === 'string' ? config.currency_unit : 'IRR',
    amount_divisor: amountDivisor,
  };
}

/**
 * @param {unknown} value
 * @param {{ configId: number|string|null, providerCode: string }} meta
 */
function resolveAmountDivisor(value, meta) {
  if (value == null || value === '') {
    return 1;
  }
  const divisor = Number(value);
  if (!Number.isFinite(divisor) || divisor <= 0 || !Number.isInteger(divisor)) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PAYMENT_ZARINPAL_CONFIG_INVALID',
      message: 'Zarinpal amount_divisor must be a positive integer',
      domain: INTEGRATION_DOMAINS.PAYMENT,
      providerCode: meta.providerCode,
      configId: meta.configId,
    });
  }
  return divisor;
}

/**
 * @param {number|string} amount
 * @param {number} divisor
 * @param {ZarinpalPaymentAdapter} adapter
 */
function applyAmountDivisor(amount, divisor, adapter) {
  if (amount == null) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PAYMENT_AMOUNT_REQUIRED',
      message: 'amount is required',
      domain: adapter.domain,
      providerCode: adapter.providerCode,
      configId: adapter.configId,
    });
  }

  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PAYMENT_AMOUNT_INVALID',
      message: 'amount must be a non-negative number',
      domain: adapter.domain,
      providerCode: adapter.providerCode,
      configId: adapter.configId,
    });
  }

  if (divisor === 1) {
    return numeric;
  }
  return numeric / divisor;
}

/**
 * @param {object} settings
 * @param {string} endpoint
 * @param {object} payload
 */
async function zarinpalRequest(settings, endpoint, payload) {
  const response = await fetch(`${settings.apiBase}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`Zarinpal HTTP ${response.status}`);
    error.status = response.status;
    error.response = body;
    throw error;
  }

  return body;
}

/**
 * @param {object|import('node:url').URLSearchParams} callbackData
 */
function normalizeCallbackData(callbackData) {
  if (!callbackData || typeof callbackData !== 'object') {
    return {};
  }
  if (callbackData instanceof URLSearchParams) {
    return Object.fromEntries(callbackData.entries());
  }
  return callbackData;
}

function pickStatus(raw) {
  if (raw == null) return null;
  return raw.Status ?? raw.status ?? null;
}

function pickAuthority(raw) {
  if (raw == null) return null;
  const value = raw.Authority ?? raw.authority ?? null;
  return value == null || value === '' ? null : String(value);
}

/**
 * @param {unknown} error
 * @param {ZarinpalPaymentAdapter} adapter
 * @param {{ code: string, message: string }} options
 */
function mapProviderError(error, adapter, { code, message }) {
  const status = error && typeof error === 'object'
    ? /** @type {{ status?: number }} */ (error).status
    : undefined;
  return new IntegrationProviderError({
    code,
    message,
    retryable: status === 429 || status === 500 || status === 502 || status === 503,
    domain: adapter.domain,
    providerCode: adapter.providerCode,
    configId: adapter.configId,
    details: {
      httpStatus: status ?? null,
      providerErrorName:
        error && typeof error === 'object'
          ? /** @type {{ name?: string }} */ (error).name ?? null
          : null,
    },
  });
}
