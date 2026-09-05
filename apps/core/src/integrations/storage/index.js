import {
  getIntegrationConfig,
  resolveAdapterForConfig,
  resolveAdapterForSelector,
} from '../configResolver.js';
import { IntegrationConfigError } from '../integrationErrors.js';
import {
  getIntegrationAdapterFactory,
  registerIntegrationAdapter,
} from '../registry.js';
import { INTEGRATION_DOMAINS } from '../types.js';
import {
  MinioStorageAdapter,
  MINIO_ADAPTER_KEY,
  createMinioStorageAdapter,
} from './minio.js';

export { MinioStorageAdapter, MINIO_ADAPTER_KEY, createMinioStorageAdapter };

if (!getIntegrationAdapterFactory(INTEGRATION_DOMAINS.STORAGE, MINIO_ADAPTER_KEY)) {
  registerIntegrationAdapter(
    INTEGRATION_DOMAINS.STORAGE,
    MINIO_ADAPTER_KEY,
    createMinioStorageAdapter,
  );
}

/**
 * @param {object} configOrSelector
 * @param {number|string} [configOrSelector.configId]
 * @param {string} [configOrSelector.code]
 * @param {number|string|null} [configOrSelector.organizationId]
 * @param {number|string|null} [configOrSelector.vendorId]
 * @param {boolean} [configOrSelector.requireDefault]
 * @param {number|string} [configOrSelector.provider_id]
 * @param {unknown} [configOrSelector.config_json]
 * @param {import('objection').TransactionOrKnex} [configOrSelector.trx]
 */
export async function resolveStorageAdapter(configOrSelector = {}) {
  if (
    configOrSelector?.provider_id != null &&
    'config_json' in configOrSelector
  ) {
    return resolveAdapterForConfig(configOrSelector, {
      trx: configOrSelector.trx,
    });
  }

  if (configOrSelector?.configId != null) {
    const integrationConfig = await getIntegrationConfig({
      configId: configOrSelector.configId,
      trx: configOrSelector.trx,
    });
    return resolveAdapterForConfig(integrationConfig, {
      trx: configOrSelector.trx,
    });
  }

  if (
    typeof configOrSelector?.code !== 'string' ||
    configOrSelector.code.trim() === ''
  ) {
    throw new IntegrationConfigError({
      code: 'INTEGRATION_CONFIG_SELECTOR_INVALID',
      message: 'Storage adapter selector requires code or configId',
      domain: INTEGRATION_DOMAINS.STORAGE,
    });
  }

  return resolveAdapterForSelector({
    domain: INTEGRATION_DOMAINS.STORAGE,
    code: configOrSelector.code.trim(),
    organizationId: configOrSelector.organizationId,
    vendorId: configOrSelector.vendorId,
    requireDefault: configOrSelector.requireDefault ?? true,
    trx: configOrSelector.trx,
  });
}
