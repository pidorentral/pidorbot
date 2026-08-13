import 'dotenv/config';
import { getClient } from '../src/db.js';

const statements = [
  `ALTER TABLE rentals ADD COLUMN IF NOT EXISTS cleanup_requested_at TIMESTAMPTZ`,
  `ALTER TABLE rentals ADD COLUMN IF NOT EXISTS cleanup_started_at TIMESTAMPTZ`,
  `ALTER TABLE rentals ADD COLUMN IF NOT EXISTS cleanup_lease_until TIMESTAMPTZ`,
  `ALTER TABLE rentals ADD COLUMN IF NOT EXISTS cleanup_completed_at TIMESTAMPTZ`,
  `ALTER TABLE rentals ADD COLUMN IF NOT EXISTS cleanup_next_retry_at TIMESTAMPTZ`,
  `ALTER TABLE rentals ADD COLUMN IF NOT EXISTS cleanup_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE rentals ADD COLUMN IF NOT EXISTS cleanup_last_error TEXT`,
  `CREATE INDEX IF NOT EXISTS rentals_cleanup_due_idx
     ON rentals (status, cleanup_next_retry_at)
     WHERE status = 'active'`,
];

const client = await getClient();
try {
  await client.query('BEGIN');
  for (const statement of statements) {
    await client.query(statement);
  }
  await client.query('COMMIT');
  console.log('Rental cleanup lifecycle migration completed.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
