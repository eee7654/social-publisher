import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import {
  IntegrationConfigError,
  IntegrationProviderError,
} from './integrationErrors.js';
import { getIntegrationAdapterFactory } from './registry.js';
import { INTEGRATION_CONFIG_STATUS } from './types.js';

const USABLE_CONFIG_STATUSES = [
  INTEGRATION_CONFIG_STATUS.ACTIVE,
  INTEGRATION_CONFIG_STATUS.TESTING,
];

/**
 * @param {number|string} providerId
 * @param {object} [options]
 * @param {import('objection').TransactionOrKnex} [options.trx]
 * @param {number|string|null} [options.configId]
 */
async function loadAndValidateProvider(providerId, { trx, configId = null } = {}) {
  const provider = await IntegrationProvider.query(trx).findById(providerId);

  if (!provider) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PROVIDER_NOT_FOUND',
      message: configId != null
        ? `Integration provider not found for config ${configId}`
        : 'Integration provider not found',
      configId,
    });
  }

  if (!provider.is_enabled) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PROVIDER_DISABLED',
      message: configId != null
        ? `Integration provider is disabled for config ${configId}`
        : `Integration provider is disabled for ${provider.domain}/${provider.code}`,
      domain: provider.domain,
      providerCode: provider.code,
      configId,
    });
  }

  return provider;
}

/**
 * @param {object} params
 * @param {string} params.domain
 * @param {string} params.code
 * @param {import('objection').TransactionOrKnex} [params.trx]
 */
export async function getIntegrationProvider({ domain, code, trx } = {}) {
  if (!domain || !code) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PROVIDER_SELECTOR_INVALID',
      message: 'domain and code are required',
      domain: domain || null,
    });
  }

  const provider = await IntegrationProvider.query(trx).findOne({ domain, code });
  if (!provider) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PROVIDER_NOT_FOUND',
      message: `Integration provider not found for ${domain}/${code}`,
      domain,
      providerCode: code,
    });
  }

  if (!provider.is_enabled) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PROVIDER_DISABLED',
      message: `Integration provider is disabled for ${domain}/${code}`,
      domain,
      providerCode: code,
    });
  }

  return provider;
}

/**
 * @param {object} params
 * @param {number|string} params.configId
 * @param {import('objection').TransactionOrKnex} [params.trx]
 * @param {boolean} [params.includeProvider]
 */
export async function getIntegrationConfig({
  configId,
  trx,
  includeProvider = true,
} = {}) {
  if (configId == null) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_SELECTOR_INVALID',
      message: 'configId is required',
    });
  }

  const integrationConfig = await IntegrationConfig.query(trx)
    .findById(configId)
    .whereNull('deleted_at');

  if (!integrationConfig) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_NOT_FOUND',
      message: `Integration config not found: ${configId}`,
      configId,
    });
  }

  if (!USABLE_CONFIG_STATUSES.includes(integrationConfig.status)) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_INACTIVE',
      message: `Integration config is not usable: ${configId}`,
      configId: integrationConfig.id,
    });
  }

  if (includeProvider) {
    integrationConfig.provider = await loadAndValidateProvider(
      integrationConfig.provider_id,
      { trx, configId: integrationConfig.id },
    );
  }

  return integrationConfig;
}

/**
 * @param {object} params
 * @param {number|string} params.providerId
 * @param {import('objection').TransactionOrKnex} [params.trx]
 */
function baseConfigQuery({ providerId, trx }) {
  return IntegrationConfig.query(trx)
    .where('provider_id', providerId)
    .whereIn('status', USABLE_CONFIG_STATUSES)
    .whereNull('deleted_at');
}

/**
 * @param {import('objection').QueryBuilder} query
 * @param {boolean} requireDefault
 */
async function firstConfigForScope(query, requireDefault) {
  if (requireDefault) {
    return query.clone().where('is_default', true).first();
  }
  return query.clone().orderBy('is_default', 'desc').orderBy('id', 'asc').first();
}

