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

    // Stores an encrypted JSON array of Steam session cookies so we can
    // reuse an authenticated session instead of automating form login,
    // which Steam blocks.
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS steam_session_cookies TEXT`);

    await client.query('COMMIT');
    console.log('Added steam_session_cookies column to accounts');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();
