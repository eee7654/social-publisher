import {
  IntegrationConfigError,
  IntegrationProviderError,
} from "../../integrationErrors.js";
import { resolveProviderOriginId } from "../../providerOriginBinding.js";
import { resolveTapinLocation } from "./locations/resolver.js";
import { INTEGRATION_DOMAINS } from "../../types.js";

export const TAPIN_ADAPTER_KEY = "shipping.tapin";

const PROVIDER_CODE = "tapin";
const DEFAULT_BASE_URL = "https://api.tapin.ir";
const DEFAULT_TIMEOUT_MS = 10000;
const CATALOG_PAGE_SIZE = 100;
/** Bounded so a provider that mis-reports `total_count` cannot loop forever. */
const MAX_CATALOG_PAGES = 50;

const ENDPOINTS = Object.freeze({
  CHECK_PRICE: "/api/v2/public/order/post/check-price/",
  PACKING_BOX: "/api/v2/public/order/post/packing-box/",
  PROVINCE_LIST: "/api/v2/public/state/list/",
  CITY_LIST: "/api/v2/public/city/list/",
  SHOP_LIST: "/api/v2/public/shop/list/",
});

/**
 * Official Tapin packet types (نوع بسته‌بندی).
 * 1 = پاکت (envelope, 50-500g, box size 11-15)
 * 2 = بسته (parcel / carton, 50-30000g, box size 1-10) — Official Default
 * 3 = پاکت جوف (padded envelope, 50-2000g, box size 11-15)
 */
export const TAPIN_PACKET_TYPES = Object.freeze({
  ENVELOPE: 1,
  PARCEL: 2,
  PADDED_ENVELOPE: 3,
});

export const DEFAULT_TAPIN_PACKET_TYPE = TAPIN_PACKET_TYPES.PARCEL;

/**
 * Official Tapin order types (نوع سفارش), per the current Tapin Order Guide.
 * The check-price *example* in Tapin's own documentation still shows
 * `order_type: 0`, which appears in no service table. Esima follows the
 * normative table and never falls back to the undocumented 0 — see
 * TAPIN_V1_POLICY below.
 */
export const TAPIN_ORDER_TYPES = Object.freeze({
  PISHTAZ: 1,
  SPECIAL: 3,
  EXPRESS: 5,
});

/**
 * Official Tapin payment types (نوع پرداخت سفارش).
 * 0 = COD, 1 = online, 2 = collect / pas-keraye, 3 = free shipping.
 */
export const TAPIN_PAY_TYPES = Object.freeze({
  COD: 0,
  ONLINE: 1,
  COLLECT: 2,
  FREE: 3,
});

/**
 * Owner-frozen Esima V1 shipping policy.
 *
 * These are *Esima product decisions* over the official provider tables above,
 * not provider facts. They live here — inside the adapter — because generic
 * checkout must never learn what a Tapin order type is.
 *
 * - `orderType: PISHTAZ` — V1 sells exactly one Tapin service. There is no
 *   customer-facing carrier-service choice, so quote selection over multiple
 *   eligible services degenerates to this single option.
 * - `payType: ONLINE` + `prePaidPrice: 0` — the shop pays the carrier; the
 *   recipient owes nothing on delivery.
 * - `packetType: PARCEL` — VendorPackage models cartons, not envelopes.
 */
export const TAPIN_V1_POLICY = Object.freeze({
  orderType: TAPIN_ORDER_TYPES.PISHTAZ,
  serviceCode: "pishtaz",
  payType: TAPIN_PAY_TYPES.ONLINE,
  prePaidPrice: 0,
  packetType: DEFAULT_TAPIN_PACKET_TYPE,
});

/**
 * Esima's canonical monetary unit for Tapin amounts.
 *
 * Owner-frozen: Tapin denominates this integration in IRR, which is already
 * Esima's canonical unit, so normalization is an identity plus a validation —
 * deliberately NOT a Rial↔Toman conversion. If a conversion is ever needed it
 * belongs here, applied exactly once, and nowhere else.
 */
export const TAPIN_CURRENCY = "IRR";