/**
 * Resolve a usable config with precedence:
 * organization → platform.
 * Attaches integrationConfig.provider. Does not decrypt config_json.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {string} params.code
 * @param {number|string|null} [params.organizationId]
 * @param {boolean} [params.requireDefault]
 * @param {import('objection').TransactionOrKnex} [params.trx]
 */
export async function resolveIntegrationConfig({
  domain,
  code,
  organizationId = null,
  requireDefault = true,
  trx,
} = {}) {
  const provider = await getIntegrationProvider({ domain, code, trx });
  let integrationConfig = null;

  if (organizationId != null) {
    integrationConfig = await firstConfigForScope(
      baseConfigQuery({ providerId: provider.id, trx })
        .where('organization_id', organizationId),
      requireDefault,
    );
  }

  if (!integrationConfig) {
    integrationConfig = await firstConfigForScope(
      baseConfigQuery({ providerId: provider.id, trx })
        .whereNull('organization_id'),
      requireDefault,
    );
  }

  if (!integrationConfig) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_NOT_FOUND',
      message: `No usable integration config for ${domain}/${code}`,
      domain,
      providerCode: code,
    });
  }

  integrationConfig.provider = provider;
  return integrationConfig;
}

/**
 * Build an adapter for a loaded IntegrationConfig row.
 * Does not decrypt config_json.
 *
 * Factory context:
 *   - provider
 *   - integrationConfig
 *   - providerConfig (integrationConfig.config_json ?? {})
 *   - httpClient (optional transport override)
 *
 * `httpClient` exists so a caller can substitute a deterministic transport for
 * the adapter's real one — the seam automated validation drives provider
 * contracts through without a live provider. It is passed through untouched;
 * adapters that declare no transport override simply ignore it.
 *
 * @param {object} integrationConfig
 * @param {object} [options]
 * @param {import('objection').TransactionOrKnex} [options.trx]
 * @param {{ post: Function }} [options.httpClient]
 */
export async function resolveAdapterForConfig(integrationConfig, { trx, httpClient } = {}) {
  if (!integrationConfig || integrationConfig.provider_id == null) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_SELECTOR_INVALID',
      message: 'A valid integration config is required',
      configId: integrationConfig?.id ?? null,
    });
  }

  if (integrationConfig.deleted_at) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_NOT_FOUND',
      message: `Integration config is deleted: ${integrationConfig.id}`,
      configId: integrationConfig.id,
    });
  }

  if (
    integrationConfig.status &&
    !USABLE_CONFIG_STATUSES.includes(integrationConfig.status)
  ) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_INACTIVE',
      message: `Integration config is not usable: ${integrationConfig.id}`,
      configId: integrationConfig.id,
    });
  }

  let provider = integrationConfig.provider;
  if (!provider) {
    provider = await loadAndValidateProvider(integrationConfig.provider_id, {
      trx,
      configId: integrationConfig.id,
    });
    integrationConfig.provider = provider;
  } else if (!provider.is_enabled) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_PROVIDER_DISABLED',
      message: `Integration provider is disabled for config ${integrationConfig.id}`,
      domain: provider.domain,
      providerCode: provider.code,
      configId: integrationConfig.id,
    });
  }

  const factory = getIntegrationAdapterFactory(provider.domain, provider.adapter_key);
  if (!factory) {
    throw new IntegrationProviderError({
      code: 'INTEGRATION_ADAPTER_NOT_REGISTERED',
      message: `No adapter registered for ${provider.domain}/${provider.adapter_key}`,
      domain: provider.domain,
      providerCode: provider.code,
      configId: integrationConfig.id,
    });
  }

  return factory({
    provider,
    integrationConfig,
    providerConfig: integrationConfig.config_json ?? {},
    httpClient,
  });
}

/**
 * @param {object} selector
 * @param {string} selector.domain
 * @param {string} selector.code
 * @param {number|string|null} [selector.organizationId]
 * @param {boolean} [selector.requireDefault]
 * @param {import('objection').TransactionOrKnex} [selector.trx]
 */
export async function resolveAdapterForSelector(selector = {}) {
  const integrationConfig = await resolveIntegrationConfig(selector);
  return resolveAdapterForConfig(integrationConfig, { trx: selector.trx });
}
