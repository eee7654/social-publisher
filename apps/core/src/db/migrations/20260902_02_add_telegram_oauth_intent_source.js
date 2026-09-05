/**
 * Adds source metadata for web and Telegram-originated platform connection
 * intents. Browser tickets are stored only as SHA-256 hashes and are separate
 * from Google OAuth state hashes.
 */
export async function up(knex) {
  await knex.schema.alterTable('integration_connection_intents', (table) => {
    table.string('source', 32).notNullable().defaultTo('web').after('purpose');
    table.string('browser_ticket_hash', 64).nullable().unique().after('nonce_hash');
    table.timestamp('browser_ticket_reserved_at').nullable().after('reserved_at');
    table.string('telegram_user_id', 255).nullable().after('organization_id');
    table.string('telegram_chat_id', 255).nullable().after('telegram_user_id');

    table.index(['source', 'status', 'expires_at']);
    table.index(['telegram_user_id', 'status']);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('integration_connection_intents', (table) => {
    table.dropIndex(['telegram_user_id', 'status']);
    table.dropIndex(['source', 'status', 'expires_at']);
    table.dropUnique(['browser_ticket_hash']);
    table.dropColumn('telegram_chat_id');
    table.dropColumn('telegram_user_id');
    table.dropColumn('browser_ticket_reserved_at');
    table.dropColumn('browser_ticket_hash');
    table.dropColumn('source');
  });
}
