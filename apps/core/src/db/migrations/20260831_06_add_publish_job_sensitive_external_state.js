/** Stores encrypted, provider-specific transient capabilities separately from state labels. */
export async function up(knex) {
  await knex.schema.alterTable('publish_jobs', (table) => {
    table.json('sensitive_external_state_json').nullable().after('external_stage');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('publish_jobs', (table) => {
    table.dropColumn('sensitive_external_state_json');
  });
}
