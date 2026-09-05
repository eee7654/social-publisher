import crypto from "node:crypto";
import { IntegrationConfigError } from "./integrationErrors.js";
import { INTEGRATION_ENCRYPTION } from "./types.js";

const SECRET_KEY_PATTERN =
  /^(api_key|apikey|client_secret|private_key|merchant_key|merchantkey|access_key|accesskey|secret_key|secretkey|secret|token|access_token|refresh_token|token_[0-9]+|password|authorization|proxy_url|proxy_password|proxy_user|signdata)$/i;

const PII_KEY_PATTERN =
  /^(phone|phone_number|mobile|mobile_number|recipient|recipient_phone|to|email|email_address|payer_email|customer_email)$/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function maskSecret(value) {
  if (value === null || value === undefined) {
    return value;
  }

  const text = String(value);
  if (text.length === 0) {
    return text;
  }
  return "****";
}

/**
 * Mask a phone number, keeping the last up to 4 digits.
 * @param {unknown} value
 * @returns {unknown}
 */
export function maskPhone(value) {
  if (value === null || value === undefined) {
    return value;
  }

  const text = String(value);
  if (text.length === 0) {
    return text;
  }
  if (text.length <= 4) {
    return "****";
  }
  return `${"*".repeat(text.length - 4)}${text.slice(-4)}`;
}

/**
 * Mask an email local-part; keep domain intact.
 * @param {unknown} value
 * @returns {unknown}
 */
export function maskEmail(value) {
  if (value === null || value === undefined) {
    return value;
  }

  const text = String(value);
  if (text.length === 0) {
    return text;
  }

  const at = text.indexOf("@");
  if (at <= 0 || at === text.length - 1) {
    return maskSecret(text);
  }

  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const maskedLocal = local.length === 1 ? "*" : `${local[0]}***`;
  return `${maskedLocal}@${domain}`;
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isSecretKey(key) {
  return typeof key === "string" && SECRET_KEY_PATTERN.test(key);
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isPiiKey(key) {
  return typeof key === "string" && PII_KEY_PATTERN.test(key);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function maskPiiByKey(key, value) {
  const lower = key.toLowerCase();
  if (lower.includes("email")) {
    return maskEmail(value);
  }
  return maskPhone(value);
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} ancestors
 * @returns {unknown}
 */
function maskValue(value, ancestors) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    const maskedArray = value.map((item) => maskValue(item, ancestors));
    ancestors.delete(value);
    return maskedArray;
  }

  /** @type {Record<string, unknown>} */
  const masked = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      masked[key] = maskSecret(entry);
    } else if (isPiiKey(key)) {
      masked[key] = maskPiiByKey(key, entry);
    } else {
      masked[key] = maskValue(entry, ancestors);
    }
  }
  ancestors.delete(value);
  return masked;
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Invalid base64");
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Invalid base64");
  }
  return decoded;
}

/**
 * Mask known secret and PII fields in an integration config object.
 * @param {unknown} config
 * @returns {unknown}
 */
export function maskConfig(config) {
  return maskValue(config, new WeakSet());
}

/**
 * Mask known secret and PII fields in request/response payloads for event logs.
 * @param {unknown} payload
 * @returns {unknown}
 */
export function maskPayload(payload) {
  return maskValue(payload, new WeakSet());
}

/**
 * Walk a provider config and decrypt every string written by
 * `encryptConfigValue`. Values without the marker prefix and non-string leaves
 * are returned untouched, so a config that mixes clear settings with encrypted
 * credentials round-trips correctly.
 *
 * Services call this before handing `config_json` to an adapter factory:
 * adapters receive already-decrypted config and never decrypt themselves
 * (docs/core/AGENTS.md §6/§9).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function decryptProviderConfig(value) {
  if (Array.isArray(value)) {
    return value.map(decryptProviderConfig);
  }
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = decryptProviderConfig(entry);
    }
    return out;
  }
  if (typeof value === "string" && value.startsWith(`${INTEGRATION_ENCRYPTION.PREFIX}:`)) {
    return decryptConfigValue(value);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEncryptedConfigValue(value) {
  return (
    typeof value === "string" &&
    value.startsWith(`${INTEGRATION_ENCRYPTION.PREFIX}:`)
  );
}

/**
 * @returns {Buffer}
 */
