import 'dotenv/config';
import { query, transaction, close } from '../src/db.js';
import { encrypt } from '../src/crypto.js';

async function main() {
  const result = await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, raw_json AS "rawJson"
       FROM mafiles
       WHERE raw_json IS NOT NULL
       FOR UPDATE`
    );

    let migrated = 0;
    for (const row of rows) {
      if (typeof row.rawJson === 'string') continue;

      const encryptedPayload = JSON.stringify(encrypt(JSON.stringify(row.rawJson)));
      await client.query(
        `UPDATE mafiles
         SET raw_json = $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [encryptedPayload, row.id]
      );
      migrated += 1;
    }

    return { migrated, skipped: rows.length - migrated };
  });

  console.log(`Migrated ${result.migrated} mafile payload(s); skipped ${result.skipped}.`);
}

main()
  .catch((error) => {
    console.error(`Mafile payload migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(close);
