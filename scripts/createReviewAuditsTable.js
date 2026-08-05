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
      CREATE TABLE IF NOT EXISTS review_audits (
        id SERIAL PRIMARY KEY,
        review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        performed_by TEXT,
        performed_at TIMESTAMPTZ DEFAULT NOW(),
        details JSONB
      )
    `);

    await client.query('COMMIT');
    console.log('Created review_audits table');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();
