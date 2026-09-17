import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';
import { logger } from '../lib/logger.js';
import { hashSecret } from '../lib/crypto.js';

const here = dirname(fileURLToPath(import.meta.url));

async function run() {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  logger.info('schema applied');

  // bootstrap one admin so the reviewer console and control tower are reachable
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (email && password) {
    await pool.query(
      `INSERT INTO staff_users (email, full_name, password_hash, role)
       VALUES ($1,$2,$3,'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [email.toLowerCase(), process.env.BOOTSTRAP_ADMIN_NAME || 'Platform Admin', hashSecret(password)]
    );
    logger.info({ email }, 'bootstrap admin ready');
  }
  await pool.end();
}

run().catch((err) => { logger.error({ err }, 'migration failed'); process.exit(1); });