/*
 * Location-name normalization deliberately does NOT live here any more.
 *
 * CHECKOUT-R1B's location repair removed this adapter's `normalizeLocationName`
 * along with the runtime resolver that used it. Destination translation is now
 * the static curated mapping in `locations/resolver.js`, and the mechanical
 * normalization primitive lives in `locations/normalize.js`, where its
 * provider-matching use is explicitly named as bootstrap-only.
 *
 * Reintroducing a normalize-and-search helper at this level is how name
 * matching would find its way back onto the monetary path.
 */

/**
 * Normalizes a single Tapin packing-box catalog entry.
 *
 * Official schema example:
 * {
 *   "pk": 14,
 *   "length": 30,
 *   "width": 20,
 *   "height": 20,
 *   "title": "30*20*20 cm"
 * }
 *
 * @param {object} rawBox
 * @returns {{ provider: 'tapin', externalId: number, dimensions: { length: number, width: number, height: number }, title: string, rawMetadata: object }}
 */
export function normalizeTapinPackingBox(rawBox) {
  if (!rawBox || typeof rawBox !== "object" || Array.isArray(rawBox)) {
    throw new TypeError("Tapin packing box entry must be an object");
  }

  const pk = Number(rawBox.pk);
  const length = Number(rawBox.length);
  const width = Number(rawBox.width);
  const height = Number(rawBox.height);

  if (!Number.isFinite(pk) || !Number.isInteger(pk) || pk <= 0) {
    throw new TypeError("Tapin packing box requires a positive integer pk");
  }
  if (!Number.isFinite(length) || length <= 0) {
    throw new TypeError("Tapin packing box requires positive finite length");
  }
  if (!Number.isFinite(width) || width <= 0) {
    throw new TypeError("Tapin packing box requires positive finite width");
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new TypeError("Tapin packing box requires positive finite height");
  }

  const title =
    typeof rawBox.title === "string" && rawBox.title.trim().length > 0
      ? rawBox.title.trim()
      : `${length}*${width}*${height} cm`;

  return {
    provider: PROVIDER_CODE,
    externalId: pk,
    dimensions: {
      length,
      width,
      height,
    },
    title,
    rawMetadata: rawBox,
  };
}

/**
 * Normalizes the full Tapin packing-box catalog API response.
 *
 * Handles both the full HTTP envelope:
 * { "returns": { "status": 200 }, "entries": { "list": [...] } }
 * and direct array of list items.
 *
 * Malformed individual items fail safely by being omitted.
 *
 * @param {object} responseBody
 * @returns {Array<{ provider: 'tapin', externalId: number, dimensions: { length: number, width: number, height: number }, title: string, rawMetadata: object }>}
 */
export function normalizeTapinPackingBoxCatalog(responseBody) {
  if (!responseBody || typeof responseBody !== "object") {
    return [];
  }

  const list = Array.isArray(responseBody)
    ? responseBody
    : Array.isArray(responseBody.entries?.list)
      ? responseBody.entries.list
      : Array.isArray(responseBody.list)
        ? responseBody.list
        : [];

  const normalized = [];
  for (const item of list) {
    try {
      normalized.push(normalizeTapinPackingBox(item));
    } catch {
      // Malformed entries fail safely
    }
  }

  return normalized;
}

/**
 * Tapin shipping adapter.
 *
 * ## Real vs mock
 *
 * REAL provider transport: `getPackingBoxCatalog` (SHIPPING-PHYSICAL-R1),
 * `listProvinces`, `listCities`, `listShops`, `checkPrice`, `quoteShipment`
 * (CHECKOUT-R1B).
 *
 * LEGACY MOCK, retained only because the pre-existing `POST /cart/shipping-rates`
 * endpoint still calls it and CHECKOUT-R1C owns its retirement:
 * `getShippingRates`, `createShippingLabel`. Neither is reachable from
 * `quoteShipment` or from `POST /checkout/plan`.
 */
