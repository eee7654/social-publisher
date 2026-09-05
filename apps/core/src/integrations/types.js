/**
 * Integration kernel constants.
 * Values align with migration 20260831_01_create_publisher_domain.js.
 */
export const INTEGRATION_DOMAINS = Object.freeze({
  SMS: "sms",
  PAYMENT: "payment",
  STORAGE: "storage",
  SHIPPING: "shipping",
  MAPS: "maps",
  PUBLISHING: "publishing",
});

export const INTEGRATION_DIRECTIONS = Object.freeze({
  OUTBOUND: "outbound",
  INBOUND: "inbound",
});

export const INTEGRATION_EVENT_STATUS = Object.freeze({
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
});

export const INTEGRATION_CONFIG_STATUS = Object.freeze({
  ACTIVE: "active",
  INACTIVE: "inactive",
  TESTING: "testing",
});

/**
 * AES-256-GCM config encryption markers.
 * Encrypted strings: enc:v1:<iv>:<tag>:<ciphertext> (base64 segments).
 */
export const INTEGRATION_ENCRYPTION = Object.freeze({
  PREFIX: "enc:v1",
  KEY_ENV: "INTEGRATION_CONFIG_ENCRYPTION_KEY",
  KEY_BYTES: 32,
  IV_BYTES: 12,
  TAG_BYTES: 16,
});

/**
 * System provider catalog candidates (no credentials).
 * Seeded into integration_providers only.
 */
export const INTEGRATION_PROVIDER_CATALOG = Object.freeze([
  Object.freeze({
    domain: INTEGRATION_DOMAINS.SMS,
    code: "smsir",
    display_name: "SMS.ir",
    adapter_key: "sms.smsir",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PAYMENT,
    code: "zarinpal",
    display_name: "Zarinpal",
    adapter_key: "payment.zarinpal",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PAYMENT,
    code: "sadad",
    display_name: "Sadad",
    adapter_key: "payment.sadad",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.STORAGE,
    code: "minio",
    display_name: "MinIO",
    adapter_key: "storage.minio",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.SHIPPING,
    code: "tapin",
    display_name: "Tapin",
    adapter_key: "shipping.tapin",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.MAPS,
    code: "neshan",
    display_name: "Neshan",
    adapter_key: "maps.neshan",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    code: "instagram",
    display_name: "Instagram",
    adapter_key: "publishing.instagram",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    code: "youtube",
    display_name: "YouTube",
    adapter_key: "publishing.youtube",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    code: "aparat",
    display_name: "Aparat",
    adapter_key: "publishing.aparat",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    code: "linkedin",
    display_name: "LinkedIn",
    adapter_key: "publishing.linkedin",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    code: "bale",
    display_name: "Bale",
    adapter_key: "publishing.bale",
  }),
  Object.freeze({
    domain: INTEGRATION_DOMAINS.PUBLISHING,
    code: "telegram",
    display_name: "Telegram",
    adapter_key: "publishing.telegram",
  }),
]);
