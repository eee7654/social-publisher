import axios from "axios";
import {
  IntegrationConfigError,
  IntegrationProviderError,
} from "../../integrationErrors.js";
import { INTEGRATION_DOMAINS } from "../../types.js";

export const NESHAN_ADAPTER_KEY = "maps.neshan";

const PROVIDER_CODE = "neshan";
const DEFAULT_BASE_URL = "https://api.neshan.org";
const DEFAULT_TIMEOUT_MS = 5000;
const REVERSE_GEOCODE_PATH = "/v5/reverse";

/**
 * Neshan maps adapter — reverse geocoding only.
 *
 * Transport + provider-error/response normalization only, matching the
 * `SmsirSmsAdapter` precedent: config resolution, decryption, retry policy and
 * any persistence belong to the calling service (docs/core/AGENTS.md §9).
 *
 * Deliberately does NOT implement search, autocomplete, forward geocoding,
 * routing, distance matrix, traffic, or POI lookups. Stage 9.1 needs exactly
 * one operation and the adapter surface is kept proportional to it.
 *
 * Provider contract (https://platform.neshan.org/docs/api/search-category/reverse-geocoding/):
 *   GET https://api.neshan.org/v5/reverse?lat=<lat>&lng=<lng>
 *   Header: `Api-Key: <service key>`
 *   200 → { status: "OK", formatted_address, route_name, neighbourhood,
 *           city, state, county, district, place, village, municipality_zone, ... }
 *   Errors are non-2xx with provider codes: 400 INVALID_ARGUMENT,
 *   470 CoordinateParseError, 480 KeyNotFound, 481 LimitExceeded,
 *   482 RateExceeded, 483 ApiKeyTypeError, 484 ApiWhiteListError,
 *   485 ApiServiceListError, 500 GenericError.
 */
export class NeshanMapsAdapter {
  /**
   * @param {object} config Already-decrypted integration config JSON.
   * @param {object} [meta]
   * @param {number|string|null} [meta.configId]
   * @param {string|null} [meta.providerCode]
   * @param {number|string|null} [meta.providerId]
   * @param {{ get: Function }} [meta.httpClient] Test/client override.
   */
  constructor(config, meta = {}) {
    this.domain = INTEGRATION_DOMAINS.MAPS;
    this.providerCode = meta.providerCode ?? PROVIDER_CODE;
    this.configId = meta.configId ?? null;
    this.providerId = meta.providerId ?? null;
    this.settings = normalizeNeshanConfig(config, {
      configId: this.configId,
      providerCode: this.providerCode,
    });

    this.client = meta.httpClient ?? axios.create({
      baseURL: this.settings.base_url,
      timeout: this.settings.timeout_ms,
      headers: {
        "Api-Key": this.settings.api_key,
        Accept: "application/json",
      },
    });
  }

