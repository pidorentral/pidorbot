import assert from 'node:assert/strict';
import test from 'node:test';
import * as writeDao from '../src/dao/write.js';
import * as readDao from '../src/dao/read.js';
import { autoVerifyReviewById } from '../src/reviewVerifier.js';

if (!process.env.DATABASE_URL) {
  test('skip reviewVerifier tests without DATABASE_URL', () => {});
} else {
  test('autoVerifyReviewById detects review text on FunPay page', async () => {
    // create a minimal order
    const order = await writeDao.createOrder({ funpayOrderId: 'RV-TEST-1', buyer: 'bob', price: 1, status: 'paid' });

    // create a review linked to the order
    const review = await writeDao.createReview({ orderId: order.id, userId: 'bob', platform: 'funpay', rating: 5, text: 'Great service, bob!', link: '' });

    // mock global fetch to return an HTML containing the review text
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, text: async () => `<html><body><div>${review.text}</div><div>${order.buyer}</div></body></html>` });

    try {
      const result = await autoVerifyReviewById(review);
      assert(result.confidence >= 0.9, `expected high confidence, got ${result.confidence}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
