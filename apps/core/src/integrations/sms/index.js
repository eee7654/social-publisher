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
  createSmsirSmsAdapter,
  SMSIR_ADAPTER_KEY,
  SmsirSmsAdapter,
} from "./smsir/index.js";

export { createSmsirSmsAdapter, SMSIR_ADAPTER_KEY, SmsirSmsAdapter };

if (!getIntegrationAdapterFactory(INTEGRATION_DOMAINS.SMS, SMSIR_ADAPTER_KEY)) {
  registerIntegrationAdapter(
    INTEGRATION_DOMAINS.SMS,
    SMSIR_ADAPTER_KEY,
    createSmsirSmsAdapter,
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
export async function resolveSmsAdapter(configOrSelector = {}) {
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
      message: "SMS adapter selector requires code or configId",
      domain: INTEGRATION_DOMAINS.SMS,
    });
  }

  return resolveAdapterForSelector({
    domain: INTEGRATION_DOMAINS.SMS,
    code: configOrSelector.code.trim(),
    organizationId: configOrSelector.organizationId,
    vendorId: configOrSelector.vendorId,
    requireDefault: configOrSelector.requireDefault ?? true,
    trx: configOrSelector.trx,
  });
}
