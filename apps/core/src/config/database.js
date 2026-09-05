'use strict';
import '../bootstrap.js';
import { validateDatabaseEnv } from '../bootstrap.js';
import knex from 'knex';

let dbpool;

export function validateTestDatabase(dbName) {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('CRITICAL: Refusing to execute destructive test DB operation in production environment!');
    }

    // A flag is never sufficient: only an unmistakably isolated database is
    // allowed to receive destructive test operations.
    const isTestDb = dbName && dbName.endsWith('_test');
    if (!isTestDb) {
        throw new Error(`CRITICAL: REFUSING DESTRUCTIVE TEST OPERATION. Configured database '${dbName}' is not an isolated test database (must end with _test).`);
    }
}

export function sanitizeKnexBinding(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'string') {
        try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === 'object') {
                return JSON.stringify(sanitizeKnexObject(parsed));
            }
        } catch {}
        if (val.includes('enc:v1:')) {
            return '[REDACTED_CIPHERTEXT]';
        }
        if (val.includes('AuthV1=') || val.includes('AFCN=')) {
            return '[REDACTED_SESSION_COOKIE]';
        }
        return val;
    }
    if (typeof val === 'object') {
        return sanitizeKnexObject(val);
    }
    return val;
}

export function sanitizeKnexObject(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(sanitizeKnexBinding);
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
        const lk = k.toLowerCase();
        if (
            lk.includes('secret') ||
            lk.includes('password') ||
            lk.includes('session') ||
            lk.includes('token') ||
            lk.includes('cookie') ||
            lk.includes('auth') ||
            lk.includes('credential') ||
            lk.includes('pkce')
        ) {
            clean[k] = '[REDACTED]';
        } else if (typeof v === 'string' && v.includes('enc:v1:')) {
            clean[k] = '[REDACTED_CIPHERTEXT]';
        } else {
            clean[k] = sanitizeKnexBinding(v);
        }
    }
    return clean;
}

export function sanitizeKnexMessage(msg) {
    if (msg && typeof msg === 'object') {
        const clean = { ...msg };
        if (Array.isArray(clean.bindings)) {
            clean.bindings = clean.bindings.map(sanitizeKnexBinding);
        }
        return clean;
    }
    return msg;
}

export function db() {
    if (!dbpool) {
        validateDatabaseEnv();

        // If NODE_ENV=test and no custom DB_NAME is set, force it to social_publisher_test
        let finalDbName = process.env.DB_NAME;
        if (!finalDbName) {
            throw new Error('DB_NAME is required');
        }
        if (process.env.NODE_ENV === 'test' && !finalDbName.endsWith('_test')) {
            finalDbName = `${finalDbName}_test`;
            process.env.DB_NAME = finalDbName;
        }

        const isDebug = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

        dbpool = knex({
            client: 'mysql2',
            connection: {
              host : process.env.DB_HOST,
              port : process.env.DB_PORT,
              user : process.env.DB_USER,
              password : process.env.DB_PASS,
              database : finalDbName,
              dateStrings: true
            },
            pool: {
                min: 2,
                max: 10,
                afterCreate(conn, done) {
                    conn.query("SET time_zone = '+00:00'", (err) => done(err, conn));
                }
            },
            debug: isDebug,
            log: isDebug ? {
                debug(msg) {
                    console.log(sanitizeKnexMessage(msg));
                },
            } : undefined,
        });
    }
    return dbpool;
}

export default db;
