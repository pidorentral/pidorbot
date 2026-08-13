import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createCleanupAgentClient,
  getCleanupAgentConfig,
} = await import('../src/rentals/cleanupAgentClient.js');
const {
  getCleanupRetryDelayMs,
  getRentalRenewalGraceMs,
} = await import('../src/funpay/rentalExpiry.js');

test('cleanup agent stays disabled without VM configuration', async () => {
  const config = getCleanupAgentConfig({});
  assert.equal(config.enabled, false);

  const result = await createCleanupAgentClient({ config }).cleanupRental({ rentalId: 12, accountId: 34, attempt: 1 });
  assert.deepEqual(result, { ok: false, reason: 'not-configured', retryable: false });
});

test('cleanup agent sends only rental metadata to a private VM endpoint', async () => {
  const calls = [];
  const client = createCleanupAgentClient({
    config: {
      enabled: true,
      baseUrl: 'https://vm-controller.internal',
      token: 'test-token',
      timeoutMs: 1_000,
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, stoppedSessions: 1 }), { status: 200 });
    },
  });

  const result = await client.cleanupRental({ rentalId: 12, accountId: 34, attempt: 2 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://vm-controller.internal/v1/rentals/12/cleanup');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { rentalId: 12, accountId: 34, attempt: 2 });
  assert.doesNotMatch(calls[0].options.body, /password|secret|mafile/i);
});

test('cleanup retry backoff is capped and the renewal grace may be disabled explicitly', () => {
  assert.equal(getCleanupRetryDelayMs(1, { initialMs: 1_000, maxMs: 10_000 }), 1_000);
  assert.equal(getCleanupRetryDelayMs(5, { initialMs: 1_000, maxMs: 10_000 }), 10_000);
  assert.equal(getRentalRenewalGraceMs('0'), 0);
});
