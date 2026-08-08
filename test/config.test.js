import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = 'postgresql://user:password@localhost:5432/test';
process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
process.env.FUNPAY_GOLDEN_KEY = 'test-key';

const { getChatPollIntervalMs } = await import('../src/funpay/chatPoller.js');
const { getExpiryCheckIntervalMs } = await import('../src/funpay/rentalExpiry.js');
const { getRentalDurationHours } = await import('../src/funpay/handlers/orderHandler.js');

test('rejects unsafe runtime intervals and durations', () => {
  assert.throws(() => getChatPollIntervalMs('1000'), /FUNPAY_CHAT_POLL_MS/);
  assert.throws(() => getExpiryCheckIntervalMs('invalid'), /RENTAL_EXPIRY_CHECK_MS/);
  assert.throws(() => getRentalDurationHours('0'), /RENTAL_DURATION_HOURS/);
  assert.equal(getRentalDurationHours('1.5'), 1.5);
});

test('multiplies rental duration by lot count', () => {
  assert.equal(getRentalDurationHours('1') * 2, 2);
  assert.equal(getRentalDurationHours('2') * 3, 6);
});
