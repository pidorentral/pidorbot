import { Pool } from 'pg';

let pool = null;

function getPool() {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const useSsl =
    process.env.NODE_ENV === 'production' ||
    process.env.DATABASE_URL?.includes('railway') ||
    process.env.DATABASE_URL?.includes('proxy.rlwy.net');

  pool = new Pool({
    connectionString,
    max: parseInt(process.env.PG_MAX_CLIENTS || '10', 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT || '30000', 10),
    allowExitOnIdle: true,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  pool.on('error', (err) => {
    console.error('Unexpected Postgres client error', err);
  });

  return pool;
}

export async function init() {
  await getPool().query('SELECT 1');
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function getClient() {
  return getPool().connect();
}

export async function close() {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
}

export async function transaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}