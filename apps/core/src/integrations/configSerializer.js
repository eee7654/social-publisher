/**
 * Provider config (de)serialization: the secret boundary.
 *
 * This is deliberately kernel code rather than service code, and deliberately
 * free of database and HTTP imports. Everything that decides whether a
 * credential is encrypted, preserved, replaced, or shown lives in these two
 * functions, so the rule can be read — and unit-tested — in one place instead
 * of being spread across a controller and a query builder.
 *
 * Two invariants hold across every provider:
 *
 *   1. A `secret` field never leaves the process as a value. Not plaintext,
 *      not ciphertext, not `****`. `toPublicProviderConfig` omits the key and
 *      reports only whether something is stored. A placeholder rendered into
 *      an editable input is one submit away from being saved as a literal
 *      credential, and every masking scheme that round-trips has that bug.
 *
 *   2. A key the provider schema does not declare is dropped on write. That is
 *      what makes this a settings surface rather than an arbitrary JSON
 *      editor, and it holds even if a client sends extra keys.
 */

import {
  getIntegrationConfigSchema,
  getConfigValue,
  setConfigValue,
  INTEGRATION_FIELD_KINDS,
} from './configSchemas.js';
import { IntegrationConfigError } from './integrationErrors.js';
import { encryptConfigValue, isEncryptedConfigValue } from './secrets.js';

export const INTEGRATION_CONFIG_ERROR_CODES = Object.freeze({
  FIELD_INVALID: 'INTEGRATION_CONFIG_FIELD_INVALID',
  NOT_CONFIGURABLE: 'INTEGRATION_CONFIG_NOT_CONFIGURABLE',
});

/**
 * @param {string} path
 * @param {string} reason
 */
function fieldError(path, reason) {
  return new IntegrationConfigError({
    code: INTEGRATION_CONFIG_ERROR_CODES.FIELD_INVALID,
    message: `Invalid value for '${path}': ${reason}`,
    details: { path, reason },
  });
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {import('./configSchemas.js').IntegrationConfigField} field
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceField(field, value) {
  switch (field.kind) {
    case INTEGRATION_FIELD_KINDS.BOOLEAN: {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw fieldError(field.path, 'expected a boolean');
    }

    case INTEGRATION_FIELD_KINDS.NUMBER: {
      const num = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(num)) throw fieldError(field.path, 'expected a number');
      if (field.integer === true && !Number.isInteger(num)) {
        throw fieldError(field.path, 'expected an integer');
      }
      if (field.min != null && num < field.min) {
        throw fieldError(field.path, `must be at least ${field.min}`);
      }
      return num;
    }

    case INTEGRATION_FIELD_KINDS.ENUM: {
      const text = String(value);
      if (!field.options?.includes(text)) {
        throw fieldError(field.path, `must be one of ${field.options?.join(', ')}`);
      }
      return text;
    }

    case INTEGRATION_FIELD_KINDS.PATTERN_MAP:
      return coercePatternMap(field, value);

    case INTEGRATION_FIELD_KINDS.ORIGIN_MAP:
      return coerceOriginMap(field, value);

    case INTEGRATION_FIELD_KINDS.URL:
    case INTEGRATION_FIELD_KINDS.TEXT:
    case INTEGRATION_FIELD_KINDS.SECRET:
    default: {
      if (typeof value !== 'string') throw fieldError(field.path, 'expected a string');
      const text = value.trim();
      if (text === '') throw fieldError(field.path, 'must not be empty');
      if (field.length != null && text.length !== field.length) {
        throw fieldError(field.path, `must be exactly ${field.length} characters`);
      }
      return text;
    }
  }
}

/**
 * Mirrors `normalizeSmsirConfig`'s pattern contract so a malformed pattern map
 * is rejected while the merchant is looking at the form, rather than at the
 * first SMS send hours later.
 */
