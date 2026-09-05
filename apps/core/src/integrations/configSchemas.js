/**
 * Provider config field contracts.
 *
 * This module is the single backend authority for *which* keys a provider's
 * `integration_configs.config_json` may hold, which of them are credentials,
 * and which are deliberately safe to hand to a browser.
 *
 * Every entry below was derived from the provider adapter that consumes it —
 * nothing here is guessed:
 *   - `sms.smsir`        → `normalizeSmsirConfig`   (sms/smsir/index.js)
 *   - `payment.zarinpal` → `normalizeZarinpalConfig`(payment/zarinpal/index.js)
 *   - `payment.sadad`    → `normalizeSadadConfig`   (payment/sadad/index.js)
 *   - `storage.minio`    → `normalizeMinioConfig`   (storage/minio.js)
 *   - `maps.neshan`      → `normalizeNeshanConfig`  (maps/neshan/index.js)
 *
 * `shipping.tapin` gained an entry in CHECKOUT-R1B. It previously had none on
 * purpose — the adapter mocked its transport and read no config keys, so there
 * was no credential contract to expose. R1B implements real Tapin transport
 * (check-price, location catalog, shops), so the credential and the
 * Warehouse→provider-origin binding are now real config with a real contract.
 *
 * ## Warehouse provider-origin binding (`warehouse_origins`)
 *
 * One Tapin account may own several Tapin Shops, and each shippable Esima
 * Warehouse maps to one of them. That is a *mapping*, not a credential, so it
 * lives inside one config's `config_json` rather than forcing one
 * IntegrationConfig per Warehouse — duplicating the credential per Warehouse
 * would multiply the secret for a reason that has nothing to do with
 * authentication, and leave several rows to rotate in lockstep.
 *
 * The key is the Esima Warehouse id (Esima is the authority for warehouse
 * identity); the value is an opaque `external_origin_id` string. Generic Core
 * never interprets it. Only the Tapin adapter knows it is a `shop_id`.
 *
 * ## Secret classification
 *
 * `secret: true` must agree with `SECRET_KEY_PATTERN` in `secrets.js`, which is
 * the authoritative masking rule for event payloads. Where the two could
 * disagree the pattern wins and the field stays non-secret — `merchant_id` and
 * `terminal_id` are provider *identifiers* that the masking contract already
 * treats as non-secret, and inventing a stricter rule only here would make the
 * panel and the audit log disagree about the same value.
 *
 * ## Browser exposure
 *
 * `browserExposed: true` marks a value that is public *by the provider's own
 * design* and may be served to the panel through the bootstrap DTO. Exactly one
 * field carries it today (`maps.neshan.web_map_key`). It is a separate
 * credential from the Neshan service key in the same config, and the service
 * key must never gain this flag.
 */

import { INTEGRATION_DOMAINS } from './types.js';

export const INTEGRATION_FIELD_KINDS = Object.freeze({
  TEXT: 'text',
  SECRET: 'secret',
  URL: 'url',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  ENUM: 'enum',
  /** SMS.ir `patterns`: a map of pattern key → { pattern_code, params[] }. */
  PATTERN_MAP: 'pattern_map',
  /**
   * Warehouse provider-origin binding: a map of Esima warehouse id →
   * { external_origin_id }. The provider-side meaning of the id is adapter-owned.
   */
  ORIGIN_MAP: 'origin_map',
});

/**
 * @typedef {object} IntegrationConfigField
 * @property {string} path Dotted path inside config_json.
 * @property {string} kind One of INTEGRATION_FIELD_KINDS.
 * @property {boolean} [required]
 * @property {boolean} [secret] Encrypted at rest; never serialized to the panel.
 * @property {boolean} [browserExposed] Safe to serve to the browser by design.
 * @property {boolean} [advanced] Rendered behind progressive disclosure.
 * @property {number} [length] Exact string length.
 * @property {number} [min] Minimum for NUMBER.
 * @property {boolean} [integer] NUMBER must be an integer.
 * @property {string[]} [options] Allowed values for ENUM.
 * @property {unknown} [default] Adapter default, shown as a placeholder only.
 */