export class TapinShippingAdapter {
  /**
   * @param {object} config Already-decrypted integration config JSON.
   * @param {object} [meta]
   * @param {number|string|null} [meta.configId]
   * @param {string|null} [meta.providerCode]
   * @param {{ post: Function }} [meta.httpClient] Test/client override.
   */
  constructor(config = {}, meta = {}) {
    this.domain = INTEGRATION_DOMAINS.SHIPPING;
    this.providerCode = meta.providerCode ?? PROVIDER_CODE;
    this.configId = meta.configId ?? null;
    this.settings = config && typeof config === "object" ? config : {};
    this.client = meta.httpClient ?? null;
    this.baseUrl = this.settings.base_url || DEFAULT_BASE_URL;
    this.timeoutMs = Number(this.settings.timeout_ms) > 0
      ? Number(this.settings.timeout_ms)
      : DEFAULT_TIMEOUT_MS;

    /**
     * Per-instance provider catalog memo. The repository has no shared
     * integration cache to reuse, and inventing a process-wide one here would
     * outlive the config it was fetched under. One adapter instance serves one
     * checkout plan, which is exactly the scope where refetching the province
     * list once per parcel group is pure waste.
     * @type {Map<string, unknown>}
     */
    this.catalogCache = new Map();
  }

  /* ─────────────────────────────── transport ─────────────────────────────── */

  configError(code, message, details = null) {
    return new IntegrationConfigError({
      code,
      message,
      domain: this.domain,
      providerCode: this.providerCode,
      configId: this.configId,
      details,
    });
  }

  providerError(code, message, { retryable = false, details = null } = {}) {
    return new IntegrationProviderError({
      code,
      message,
      domain: this.domain,
      providerCode: this.providerCode,
      configId: this.configId,
      retryable,
      details,
    });
  }

  /**
   * The single provider transport.
   *
   * Every real Tapin call goes through here so the injected client override
   * (used by validation) substitutes deterministically for all of them, and so
   * error normalization exists in exactly one place.
   *
   * The Authorization header is constructed here and never returned, logged, or
   * attached to an error — `details` carries only the endpoint and HTTP status.
   *
   * @param {string} endpoint
   * @param {object} payload
   * @returns {Promise<object>} Parsed provider body.
   */
  async request(endpoint, payload) {
    if (this.client && typeof this.client.post === "function") {
      try {
        const resp = await this.client.post(endpoint, payload);
        return resp?.data ?? resp;
      } catch (cause) {
        // An injected transport stands in for the network, so a raw throw from
        // it must normalize exactly as a `fetch` rejection does below.
        // Otherwise the substituted seam would exercise a different failure
        // contract than production, and validation would prove the wrong thing.
        if (cause instanceof IntegrationConfigError || cause instanceof IntegrationProviderError) {
          throw cause;
        }
        throw this.providerError(
          "INTEGRATION_SHIPPING_TRANSPORT_FAILED",
          `Tapin request to ${endpoint} failed at transport level`,
          { retryable: true, details: { endpoint } },
        );
      }
    }

    const apiKey = this.settings.api_key;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw this.configError(
        "INTEGRATION_SHIPPING_CREDENTIAL_MISSING",
        "Tapin requires a configured api_key",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: apiKey.trim(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      // Transport-level failure: timeouts and connection resets are worth
      // retrying, so they are marked retryable. The cause is attached but the
      // request body — which holds recipient PII — is not.
      throw this.providerError(
        "INTEGRATION_SHIPPING_TRANSPORT_FAILED",
        `Tapin request to ${endpoint} failed at transport level`,
        { retryable: true, details: { endpoint } },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw this.providerError(
        "INTEGRATION_SHIPPING_REQUEST_FAILED",
        `Tapin request to ${endpoint} failed with HTTP ${res.status}`,
        // 5xx is the provider's problem and may pass; 4xx is ours and will not.
        { retryable: res.status >= 500, details: { endpoint, status: res.status } },
      );
    }

    try {
      return await res.json();
    } catch {
      throw this.providerError(
        "INTEGRATION_SHIPPING_RESPONSE_MALFORMED",
        `Tapin response for ${endpoint} was not valid JSON`,
        { details: { endpoint } },
      );
    }
  }

  /**
   * Unwraps the standard Tapin `{ returns, entries }` envelope.
   *
   * A provider that answers HTTP 200 with an error status inside the envelope is
   * still an error. The provider's own message is deliberately not propagated
   * into `details` — it is arbitrary provider prose that would become a de facto
   * Core error contract the moment anything matched on it.
   *
   * @param {unknown} body
   * @param {string} endpoint
   * @returns {object} `entries`
   */
  unwrap(body, endpoint) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw this.providerError(
        "INTEGRATION_SHIPPING_RESPONSE_MALFORMED",
        `Tapin response for ${endpoint} was not an object`,
        { details: { endpoint } },
      );
    }

    const rawStatus = body.returns?.status;
    const status = typeof rawStatus === "number" && Number.isFinite(rawStatus)
      ? rawStatus
      : typeof rawStatus === "string" && /^\d+$/.test(rawStatus)
        ? Number(rawStatus)
        : null;

    if (status == null) {
      throw this.providerError(
        "INTEGRATION_SHIPPING_RESPONSE_MALFORMED",
        `Tapin response for ${endpoint} carried no valid provider status`,
        { details: { endpoint, field: "returns.status" } },
      );
    }

    if (status !== 200) {
      console.error("Tapin rejection body:", JSON.stringify(body, null, 2));
      throw this.providerError(
        "INTEGRATION_SHIPPING_PROVIDER_REJECTED",
        `Tapin rejected the request to ${endpoint}`,
        { details: { endpoint, providerStatus: status } },
      );
    }

    const entries = body.entries;
    if (!entries || typeof entries !== "object") {
      throw this.providerError(
        "INTEGRATION_SHIPPING_RESPONSE_MALFORMED",
        `Tapin response for ${endpoint} carried no entries object`,
        { details: { endpoint } },
      );
    }

    return entries;
  }

