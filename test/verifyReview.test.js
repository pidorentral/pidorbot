import assert from 'node:assert/strict';
import test from 'node:test';
import { getClient, query } from '../src/db.js';
import * as writeDao from '../src/dao/write.js';
import { handleNewOrders } from '../src/funpay/handlers/orderHandler.js';

if (!process.env.DATABASE_URL) {
  test('skip verifyReview tests without DATABASE_URL', () => {});
} else {
  test('verifyReviewAndGrantBonus extends active rental by 1 hour', async () => {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // create order and account
      const order = await writeDao.createOrder({ funpayOrderId: 'VR-ORDER-1', buyer: 'cli-user', price: 1, status: 'paid' });
      const account = await writeDao.addAccount({ title: 'test acc', login: 'l', password: 'p', notes: null });

      // create active rental linked to order
      const nowRes = await client.query(`SELECT NOW() as now`);
      const now = nowRes.rows[0].now;
      const endsAt = new Date(Date.parse(now) + 60 * 60 * 1000); // +1h

      const rentalInsert = await client.query(
        `INSERT INTO rentals (account_id, buyer, order_id, ends_at, node_id, status, state)
         VALUES ($1,$2,$3,$4,$5,'active','active') RETURNING id, ends_at`,
        [account.id, order.buyer, order.id, endsAt, null]
      );

      const rentalBefore = rentalInsert.rows[0];

      // create review
      const review = await writeDao.createReview({ orderId: order.id, userId: 'cli-user', platform: 'funpay', rating: 5, text: 'Good', link: '' });

      await client.query('COMMIT');

      // call verification (this uses its own transaction)
      const res = await writeDao.verifyReviewAndGrantBonus(review.id, 'admin-test');
      assert(res.reviewId === review.id, 'review id mismatch');

      // check rental ends_at increased by roughly 1 hour
      const r = await query(`SELECT ends_at FROM rentals WHERE id = $1`, [rentalBefore.id]);
      const newEnds = new Date(r.rows[0].ends_at);
      const diffMs = newEnds - new Date(rentalBefore.ends_at);
      // expect ~1 hour (allow small skew)
      assert(diffMs >= 59 * 60 * 1000, `expected at least ~1h extension, got ${diffMs}ms`);
    } finally {
      // cleanup created artifacts (best-effort)
      try {
        await query(`DELETE FROM reviews WHERE funpay_order_id IS NULL AND user_id = 'cli-user'`);
      } catch {}
    }
  });

  test('extendActiveRental extends a live rental by the requested hours', async () => {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const order = await writeDao.createOrder({ funpayOrderId: 'EXTEND-ORDER-1', buyer: 'extend-user', price: 1, status: 'paid' });
      const account = await writeDao.addAccount({ title: 'extend test', login: 'extend-login', password: 'p', notes: null });
      const nowRes = await client.query('SELECT NOW() as now');
      const endsAt = new Date(Date.parse(nowRes.rows[0].now) + 30 * 60 * 1000);

      const rentalInsert = await client.query(
        `INSERT INTO rentals (account_id, buyer, order_id, ends_at, node_id, status, state)
         VALUES ($1, $2, $3, $4, $5, 'active', 'active') RETURNING id, ends_at`,
        [account.id, order.buyer, order.id, endsAt, null]
      );

      await client.query('COMMIT');

      const result = await writeDao.extendActiveRental(rentalInsert.rows[0].id, 2, { reason: 'manual-extend' });
      assert.equal(result.rentalId, rentalInsert.rows[0].id);
      assert.equal(result.hours, 2);

      const refreshed = await query(`SELECT ends_at FROM rentals WHERE id = $1`, [rentalInsert.rows[0].id]);
      const diffMs = new Date(refreshed.rows[0].ends_at) - new Date(rentalInsert.rows[0].ends_at);
      assert(diffMs >= 1.9 * 60 * 60 * 1000, `expected ~2h extension, got ${diffMs}ms`);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('handleNewOrders extends the active rental when the same buyer places additional lots', async () => {
    const client = await getClient();
    const envBefore = process.env.RENTAL_DURATION_HOURS;
    process.env.RENTAL_DURATION_HOURS = '1';

    try {
      await client.query('BEGIN');

      const account = await writeDao.addAccount({ title: 'auto-extend account', login: 'auto-extend-login', password: 'p', notes: null });
      const order = await writeDao.createOrder({ funpayOrderId: 'AUTO-EXTEND-ORDER-1', buyer: 'same-user', price: 1, status: 'paid' });
      const now = new Date();
      const rentalInsert = await client.query(
        `INSERT INTO rentals (account_id, buyer, order_id, ends_at, node_id, status, state)
         VALUES ($1, $2, $3, $4, $5, 'active', 'active') RETURNING id, ends_at`,
        [account.id, 'same-user', order.id, new Date(now.getTime() + 30 * 60 * 1000), 777]
      );

      await client.query('COMMIT');

      const result = await handleNewOrders([
        {
          funpayOrderId: 'AUTO-EXTEND-ORDER-2',
          buyerId: 123,
          buyerUsername: 'same-user',
          price: 1,
          lotId: 99,
          desiredMmr: null,
          lotCount: 2,
          description: 'extra lot',
        },
      ], console, {
        client: {
          getChatNodeId: async () => 777,
          sendMessage: async () => {},
        },
        notifyAdmin: async () => {},
      });

      assert.equal(result.length, 1);

      const updated = await query(`SELECT ends_at, order_id FROM rentals WHERE id = $1`, [rentalInsert.rows[0].id]);
      assert.equal(updated.rows[0].order_id, order.id);
      assert(updated.rows[0].ends_at > rentalInsert.rows[0].ends_at, 'expected extended end time');
    } finally {
      process.env.RENTAL_DURATION_HOURS = envBefore;
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
}
