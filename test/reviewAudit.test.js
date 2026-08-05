import assert from 'node:assert/strict';
import test from 'node:test';
import * as writeDao from '../src/dao/write.js';
import { getClient } from '../src/db.js';

if (!process.env.DATABASE_URL) {
  test('skip reviewAudit tests without DATABASE_URL', () => {});
} else {
  test('verifyReviewAndGrantBonus writes review audit and is idempotent', async () => {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const order = await writeDao.createOrder({ funpayOrderId: 'AUDIT-ORDER-1', buyer: 'audit-user', price: 1, status: 'paid' });
      const account = await writeDao.addAccount({ title: 'audit test', login: 'a', password: 'p', notes: null });
      const nowRes = await client.query('SELECT NOW() as now');
      const endsAt = new Date(Date.parse(nowRes.rows[0].now) + 60 * 60 * 1000);
      const rentalRes = await client.query(
        `INSERT INTO rentals (account_id, buyer, order_id, ends_at, node_id, status, state)
         VALUES ($1,$2,$3,$4,$5,'active','active') RETURNING id, ends_at`,
        [account.id, order.buyer, order.id, endsAt, null]
      );
      const review = await writeDao.createReview({ orderId: order.id, userId: 'audit-user', platform: 'funpay', rating: 5, text: 'audit test', link: '' });
      await client.query('COMMIT');

      const first = await writeDao.verifyReviewAndGrantBonus(review.id, 'admin-audit');
      assert.equal(first.reviewId, review.id);
      assert.equal(first.alreadyVerified, undefined);

      const second = await writeDao.verifyReviewAndGrantBonus(review.id, 'admin-audit');
      assert.equal(second.reviewId, review.id);
      assert.equal(second.alreadyVerified, true);

      const auditRows = await client.query(`SELECT action, performed_by FROM review_audits WHERE review_id = $1`, [review.id]);
      assert(auditRows.rows.length >= 1, 'expected audit rows');
      assert.equal(auditRows.rows[0].action, 'verify');
      assert.equal(auditRows.rows[0].performed_by, 'admin-audit');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('rejectReview writes reject audit', async () => {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const order = await writeDao.createOrder({ funpayOrderId: 'AUDIT-ORDER-2', buyer: 'audit-user', price: 1, status: 'paid' });
      const review = await writeDao.createReview({ orderId: order.id, userId: 'audit-user', platform: 'funpay', rating: 2, text: 'reject test', link: '' });
      await client.query('COMMIT');

      const result = await writeDao.rejectReview(review.id, 'admin-reject', 'bad review');
      assert.equal(result.reviewId, review.id);
      assert.equal(result.rejected, true);

      const auditRows = await client.query(`SELECT action, performed_by, details FROM review_audits WHERE review_id = $1`, [review.id]);
      assert.equal(auditRows.rows.length, 1);
      assert.equal(auditRows.rows[0].action, 'reject');
      assert.equal(auditRows.rows[0].performed_by, 'admin-reject');
      assert.ok(auditRows.rows[0].details.includes('bad review'));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
}
