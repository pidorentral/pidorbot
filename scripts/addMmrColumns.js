import { getClient } from '../src/db.js';

async function run() {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS desired_mmr INTEGER`);
    await client.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mmr INTEGER`);

    await client.query('COMMIT');
    console.log('Added desired_mmr to orders and mmr to accounts');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();
