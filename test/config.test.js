import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = 'postgresql://user:password@localhost:5432/test';
process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');
process.env.FUNPAY_GOLDEN_KEY = 'test-key';

const { getChatPollIntervalMs } = await import('../src/funpay/chatPoller.js');
const { getExpiryCheckIntervalMs } = await import('../src/funpay/rentalExpiry.js');
const { resolveSettingsTable } = await import('../src/funpay/client.js');

test('rejects unsafe runtime intervals', () => {
  assert.throws(() => getChatPollIntervalMs('1000'), /FUNPAY_CHAT_POLL_MS/);
  assert.throws(() => getExpiryCheckIntervalMs('invalid'), /RENTAL_EXPIRY_CHECK_MS/);
});

test('prefers settings table when it already exists', async () => {
  const table = await resolveSettingsTable(async (sql, params) => {
    if (sql.includes('information_schema.tables')) {
      return { rows: [{ table_name: 'settings' }] };
    }
    return { rows: [{ column_name: 'key' }, { column_name: 'value' }, { column_name: 'updated_at' }] };
  });

  assert.equal(table, 'settings');
});
