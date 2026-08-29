import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins"
import { createPool } from "mysql2/promise";
import "dotenv/config";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

const poolConfig = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: 8
};

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:4000/api/auth",
    database: createPool(poolConfig), 
    user: {
        additionalFields: {
            role_id: {
                type: "number",
                required: false,
            },
            is_active: {
                type: "boolean",
                required: false,
                defaultValue: true,
            }
        },
    },
    emailAndPassword: {
        enabled: true,
        minPasswordLength: 4
    },
    plugins:[
        username(),
    ],
    session: {
        expiresIn: 60 * 60 * 24 * 15,
    },
    trustedOrigins: [
        process.env.DASHBOARD_URL || "http://localhost:3000",
    ],
    advanced: {
        trustedProxyHeaders:true,
        database:{
            generateId: () => ulid()
        }
    }
});