function coercePatternMap(field, value) {
  if (!isPlainObject(value)) throw fieldError(field.path, 'expected an object');

  /** @type {Record<string, { pattern_code: string, params: string[] }>} */
  const out = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw fieldError(field.path, 'pattern names must be non-empty strings');
    }
    if (!isPlainObject(entry)) {
      throw fieldError(`${field.path}.${key}`, 'expected an object');
    }

    const code = entry.pattern_code;
    if (code == null || String(code).trim() === '') {
      throw fieldError(`${field.path}.${key}.pattern_code`, 'must not be empty');
    }

    const params = entry.params == null ? [] : entry.params;
    if (!Array.isArray(params)) {
      throw fieldError(`${field.path}.${key}.params`, 'expected an array of names');
    }
    if (params.some((name) => typeof name !== 'string' || name.trim() === '')) {
      throw fieldError(`${field.path}.${key}.params`, 'expected an array of non-empty names');
    }

    out[key.trim()] = {
      pattern_code: String(code).trim(),
      params: params.map((name) => name.trim()),
    };
  }

  return out;
}

/**
 * Warehouse → provider-origin binding.
 *
 * Keys are normalized to the canonical decimal form of a positive integer
 * warehouse id, so `"12"`, `" 12 "` and `12` cannot become three distinct
 * bindings for one Warehouse — a duplicate binding would make origin resolution
 * depend on object key order, which is exactly the "arbitrary origin" the slice
 * forbids. A non-numeric key is rejected rather than coerced: it can only mean
 * the caller believed something else was a warehouse id.
 *
 * The value is an opaque provider string. This module deliberately does not
 * know it is a Tapin `shop_id`, and must not learn.
 */
function coerceOriginMap(field, value) {
  if (!isPlainObject(value)) throw fieldError(field.path, 'expected an object');

  /** @type {Record<string, { external_origin_id: string }>} */
  const out = {};

  for (const [key, entry] of Object.entries(value)) {
    const warehouseId = Number(String(key).trim());
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
      throw fieldError(field.path, 'warehouse keys must be positive integer ids');
    }

    const canonicalKey = String(warehouseId);
    if (Object.prototype.hasOwnProperty.call(out, canonicalKey)) {
      throw fieldError(`${field.path}.${canonicalKey}`, 'duplicate warehouse binding');
    }

    // Accept either the object form or a bare id string, and normalize to the
    // object form so the persisted shape stays one thing.
    const rawOriginId = isPlainObject(entry) ? entry.external_origin_id : entry;
    if (rawOriginId == null || typeof rawOriginId !== 'string' || rawOriginId.trim() === '') {
      throw fieldError(
        `${field.path}.${canonicalKey}.external_origin_id`,
        'must be a non-empty string',
      );
    }

    out[canonicalKey] = { external_origin_id: rawOriginId.trim() };
  }

  if (Object.keys(out).length === 0) {
    throw fieldError(field.path, 'must bind at least one warehouse');
  }

  return out;
}

/**
 * Build the `config_json` to persist.
 *
 * Non-secret field: the submitted value wins; blank removes the key so the
 * adapter's own documented default applies rather than an empty string being
 * persisted as if it were a choice.
 *
 * Secret field: blank means *keep the stored ciphertext untouched*; a non-empty
 * value is validated, encrypted, and replaces it. Already-encrypted input is
 * rejected rather than double-encrypted — it can only come from a client that
 * read the database directly, and accepting it would store an undecryptable
 * credential that fails at the next provider call instead of here.
 *
 * @param {object} params
 * @param {string|null|undefined} params.adapterKey
 * @param {unknown} params.submitted
 * @param {object} [params.stored] Existing `config_json`.
 * @param {boolean} params.isCreate
 * @returns {object}
 */