function getEncryptionKey() {
  const encoded = process.env[INTEGRATION_ENCRYPTION.KEY_ENV];
  if (!encoded) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_ENCRYPTION_NOT_CONFIGURED",
      message: `${INTEGRATION_ENCRYPTION.KEY_ENV} is not configured`,
    });
  }

  let key;
  try {
    key = decodeBase64(encoded);
  } catch {
    throw new IntegrationConfigError({
      code: "INTEGRATION_ENCRYPTION_KEY_INVALID",
      message: `${INTEGRATION_ENCRYPTION.KEY_ENV} must be valid base64`,
    });
  }

  if (key.length !== INTEGRATION_ENCRYPTION.KEY_BYTES) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_ENCRYPTION_KEY_INVALID",
      message: `${INTEGRATION_ENCRYPTION.KEY_ENV} must be base64-encoded ${INTEGRATION_ENCRYPTION.KEY_BYTES} bytes`,
    });
  }

  return key;
}

/**
 * Encrypt a config secret with AES-256-GCM.
 * Format: enc:v1:<iv>:<tag>:<ciphertext> (base64 segments).
 * Never silently stores plaintext as encrypted.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function encryptConfigValue(value) {
  if (value === null || value === undefined) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_ENCRYPTION_VALUE_INVALID",
      message: "Cannot encrypt null or undefined",
    });
  }

  if (String(value).length === 0) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_ENCRYPTION_VALUE_INVALID",
      message: "Cannot encrypt an empty value",
    });
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(INTEGRATION_ENCRYPTION.IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(String(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    INTEGRATION_ENCRYPTION.PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a value produced by encryptConfigValue.
 * Only accepts strings with the enc:v1 prefix.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function decryptConfigValue(value) {
  if (value === null || value === undefined) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_DECRYPTION_VALUE_INVALID",
      message: "Cannot decrypt null or undefined",
    });
  }

  const text = String(value);
  const prefix = `${INTEGRATION_ENCRYPTION.PREFIX}:`;
  if (!text.startsWith(prefix)) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_DECRYPTION_MALFORMED",
      message: `Encrypted value must use ${INTEGRATION_ENCRYPTION.PREFIX} prefix`,
    });
  }

  const parts = text.split(":");
  // enc : v1 : iv : tag : ciphertext
  if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
    throw new IntegrationConfigError({
      code: "INTEGRATION_DECRYPTION_MALFORMED",
      message: "Encrypted value format is invalid",
    });
  }

  const [, , ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_DECRYPTION_MALFORMED",
      message: "Encrypted value format is invalid",
    });
  }

  let iv;
  let tag;
  let ciphertext;
  try {
    iv = decodeBase64(ivB64);
    tag = decodeBase64(tagB64);
    ciphertext = decodeBase64(dataB64);
  } catch {
    throw new IntegrationConfigError({
      code: "INTEGRATION_DECRYPTION_MALFORMED",
      message: "Encrypted value segments must be valid base64",
    });
  }

  if (
    iv.length !== INTEGRATION_ENCRYPTION.IV_BYTES ||
    tag.length !== INTEGRATION_ENCRYPTION.TAG_BYTES ||
    ciphertext.length === 0
  ) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_DECRYPTION_MALFORMED",
      message: "Encrypted value segments have invalid lengths",
    });
  }

  const key = getEncryptionKey();

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (cause) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_DECRYPTION_FAILED",
      message: "Failed to decrypt config value",
      cause,
    });
  }
}
