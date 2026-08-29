'user strict';
import knex from 'knex'

let dbpool

export function db() {
    if (!dbpool) {
        dbpool = knex({
            client: 'mysql2',
            connection: {
              host : process.env.DB_HOST,
              port : process.env.DB_PORT,
              user : process.env.DB_USER,
              password : process.env.DB_PASS,
              database : process.env.DB_NAME,
              dateStrings: true
            },
            pool: { min: 2, max: 10 },
            debug:process.env.NODE_ENV !== "production"
        })
    }
    return dbpool
}

export default db