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

test('refreshes CSRF token from fresh app data on each request', async () => {
  let callCount = 0;
  const client = new FunpayClient({
    goldenKey: 'test-key',
    fetchImpl: async () => {
      callCount += 1;
      const token = callCount === 1 ? 'token-1' : 'token-2';
      return new Response(`<html><body><script data-app-data='{"csrf-token":"${token}","userId":1,"username":"buyer"}'></script></body></html>`, { status: 200 });
    },
  });

  const firstToken = await client.getCsrfToken();
  const secondToken = await client.getCsrfToken();

  assert.equal(firstToken, 'token-1');
  assert.equal(secondToken, 'token-2');
  assert.equal(callCount, 2);
});

test('uses configured User-Agent and proxy metadata for requests', async () => {
  let options;
  const client = new FunpayClient({
    goldenKey: 'test-key',
    userAgent: 'Custom UA/1.0',
    proxyUrl: 'http://proxy.internal:8080',
    fetchImpl: async (_url, requestOptions) => {
      options = requestOptions;
      return new Response('ok', { status: 200 });
    },
  });

  await client.request('health');

  assert.equal(client.userAgent, 'Custom UA/1.0');
  assert.equal(options.headers['User-Agent'], 'Custom UA/1.0');
  assert.equal(options.proxy, 'http://proxy.internal:8080');
});

test('throws a dedicated rate-limit error on FunPay 429 responses', async () => {
  const client = new FunpayClient({
    goldenKey: 'test-key',
    fetchImpl: async () => new Response('<html><body>429 Too Many Requests</body></html>', { status: 429 }),
  });

  await assert.rejects(
    () => client.request('health'),
    (error) => error.name === 'FunpayRateLimitError' && /429/.test(error.message),
    'Should convert 429 into a rate-limit error',
  );
});
