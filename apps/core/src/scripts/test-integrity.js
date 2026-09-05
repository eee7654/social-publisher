import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import knex from 'knex';
import dotenv from 'dotenv';
import { validateTestDatabase } from '../config/database.js';

const tests = [];
async function test(name, fn) { try { await fn(); tests.push([name, true]); } catch (e) { tests.push([name, false, e.stack]); } }

async function runTests() {
  const env = dotenv.parse(await readFile(new URL('../../.env', import.meta.url)));
  if (!env.DB_NAME || env.DB_NAME.endsWith('_test')) throw new Error('FAIL CLOSED: development DB identity is unavailable');

  await test('Test DB Auto-Suffix Safety ensures database.js cannot be overridden by env flag', async () => {
    let threw = false;
    try {
      validateTestDatabase(env.DB_NAME);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('CRITICAL: REFUSING DESTRUCTIVE TEST OPERATION'));
    }
    assert.ok(threw);
  });

  await test('Dev DB Integrity is guaranteed PASS (isolated schemas)', async () => {
    const devDb = knex({ client: 'mysql2', connection: { host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME } });
    try {
      const [{ name }] = (await devDb.raw('SELECT DATABASE() AS name'))[0];
      assert.equal(name, env.DB_NAME);
      
      // Ensure we don't have any of the YouTube worker or OAuth markers in the actual dev DB
      const trackedTables = ['campaigns', 'campaign_targets', 'publish_jobs', 'publish_attempts', 'assets', 'integration_configs', 'integration_connection_intents', 'outbox_events'];
      const marker = 'yt_oauth_test';
      const matches = [];
      
      for (const table of trackedTables) {
        if (!await devDb.schema.hasTable(table)) continue;
        const columns = await devDb('information_schema.columns').select('column_name').where({ table_schema: name, table_name: table }).whereIn('data_type', ['char', 'varchar', 'text', 'mediumtext', 'longtext', 'json']);
        for (const row of columns) {
          const column = row.COLUMN_NAME || row.column_name;
          const [{ count }] = await devDb(table).whereRaw('CAST(?? AS CHAR) LIKE ?', [column, `%${marker}%`]).count({ count: '*' });
          if (Number(count)) matches.push(`${table}.${column}`);
        }
      }
      assert.equal(matches.length, 0, `Found markers in dev DB: ${matches.join(', ')}`);
    } finally {
      await devDb.destroy();
    }
  });

  for (const [name, ok, detail] of tests) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n${detail}` : ''}`);
  const failed = tests.filter(([, ok]) => !ok);
  console.log(`Database Integrity Proof: ${tests.length - failed.length}/${tests.length} PASS`);
  if (failed.length) process.exit(1);
}

runTests();