  /**
   * Resolves a coordinate pair to a provider-neutral address.
   *
   * @param {object} params
   * @param {number} params.latitude
   * @param {number} params.longitude
   * @returns {Promise<{ address: NormalizedAddress, formattedAddress: string|null, isReliable: boolean }>}
   */
  async reverseGeocode({ latitude, longitude } = {}) {
    const lat = requireCoordinate(latitude, "latitude", -90, 90, this);
    const lng = requireCoordinate(longitude, "longitude", -180, 180, this);

    let response;
    try {
      response = await this.client.get(REVERSE_GEOCODE_PATH, {
        params: { lat, lng },
      });
    } catch (error) {
      throw mapNeshanError(error, this);
    }

    const payload = response?.data;

    // Neshan signals failure with a non-2xx status carrying a textual
    // `status`, but a 200 with a non-OK body is still treated as a provider
    // failure rather than silently normalized into an empty address.
    if (payload?.status != null && String(payload.status).toUpperCase() !== "OK") {
      throw new IntegrationProviderError({
        code: "INTEGRATION_MAPS_REVERSE_GEOCODE_FAILED",
        message: "Neshan rejected the reverse-geocoding request",
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

    return normalizeReverseGeocodeResponse(payload);
  }
}

/**
 * Factory used by the integration registry.
 * @param {{ providerConfig?: object, provider?: object, integrationConfig?: object }} context
 */
export function createNeshanMapsAdapter({
  providerConfig = {},
  provider,
  integrationConfig,
} = {}) {
  return new NeshanMapsAdapter(providerConfig, {
    configId: integrationConfig?.id ?? null,
    providerCode: provider?.code ?? PROVIDER_CODE,
    providerId: provider?.id ?? null,
  });
}

/**
 * @typedef {object} NormalizedAddress
 * @property {string|null} line1
 * @property {string|null} city
 * @property {string|null} province
 * @property {string|null} postal_code
 * @property {string|null} country
 */

/**
 * Provider response → the application's existing address contract.
 *
 * Field names deliberately match the `address_json` shape the application
 * already reads elsewhere (`cartService` reads `postal_code`;
 * `shippingZoneService.calculateZoneShippingRate` compares `city`/`province`/
 * `country`), so no competing address schema is introduced.
 *
 * Two fields are always `null` because Neshan's reverse-geocoding response
 * genuinely does not carry them — this is reported honestly rather than
 * guessed at, and callers must treat `null` as "provider does not know" and
 * preserve any existing merchant-entered value:
 *   - `postal_code`: absent from the documented response schema entirely.
 *   - `country`: Neshan covers Iran only, but the response never asserts a
 *     country, so inventing one here would be fabricating provider data.
 *
 * @param {object} payload
 * @returns {{ address: NormalizedAddress, formattedAddress: string|null, isReliable: boolean }}
 */
export function normalizeReverseGeocodeResponse(payload) {
  const source = payload && typeof payload === "object" ? payload : {};

  const formattedAddress = pickString(source.formatted_address);
  const address = {
    line1: formattedAddress ?? pickString(source.route_name),
    // `city` is the primary locality; rural coordinates return `village` and
    // some responses only carry the `county`, so both are honest fallbacks
    // for the same conceptual field rather than invented data.
    city: pickString(source.city) ?? pickString(source.village) ?? pickString(source.county),
    province: pickString(source.state),
    postal_code: null,
    country: null,
  };

  // "Reliable" gates whether the caller may overwrite a stored address at all.
  // A response with no locality and no street line resolved nothing useful,
  // and must not be allowed to blank out a merchant's own address.
  const isReliable = Boolean(address.line1 || address.city || address.province);

  return { address, formattedAddress, isReliable };
}

function normalizeNeshanConfig(config, meta) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw configError("Neshan config must be an object", meta);
  }

  const apiKey = requireConfigString(config.api_key, "api_key", meta);
  const timeoutMs = Number(config.timeout_ms);

  return {
    api_key: apiKey,
    base_url:
      typeof config.base_url === "string" && config.base_url.trim() !== ""
        ? config.base_url.trim().replace(/\/+$/, "")
        : DEFAULT_BASE_URL,
    timeout_ms:
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

function requireCoordinate(value, field, min, max, adapter) {
  const num = typeof value === "number" ? value : Number(value);

  if (value === null || value === undefined || value === "" || !Number.isFinite(num)) {
    throw requestError(`${field} must be a finite number`, adapter);
  }
  if (num < min || num > max) {
    throw requestError(`${field} must be between ${min} and ${max}`, adapter);
  }

  return num;
}

function pickString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function mapNeshanError(error, adapter) {
  const status = error?.response?.status ?? null;
  const providerStatus = error?.response?.data?.status ?? null;

  // 481 LimitExceeded is a hard quota stop, not a transient condition, so it
  // is deliberately excluded from the retryable set; 482 RateExceeded is the
  // per-second throttle and is retryable.
  const retryable =
    status === 408 ||
    status === 429 ||
    status === 482 ||
    (typeof status === "number" && status >= 500) ||
    (status == null &&
      ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(error?.code));

  return new IntegrationProviderError({
    code: "INTEGRATION_MAPS_REVERSE_GEOCODE_FAILED",
    message: "Failed to reverse geocode coordinates with Neshan",
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
    throw configError(`Neshan config missing required field: ${field}`, meta);
  }
  return value.trim();
}

function configError(message, meta) {
  return new IntegrationConfigError({
    code: "INTEGRATION_MAPS_CONFIG_INVALID",
    message,
    domain: INTEGRATION_DOMAINS.MAPS,
    providerCode: meta?.providerCode ?? PROVIDER_CODE,
    configId: meta?.configId ?? null,
  });
}

function requestError(message, adapter) {
  return new IntegrationConfigError({
    code: "INTEGRATION_MAPS_REQUEST_INVALID",
    message,
    domain: adapter.domain,
    providerCode: adapter.providerCode,
    configId: adapter.configId,
  });
}
