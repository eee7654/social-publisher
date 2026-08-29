/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const up = async function(knex) {
    await knex.schema.createTable('roles', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable().unique();
        table.string('label').notNullable();
        table.integer('level').notNullable().defaultTo(10);
        table.timestamps(true, true);
    });
    await knex.schema.createTable('permissions', (table) => {
        table.increments('id').primary();
        table.string('resource').notNullable();        
        table.string('action').notNullable();          
        table.string('description'); 
        table.timestamps(true, true);
        table.unique(['resource', 'action']); 
    });
    await knex.schema.createTable('role_permissions', (table) => {
        table.increments('id').primary();
        table.integer('role_id').unsigned().references('id').inTable('roles').onDelete('CASCADE');
        table.integer('permission_id').unsigned().references('id').inTable('permissions').onDelete('CASCADE');
        table.json('conditions').nullable(); 
        table.json('fields').nullable();
        table.tinyint('inverted').notNullable().defaultTo(0);
    });
    await knex.schema.createTable('organizations', (table) => {
        table.bigIncrements('id').primary();
        table.string('name').notNullable(); 
        table.string('slug').unique().notNullable(); 
        table.boolean('is_active').defaultTo(true);
        table.string('path', 255).index();
        table.bigInteger('parent_id').unsigned().nullable().references('id').inTable('organizations').onDelete('SET NULL');
        table.timestamps(true, true);
    });
    await knex.schema.createTable('user_organization_roles', (table) => {
        table.bigIncrements('id').primary();
        table.string('user_id').notNullable().references('id').inTable('user').onDelete('CASCADE');
        table.bigInteger('organization_id').unsigned().notNullable().references('id').inTable('organizations').onDelete('CASCADE');
        table.integer('role_id').unsigned().notNullable().references('id').inTable('roles').onDelete('CASCADE');
        table.timestamps(true, true);
        table.unique(['user_id', 'organization_id']); 
    });
    await knex.schema.alterTable('user', (table) => {
        table.dropColumn('role_id');
    });
    await knex.schema.alterTable('user', (table) => {
        table.integer('role_id').unsigned().references('id').inTable('roles').onDelete('SET NULL');
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const down = async function(knex) {
    await knex.schema.alterTable('user', (table) => {
        table.dropForeign(['role_id']);
        table.dropColumn('role_id');
    });
    await knex.schema.alterTable('user', (table) => {
        table.integer('role_id');
    });
    await knex.schema.dropTableIfExists('user_organization_roles');
    await knex.schema.dropTableIfExists('organizations');
    await knex.schema.dropTableIfExists('role_permissions');
    await knex.schema.dropTableIfExists('permissions');
    await knex.schema.dropTableIfExists('roles');
};