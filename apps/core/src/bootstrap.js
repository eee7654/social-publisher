import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let bootstrapped = false;

/**
 * Centrally locates and loads .env for Core and standalone process entrypoints.
 * Checks apps/core/.env, cwd .env, and workspace root .env safely without secret exposure.
 */
export function bootstrapEnv() {
  if (bootstrapped) return;
  bootstrapped = true;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const candidatePaths = [
    // 1. apps/core/.env relative to this file
    path.resolve(__dirname, '../.env'),
    // 2. Current working directory .env
    path.resolve(process.cwd(), '.env'),
    // 3. apps/core/.env relative to current working directory
    path.resolve(process.cwd(), 'apps/core/.env'),
    // 4. Workspace root .env
    path.resolve(__dirname, '../../.env'),
  ];

  for (const envPath of candidatePaths) {
    try {
      if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath, override: false });
      }
    } catch (e) {
      // Ignore filesystem inspection errors
    }
  }
}

/**
 * Validates that essential database configuration variables are present.
 * Fails fast with a safe error message without printing secrets.
 */
export function validateDatabaseEnv() {
  bootstrapEnv();
  const missing = [];
  if (!process.env.DB_HOST) missing.push('DB_HOST');
  if (!process.env.DB_NAME) missing.push('DB_NAME');
  if (!process.env.DB_USER) missing.push('DB_USER');

  if (missing.length > 0) {
    throw new Error(`Database configuration missing (${missing.join(', ')} must be set in environment)`);
  }
}

// Auto-run on module import
bootstrapEnv();

export default bootstrapEnv;
