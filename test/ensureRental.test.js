import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';

// provide a test encryption key if not present
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
}

import { addAccount, bindAccountOffer, createOrder, ensureRental } from '../src/dao/write.js';
import { query } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  test.skip('ensureRental selects account by offer ID (skipped) - DATABASE_URL not set', () => {});
} else {
  test('ensureRental selects account by offer ID', async () => {
  const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const matchingTitle = `Dota pro ${marker}`;
  const otherTitle = `Other ${marker}`;

  let acc1;
  let acc2;
  let order;

  try {
    acc1 = await addAccount({ title: matchingTitle, login: `l1-${marker}`, password: 'p1' });
    acc2 = await addAccount({ title: otherTitle, login: `l2-${marker}`, password: 'p2' });
    await bindAccountOffer(acc1.id, `offer-${marker}`, 1);

    order = await createOrder({ funpayOrderId: `FT-${marker}`, buyer: 'buyer1', price: 1, status: 'paid' });

    const reservation = await ensureRental({ buyer: 'buyer1', orderId: order.id, nodeId: 1, offerId: `offer-${marker}`, quantity: 2 });

    assert(reservation && reservation.account, 'reservation not created');
    assert.equal(reservation.account.id, acc1.id, 'did not pick account bound to offer');
    assert.equal(reservation.rentalHours, 2);
  } finally {
    if (acc1 || acc2) {
      await query('UPDATE accounts SET status = $1 WHERE id = ANY($2)', ['available', [acc1?.id, acc2?.id].filter(Boolean)]);
    }
    if (order) {
      await query('DELETE FROM rentals WHERE order_id = $1', [order.id]);
      await query('DELETE FROM orders WHERE id = $1', [order.id]);
    }
    if (acc1 || acc2) {
      await query('DELETE FROM accounts WHERE id = ANY($1)', [[acc1?.id, acc2?.id].filter(Boolean)]);
    }
  }
  });
}
