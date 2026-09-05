import {
  getIntegrationConfig,
  resolveAdapterForConfig,
  resolveAdapterForSelector,
} from "../configResolver.js";
import { IntegrationConfigError } from "../integrationErrors.js";
import {
  getIntegrationAdapterFactory,
  registerIntegrationAdapter,
} from "../registry.js";
import { INTEGRATION_DOMAINS } from "../types.js";
import {
  createNeshanMapsAdapter,
  NESHAN_ADAPTER_KEY,
  NeshanMapsAdapter,
} from "./neshan/index.js";

export { createNeshanMapsAdapter, NESHAN_ADAPTER_KEY, NeshanMapsAdapter };

if (!getIntegrationAdapterFactory(INTEGRATION_DOMAINS.MAPS, NESHAN_ADAPTER_KEY)) {
  registerIntegrationAdapter(
    INTEGRATION_DOMAINS.MAPS,
    NESHAN_ADAPTER_KEY,
    createNeshanMapsAdapter,
  );
}

/**
 * Replicates the `resolveShippingAdapter`/`resolveSmsAdapter` pattern for the
 * maps domain.
 *
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
export async function resolveMapsAdapter(configOrSelector = {}) {
  if (
    configOrSelector?.provider_id != null &&
    "config_json" in configOrSelector
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
    typeof configOrSelector?.code !== "string" ||
    configOrSelector.code.trim() === ""
  ) {
    throw new IntegrationConfigError({
      code: "INTEGRATION_CONFIG_SELECTOR_INVALID",
      message: "Maps adapter selector requires code or configId",
      domain: INTEGRATION_DOMAINS.MAPS,
    });
  }

  return resolveAdapterForSelector({
    domain: INTEGRATION_DOMAINS.MAPS,
    code: configOrSelector.code.trim(),
    organizationId: configOrSelector.organizationId,
    vendorId: configOrSelector.vendorId,
    requireDefault: configOrSelector.requireDefault ?? true,
    trx: configOrSelector.trx,
  });
}
