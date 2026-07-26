import { getClient, query } from '../db.js';
import * as crypto from '../crypto.js';

export async function addAccount({ title, login, password, notes = null }) {
  const encryptedPassword = crypto.encrypt(password);

  const res = await query(
    `INSERT INTO accounts (title, login, password, notes, status)
     VALUES ($1, $2, $3, $4, 'available')
     RETURNING id, title, login, status, steam_id, mafile_id, notes, created_at`,
    [title, login, encryptedPassword, notes]
  );

  return res.rows[0];
}

export async function attachMafileToAccount(accountId, { sharedSecret, identitySecret = null, rawJson }) {
  const encryptedShared = crypto.encrypt(sharedSecret);
  const encryptedIdentity = identitySecret ? crypto.encrypt(identitySecret) : null;

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
      [accountId, encryptedShared, encryptedIdentity, rawJson]
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

export async function createOrder({
  funpayOrderId,
  buyer,
  accountId = null,
  price,
  status = 'new'
}) {

  console.log({
    funpayOrderId,
    buyer,
    accountId,
    price,
    status
  });

  const res = await query(
    `INSERT INTO orders (funpay_order_id, buyer, account_id, price, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [funpayOrderId, buyer, accountId, price, status]
  );

  return res.rows[0];
}

export async function ensureRental({
  buyer,
  endsAt,
  orderId,
  nodeId
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
    const accountRes = await client.query(
      `SELECT *
       FROM accounts
       WHERE status = 'available'
       ORDER BY id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    if (!accountRes.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    const account = accountRes.rows[0];

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

  if (fields.length === 0) {
    const res = await query(`SELECT id, title, login, status, steam_id, notes FROM accounts WHERE id = $1`, [accountId]);
    return res.rows[0] || null;
  }

  values.push(accountId);
  const sql = `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, title, login, status, steam_id AS "steamId", notes`;
  const res = await query(sql, values);
  return res.rows[0] || null;
}

export async function incrementCodeCount(rentalId) {
  await query(`UPDATE rentals SET code_count = code_count + 1 WHERE id = $1`, [rentalId]);
}

export async function setRentalState(rentalId, state) {
  await query(`UPDATE rentals SET state = $1 WHERE id = $2`, [state, rentalId]);
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