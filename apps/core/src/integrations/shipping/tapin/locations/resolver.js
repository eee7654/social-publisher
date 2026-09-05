import { IntegrationConfigError } from '../../../integrationErrors.js';
import { INTEGRATION_DOMAINS } from '../../../types.js';
import { normalizePersianText } from './normalize.js';
import TAPIN_LOCATION_MAPPINGS from './mappings.js';

/**
 * Runtime Tapin destination resolution — static, explicit, provider-global.
 *
 * ## The authority boundary
 *
 * Input is a *canonical Esima location* that the server already loaded and
 * validated from `provinces` / `cities`. Output is the pair of external Tapin
 * IDs curated for that location. Between the two there is a table lookup and
 * nothing else:
 *
 *   - no HTTP call,
 *   - no provider catalog read,
 *   - no comparison against provider names,
 *   - no fuzzy matching, first-result fallback, or nearest-city guess.
 *
 * LOCATION-R0 established why. Resolving a destination by matching text against
 * the provider catalog looks correct until the catalog contains one name under
 * two external IDs — which this provider's own dataset does — at which point
 * the resolver silently picks one and a real parcel ships to the wrong
 * locality. Neither the customer nor the merchant can see that happen. An
 * explicit curated mapping cannot make that mistake, because ambiguity was
 * resolved by a human at build time or the location is simply not mapped.
 *
 * ## Scope
 *
 * This mapping is provider-*global* geography: Tapin province/city IDs are the
 * same for every Tapin account. It is deliberately not stored per Vendor and
 * not stored in `IntegrationConfig`. The account-scoped resource — which Tapin
 * Shop a Warehouse ships from — lives in `config_json.warehouse_origins` and is
 * a separate concern that this module does not touch.
 *
 * ## Key portability
 *
 * The key is `countryCode|provinceCode|normalizedCityName`. It deliberately
 * avoids `cities.id` / `provinces.id`: those are auto-increment values that
 * differ between environments, so a static artifact keyed by them would mean
 * different things in dev and production while looking identical in review.
 * `cities` has no code column, so the canonical city *name* — which is unique
 * within a province in this dataset — carries city identity, normalized only to
 * absorb orthographic variance in Esima's own stored value.
 */

export const TAPIN_LOCATION_ERROR_CODES = Object.freeze({
  MAPPING_MISSING: 'INTEGRATION_SHIPPING_PROVIDER_LOCATION_MAPPING_MISSING',
  CANONICAL_LOCATION_INVALID: 'INTEGRATION_SHIPPING_CANONICAL_LOCATION_INVALID',
});

/**
 * Portable canonical identity for one Esima city.
 *
 * @param {object} params
 * @param {string} params.countryCode
 * @param {string} params.provinceCode
 * @param {string} params.cityName
 * @returns {string}
 */
export function buildCanonicalLocationKey({ countryCode, provinceCode, cityName }) {
  return `${String(countryCode).trim().toUpperCase()}|${String(provinceCode).trim()}|${normalizePersianText(cityName)}`;
}

/**
 * @param {object} canonicalLocation Server-validated canonical destination.
 * @returns {{ externalProvinceId: number, externalCityId: number, mappingKey: string }}
 */
export function resolveTapinLocation(canonicalLocation) {
  const countryCode = canonicalLocation?.countryCode;
  const provinceCode = canonicalLocation?.provinceCode;
  const cityName = canonicalLocation?.cityName;

  if (!countryCode || !provinceCode || !cityName) {
    throw new IntegrationConfigError({
      code: TAPIN_LOCATION_ERROR_CODES.CANONICAL_LOCATION_INVALID,
      message: 'A canonical country code, province code and city name are required',
      domain: INTEGRATION_DOMAINS.SHIPPING,
      providerCode: 'tapin',
    });
  }

  const mappingKey = buildCanonicalLocationKey({ countryCode, provinceCode, cityName });
  const mapped = TAPIN_LOCATION_MAPPINGS.cities[mappingKey];

  if (!mapped) {
    // Fail closed. Every alternative — nearest city, province capital, first
    // catalog hit, the client's own suggestion — quotes and eventually ships to
    // somewhere the customer did not choose. Refusing is the only outcome that
    // cannot be silently wrong.
    throw new IntegrationConfigError({
      code: TAPIN_LOCATION_ERROR_CODES.MAPPING_MISSING,
      message: `No provider location mapping exists for ${mappingKey}`,
      domain: INTEGRATION_DOMAINS.SHIPPING,
      providerCode: 'tapin',
      // Esima's own canonical identity only — no provider candidate ids, which
      // would leak the provider's geography into an error a client can read.
      details: { countryCode, provinceCode },
    });
  }

  return {
    externalProvinceId: mapped.externalProvinceId,
    externalCityId: mapped.externalCityId,
    mappingKey,
  };
}

/**
 * Diagnostics only — coverage/version reporting for maintenance.
 * @returns {object}
 */
export function describeTapinLocationMapping() {
  return {
    schemaVersion: TAPIN_LOCATION_MAPPINGS.schemaVersion,
    keyFormat: TAPIN_LOCATION_MAPPINGS.keyFormat,
    mappedProvinces: Object.keys(TAPIN_LOCATION_MAPPINGS.provinces).length,
    mappedCities: Object.keys(TAPIN_LOCATION_MAPPINGS.cities).length,
    unresolvedCities: TAPIN_LOCATION_MAPPINGS.unresolved.length,
    ambiguousCities: TAPIN_LOCATION_MAPPINGS.ambiguous.length,
  };
}

export default { resolveTapinLocation, buildCanonicalLocationKey, describeTapinLocationMapping };
