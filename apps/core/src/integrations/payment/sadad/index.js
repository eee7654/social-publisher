import {
  IntegrationConfigError,
  IntegrationProviderError,
} from '../../integrationErrors.js';
import { INTEGRATION_DOMAINS } from '../../types.js';
import { SadadEncryption } from './sadadEncryption.js';

export const SADAD_ADAPTER_KEY = 'payment.sadad';

const PROVIDER_CODE = 'sadad';
const SUCCESS_RESCODES = new Set(['0', '100']);
const PAYMENT_REQUEST_URL = 'https://sadad.shaparak.ir/api/v0/Request/PaymentRequest';
const PAYMENT_REQUEST_IDENTITY_URL =
  'https://sadad.shaparak.ir/api/v0/PaymentByIdentity/PaymentRequest';
const VERIFY_URL = 'https://sadad.shaparak.ir/api/v0/Advice/Verify';

/**
 * Sadad (Sepehr) payment adapter.
 * Receives already-decrypted providerConfig. Does not own payment state.
 */
export class SadadPaymentAdapter {
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
    this.settings = normalizeSadadConfig(providerConfig, {
      configId: this.configId,
      providerCode: this.providerCode,
    });
    this.encryption = new SadadEncryption(this.settings.merchant_key);
  }

  /**
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} [params.currency]
   * @param {string} [params.description]
   * @param {string} params.callbackUrl
   * @param {object} [params.metadata]
   * @param {string|number} [params.metadata.orderId]
   * @param {string|null} [params.metadata.paymentIdentity]
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
        message: 'Sadad createPayment requires callbackUrl',
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    const orderId = metadata.orderId;
    if (orderId == null || String(orderId).trim() === '') {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_ORDER_ID_REQUIRED',
        message: 'Sadad createPayment requires metadata.orderId',
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    const providerAmount = applyAmountDivisor(amount, this.settings.amount_divisor, this);
    const orderStr = String(orderId);
    const signData = this.encryption.encrypt(
      `${this.settings.terminal_id};${orderStr};${providerAmount}`,
    );

    /** @type {Record<string, unknown>} */
    const payload = {
      MerchantId: this.settings.merchant_id,
      TerminalId: this.settings.terminal_id,
      MerchantKey: this.settings.merchant_key,
      OrderId: orderStr,
      Amount: providerAmount,
      ReturnUrl: String(callbackUrl),
      LocalDateTime: new Date().toISOString(),
      SignData: signData,
      ApplicationName: this.settings.application_name,
    };

    const useIdentity = Boolean(
      this.settings.payment_identity || metadata.paymentIdentity,
    );
    const identity = this.settings.payment_identity || metadata.paymentIdentity;
    const url = useIdentity ? PAYMENT_REQUEST_IDENTITY_URL : PAYMENT_REQUEST_URL;
    if (useIdentity && identity) {
      payload.PaymentIdentity = String(identity);
    }

    let response;
    try {
      response = await sadadRequest(url, payload);
    } catch (error) {
      throw mapProviderError(error, this, {
        code: 'INTEGRATION_PAYMENT_CREATE_FAILED',
        message: 'Sadad PaymentRequest failed',
      });
    }

    const resCode = response?.ResCode != null ? String(response.ResCode) : null;
    const token = response?.Token ? String(response.Token) : null;

    if (SUCCESS_RESCODES.has(resCode) && token) {
      return {
        success: true,
        authority: token,
        redirectUrl: token,
        providerTransactionId: null,
        referenceNumber: null,
        raw: { ResCode: resCode, Token: token, SignData: signData },
      };
    }

    return {
      success: false,
      authority: token,
      errorCode: `SADAD_CREATE_${resCode == null ? 'NO_RESCODE' : resCode}`,
      errorMessage: response?.Description || 'Sadad PaymentRequest rejected',
      raw: response,
    };
  }

  /**
   * @param {object|import('node:url').URLSearchParams} callbackData
   * @returns {{ authority: string|null, statusHint: 'ok'|'nok'|'unknown', raw: object }}
   */
  parseCallback(callbackData = {}) {
    const raw = normalizeCallbackData(callbackData);
    const resCode = raw.ResCode != null ? String(raw.ResCode) : null;
    const token = raw.Token ? String(raw.Token) : null;

    let statusHint = 'unknown';
    if (resCode != null) {
      statusHint = SUCCESS_RESCODES.has(resCode) ? 'ok' : 'nok';
    } else if (token) {
      statusHint = 'ok';
    }

    return { authority: token, statusHint, raw };
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
    const tokenValue = authority ?? token ?? pickToken(normalizeCallbackData(callbackData));

    if (!tokenValue) {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_TOKEN_REQUIRED',
        message: 'Sadad verifyPayment requires authority or token',
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    const signData = this.encryption.encrypt(String(tokenValue));
    const payload = {
      Token: String(tokenValue),
      SignData: signData,
    };

    let response;
    try {
      response = await sadadRequest(VERIFY_URL, payload);
    } catch (error) {
      throw mapProviderError(error, this, {
        code: 'INTEGRATION_PAYMENT_VERIFY_FAILED',
        message: 'Sadad verify failed',
      });
    }

    const resCode = response?.ResCode != null ? String(response.ResCode) : null;
    const orderId = response?.OrderId != null ? String(response.OrderId) : null;
    const retrRefNum =
      response?.RetrRefNum != null ? String(response.RetrRefNum) : null;
    // Sadad's Verify response echoes the amount in PROVIDER units. Convert it
    // back through the same divisor `createPayment` applied so the service only
    // ever compares canonical business amounts — `amount_divisor` must never
    // reach domain amount storage. Sadad exposes no currency, so none is
    // reported rather than inventing one from config.
    const providerVerifiedAmount = reverseAmountDivisor(
      response?.Amount,
      this.settings.amount_divisor,
    );

    if (SUCCESS_RESCODES.has(resCode) && retrRefNum) {
      return {
        success: true,
        authority: String(tokenValue),
        providerTransactionId: retrRefNum,
        referenceNumber: retrRefNum,
        providerStatusCode: resCode,
        providerVerifiedAmount,
        providerVerifiedCurrency: null,
        providerOrderId: orderId,
        raw: { ResCode: resCode, OrderId: orderId, RetrRefNum: retrRefNum, Amount: response?.Amount ?? null },
      };
    }

    return {
      success: false,
      // A resolved HTTP response with a non-success ResCode IS Sadad's
      // definitive answer — an unresolved transport/HTTP failure throws above
      // instead, so no finality is fabricated for a genuinely unproven case.
      terminal: true,
      authority: String(tokenValue),
      providerStatusCode: resCode,
      providerVerifiedAmount,
      providerVerifiedCurrency: null,
      providerOrderId: orderId,
      errorCode: `SADAD_VERIFY_${resCode == null ? 'NO_RESCODE' : resCode}`,
      errorMessage: response?.Description || 'Sadad verify rejected',
      raw: response,
    };
  }
}

