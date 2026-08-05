import assert from 'node:assert/strict';
import test from 'node:test';
import { getClient, query } from '../src/db.js';
import * as writeDao from '../src/dao/write.js';

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
}
