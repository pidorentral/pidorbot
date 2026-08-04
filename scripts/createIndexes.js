import { getClient } from '../src/db.js';

async function run() {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_funpay_order_id
         ON orders (funpay_order_id)`
    );
    await client.query('COMMIT');
    console.log('Created unique index ux_orders_funpay_order_id');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to create indexes:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run();
