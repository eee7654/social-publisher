/**
 * Safe OAuth callback diagnostics for provider connection intents.
 * Stores stage and non-secret Google metadata only; OAuth codes, states,
 * PKCE verifiers, access tokens, and refresh tokens must never be persisted here.
 */
export async function up(knex) {
  await knex.schema.alterTable('integration_connection_intents', (table) => {
    table.string('callback_stage', 64).nullable();
    table.string('failure_stage', 64).nullable();
    table.integer('failure_http_status').nullable();
    table.string('failure_error_code', 120).nullable();
    table.string('failure_error_reason', 120).nullable();
    table.string('failure_message', 512).nullable();
    table.json('granted_scopes_json').nullable();
    table.boolean('token_access_present').nullable();
    table.boolean('token_refresh_present').nullable();
    table.boolean('token_expiry_present').nullable();
    table.integer('channel_items_count').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('integration_connection_intents', (table) => {
    table.dropColumn('callback_stage');
    table.dropColumn('failure_stage');
    table.dropColumn('failure_http_status');
    table.dropColumn('failure_error_code');
    table.dropColumn('failure_error_reason');
    table.dropColumn('failure_message');
    table.dropColumn('granted_scopes_json');
    table.dropColumn('token_access_present');
    table.dropColumn('token_refresh_present');
    table.dropColumn('token_expiry_present');
    table.dropColumn('channel_items_count');
  });
}
