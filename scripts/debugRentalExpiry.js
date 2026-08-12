import 'dotenv/config';
import { createExpiryChecker } from '../src/funpay/rentalExpiry.js';
import { query } from '../src/db.js';

process.env.RENTAL_EXPIRY_CHECK_MS = '2000';
process.env.RENTAL_DURATION_HOURS = '0.01';

const logger = console;

async function main() {
  const accountId = Number(process.env.DEBUG_ACCOUNT_ID || '88');
  const buyer = process.env.DEBUG_BUYER || 'debug-buyer';
  const nodeId = Number(process.env.DEBUG_NODE_ID || '123456789');

  if (!accountId) {
    throw new Error('DEBUG_ACCOUNT_ID must be set to a valid account id');
  }

  const accountRes = await query('SELECT id, login FROM accounts WHERE id = $1', [accountId]);
  if (accountRes.rows.length === 0) {
    throw new Error(`Account #${accountId} not found`);
  }

  const debugOrder = await query(
    `
      INSERT INTO orders (funpay_order_id, buyer, account_id, price, status, lot_count)
      VALUES ($1, $2, $3, 0, 'paid', 1)
      RETURNING id
    `,
    [`debug-${Date.now()}`, buyer, accountId]
  );

  const orderId = debugOrder.rows[0].id;

  const checker = createExpiryChecker({
    logger,
    notifyAdmin: async (msg) => {
      logger.info(`ADMIN NOTIFY: ${msg}`);
    },
  });

  await query(
    `
      INSERT INTO rentals (account_id, buyer, order_id, node_id, started_at, ends_at, status, state)
      VALUES ($1, $2, $3, $4, NOW() - INTERVAL '2 hour', NOW() - INTERVAL '1 minute', 'active', 'active')
    `,
    [accountId, buyer, orderId, nodeId]
  );

  logger.info(`Created debug rental for account #${accountId} and order #${orderId} with expiry in the past`);
  logger.info(`Using RENTAL_DURATION_HOURS=${process.env.RENTAL_DURATION_HOURS}`);

  checker.start();

  setTimeout(async () => {
    try {
      await query('DELETE FROM rentals WHERE order_id = $1', [orderId]);
      await query('DELETE FROM orders WHERE id = $1', [orderId]);
      logger.info(`Removed debug order #${orderId} and related rental after test`);
    } catch (cleanupErr) {
      logger.warn(`Cleanup failed for order #${orderId}: ${cleanupErr.message}`);
    }

    checker.stop();
    logger.info('Debug expiry check finished');
    process.exit(0);
  }, 6000);
}

main().catch((err) => {
  logger.error(err.message);
  process.exit(1);
});
