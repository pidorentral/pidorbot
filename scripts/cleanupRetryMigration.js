import { getClient } from '../src/db.js';
import { CLEANUP_RETRY_SCHEMA } from '../steam/cleanupRetry.js';

async function run() {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    await client.query(CLEANUP_RETRY_SCHEMA);
    await client.query('COMMIT');
    console.log('Cleanup retry migration applied successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cleanup retry migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();