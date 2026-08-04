import { getClient, query } from '../db.js';
import * as crypto from '../crypto.js';

export async function addAccount({ title, login, password, notes = null, mmr = null }) {
  const encryptedPassword = crypto.encrypt(password);

  const res = await query(
    `INSERT INTO accounts (title, login, password, notes, mmr, status)
     VALUES ($1, $2, $3, $4, $5, 'available')
     RETURNING id, title, login, status, steam_id, mafile_id, notes, mmr, created_at`,
    [title, login, encryptedPassword, notes, mmr]
  );

  return res.rows[0];
}

export async function attachMafileToAccount(accountId, { sharedSecret, identitySecret = null, rawJson }) {
  const encryptedShared = crypto.encrypt(sharedSecret);
  const encryptedIdentity = identitySecret ? crypto.encrypt(identitySecret) : null;
  const encryptedRawJson = rawJson == null
    ? null
    : JSON.stringify(crypto.encrypt(JSON.stringify(rawJson)));

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const insertMafile = await client.query(
      `INSERT INTO mafiles (account_id, shared_secret, identity_secret, raw_json)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id)
       DO UPDATE SET shared_secret = EXCLUDED.shared_secret,
                     identity_secret = EXCLUDED.identity_secret,
                     raw_json = EXCLUDED.raw_json,
                     updated_at = NOW()
       RETURNING id`,
      [accountId, encryptedShared, encryptedIdentity, encryptedRawJson]
    );

    const mafileId = insertMafile.rows[0].id;
    await client.query(
      `UPDATE accounts
       SET mafile_id = $1
       WHERE id = $2`,
      [mafileId, accountId]
    );

    await client.query('COMMIT');
    return { accountId, mafileId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function parseMmrFromText(text = '') {
  const normalized = String(text || '').toLowerCase().replace(/\u00A0/g, ' ');
  const match = normalized.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*(k|к)?\b/);
  if (!match) return null;

  let value = match[1].replace(/\s+/g, '').replace(',', '.');
  let mmr = Number(value);
  if (!Number.isFinite(mmr)) return null;

  if (match[2]) {
    mmr = Math.round(mmr * 1000);
  }

  return Math.round(mmr);
}

function findAccountByMmr(accounts, desiredMmr) {
  if (!desiredMmr) {
    return accounts[0] || null;
  }

  return accounts.find((account) => {
    if (account.mmr === desiredMmr) {
      return true;
    }
    const titleMmr = parseMmrFromText(account.title);
    if (titleMmr === desiredMmr) return true;
    const notesMmr = parseMmrFromText(account.notes);
    return notesMmr === desiredMmr;
  }) || null;
}

export async function createOrder({
  funpayOrderId,
  buyer,
  accountId = null,
  price,
  status = 'new',
  desiredMmr = null
}) {
  const res = await query(
    `INSERT INTO orders (funpay_order_id, buyer, account_id, price, status, desired_mmr)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [funpayOrderId, buyer, accountId, price, status, desiredMmr]
  );

  return res.rows[0];
}

export async function ensureRental({
  buyer,
  endsAt,
  orderId,
  nodeId,
  desiredMmr
}) {
  const client = await getClient();

  try {
    await client.query("BEGIN");

    // Проверяем, не создана ли уже аренда
    const existingRental = await client.query(
      `SELECT
          r.*,
          a.id AS account_id
       FROM rentals r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.order_id = $1
       FOR UPDATE`,
      [orderId]
    );

    if (existingRental.rows.length) {
      const rental = existingRental.rows[0];

      await client.query("COMMIT");

      return {
        rental,
        account: {
          id: rental.account_id
        }
      };
    }

    // Ищем свободный аккаунт
    const queryText = desiredMmr
      ? `SELECT *
         FROM accounts
         WHERE status = 'available'
           AND (mmr = $1 OR mmr IS NULL)
         ORDER BY id
         LIMIT 200
         FOR UPDATE SKIP LOCKED`
      : `SELECT *
         FROM accounts
         WHERE status = 'available'
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`;

    const accountRes = await client.query(queryText, desiredMmr ? [desiredMmr] : []);

    if (!accountRes.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    const account = findAccountByMmr(accountRes.rows, desiredMmr);
    if (!account) {
      await client.query("ROLLBACK");
      return null;
    }

    // Создаём аренду
    const rentalRes = await client.query(
      `INSERT INTO rentals (
          account_id,
          buyer,
          order_id,
          ends_at,
          node_id,
          status,
          state
      )
      VALUES ($1,$2,$3,$4,$5,'active','active')
      RETURNING *`,
      [
        account.id,
        buyer,
        orderId,
        endsAt,
        nodeId
      ]
    );

    // Помечаем заказ привязанным аккаунтом
    await client.query(
      `UPDATE orders
       SET account_id = $1
       WHERE id = $2`,
      [account.id, orderId]
    );

    // Помечаем аккаунт занятым
    await client.query(
      `UPDATE accounts
       SET status = 'rented'
       WHERE id = $1`,
      [account.id]
    );

    await client.query("COMMIT");

    return {
      account,
      rental: rentalRes.rows[0]
    };

  } catch (err) {

    await client.query("ROLLBACK");
    throw err;

  } finally {

    client.release();

  }
}

export async function completeRental(rentalId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const rentalRes = await client.query(
      `SELECT account_id, status
       FROM rentals
       WHERE id = $1
       FOR UPDATE`,
      [rentalId]
    );

    if (!rentalRes.rows.length) {
      throw new Error('Rental not found');
    }

    const rental = rentalRes.rows[0];
    if (rental.status !== 'active') {
      throw new Error('Rental is not active');
    }

    await client.query(
      `UPDATE rentals
       SET status = 'ended'
       WHERE id = $1`,
      [rentalId]
    );

    await client.query(
      `UPDATE accounts
       SET status = 'available'
       WHERE id = $1`,
      [rental.account_id]
    );

    await client.query('COMMIT');
    return { rentalId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function cancelRental(rentalId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const rentalRes = await client.query(
      `SELECT account_id, status
       FROM rentals
       WHERE id = $1
       FOR UPDATE`,
      [rentalId]
    );

    if (!rentalRes.rows.length) {
      throw new Error('Rental not found');
    }

    const rental = rentalRes.rows[0];
    if (rental.status !== 'active') {
      throw new Error('Rental is not active');
    }

    await client.query(
      `UPDATE rentals
       SET status = 'cancelled'
       WHERE id = $1`,
      [rentalId]
    );

    await client.query(
      `UPDATE accounts
       SET status = 'available'
       WHERE id = $1`,
      [rental.account_id]
    );

    await client.query('COMMIT');
    return { rentalId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function setAccountStatus(accountId, status) {
  const res = await query(
    `UPDATE accounts SET status = $1 WHERE id = $2 RETURNING id, status`,
    [status, accountId]
  );
  return res.rows[0] || null;
}

export async function deleteAccount(accountId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // remove mafile if exists (ON DELETE CASCADE on mafiles.account_id? we use cascade in schema)
    await client.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
    await client.query('COMMIT');
    return { id: accountId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateAccount(accountId, updates = {}) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.title !== undefined) {
    fields.push(`title = $${idx++}`);
    values.push(updates.title);
  }
  if (updates.login !== undefined) {
    fields.push(`login = $${idx++}`);
    values.push(updates.login);
  }
  if (updates.password !== undefined) {
    // encrypt password before storing
    const encrypted = crypto.encrypt(updates.password);
    fields.push(`password = $${idx++}`);
    values.push(encrypted);
  }
  if (updates.notes !== undefined) {
    fields.push(`notes = $${idx++}`);
    values.push(updates.notes);
  }
  if (updates.mmr !== undefined) {
    fields.push(`mmr = $${idx++}`);
    values.push(updates.mmr);
  }

  if (fields.length === 0) {
    const res = await query(`SELECT id, title, login, status, steam_id, notes FROM accounts WHERE id = $1`, [accountId]);
    return res.rows[0] || null;
  }

  values.push(accountId);
  const sql = `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, title, login, status, steam_id AS "steamId", notes, mmr`;
  const res = await query(sql, values);
  return res.rows[0] || null;
}

export async function consumeCodeAllowance(rentalId, maxCodes) {
  const res = await query(
    `UPDATE rentals
     SET code_count = code_count + 1,
         state = CASE WHEN code_count + 1 >= $2 THEN 'locked' ELSE state END
     WHERE id = $1
       AND status = 'active'
       AND state = 'active'
       AND ends_at > NOW()
       AND code_count < $2
     RETURNING code_count AS "codeCount", state`,
    [rentalId, maxCodes]
  );

  return res.rows[0] || null;
}

export async function updateOrder(orderId, updates = {}) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${idx++}`);
    values.push(updates.status);
  }

  if (updates.accountId !== undefined) {
    fields.push(`account_id = $${idx++}`);
    values.push(updates.accountId);
  }

  if (updates.price !== undefined) {
    fields.push(`price = $${idx++}`);
    values.push(updates.price);
  }

  if (fields.length === 0) {
    throw new Error('No fields to update');
  }

  values.push(orderId);

  const res = await query(
    `UPDATE orders
     SET ${fields.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values
  );

  return res.rows[0] || null;
}

// export async function reserveAvailableAccount() {
//   const client = await getClient();

//   try {
//     await client.query('BEGIN');

//     const accountRes = await client.query(
//       `SELECT *
//        FROM accounts
//        WHERE status = 'available'
//        ORDER BY id
//        LIMIT 1
//        FOR UPDATE SKIP LOCKED`
//     );

//     if (!accountRes.rows.length) {
//       await client.query('ROLLBACK');
//       return null;
//     }

//     const account = accountRes.rows[0];

//     await client.query(
//       `UPDATE accounts
//        SET status = 'reserved'
//        WHERE id = $1`,
//       [account.id]
//     );

//     await client.query('COMMIT');

//     return account;

//   } catch (err) {

//     await client.query('ROLLBACK');
//     throw err;

//   } finally {

//     client.release();

//   }
// }
