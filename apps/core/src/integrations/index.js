export {
  INTEGRATION_DOMAINS,
  INTEGRATION_DIRECTIONS,
  INTEGRATION_EVENT_STATUS,
  INTEGRATION_CONFIG_STATUS,
  INTEGRATION_ENCRYPTION,
  INTEGRATION_PROVIDER_CATALOG,
} from "./types.js";

export {
  IntegrationError,
  IntegrationConfigError,
  IntegrationProviderError,
  isRetryableIntegrationError,
} from "./integrationErrors.js";

export {
  maskSecret,
  maskPhone,
  maskEmail,
  maskConfig,
  maskPayload,
  encryptConfigValue,
  decryptConfigValue,
  decryptProviderConfig,
  isEncryptedConfigValue,
} from "./secrets.js";

export {
  INTEGRATION_FIELD_KINDS,
  INTEGRATION_CONFIG_SCHEMAS,
  getIntegrationConfigSchema,
  describeIntegrationConfigFields,
  listSecretFieldPaths,
  listBrowserExposedFieldPaths,
  getConfigValue,
  setConfigValue,
} from "./configSchemas.js";

export {
  INTEGRATION_CONFIG_ERROR_CODES,
  buildProviderConfig,
  toPublicProviderConfig,
  toBrowserProviderConfig,
} from "./configSerializer.js";

export {
  INTEGRATION_CONFIG_SCOPES,
  scopeOfConfigRow,
  buildResolutionTiers,
  applyScopeTier,
} from "./configScope.js";

export {
  registerIntegrationAdapter,
  getIntegrationAdapterFactory,
  listIntegrationAdapters,
} from "./registry.js";

export {
  getIntegrationProvider,
  getIntegrationConfig,
  resolveIntegrationConfig,
  resolveAdapterForConfig,
  resolveAdapterForSelector,
} from "./configResolver.js";

export {
  createIntegrationEvent,
  markIntegrationEventSuccess,
  markIntegrationEventFailed,
  withIntegrationEvent,
} from "./eventLogger.js";

export { resolveSmsAdapter } from "./sms/index.js";
export { resolvePaymentAdapter } from "./payment/index.js";
export { resolveStorageAdapter } from "./storage/index.js";
export { resolveShippingAdapter } from "./shipping/index.js";
export { resolveMapsAdapter } from "./maps/index.js";