/** @type {Readonly<Record<string, { domain: string, fields: IntegrationConfigField[] }>>} */
export const INTEGRATION_CONFIG_SCHEMAS = Object.freeze({
  'sms.smsir': Object.freeze({
    domain: INTEGRATION_DOMAINS.SMS,
    fields: Object.freeze([
      { path: 'api_key', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'line_number', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'base_url', kind: INTEGRATION_FIELD_KINDS.URL, advanced: true, default: 'https://api.sms.ir' },
      { path: 'patterns', kind: INTEGRATION_FIELD_KINDS.PATTERN_MAP },
      { path: 'defaults.otp_pattern_key', kind: INTEGRATION_FIELD_KINDS.TEXT, default: 'otp' },
    ]),
  }),

  'payment.zarinpal': Object.freeze({
    domain: INTEGRATION_DOMAINS.PAYMENT,
    fields: Object.freeze([
      // Adapter requires exactly 36 characters (MERCHANT_ID_LENGTH).
      { path: 'merchant_id', kind: INTEGRATION_FIELD_KINDS.TEXT, required: true, length: 36 },
      { path: 'sandbox', kind: INTEGRATION_FIELD_KINDS.BOOLEAN, default: false },
      {
        path: 'currency_unit',
        kind: INTEGRATION_FIELD_KINDS.ENUM,
        options: Object.freeze(['IRR', 'IRT']),
        default: 'IRR',
        advanced: true,
      },
      {
        path: 'amount_divisor',
        kind: INTEGRATION_FIELD_KINDS.NUMBER,
        min: 1,
        integer: true,
        default: 1,
        advanced: true,
      },
    ]),
  }),

  'payment.sadad': Object.freeze({
    domain: INTEGRATION_DOMAINS.PAYMENT,
    fields: Object.freeze([
      { path: 'merchant_id', kind: INTEGRATION_FIELD_KINDS.TEXT, required: true },
      { path: 'terminal_id', kind: INTEGRATION_FIELD_KINDS.TEXT, required: true },
      { path: 'merchant_key', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'application_name', kind: INTEGRATION_FIELD_KINDS.TEXT, default: 'Esima Commerce' },
      { path: 'payment_identity', kind: INTEGRATION_FIELD_KINDS.TEXT, advanced: true },
      {
        path: 'amount_divisor',
        kind: INTEGRATION_FIELD_KINDS.NUMBER,
        min: 1,
        integer: true,
        default: 1,
        advanced: true,
      },
    ]),
  }),

  'storage.minio': Object.freeze({
    domain: INTEGRATION_DOMAINS.STORAGE,
    fields: Object.freeze([
      { path: 'endpoint', kind: INTEGRATION_FIELD_KINDS.URL, required: true },
      { path: 'bucket', kind: INTEGRATION_FIELD_KINDS.TEXT, required: true },
      { path: 'access_key', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'secret_key', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'region', kind: INTEGRATION_FIELD_KINDS.TEXT, default: 'us-east-1' },
      { path: 'force_path_style', kind: INTEGRATION_FIELD_KINDS.BOOLEAN, default: true, advanced: true },
      { path: 'public_base_url', kind: INTEGRATION_FIELD_KINDS.URL, advanced: true },
      {
        path: 'upload_url_ttl_seconds',
        kind: INTEGRATION_FIELD_KINDS.NUMBER,
        min: 1,
        advanced: true,
      },
      {
        path: 'download_url_ttl_seconds',
        kind: INTEGRATION_FIELD_KINDS.NUMBER,
        min: 1,
        advanced: true,
      },
    ]),
  }),

  'shipping.tapin': Object.freeze({
    domain: INTEGRATION_DOMAINS.SHIPPING,
    fields: Object.freeze([
      // Sent as the raw Authorization header value by the adapter.
      { path: 'api_key', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'base_url', kind: INTEGRATION_FIELD_KINDS.URL, advanced: true, default: 'https://api.tapin.ir' },
      // Esima warehouse id → { external_origin_id }. Required: a Tapin config
      // that binds no Warehouse can quote nothing, and failing at save time is
      // better than failing at the customer's checkout.
      { path: 'warehouse_origins', kind: INTEGRATION_FIELD_KINDS.ORIGIN_MAP, required: true },
      {
        path: 'timeout_ms',
        kind: INTEGRATION_FIELD_KINDS.NUMBER,
        min: 1,
        integer: true,
        default: 10000,
        advanced: true,
      },
    ]),
  }),

  'maps.neshan': Object.freeze({
    domain: INTEGRATION_DOMAINS.MAPS,
    fields: Object.freeze([
      { path: 'api_key', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'web_map_key', kind: INTEGRATION_FIELD_KINDS.TEXT, browserExposed: true },
      { path: 'base_url', kind: INTEGRATION_FIELD_KINDS.URL, advanced: true, default: 'https://api.neshan.org' },
      {
        path: 'timeout_ms',
        kind: INTEGRATION_FIELD_KINDS.NUMBER,
        min: 1,
        integer: true,
        default: 5000,
        advanced: true,
      },
    ]),
  }),

  'publishing.instagram': Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    fields: Object.freeze([
      { path: 'system_user_token', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'page_id', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'instagram_user_id', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'username', kind: INTEGRATION_FIELD_KINDS.TEXT },
    ]),
  }),

  'publishing.aparat': Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    fields: Object.freeze([
      { path: 'auth_mode', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'username', kind: INTEGRATION_FIELD_KINDS.TEXT, required: true },
      { path: 'account_id', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'account_name', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'session', kind: INTEGRATION_FIELD_KINDS.SECRET, required: true, secret: true },
      { path: 'default_category_id', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'default_category_title', kind: INTEGRATION_FIELD_KINDS.TEXT },
    ]),
  }),

  'publishing.youtube': Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    fields: Object.freeze([
      { path: 'refresh_token', kind: INTEGRATION_FIELD_KINDS.SECRET, secret: true },
    ]),
  }),

  'publishing.linkedin': Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    fields: Object.freeze([
      { path: 'access_token', kind: INTEGRATION_FIELD_KINDS.SECRET, secret: true },
      { path: 'refresh_token', kind: INTEGRATION_FIELD_KINDS.SECRET, secret: true },
      { path: 'expires_at', kind: INTEGRATION_FIELD_KINDS.STRING },
      { path: 'refresh_token_expires_at', kind: INTEGRATION_FIELD_KINDS.STRING },
      { path: 'organization_urn', kind: INTEGRATION_FIELD_KINDS.STRING },
      { path: 'organization_id', kind: INTEGRATION_FIELD_KINDS.STRING },
      { path: 'organization_name', kind: INTEGRATION_FIELD_KINDS.STRING },
      { path: 'vanity_name', kind: INTEGRATION_FIELD_KINDS.STRING },
    ]),
  }),

  'publishing.telegram': Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    fields: Object.freeze([
      // Shared bot token is application/server-level; config stores channel target details
      { path: 'chat_id', kind: INTEGRATION_FIELD_KINDS.TEXT, required: true },
      { path: 'chat_title', kind: INTEGRATION_FIELD_KINDS.TEXT },
      { path: 'chat_username', kind: INTEGRATION_FIELD_KINDS.TEXT },
    ]),
  }),

  'publishing.bale': Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    fields: Object.freeze([
      // To be defined when bale adapter is created
    ]),
  }),
});

