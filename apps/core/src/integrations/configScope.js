/**
 * Integration config scope tiers.
 *
 * Kernel code with no database imports, so the tenancy rule that governs config
 * resolution can be read — and unit tested — without a database.
 *
 * `configResolver.resolveIntegrationConfig` resolves a usable config with the
 * precedence organization → platform. This module expresses the same
 * precedence as data, with the organization tier always required so that a
 * request-facing endpoint can never resolve cross-tenant configs.
 */

export const INTEGRATION_CONFIG_SCOPES = Object.freeze({
  PLATFORM: 'platform',
  ORGANIZATION: 'organization',
});

/**
 * @param {{ organization_id?: number|string|null }} row
 * @returns {string}
 */
export function scopeOfConfigRow(row) {
  if (row?.organization_id != null) return INTEGRATION_CONFIG_SCOPES.ORGANIZATION;
  return INTEGRATION_CONFIG_SCOPES.PLATFORM;
}

/**
 * @typedef {object} IntegrationScopeTier
 * @property {string} scope
 * @property {number|null} organization_id
 */

/**
 * The ordered `(organization_id)` filters to try, most specific
 * first. `organizationId` must already be trusted server context.
 *
 * @param {object} params
 * @param {number|string} params.organizationId
 * @returns {IntegrationScopeTier[]}
 */
export function buildResolutionTiers({ organizationId }) {
  const orgId = Number(organizationId);

  if (!Number.isFinite(orgId)) {
    throw new TypeError('buildResolutionTiers requires a numeric organizationId');
  }

  /** @type {IntegrationScopeTier[]} */
  const tiers = [];

  tiers.push({
    scope: INTEGRATION_CONFIG_SCOPES.ORGANIZATION,
    organization_id: orgId,
  });

  tiers.push({
    scope: INTEGRATION_CONFIG_SCOPES.PLATFORM,
    organization_id: null,
  });

  return tiers;
}

/**
 * Apply a tier to a query as explicit equality-or-NULL predicates.
 *
 * Duck-typed on `where`/`whereNull` rather than importing Objection, so the
 * predicates a tier actually produces can be asserted against a recording fake
 * without a database.
 *
 * @template {{ where: Function, whereNull: Function }} Q
 * @param {Q} query
 * @param {IntegrationScopeTier} tier
 * @returns {Q}
 */
export function applyScopeTier(query, tier) {
  let next = tier.organization_id == null
    ? query.whereNull('organization_id')
    : query.where('organization_id', tier.organization_id);

  return next;
}
