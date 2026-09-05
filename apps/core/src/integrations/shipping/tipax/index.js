import { IntegrationProviderError } from "../../integrationErrors.js";
import { INTEGRATION_DOMAINS } from "../../types.js";

export const TIPAX_ADAPTER_KEY = "shipping.tipax";
const PROVIDER_CODE = "tipax";

/**
 * Tipax shipping adapter.
 *
 * ORDER-R3 adapter boundary: provider transport, request serialization and
 * response normalization ONLY. IntegrationEvent audit, business state,
 * inventory and transaction boundaries belong to the service layer, so nothing
 * here persists an event or mutates a domain row.
 *
 * The real Tipax HTTP contract is not wired up yet, so `createShipment` returns
 * a normalized mock. No webhook verification capability is exposed, because
 * Tipax's real signature scheme is unknown — inventing one would let an
 * unauthenticated POST advance a shipment.
 */
export class TipaxShippingAdapter {
  /**
   * @param {object} config Already-decrypted integration config JSON.
   * @param {object} [meta]
   * @param {number|string|null} [meta.configId]
   * @param {string|null} [meta.providerCode]
   * @param {number|string|null} [meta.providerId]
   * @param {{ post: Function }} [meta.httpClient] Test/client override.
   */
  constructor(config = {}, meta = {}) {
    this.domain = INTEGRATION_DOMAINS.SHIPPING;
    this.providerCode = meta.providerCode ?? PROVIDER_CODE;
    this.configId = meta.configId ?? null;
    this.providerId = meta.providerId ?? null;
    this.settings = config && typeof config === "object" ? config : {};
    this.client = meta.httpClient ?? null;
  }

  static getShippingRates({ originPostalCode, destinationPostalCode, items = [] } = {}) {
    const baseRate = 450000; // IRR
    let totalWeight = 0;
    for (const item of items) {
      const weight = Number(item.weight || 0);
      const quantity = Number(item.quantity || 1);
      totalWeight += weight * quantity;
    }

    void originPostalCode;
    void destinationPostalCode;

    return [
      {
        provider: "tipax",
        name: "تیپاکس",
        cost: baseRate + (totalWeight * 8000),
        estimated_days: 2,
      },
    ];
  }

  getShippingRates({ originPostalCode, destinationPostalCode, items = [] } = {}) {
    return TipaxShippingAdapter.getShippingRates({ originPostalCode, destinationPostalCode, items });
  }

  calculateRates(payload = {}) {
    return this.getShippingRates(payload);
  }

  /**
   * Registers a consignment and returns a normalized registration result.
   *
   * @param {object} payload
   * @param {number|string} [payload.fulfillmentOrderId]
   * @param {object} [payload.vendorOrder]
   * @param {object[]} [payload.items] Fulfillment contents/package descriptors.
   * @returns {Promise<{ success: true, providerShipmentId: string, trackingCode: string, labelUrl: string, raw: object }>}
   */
  async createShipment(payload = {}) {
    const { fulfillmentOrderId, vendorOrder, items = [] } = payload;

    if (!fulfillmentOrderId && !vendorOrder) {
      throw new IntegrationProviderError({
        code: "INTEGRATION_SHIPPING_REQUEST_INVALID",
        message: "fulfillmentOrderId or vendorOrder is required to create a Tipax shipment",
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    const reference = fulfillmentOrderId ?? vendorOrder?.id ?? "MOCK";
    const trackingCode = `TPX-${reference}-999`;

    return {
      success: true,
      providerShipmentId: trackingCode,
      trackingCode,
      labelUrl: "https://tipax.ir/mock-pdf",
      raw: { ok: true, reference, item_count: items.length },
    };
  }

  async createShippingLabel(payload = {}) {
    return this.createShipment(payload);
  }

  /**
   * @param {string} trackingNumber
   * @returns {Promise<{ success: true, status: string, trackingCode: string, events: object[] }>}
   */
  async trackShipment(trackingNumber) {
    if (!trackingNumber) {
      throw new IntegrationProviderError({
        code: "INTEGRATION_SHIPPING_REQUEST_INVALID",
        message: "trackingNumber is required to track shipment",
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    return {
      success: true,
      status: "in_transit",
      trackingCode: trackingNumber,
      events: [{ status: "accepted", description: "Shipment accepted by Tipax" }],
    };
  }

  /**
   * @param {string|number} shipmentId
   * @returns {Promise<{ success: true, shipmentId: string|number, status: string }>}
   */
  async cancelShipment(shipmentId) {
    if (!shipmentId) {
      throw new IntegrationProviderError({
        code: "INTEGRATION_SHIPPING_REQUEST_INVALID",
        message: "shipmentId is required to cancel shipment",
        domain: this.domain,
        providerCode: this.providerCode,
        configId: this.configId,
      });
    }

    return { success: true, shipmentId, status: "cancelled" };
  }
}

/**
 * Factory used by the integration registry.
 * @param {{ providerConfig?: object, provider?: object, integrationConfig?: object }} context
 */
export function createTipaxShippingAdapter({
  providerConfig = {},
  provider,
  integrationConfig,
} = {}) {
  return new TipaxShippingAdapter(providerConfig, {
    configId: integrationConfig?.id ?? null,
    providerCode: provider?.code ?? PROVIDER_CODE,
    providerId: provider?.id ?? null,
  });
}
