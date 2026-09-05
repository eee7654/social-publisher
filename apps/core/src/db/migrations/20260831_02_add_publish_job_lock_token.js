/**
 * Adds an opaque per-claim fencing token for running publish jobs.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const up = async function(knex) {
  await knex.schema.alterTable('publish_jobs', (table) => {
    table.string('lock_token', 64).nullable().after('locked_at');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const down = async function(knex) {
  await knex.schema.alterTable('publish_jobs', (table) => {
    table.dropColumn('lock_token');
  });
};