/**
 * @param {string|null|undefined} adapterKey
 * @returns {{ domain: string, fields: IntegrationConfigField[] } | null}
 */
export function getIntegrationConfigSchema(adapterKey) {
  if (typeof adapterKey !== 'string') {
    return null;
  }
  return INTEGRATION_CONFIG_SCHEMAS[adapterKey] ?? null;
}

/**
 * Field descriptors safe to publish to the panel: the `secret` flag travels so
 * the editor can render a "credential configured / replace" control, but no
 * value ever does.
 *
 * @param {string|null|undefined} adapterKey
 * @returns {IntegrationConfigField[]}
 */
export function describeIntegrationConfigFields(adapterKey) {
  const schema = getIntegrationConfigSchema(adapterKey);
  return schema ? schema.fields.map((field) => ({ ...field })) : [];
}

/**
 * @param {string|null|undefined} adapterKey
 * @returns {string[]}
 */
export function listSecretFieldPaths(adapterKey) {
  return describeIntegrationConfigFields(adapterKey)
    .filter((field) => field.secret === true)
    .map((field) => field.path);
}

/**
 * @param {string|null|undefined} adapterKey
 * @returns {string[]}
 */
export function listBrowserExposedFieldPaths(adapterKey) {
  return describeIntegrationConfigFields(adapterKey)
    .filter((field) => field.browserExposed === true)
    .map((field) => field.path);
}

/**
 * @param {unknown} source
 * @param {string} path Dotted path.
 * @returns {unknown}
 */
export function getConfigValue(source, path) {
  const segments = path.split('.');
  let current = source;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Immutably writes `value` at a dotted path, creating intermediate objects.
 * Passing `undefined` removes the key (and prunes emptied parents) so an
 * unanswered optional field never persists as an explicit `undefined`.
 *
 * @param {object} target
 * @param {string} path
 * @param {unknown} value
 * @returns {object}
 */
export function setConfigValue(target, path, value) {
  const [head, ...rest] = path.split('.');
  const base = target && typeof target === 'object' && !Array.isArray(target) ? target : {};

  if (rest.length === 0) {
    const next = { ...base };
    if (value === undefined) {
      delete next[head];
    } else {
      next[head] = value;
    }
    return next;
  }

  const child = setConfigValue(base[head], rest.join('.'), value);
  const next = { ...base };

  if (Object.keys(child).length === 0) {
    delete next[head];
  } else {
    next[head] = child;
  }

  return next;
}
