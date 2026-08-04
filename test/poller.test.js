import assert from 'node:assert/strict';
import test from 'node:test';

process.env.FUNPAY_GOLDEN_KEY = 'test-key';
const { createFunpayPoller } = await import('../src/funpay/poller.js');

test('retries unprocessed orders and remembers successful ones', async () => {
  const orders = [{ funpayOrderId: 'retry-me' }];
  let calls = 0;
  const poller = createFunpayPoller({
    client: { getNewOrders: async () => orders },
    onNewOrders: async () => {
      calls += 1;
      return calls < 3 ? [] : ['retry-me'];
    },
    logger: { info() {}, error() {} },
  });

  await poller.pollOnce();
  await poller.pollOnce();
  await poller.pollOnce();
  await poller.pollOnce();

  assert.equal(calls, 3);
});
