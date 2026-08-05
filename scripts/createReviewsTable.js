import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { getClient } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

async function run() {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        user_id TEXT,
        platform TEXT,
        rating INTEGER,
        text TEXT,
        link_or_screenshot TEXT,
        verified_by TEXT,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reviews_order_id_idx ON reviews(order_id)`);

    await client.query('COMMIT');
    console.log('Created reviews table');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();
