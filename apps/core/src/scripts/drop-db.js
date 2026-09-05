import '../bootstrap.js';
import knex from 'knex';

async function dropDb() {
    const rootUser = process.env.DB_ROOT_USER;
    const rootPass = process.env.DB_ROOT_PASS;
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
        await rootKnex.raw(`DROP DATABASE IF EXISTS \`${process.env.DB_NAME}\``);
        console.log('Database dropped.');
    } catch (e) {
        console.error(e);
    } finally {
        await rootKnex.destroy();
    }
}

dropDb();
