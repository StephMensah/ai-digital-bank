import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// bigint columns come back as strings by default; bank balances fit in Number safely
// below 2^53 pesewas, so parse them as numbers for ergonomics.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/* The Python decision service owns public.accounts and public.transactions in
   this same database, with an entirely different shape. The Node service keeps
   its tables in their own schema so the two can share one Postgres instance
   without either one standing on the other. */
export const SCHEMA = process.env.PG_SCHEMA || 'adb';

export const pool = new pg.Pool({
  connectionString: config.db.url,
  options: `-c search_path=${SCHEMA},public`,
  ssl: config.db.ssl,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
});

pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
