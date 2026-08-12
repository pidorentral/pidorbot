import { query } from '../src/db.js';
import * as crypto from '../src/crypto.js';

function normalizeSteamId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const numeric = BigInt(raw);
  const candidate = numeric - 8n;
  const minimumSteamId = 76561197960265728n;

  if (
    numeric >= minimumSteamId &&
    numeric % 10n === 0n &&
    candidate >= minimumSteamId &&
    candidate % 10n === 2n
  ) {
    return candidate.toString();
  }

  return numeric.toString();
}

async function main() {
  const rows = await query(`
    SELECT m.id, m.account_id AS "accountId", m.raw_json AS "rawJson"
    FROM mafiles m
    WHERE m.raw_json IS NOT NULL
    ORDER BY m.id ASC
  `);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows.rows) {
    try {
      const decrypted = crypto.decrypt(row.rawJson);
      const parsed = JSON.parse(decrypted);
      const steamId = normalizeSteamId(parsed?.steamid ?? parsed?.steam_id ?? parsed?.Session?.SteamID ?? parsed?.session?.SteamID ?? null);

      if (!steamId) {
        skipped += 1;
        continue;
      }

      await query(
        `UPDATE accounts
         SET steam_id = $1
         WHERE id = $2
           AND (steam_id IS NULL OR steam_id = '')`,
        [steamId, row.accountId]
      );

      updated += 1;
    } catch (err) {
      failed += 1;
      console.warn(`Failed mafile #${row.id} / account #${row.accountId}: ${err.message}`);
    }
  }

  console.log(JSON.stringify({ updated, skipped, failed }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
