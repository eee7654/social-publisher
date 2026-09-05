import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import { INTEGRATION_PROVIDER_CATALOG } from './types.js';

/**
 * Idempotently seeds system integration providers from catalog.
 * Uses domain + code unique constraint without overwriting existing records.
 *
 * @param {import('knex').Knex} [queryable]
 * @returns {Promise<Array<IntegrationProvider>>}
 */
export async function seedIntegrationProviders(queryable) {
  const seeded = [];

  for (const item of INTEGRATION_PROVIDER_CATALOG) {
    const query = queryable
      ? IntegrationProvider.query(queryable)
      : IntegrationProvider.query();

    const existing = await query
      .where({
        domain: item.domain,
        code: item.code,
      })
      .first();

    if (!existing) {
      const insertQuery = queryable
        ? IntegrationProvider.query(queryable)
        : IntegrationProvider.query();

      const created = await insertQuery.insertAndFetch({
        domain: item.domain,
        code: item.code,
        display_name: item.display_name,
        adapter_key: item.adapter_key,
        is_enabled: true,
        is_system: true,
      });
      seeded.push(created);
    } else {
      seeded.push(existing);
    }
  }

  return seeded;
}