/**
 * Factory for the integration registry.
 *
 * @param {{ providerConfig?: object, provider?: object, integrationConfig?: object }} context
 * @returns {SadadPaymentAdapter}
 */
export function createSadadPaymentAdapter({
  providerConfig = {},
  provider,
  integrationConfig,
} = {}) {
  return new SadadPaymentAdapter(providerConfig, {
    configId: integrationConfig?.id ?? null,
    providerCode: provider?.code ?? PROVIDER_CODE,
  });
}

/**
 * @param {object} config
 * @param {{ configId: number|string|null, providerCode: string }} meta
 */
function normalizeSadadConfig(config, meta) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PAYMENT_SADAD_CONFIG_INVALID',
      message: 'Sadad config must be an object',
      domain: INTEGRATION_DOMAINS.PAYMENT,
      providerCode: meta.providerCode,
      configId: meta.configId,
    });
  }

  const required = ['merchant_id', 'terminal_id', 'merchant_key'];
  for (const field of required) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      throw new IntegrationConfigError({
        code: 'INTEGRATION_PAYMENT_SADAD_CONFIG_INVALID',
        message: `Sadad config missing required field: ${field}`,
        domain: INTEGRATION_DOMAINS.PAYMENT,
        providerCode: meta.providerCode,
        configId: meta.configId,
      });
    }
  }

  const amountDivisor = resolveAmountDivisor(config.amount_divisor, meta);

  return {
    merchant_id: String(config.merchant_id).trim(),
    terminal_id: String(config.terminal_id).trim(),
    merchant_key: String(config.merchant_key).trim(),
    application_name:
      typeof config.application_name === 'string' && config.application_name.trim() !== ''
        ? config.application_name.trim()
        : 'Esima Commerce',
    payment_identity:
      typeof config.payment_identity === 'string' && config.payment_identity.trim() !== ''
        ? config.payment_identity.trim()
        : null,
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
      code: 'INTEGRATION_PAYMENT_SADAD_CONFIG_INVALID',
      message: 'Sadad amount_divisor must be a positive integer',
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
 * @param {SadadPaymentAdapter} adapter
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
 * Converts a provider-unit amount back into the canonical business amount by
 * reversing the `amount_divisor` that `createPayment` applied. Returns `null`
 * for anything the provider did not genuinely supply as a number, so a missing
 * field is reported as "not confirmed" rather than as a confirmed zero.
 *
 * @param {unknown} providerAmount
 * @param {number} divisor
 * @returns {number|null}
 */
function reverseAmountDivisor(providerAmount, divisor) {
  if (providerAmount == null || providerAmount === '') {
    return null;
  }
  const numeric = Number(providerAmount);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return divisor === 1 ? numeric : numeric * divisor;
}

/**
 * @param {string} url
 * @param {object} payload
 */
async function sadadRequest(url, payload) {
  const response = await fetch(url, {
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
    const error = new Error(`Sadad HTTP ${response.status}`);
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

function pickToken(raw) {
  if (raw == null) return null;
  const value = raw.Token ?? raw.token ?? null;
  return value == null || value === '' ? null : String(value);
}

/**
 * @param {unknown} error
 * @param {SadadPaymentAdapter} adapter
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
