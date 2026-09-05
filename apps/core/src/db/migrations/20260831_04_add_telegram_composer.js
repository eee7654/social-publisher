/**
 * Migration: Add Telegram Composer tables
 * 
 * Creates:
 * 1. telegram_user_bindings: Binds Telegram User ID (as string) to Core User & Organization
 * 2. telegram_composer_sessions: Tracks stateful, durable multi-step composition
 * 3. telegram_update_receipts: Ensures durable, lease-fenced Telegram update idempotency
 */

export async function up(knex) {
  // 1. telegram_user_bindings
  await knex.schema.createTable('telegram_user_bindings', (table) => {
    table.bigIncrements('id').primary();
    table.string('telegram_user_id', 255).notNullable();
    table.string('user_id', 255).notNullable().references('id').inTable('user').onDelete('CASCADE');
    table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.boolean('is_default').notNullable().defaultTo(true);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamps(true, true);

    table.unique(['telegram_user_id', 'organization_id']);
    table.index('telegram_user_id');
    table.index('organization_id');
    table.index('is_active');
  });

  // 2. telegram_composer_sessions
  await knex.schema.createTable('telegram_composer_sessions', (table) => {
    table.bigIncrements('id').primary();
    table.string('telegram_user_id', 255).notNullable();
    table.string('telegram_chat_id', 255).notNullable();
    table.string('user_id', 255).nullable().references('id').inTable('user').onDelete('SET NULL');
    table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.bigInteger('campaign_id').unsigned().nullable().references('id').inTable('campaigns').onDelete('SET NULL');
    table.string('state', 50).notNullable().defaultTo('idle');
    table.json('context_json').nullable();
    table.timestamp('expires_at').nullable();
    table.timestamps(true, true);

    table.index('telegram_user_id');
    table.index('telegram_chat_id');
    table.index('organization_id');
    table.index('campaign_id');
    table.index('state');
  });

  // 3. telegram_update_receipts
  await knex.schema.createTable('telegram_update_receipts', (table) => {
    table.bigIncrements('id').primary();
    table.string('telegram_update_id', 255).notNullable();
    table.string('telegram_user_id', 255).nullable();
    table.string('status', 50).notNullable().defaultTo('processing'); // processing | processed | failed
    table.timestamp('locked_at').nullable();
    table.string('lock_token', 255).nullable();
    table.json('result_json').nullable();
    table.timestamp('processed_at').nullable();
    table.timestamps(true, true);

    table.unique('telegram_update_id');
    table.index('status');
    table.index('telegram_user_id');
    table.index(['status', 'locked_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('telegram_update_receipts');
  await knex.schema.dropTableIfExists('telegram_composer_sessions');
  await knex.schema.dropTableIfExists('telegram_user_bindings');
}
