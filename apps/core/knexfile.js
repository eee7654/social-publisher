import "dotenv/config";

const KnexFile = {
  development: {
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    },
    migrations: {
      directory: './src/db/migrations',
    },
    seeds: {
      directory: './src/db/seeds'
    },
    pool: { min: 2, max: 10 },
    debug:process.env.NODE_ENV !== "production"
  },
  production: {
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    },
    migrations: {
      directory: './src/db/migrations',
    },
    seeds: {
      directory: './src/db/seeds'
    },
    pool: { min: 2, max: 10 },
    debug:process.env.NODE_ENV !== "production"
  },
}

export default KnexFile