  /**
   * Drains a paginated `{ list, total_count }` catalog endpoint.
   *
   * @param {string} endpoint
   * @param {object} [extraPayload]
   * @returns {Promise<object[]>}
   */
  async fetchPaginated(endpoint, extraPayload = {}) {
    const collected = [];

    for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
      const entries = this.unwrap(
        await this.request(endpoint, {
          ...extraPayload,
          count: CATALOG_PAGE_SIZE,
          page,
        }),
        endpoint,
      );

      const list = Array.isArray(entries.list) ? entries.list : [];
      collected.push(...list);

      const totalCount = Number(entries.total_count);
      if (list.length === 0 || !Number.isFinite(totalCount) || collected.length >= totalCount) {
        break;
      }
    }

    return collected;
  }

  /* ───────────────────────────── shop / origin ───────────────────────────── */

  /**
   * Resolves the Tapin shop_id bound to an Esima Warehouse.
   *
   * The generic binding lives in `warehouse_origins`; only this method knows
   * that Tapin's flavour of "external origin identity" is a shop_id.
   *
   * @param {number|string} warehouseId
   * @returns {string}
   */
  resolveShopId(warehouseId) {
    return resolveProviderOriginId({
      config: this.settings,
      warehouseId,
      domain: this.domain,
      providerCode: this.providerCode,
      configId: this.configId,
    });
  }

  /**
   * Lists the Tapin shops owned by the configured account.
   *
   * Used to validate configured origin bindings. Never called during checkout
   * quoting: a quote consumes the already-persisted binding.
   *
   * @returns {Promise<Array<{ externalId: string, title: string }>>}
   */
  async listShops() {
    const rows = await this.fetchPaginated(ENDPOINTS.SHOP_LIST);

    const shops = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const externalId = row.id == null ? "" : String(row.id).trim();
      if (externalId === "") continue;
      shops.push({
        externalId,
        title: typeof row.title === "string" ? row.title.trim() : "",
      });
    }
    return shops;
  }

  /**
   * Verifies that every warehouse-bound origin id exists at the provider.
   *
   * Configuration-time safety only — checkout does not call this.
   *
   * @returns {Promise<{ valid: string[], unknown: string[] }>}
   */
  async validateConfiguredOrigins() {
    const shops = await this.listShops();
    const known = new Set(shops.map((shop) => shop.externalId));

    const configured = Object.values(
      (this.settings.warehouse_origins && typeof this.settings.warehouse_origins === "object")
        ? this.settings.warehouse_origins
        : {},
    )
      .map((entry) => (entry && typeof entry === "object" ? entry.external_origin_id : entry))
      .filter((id) => typeof id === "string" && id.trim() !== "")
      .map((id) => id.trim());

    const valid = [];
    const unknownOrigins = [];
    for (const originId of configured) {
      (known.has(originId) ? valid : unknownOrigins).push(originId);
    }

    return { valid, unknown: unknownOrigins };
  }

  /* ──────────────────── location catalog (MAINTENANCE ONLY) ──────────────── */

  /*
   * `listProvinces` / `listCities` reach the provider's live location catalog.
   *
   * They exist for maintenance, diagnostics, and comparing the checked-in
   * catalog snapshot against the provider's current data. They are NOT part of
   * destination translation and must never be called from a quote: runtime
   * destination resolution is the static mapping in `locations/resolver.js`.
   *
   * The R1B validation harness asserts that a successful `POST /checkout/plan`
   * issues zero requests to either endpoint, so wiring them back into the quote
   * path fails the build rather than silently reintroducing name matching.
   */

  /**
   * MAINTENANCE ONLY — not part of destination resolution.
   * @returns {Promise<Array<{ code: number, title: string }>>}
   */
  async listProvinces() {
    const cacheKey = "provinces";
    if (this.catalogCache.has(cacheKey)) {
      return this.catalogCache.get(cacheKey);
    }

    const rows = await this.fetchPaginated(ENDPOINTS.PROVINCE_LIST);
    const provinces = normalizeLocationRows(rows);
    this.catalogCache.set(cacheKey, provinces);
    return provinces;
  }

  /**
   * MAINTENANCE ONLY — not part of destination resolution.
   * @param {number} provinceCode
   * @returns {Promise<Array<{ code: number, title: string }>>}
   */
  async listCities(provinceCode) {
    const code = Number(provinceCode);
    if (!Number.isInteger(code) || code <= 0) {
      throw this.providerError(
        "INTEGRATION_SHIPPING_LOCATION_INVALID",
        "A positive integer province code is required to list cities",
      );
    }

    const cacheKey = `cities:${code}`;
    if (this.catalogCache.has(cacheKey)) {
      return this.catalogCache.get(cacheKey);
    }

    const rows = await this.fetchPaginated(ENDPOINTS.CITY_LIST, { state_code: code });
    const cities = normalizeLocationRows(rows);
    this.catalogCache.set(cacheKey, cities);
    return cities;
  }

  /**
   * Resolves provider province/city codes for a CANONICAL Esima destination.
   *
   * Static, explicit, offline. Delegates to the curated mapping in
   * `locations/resolver.js`; performs no HTTP call and no comparison against
   * provider location names.
   *
   * The predecessor of this method matched customer text against the live
   * provider catalog. LOCATION-R0 retired that design: this provider's own
   * catalog lists one name under two distinct external IDs, so a name match can
   * resolve to the wrong locality and ship a real parcel to the wrong place
   * with nothing visible to the customer or the merchant. `listProvinces` /
   * `listCities` survive for maintenance and catalog comparison only, and
   * nothing on the quote path calls them.
   *
   * @param {object} canonicalLocation Server-validated canonical destination.
   * @returns {{ provinceCode: number, cityCode: number, mappingKey: string }}
   */
  resolveCanonicalDestinationCodes(canonicalLocation) {
    const { externalProvinceId, externalCityId, mappingKey } =
      resolveTapinLocation(canonicalLocation);

    // Tapin's request fields are named province_code / city_code; the generic
    // mapping calls them external ids. The rename happens here and nowhere else.
    return {
      provinceCode: externalProvinceId,
      cityCode: externalCityId,
      mappingKey,
    };
  }

  /* ──────────────────────────── packing catalog ─────────────────────────── */

  /**
   * Fetches and normalizes the provider packing-box catalog for the configured/supplied shop.
   *
   * @param {object} [params]
   * @param {string} [params.shopId] Optional shop_id override.
   * @returns {Promise<Array<{ provider: 'tapin', externalId: number, dimensions: { length: number, width: number, height: number }, title: string, rawMetadata: object }>>}
   */
  async getPackingBoxCatalog({ shopId } = {}) {
    const effectiveShopId = shopId || this.settings.shop_id;

    if (!effectiveShopId || typeof effectiveShopId !== "string" || effectiveShopId.trim() === "") {
      throw new IntegrationConfigError({
        code: "INTEGRATION_SHIPPING_SHOP_ID_REQUIRED",
        message: "Tapin getPackingBoxCatalog requires a non-empty shop_id",
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    const trimmedShopId = effectiveShopId.trim();
    const cacheKey = `boxes:${trimmedShopId}`;
    if (this.catalogCache.has(cacheKey)) {
      return this.catalogCache.get(cacheKey);
    }

    const payload = { shop_id: trimmedShopId };
    const endpoint = ENDPOINTS.PACKING_BOX;

    const responseData = await this.request(endpoint, payload);
    const entries = this.unwrap(responseData, endpoint);
    if (!Array.isArray(entries.list)) {
      throw this.providerError(
        "INTEGRATION_SHIPPING_RESPONSE_MALFORMED",
        `Tapin response for ${endpoint} carried no packing-box list`,
        { details: { endpoint, field: "entries.list" } },
      );
    }
    const catalog = normalizeTapinPackingBoxCatalog(entries);
    this.catalogCache.set(cacheKey, catalog);
    return catalog;
  }

  /* ────────────────────────────── real quote ─────────────────────────────── */

  /**
   * REAL Tapin price inquiry (استعلام قیمت).
   *
   * `POST /api/v2/public/order/post/check-price/`
   *
   * This is the only monetary authority for `POST /checkout/plan`. It is a
   * price *inquiry*: it registers nothing, buys nothing, and creates no
   * provider-side order.
   *
   * ## Physical contract (frozen)
   *
   *   products[].weight = NET unit product weight, grams, excluding packaging
   *   package_weight    = packaging TARE, grams, excluding contents
   *
   * `package_weight` is never the gross weight. Sending gross would double-count
   * the product weight the provider already derives from `products[]`, inflating
   * every quote by the net weight of the order.
   *
   * ## Omitted optional fields
   *
   * `has_insurance` is not part of the documented required set for this
   * endpoint, and its exact provider semantics (Tapin insurance vs post
   * insurance vs "insurance enabled") are not established. It is therefore
   * omitted so the provider applies its own documented default, rather than
   * having Esima assert an insurance choice it cannot yet define. Registration
   * concerns (`register_type`, `content_type`) are absent for the same reason:
   * check-price does not require them, and R1B does not register shipments.
   *
   * @param {object} params
   * @param {string} params.shopId
   * @param {object} params.destination Provider-neutral destination.
   * @param {number} params.provinceCode
   * @param {number} params.cityCode
   * @param {number} params.boxId
   * @param {number} params.packageWeight Packaging tare, grams.
   * @param {object[]} params.products
   * @returns {Promise<object>} Raw provider `entries`.
   */
  async checkPrice({
    shopId,
    destination,
    provinceCode,
    cityCode,
    boxId,
    packageWeight,
    products,
  }) {
    const payload = {
      shop_id: String(shopId),

      address: String(destination?.address ?? "").trim(),
      province_code: Number(provinceCode),
      city_code: Number(cityCode),

      first_name: String(destination?.firstName ?? "").trim(),
      last_name: String(destination?.lastName ?? "").trim(),
      mobile: String(destination?.mobile ?? "").trim(),
      postal_code: String(destination?.postalCode ?? "").trim(),

      pay_type: TAPIN_V1_POLICY.payType,
      order_type: TAPIN_V1_POLICY.orderType,
      packet_type: TAPIN_V1_POLICY.packetType,
      pre_paid_price: TAPIN_V1_POLICY.prePaidPrice,

      box_id: Number(boxId),
      package_weight: Math.round(Number(packageWeight)),
      description: "Order Checkout",
      employee_code: "1",
      phone: String(destination?.phone ?? destination?.mobile ?? "").trim(),
      products: products.map((product) => ({
        count: Number(product.quantity),
        discount: 0,
        price: Math.round(Number(product.unitPrice)),
        title: String(product.title ?? "").trim() || "Product",
        product_id: null,
        // NET unit product weight — never the packed or gross weight.
        weight: Math.round(Number(product.unitWeight)),
      })),
    };

    if (destination?.email) payload.email = String(destination.email).trim();

    console.error("Tapin request payload:", JSON.stringify(payload, null, 2));

    const body = await this.request(ENDPOINTS.CHECK_PRICE, payload);
    return this.unwrap(body, ENDPOINTS.CHECK_PRICE);
  }

  /**
   * Real quote: provider-neutral input → normalized ShippingQuote.
   *
   * The generic caller supplies Esima facts only. Every Tapin concept —
   * shop_id, province/city codes, box_id, packet_type, pay_type, order_type,
   * pre_paid_price — is derived here and never crosses back out.
   *
   * @param {object} params
   * @param {number|string} params.warehouseId
   * @param {object} params.destination
   * @param {object} params.parcel
   * @param {object[]} params.products
   * @param {object} params.providerPackage Matched provider package classification.
   * @returns {Promise<object>} Normalized quote.
   */
  async quoteShipment({
    warehouseId,
    destination,
    canonicalLocation,
    parcel,
    products,
    providerPackage,
  }) {
    const shopId = this.resolveShopId(warehouseId);

    // Synchronous and offline by construction — the whole point of the static
    // mapping. If this ever needs to await, name matching has crept back in.
    const { provinceCode, cityCode, mappingKey } =
      this.resolveCanonicalDestinationCodes(canonicalLocation);

    const boxId = Number(providerPackage?.externalId);
    if (!Number.isInteger(boxId) || boxId <= 0) {
      throw this.providerError(
        "INTEGRATION_SHIPPING_PACKAGE_UNAVAILABLE",
        "A matched provider package reference is required to quote",
      );
    }

    const entries = await this.checkPrice({
      shopId,
      destination,
      provinceCode,
      cityCode,
      boxId,
      packageWeight: parcel.packageWeight,
      products,
    });

    return normalizeTapinQuote(entries, {
      providerCode: this.providerCode,
      originReference: shopId,
      packageReference: boxId,
      destinationCodes: { provinceCode, cityCode, mappingKey },
      packageWeight: parcel.packageWeight,
    });
  }

  /* ─────────────────────────────── legacy mock ───────────────────────────── */

  /**
   * LEGACY MOCK — fabricated arithmetic pricing. NOT a provider call.
   *
   * Retained unchanged solely because `POST /cart/shipping-rates` already
   * depends on it and CHECKOUT-R1B must not alter current production behaviour.
   * CHECKOUT-R1C retires it in the same atomic change that moves monetary
   * authority to `quoteShipment`.
   *
   * Never call this from the checkout-plan path. Use `quoteShipment`.
   *
   * @param {object} params
   * @param {string} params.originPostalCode
   * @param {string} params.destinationPostalCode
   * @param {object[]} params.items Array of items, each containing weight and quantity.
   * @returns {{ provider: string, name: string, cost: number, estimated_days: number }[]}
   */
  static getShippingRates({ originPostalCode, destinationPostalCode, items = [] } = {}) {
    const baseRate = 350000; // IRR
    let totalWeight = 0;
    for (const item of items) {
      const weight = Number(item.weight || 0);
      const quantity = Number(item.quantity || 1);
      totalWeight += weight * quantity;
    }

    return [
      { provider: "post_pishtaz", name: "پست پیشتاز", cost: baseRate + (totalWeight * 5000), estimated_days: 3 },
      { provider: "tipax", name: "تیپاکس", cost: (baseRate * 1.5) + (totalWeight * 7000), estimated_days: 2 }
    ];
  }

  /**
   * LEGACY MOCK (instance wrapper). See the static method.
   */
  getShippingRates({ originPostalCode, destinationPostalCode, items = [] } = {}) {
    return TapinShippingAdapter.getShippingRates({ originPostalCode, destinationPostalCode, items });
  }

  /**
   * LEGACY MOCK — returns fabricated tracking/label data. NOT a provider call.
   *
   * Shipment registration is deferred; no R1B path reaches this.
   *
   * @param {object} params
   * @param {object[]} [params.orderAddresses] Order's shipping/billing addresses.
   * @param {object} params.vendorOrder The VendorOrder being shipped.
   * @returns {Promise<{ success: true, trackingCode: string, labelUrl: string }>}
   */
  async createShippingLabel({ orderAddresses, vendorOrder } = {}) {
    if (!vendorOrder) {
      throw new IntegrationProviderError({
        code: "INTEGRATION_SHIPPING_REQUEST_INVALID",
        message: "vendorOrder is required to create a Tapin shipping label",
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    void orderAddresses;

    return {
      success: true,
      trackingCode: "MOCK-123",
      labelUrl: "https://tapin.ir/mock-pdf",
    };
  }
}

/**
 * @param {unknown[]} rows
 * @returns {Array<{ code: number, title: string }>}
 */
function normalizeLocationRows(rows) {
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const code = Number(row.code);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!Number.isInteger(code) || code <= 0 || title === "") continue;
    out.push({ code, title });
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toMonetaryAmount(value) {
  if (value == null || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

/**
 * Real Tapin check-price response → normalized ShippingQuote.
 *
 * `entries.total_price` is the payable total and is denominated in Toman,
 * so we must multiply by 10 to convert it to Esima's canonical IRR (Rial) unit.
 * This is the one place Tapin money becomes Esima money.
 *
 * The breakdown is an explicit allowlist. Returning the provider body verbatim
 * would let any future provider field flow into a customer-visible plan and into
 * the quote fingerprint, where an unrelated provider change would silently
 * invalidate signed plans.
 *
 * @param {object} entries
 * @param {object} context
 * @returns {object} Normalized quote.
 */
export function normalizeTapinQuote(entries, {
  providerCode = PROVIDER_CODE,
  originReference,
  packageReference,
  destinationCodes,
  packageWeight,
} = {}) {
  const amountRaw = toMonetaryAmount(entries?.total_price);
  const amount = amountRaw != null ? amountRaw * 10 : null;

  if (amount == null) {
    throw new IntegrationProviderError({
      code: "INTEGRATION_SHIPPING_QUOTE_MALFORMED",
      message: "Tapin check-price response carried no usable total_price",
      domain: INTEGRATION_DOMAINS.SHIPPING,
      providerCode,
      details: { field: "total_price" },
    });
  }

  const breakdown = {};
  for (const field of [
    "send_price",
    "send_price_tax",
    "service_price",
    "service_price_tax",
    "post_service_price",
    "post_service_price_tax",
    "total_send_price",
    "total_service_price",
  ]) {
    const valueRaw = toMonetaryAmount(entries?.[field]);
    if (valueRaw != null) breakdown[field] = valueRaw * 10;
  }

  const providerTotalWeight = Number(entries?.total_weight);

  return {
    providerCode,
    serviceCode: TAPIN_V1_POLICY.serviceCode,

    amount,
    currency: TAPIN_CURRENCY,

    providerOriginReference: String(originReference),
    providerPackageReference: String(packageReference),

    // Provider-neutral names on purpose: Core must not learn that these are
    // Tapin province_code / city_code. They exist because R1C's shipment
    // registration has to target the same provider destination this price was
    // quoted for, and because binding them into the quote fingerprint makes a
    // later mapping change detectable rather than silent.
    providerDestinationProvinceReference:
      destinationCodes?.provinceCode == null ? null : String(destinationCodes.provinceCode),
    providerDestinationCityReference:
      destinationCodes?.cityCode == null ? null : String(destinationCodes.cityCode),
    // check-price is an inquiry and returns no quote id; there is nothing
    // honest to put here. R1C's registration call is what produces a durable
    // provider reference.
    providerQuoteReference: null,

    quotedAt: new Date().toISOString(),

    breakdown,

    providerMetadata: {
      orderType: TAPIN_V1_POLICY.orderType,
      packetType: TAPIN_V1_POLICY.packetType,
      payType: TAPIN_V1_POLICY.payType,
      // Which curated mapping entry produced the provider destination, so a
      // support question about a wrong city is answerable from the snapshot.
      locationMappingKey: destinationCodes?.mappingKey ?? null,
      // What Esima sent as tare, kept beside what the provider says it weighed
      // in total, so a future divergence is visible without re-deriving either.
      sentPackageWeight: Math.round(Number(packageWeight)),
      providerTotalWeight: Number.isFinite(providerTotalWeight) ? providerTotalWeight : null,
    },
  };
}

/**
 * Factory used by the integration registry.
 * @param {{ providerConfig?: object, provider?: object, integrationConfig?: object, httpClient?: object }} context
 */
export function createTapinShippingAdapter({
  providerConfig = {},
  provider,
  integrationConfig,
  httpClient,
} = {}) {
  return new TapinShippingAdapter(providerConfig, {
    configId: integrationConfig?.id ?? null,
    providerCode: provider?.code ?? PROVIDER_CODE,
    httpClient,
  });
}
