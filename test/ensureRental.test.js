import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';

// provide a test encryption key if not present
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
}

import { addAccount, createOrder, ensureRental } from '../src/dao/write.js';
import { query } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  test.skip('ensureRental selects account by title (skipped) - DATABASE_URL not set', () => {});
} else {
  test('ensureRental selects account by title', async () => {
  const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const matchingTitle = `Dota pro ${marker}`;
  const otherTitle = `Other ${marker}`;

  const acc1 = await addAccount({ title: matchingTitle, login: `l1-${marker}`, password: 'p1' });
  const acc2 = await addAccount({ title: otherTitle, login: `l2-${marker}`, password: 'p2' });

  const order = await createOrder({ funpayOrderId: `FT-${marker}`, buyer: 'buyer1', price: 1, status: 'paid' });

  const endsAt = new Date(Date.now() + 60 * 60 * 1000);

  const reservation = await ensureRental({ buyer: 'buyer1', endsAt, orderId: order.id, nodeId: 1, desiredTitle: 'Dota pro' });

  assert(reservation && reservation.account, 'reservation not created');
  assert.equal(reservation.account.id, acc1.id, 'did not pick expected account by title');

  // cleanup
  await query('UPDATE accounts SET status = $1 WHERE id = ANY($2)', ['available', [acc1.id, acc2.id]]);
  await query('DELETE FROM rentals WHERE order_id = $1', [order.id]);
  await query('DELETE FROM orders WHERE id = $1', [order.id]);
  await query('DELETE FROM accounts WHERE id = ANY($1)', [[acc1.id, acc2.id]]);
  });
}
