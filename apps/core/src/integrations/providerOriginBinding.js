/**
 * Warehouse → provider shipping-origin binding.
 *
 * Kernel code with no database imports, so the binding rule can be read and
 * tested without a database. The DB-backed tenancy check that must accompany it
 * lives in the calling service, which is the layer that already owns Warehouse
 * loading.
 *
 * ## Why this is not a Warehouse column
 *
 * A `warehouses.tapin_shop_id` column would put a provider's identifier in a
 * domain table, and would need a sibling column for every future carrier. The
 * binding is integration configuration, so it lives in the integration config,
 * keyed by the Esima Warehouse id — Esima owns warehouse identity, the provider
 * owns nothing but an opaque origin string.
 *
 * ## Fail closed
 *
 * An unbound Warehouse means "this provider cannot ship from this origin", not
 * "pick something". There is deliberately no default origin and no first-entry
 * fallback: quoting a parcel from the wrong warehouse produces a price the
 * merchant cannot honour, and the customer would never see the substitution.
 */

import { IntegrationConfigError } from './integrationErrors.js';

export const PROVIDER_ORIGIN_BINDING_CODES = Object.freeze({
  MISSING: 'INTEGRATION_PROVIDER_ORIGIN_BINDING_MISSING',
  INVALID: 'INTEGRATION_PROVIDER_ORIGIN_BINDING_INVALID',
});

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toWarehouseId(value) {
  if (value == null || value === '') return null;
  const id = Number(String(value).trim());
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Read the whole binding map in canonical form.
 *
 * @param {unknown} config Already-decrypted provider config.
 * @returns {Record<string, string>} warehouseId → externalOriginId
 */
export function listProviderOriginBindings(config) {
  const raw = config && typeof config === 'object' ? config.warehouse_origins : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(raw)) {
    const warehouseId = toWarehouseId(key);
    if (warehouseId == null) continue;

    const originId =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry.external_origin_id
        : entry;

    if (typeof originId === 'string' && originId.trim() !== '') {
      out[String(warehouseId)] = originId.trim();
    }
  }
  return out;
}

/**
 * Resolve the external provider origin identity bound to one Warehouse.
 *
 * @param {object} params
 * @param {unknown} params.config Already-decrypted provider config.
 * @param {number|string} params.warehouseId
 * @param {string|null} [params.domain]
 * @param {string|null} [params.providerCode]
 * @param {number|string|null} [params.configId]
 * @returns {string} Opaque provider origin identity.
 */
export function resolveProviderOriginId({
  config,
  warehouseId,
  domain = null,
  providerCode = null,
  configId = null,
}) {
  const id = toWarehouseId(warehouseId);
  if (id == null) {
    throw new IntegrationConfigError({
      code: PROVIDER_ORIGIN_BINDING_CODES.INVALID,
      message: 'A positive integer warehouseId is required to resolve a provider origin',
      domain,
      providerCode,
      configId,
    });
  }

  const bindings = listProviderOriginBindings(config);
  const originId = bindings[String(id)];

  if (!originId) {
    throw new IntegrationConfigError({
      code: PROVIDER_ORIGIN_BINDING_CODES.MISSING,
      message: `No provider shipping origin is bound to warehouse ${id}`,
      domain,
      providerCode,
      configId,
      // The warehouse id is Esima's own identifier, not provider data — safe to
      // surface so a merchant can see which Warehouse needs binding. No provider
      // origin ids are listed: that would leak the account's shop inventory to
      // whoever reads the error.
      details: { warehouseId: id },
    });
  }

  return originId;
}
