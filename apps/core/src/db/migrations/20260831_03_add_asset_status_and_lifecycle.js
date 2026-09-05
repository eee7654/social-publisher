/**
 * Migration: Add status, error_message, locked_at, and lock_token to assets table
 */
export async function up(knex) {
  await knex.schema.alterTable('assets', (table) => {
    table.string('status', 50).notNullable().defaultTo('stored').after('kind');
    table.text('error_message').nullable().after('probe_json');
    table.timestamp('locked_at').nullable().after('expires_at');
    table.string('lock_token', 255).nullable().after('locked_at');

    table.index('status');
    table.index(['organization_id', 'status']);
  });

  // Backfill any existing records
  await knex('assets').update({ status: 'stored' });
}

export async function down(knex) {
  await knex.schema.alterTable('assets', (table) => {
    table.dropIndex(['organization_id', 'status']);
    table.dropIndex(['status']);
    table.dropColumn('lock_token');
    table.dropColumn('locked_at');
    table.dropColumn('error_message');
    table.dropColumn('status');
  });
}
