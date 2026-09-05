/**
 * Short-lived, generic authorization binding for delegated provider connections.
 * OAuth state is represented only by a SHA-256 hash; transient secrets are
 * encrypted and cleared as soon as the connection is consumed or cancelled.
 */
export async function up(knex) {
  await knex.schema.createTable('integration_connection_intents', (table) => {
    table.string('id', 36).primary();
    table.string('nonce_hash', 64).notNullable().unique();
    table.string('user_id', 255).notNullable().references('id').inTable('user').onDelete('CASCADE');
    table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.bigInteger('provider_id').unsigned().notNullable().references('id').inTable('integration_providers').onDelete('RESTRICT');
    table.string('purpose', 80).notNullable();
    table.string('status', 32).notNullable().defaultTo('pending');
    table.text('pkce_verifier_encrypted').nullable();
    table.json('pending_secret_json').nullable();
    table.string('verified_channel_id', 255).nullable();
    table.string('verified_channel_title', 512).nullable();
    table.timestamp('expires_at').notNullable();
    table.timestamp('reserved_at').nullable();
    table.timestamp('consumed_at').nullable();
    table.timestamps(true, true);

    table.index(['status', 'expires_at']);
    table.index(['organization_id', 'provider_id']);
    table.index(['user_id', 'status']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('integration_connection_intents');
}