export function buildProviderConfig({ adapterKey, submitted, stored = {}, isCreate }) {
  const schema = getIntegrationConfigSchema(adapterKey);

  if (!schema) {
    // A provider whose adapter declares no config keys. It may hold a config
    // row for naming and scoping, but never unvalidated provider values.
    // (`shipping.tapin` was the standing example until CHECKOUT-R1B gave it a
    // real schema; `shipping.tipax` still mocks its transport and has none.)
    if (submitted != null && !isPlainObject(submitted)) {
      throw fieldError('config', 'expected an object');
    }
    if (submitted != null && Object.keys(submitted).length > 0) {
      throw new IntegrationConfigError({
        code: INTEGRATION_CONFIG_ERROR_CODES.NOT_CONFIGURABLE,
        message: `Provider '${adapterKey}' declares no configurable fields`,
      });
    }
    return {};
  }

  if (submitted != null && !isPlainObject(submitted)) {
    throw fieldError('config', 'expected an object');
  }

  const input = submitted == null ? {} : submitted;
  const storedConfig = isPlainObject(stored) ? stored : {};
  let next = {};

  for (const field of schema.fields) {
    const submittedValue = getConfigValue(input, field.path);
    const storedValue = getConfigValue(storedConfig, field.path);

    if (field.secret === true) {
      if (isBlank(submittedValue)) {
        if (storedValue !== undefined) {
          next = setConfigValue(next, field.path, storedValue);
        }
        continue;
      }

      if (typeof submittedValue !== 'string') {
        throw fieldError(field.path, 'expected a string');
      }
      if (isEncryptedConfigValue(submittedValue)) {
        throw fieldError(field.path, 'already-encrypted values cannot be submitted');
      }

      next = setConfigValue(next, field.path, encryptConfigValue(coerceField(field, submittedValue)));
      continue;
    }

    if (isBlank(submittedValue)) continue;

    next = setConfigValue(next, field.path, coerceField(field, submittedValue));
  }

  // Required fields are checked once, after the merge, so a preserved secret
  // satisfies the requirement on update exactly as a submitted one does.
  for (const field of schema.fields) {
    if (field.required && getConfigValue(next, field.path) === undefined) {
      throw fieldError(field.path, isCreate ? 'is required' : 'is required and is not stored');
    }
  }

  return next;
}

/**
 * Panel-facing view of a stored `config_json`.
 *
 * Returns only schema-declared, non-secret values, plus a `secrets` map saying
 * which credentials are stored. Undeclared keys that predate the schema stay
 * invisible rather than leaking into a form that would then write them back.
 *
 * @param {string|null|undefined} adapterKey
 * @param {unknown} storedConfig
 * @returns {{ config: object, secrets: Record<string, { configured: boolean }> }}
 */
export function toPublicProviderConfig(adapterKey, storedConfig) {
  const schema = getIntegrationConfigSchema(adapterKey);
  const stored = isPlainObject(storedConfig) ? storedConfig : {};

  /** @type {Record<string, unknown>} */
  let config = {};
  /** @type {Record<string, { configured: boolean }>} */
  const secrets = {};

  if (!schema) {
    return { config, secrets };
  }

  for (const field of schema.fields) {
    const value = getConfigValue(stored, field.path);

    if (field.secret === true) {
      secrets[field.path] = { configured: !isBlank(value) };
      continue;
    }

    if (value !== undefined) {
      config = setConfigValue(config, field.path, value);
    }
  }

  return { config, secrets };
}

/**
 * Values a provider publishes to browsers by design.
 *
 * Only fields flagged `browserExposed` are considered, and an encrypted value
 * is dropped rather than shipped: a browser-exposed field must never be a
 * secret, and if one ever became both, failing closed is the safe direction.
 *
 * @param {string|null|undefined} adapterKey
 * @param {unknown} storedConfig
 * @returns {Record<string, string>}
 */
export function toBrowserProviderConfig(adapterKey, storedConfig) {
  const schema = getIntegrationConfigSchema(adapterKey);
  const stored = isPlainObject(storedConfig) ? storedConfig : {};

  /** @type {Record<string, string>} */
  const values = {};
  if (!schema) return values;

  for (const field of schema.fields) {
    if (field.browserExposed !== true || field.secret === true) continue;

    const value = getConfigValue(stored, field.path);
    if (typeof value === 'string' && value !== '' && !isEncryptedConfigValue(value)) {
      values[field.path] = value;
    }
  }

  return values;
}
