// scripts/setup.js
import knexConfig from '../../knexfile.js';
import knex from 'knex';
import { execSync } from 'child_process';
import { auth } from '@/config/auth.js';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const createDatabase = async () => {
    console.log('⏳ [Phase 1] Provisioning Database and App User (Requires Root Privileges)...');
    const dbName = process.env.DB_NAME;
    const appUser = process.env.DB_USER;
    const appPass = process.env.DB_PASS;
    const rootUser = process.env.DB_ROOT_USER;
    const rootPass = process.env.DB_ROOT_PASS;
    if (!rootUser || !rootPass) {
        console.error('❌ Error: DB_ROOT_USER and DB_ROOT_PASSWORD are required for this step.');
        process.exit(1);
    }
    const rootKnex = knex({
        client: 'mysql2',
        connection: {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: rootUser,
            password: rootPass,
        }
    });
    try {
        const checkDbQuery = await rootKnex.raw(`SHOW DATABASES LIKE '${dbName}'`);
        if (checkDbQuery[0].length === 0) {
            console.log(`🔨 Creating database \`${dbName}\`...`);
            await rootKnex.raw(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            console.log(`✅ Database created.`);
        } else {
            console.log(`ℹ️ Database \`${dbName}\` already exists.`);
        }
        console.log(`🔨 Provisioning application user '${appUser}'...`);
        await rootKnex.raw(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [appUser, appPass]);
        await rootKnex.raw(`ALTER USER ?@'%' IDENTIFIED BY ?`, [appUser, appPass]);
        console.log(`🔐 Granting privileges to '${appUser}' on \`${dbName}\`...`);
        await rootKnex.raw(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'%'`, [appUser]);
        await rootKnex.raw('FLUSH PRIVILEGES');
        console.log(`✅ App user provisioned and privileges granted successfully.`);
    } catch (error) {
        console.error('❌ Error in Provisioning Phase:', error.message);
        process.exit(1);
    } finally {
        await rootKnex.destroy();
    }
};

const runMigrations = async () => {
    console.log('⏳ [Phase 2] Running Migrations...');
    try {
        console.log('   -> Pushing Better-Auth schema...');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const coreAppPath = path.join(__dirname, '..');
        execSync('npx @better-auth/cli migrate --config ./config/auth.js push -y', { stdio: 'inherit', cwd:coreAppPath }); 
        console.log('   -> Running Knex migrations...');
        const appKnex = knex(knexConfig.development);
        await appKnex.migrate.latest();
        await appKnex.destroy();
        console.log('✅ All migrations applied successfully.');
    } catch (error) {
         console.error('❌ Error during migrations:', error.message);
         process.exit(1);
    }
};

const runSeeder = async () => {
    console.log('⏳ [Phase 3] Starting Seeding (Roles, Permissions, Default Org)...');
    const Permission = (await import('../db/models/core/Permission')).default;
    const Role = (await import('../db/models/core/Role')).default;
    const Organization = (await import('../db/models/core/Organization')).default;
    const UserOrganizationRole = (await import('../db/models/core/UserOrganizationRole')).default;
    const isMultiOrg = process.env.IS_MULTI_ORG === 'true';
    try {
        const corePermissions = [
            { action: 'read', resource: 'Role', description: 'View roles and perms' },
            { action: 'create', resource: 'Role', description: 'Create a new role' },
            { action: 'update', resource: 'Role', description: 'Editing roles and access levs' },
            { action: 'delete', resource: 'Role', description: 'Delete a role' },
            { action: 'read', resource: 'Organization', description: 'View organization details and lists' },
            { action: 'create', resource: 'Organization', description: 'Create a new organization' },
            { action: 'update', resource: 'Organization', description: 'Edit basic organization info' },
            { action: 'delete', resource: 'Organization', description: 'Permanently delete an organization' },
            { action: 'suspend', resource: 'Organization', description: 'Activate or deactivate an organization' },
            { action: 'manage_members', resource: 'Organization', description: 'Add, remove, or modify user roles' },
            { action: 'manage_settings', resource: 'Organization', description: 'Access and modify advanced settings' },
            { action: 'view_analytics', resource: 'Organization', description: 'View org-level reports and analytics' }
        ];
        console.log('   -> Inserting Core Permissions...');
        for (const perm of corePermissions) {
            await Permission.query().insert(perm).onConflict(['resource', 'action']).ignore();
        }
        console.log('   -> Creating Root Admin Role...');
        let adminRole = await Role.query().findOne({ name: 'admin' });
        if (!adminRole) {
            adminRole = await Role.query().insertAndFetch({ name: 'admin', label: 'مدیر کل پلتفرم', level: 100 });
        }
        console.log('   -> Setting up Initial Admin User...');
        const adminEmail = 'admin@system.local';
        let adminUser = null;
        try {
            const authPayload = {
                email: adminEmail,
                name: 'مدیر ارشد سیستم',
                password: '123456',
                username: 'admin',
                displayUsername: 'Admin'
            };
            if (!isMultiOrg) {
                authPayload.role_id = adminRole.id;
            }
             const newAuthUser = await auth.api.signUpEmail({
                 body: authPayload
             });
             adminUser = newAuthUser.user;
             console.log(`✅ Admin user created. (Email: ${adminEmail})`);
        } catch (authErr) {
             // فرض بر اینه که اگر کاربر از قبل باشه اینجا میفته
             // (باید توابع BetterAuth رو چک کنی چطور هندل میکنه)
             console.log(`ℹ️ Admin user creation skipped (maybe already exists).`);
        }
        if(isMultiOrg){
            console.log('   -> Setting up Default Organization...');
            let defaultOrg = await Organization.query().findOne({ slug: 'main' });
            if (!defaultOrg) {
                defaultOrg = await Organization.query().insertAndFetch({
                    name: 'سازمان مرکزی',
                    slug: 'main',
                    is_active: true
                });
            }
             // 🌟 تخصیص نقش سوپر ادمین به این کاربر در سازمان دیفالت
        if (adminUser) {
            const existingMembership = await UserOrganizationRole.query().findOne({
                user_id: adminUser.id,
                organization_id: defaultOrg.id
            });
            if (!existingMembership) {
                await UserOrganizationRole.query().insert({
                    user_id: adminUser.id,
                    organization_id: defaultOrg.id,
                    role_id: adminRole.id
                });
                console.log(`✅ Admin assigned to Default Organization with Super Admin role.`);
            }
        }
        }
        console.log('🎉 Seeding completed successfully!');
    } catch (error) {
        console.error('❌ Seeding Error:', error);
        process.exit(1);
    }
};

// ==========================================
// کنترلر اجرای اسکریپت بر اساس آرگومان‌های خط فرمان
// ==========================================
const main = async () => {
    const args = process.argv.slice(2);
    const command = args[0];

    try {
        switch (command) {
            case 'db:create':
                await createDatabase();
                break;
            case 'db:migrate':
                await runMigrations();
                break;
            case 'db:seed':
                await runSeeder();
                break;
            case 'all':
            default:
                console.log('🚀 Running Full Bootstrap Pipeline...');
                await createDatabase();
                await runMigrations();
                await runSeeder();
                console.log('✨ System is fully ready!');
                break;
        }
        process.exit(0);
    } catch (e) {
        console.error('Fatal Pipeline Error:', e);
        process.exit(1);
    }
};

main();