import assert from 'node:assert/strict';
import test from 'node:test';
import { FunpayClient } from '../src/funpay/client.js';

test('keeps default headers when request-specific headers are provided', async () => {
  let options;
  const client = new FunpayClient({
    goldenKey: 'test-key',
    fetchImpl: async (_url, requestOptions) => {
      options = requestOptions;
      return new Response('ok', { status: 200 });
    },
  });

  await client.request('health', { headers: { 'X-Test': 'present' } });

  assert.equal(options.headers['X-Test'], 'present');
  assert.match(options.headers.Cookie, /golden_key=test-key/);
  assert.ok(options.headers['User-Agent']);
});
