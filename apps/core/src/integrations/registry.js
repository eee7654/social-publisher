import { IntegrationProviderError } from "./integrationErrors.js";
/**
 * @typedef {object} IntegrationAdapterRegistration
 * @property {string} domain
 * @property {string} adapterKey
 * @property {(context: { provider: object, integrationConfig: object, providerConfig: unknown }) => unknown} factory
 */

/** @type {Map<string, IntegrationAdapterRegistration>} */
const adapters = new Map();

/**
 * @param {string} domain
 * @param {string} adapterKey
 * @returns {string}
 */
function registryKey(domain, adapterKey) {
  return `${domain}::${adapterKey}`;
}

function requireRegistryIdentifier(value, field, domain = null) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new IntegrationProviderError({
      code: "INTEGRATION_ADAPTER_REGISTRATION_INVALID",
      message: `${field} must be a non-empty string`,
      domain,
    });
  }
  return value.trim();
}

/**
 * Register an adapter factory for a domain + adapter_key pair.
 * Static registration only — no filesystem scanning or dynamic imports.
 *
 * @param {string} domain
 * @param {string} adapterKey
 * @param {(context: { provider: object, integrationConfig: object, providerConfig: unknown }) => unknown} factory
 */
export function registerIntegrationAdapter(domain, adapterKey, factory) {
  const normalizedDomain = requireRegistryIdentifier(domain, "domain");
  const normalizedAdapterKey = requireRegistryIdentifier(
    adapterKey,
    "adapterKey",
    normalizedDomain,
  );

  if (typeof factory !== "function") {
    throw new IntegrationProviderError({
      code: "INTEGRATION_ADAPTER_FACTORY_INVALID",
      message: "adapter factory must be a function",
      domain: normalizedDomain,
    });
  }

  const key = registryKey(normalizedDomain, normalizedAdapterKey);
  if (adapters.has(key)) {
    throw new IntegrationProviderError({
      code: "INTEGRATION_ADAPTER_DUPLICATE",
      message: `Adapter already registered for ${normalizedDomain}/${normalizedAdapterKey}`,
      domain: normalizedDomain,
    });
  }

  adapters.set(key, {
    domain: normalizedDomain,
    adapterKey: normalizedAdapterKey,
    factory,
  });
}

/**
 * @param {string} domain
 * @param {string} adapterKey
 * @returns {((context: { provider: object, integrationConfig: object, providerConfig: unknown }) => unknown) | null}
 */
export function getIntegrationAdapterFactory(domain, adapterKey) {
  if (typeof domain !== "string" || typeof adapterKey !== "string") {
    return null;
  }
  const entry = adapters.get(registryKey(domain, adapterKey));
  return entry ? entry.factory : null;
}

/**
 * @param {string} [domain]
 * @returns {Array<{ domain: string, adapterKey: string }>}
 */
export function listIntegrationAdapters(domain) {
  const normalizedDomain =
    domain == null ? null : requireRegistryIdentifier(domain, "domain");

  return Array.from(adapters.values())
    .filter(
      (entry) => normalizedDomain == null || entry.domain === normalizedDomain,
    )
    .map((entry) => ({
      domain: entry.domain,
      adapterKey: entry.adapterKey,
    }))
    .sort(
      (left, right) =>
        left.domain.localeCompare(right.domain) ||
        left.adapterKey.localeCompare(right.adapterKey),
    );
}

