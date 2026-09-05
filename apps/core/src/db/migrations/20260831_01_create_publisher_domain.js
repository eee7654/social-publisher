/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const up = async function(knex) {
    // ==========================================
    // INTEGRATION DOMAIN (Generic Core)
    // ==========================================

    await knex.schema.createTable('integration_providers', (table) => {
        table.bigIncrements('id').primary();
        table.string('domain').notNullable();
        table.string('code').notNullable();
        table.string('display_name').notNullable();
        table.string('adapter_key').notNullable();
        table.boolean('is_enabled').notNullable().defaultTo(true);
        table.boolean('is_system').notNullable().defaultTo(true);
        table.timestamps(true, true);

        table.unique(['domain', 'code']);
        table.index('domain');
        table.index('is_enabled');
    });

    await knex.schema.createTable('integration_configs', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('provider_id').unsigned().notNullable().references('id').inTable('integration_providers').onDelete('RESTRICT');
        table.bigInteger('organization_id').unsigned().nullable().references('id').inTable('organizations').onDelete('SET NULL');
        
        table.string('name').notNullable();
        table.json('config_json').notNullable();
        table.boolean('is_default').notNullable().defaultTo(false);
        table.string('status').notNullable().defaultTo('active');
        table.string('created_by').nullable().references('id').inTable('user').onDelete('SET NULL');
        
        // Metadata / Connection fields
        table.string('external_account_id').nullable();
        table.string('external_account_name').nullable();
        table.json('metadata_json').nullable();
        table.timestamp('expires_at').nullable();
        table.timestamp('last_verified_at').nullable();

        table.timestamps(true, true);
        table.timestamp('deleted_at').nullable();

        table.index('provider_id');
        table.index('organization_id');
        table.index('status');
        table.index('external_account_id');
    });

    await knex.schema.createTable('integration_events', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('provider_id').unsigned().notNullable().references('id').inTable('integration_providers').onDelete('CASCADE');
        table.bigInteger('config_id').unsigned().nullable().references('id').inTable('integration_configs').onDelete('SET NULL');
        
        table.string('event_type').notNullable();
        table.string('direction').notNullable();
        table.string('status').notNullable();
        
        table.json('request_json').nullable();
        table.json('response_json').nullable();
        
        table.string('error_code').nullable();
        table.text('error_message').nullable();
        
        table.string('reference_type').nullable();
        table.bigInteger('reference_id').nullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());

        table.index(['provider_id', 'created_at']);
        table.index(['config_id', 'created_at']);
        table.index(['reference_type', 'reference_id']);
        table.index(['status', 'created_at']);
    });

    // ==========================================
    // PUBLISHING DOMAIN
    // ==========================================

    await knex.schema.createTable('telegram_channels', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
        table.bigInteger('integration_config_id').unsigned().nullable().references('id').inTable('integration_configs').onDelete('SET NULL');
        
        table.string('chat_id').notNullable();
        table.string('username').nullable();
        table.string('title').nullable();
        table.string('owner_user_id').nullable().references('id').inTable('user').onDelete('SET NULL');
        table.boolean('is_active').notNullable().defaultTo(true);
        
        table.timestamps(true, true);
    });

    await knex.schema.createTable('campaigns', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
        table.string('created_by').nullable().references('id').inTable('user').onDelete('SET NULL');
        
        table.string('source_type').notNullable(); // telegram_private, api
        table.string('source_ref').nullable();
        table.string('status').notNullable().defaultTo('draft');
        
        table.string('base_title').nullable();
        table.text('base_caption').nullable();
        
        table.bigInteger('cover_asset_id').unsigned().nullable(); // defined after assets table, will add foreign key later or rely on app logic
        
        table.timestamps(true, true);
        table.timestamp('published_at').nullable();
        
        table.index('organization_id');
        table.index('status');
    });

    await knex.schema.createTable('assets', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
        table.bigInteger('campaign_id').unsigned().nullable().references('id').inTable('campaigns').onDelete('CASCADE');
        table.bigInteger('parent_asset_id').unsigned().nullable().references('id').inTable('assets').onDelete('SET NULL');
        
        table.string('kind').notNullable();
        table.string('object_key').notNullable();
        table.string('original_filename').nullable();
        table.string('mime_type').nullable();
        table.bigInteger('size_bytes').nullable();
        table.string('sha256').nullable();
        
        table.integer('width').nullable();
        table.integer('height').nullable();
        table.integer('duration_ms').nullable();
        table.integer('fps').nullable();
        table.string('video_codec').nullable();
        table.string('audio_codec').nullable();
        table.string('aspect_ratio').nullable();
        
        table.json('probe_json').nullable();
        table.timestamp('expires_at').nullable();
        
        table.timestamps(true, true);

        table.index('organization_id');
        table.index('campaign_id');
        table.index('expires_at');
    });

    // Add cover_asset_id FK to campaigns
    await knex.schema.alterTable('campaigns', (table) => {
        table.foreign('cover_asset_id').references('id').inTable('assets').onDelete('SET NULL');
    });

    await knex.schema.createTable('campaign_targets', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('campaign_id').unsigned().notNullable().references('id').inTable('campaigns').onDelete('CASCADE');
        table.bigInteger('integration_config_id').unsigned().notNullable().references('id').inTable('integration_configs').onDelete('CASCADE');
        
        table.string('platform').notNullable();
        table.string('status').notNullable().defaultTo('pending');
        table.boolean('suggested_by_system').notNullable().defaultTo(false);
        table.boolean('confirmed_by_user').notNullable().defaultTo(false);
        
        table.bigInteger('asset_id').unsigned().nullable().references('id').inTable('assets').onDelete('SET NULL');
        table.bigInteger('cover_asset_id').unsigned().nullable().references('id').inTable('assets').onDelete('SET NULL');
        
        table.string('title_override').nullable();
        table.text('caption_override').nullable();
        table.json('settings_json').nullable();
        
        table.string('published_url').nullable();
        table.string('external_post_id').nullable();
        
        table.timestamps(true, true);

        table.index('campaign_id');
        table.index('integration_config_id');
        table.index('status');
    });

    await knex.schema.createTable('publish_jobs', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
        table.bigInteger('campaign_target_id').unsigned().notNullable().references('id').inTable('campaign_targets').onDelete('CASCADE');
        
        table.string('idempotency_key').notNullable().unique();
        table.string('status').notNullable().defaultTo('pending');
        
        table.integer('attempt_count').notNullable().defaultTo(0);
        table.integer('max_attempts').notNullable().defaultTo(3);
        table.timestamp('next_attempt_at').nullable();
        table.timestamp('locked_at').nullable();
        
        table.string('last_error_code').nullable();
        table.text('last_error_message').nullable();
        
        table.string('external_stage').nullable();
        table.string('external_container_id').nullable();
        table.string('external_media_id').nullable();
        
        table.timestamps(true, true);
        table.timestamp('completed_at').nullable();

        table.index('organization_id');
        table.index('campaign_target_id');
        table.index('status');
        table.index('next_attempt_at');
        // idempotency_key is already unique so index is implied
    });

    await knex.schema.createTable('publish_attempts', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('job_id').unsigned().notNullable().references('id').inTable('publish_jobs').onDelete('CASCADE');
        
        table.integer('attempt_number').notNullable();
        table.timestamp('started_at').nullable();
        table.timestamp('finished_at').nullable();
        
        table.string('status').notNullable();
        table.string('error_category').nullable();
        table.string('error_code').nullable();
        table.text('error_message').nullable();
        table.json('metadata_json').nullable();
        
        // No created_at requested, but usually helpful. Following prompt strictness for attempt structure.
    });

    await knex.schema.createTable('outbox_events', (table) => {
        table.bigIncrements('id').primary();
        table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
        
        table.string('event_type').notNullable();
        table.string('aggregate_type').notNullable();
        table.string('aggregate_id').notNullable();
        
        table.json('payload_json').notNullable();
        table.string('status').notNullable().defaultTo('pending');
        table.integer('attempt_count').notNullable().defaultTo(0);
        
        table.timestamp('available_at').nullable();
        table.timestamp('dispatched_at').nullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());

        table.index('status');
        table.index('available_at');
        table.index('organization_id');
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const down = async function(knex) {
    await knex.schema.dropTableIfExists('outbox_events');
    await knex.schema.dropTableIfExists('publish_attempts');
    await knex.schema.dropTableIfExists('publish_jobs');
    await knex.schema.dropTableIfExists('campaign_targets');
    
    // Drop foreign key from campaigns to assets first
    await knex.schema.alterTable('campaigns', (table) => {
        table.dropForeign('cover_asset_id');
    });
    
    await knex.schema.dropTableIfExists('assets');
    await knex.schema.dropTableIfExists('campaigns');
    await knex.schema.dropTableIfExists('telegram_channels');
    
    await knex.schema.dropTableIfExists('integration_events');
    await knex.schema.dropTableIfExists('integration_configs');
    await knex.schema.dropTableIfExists('integration_providers');
};
