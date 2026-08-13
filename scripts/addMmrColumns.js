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

    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS desired_mmr INTEGER`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS lot_id TEXT`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS lot_count INTEGER DEFAULT 1`);

    await client.query('COMMIT');
    console.log('Added desired_mmr and lot fields to orders');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();
