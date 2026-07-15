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

export async function createOrder({ funpayOrderId, buyer, accountId = null, price, status = 'new' }) {
  const res = await query(
    `INSERT INTO orders (funpay_order_id, buyer, account_id, price, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [funpayOrderId, buyer, accountId, price, status]
  );
  return res.rows[0];
}

export async function reserveAccount({ accountId, buyer, endsAt, orderId = null }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const accountRes = await client.query(
      `SELECT status
       FROM accounts
       WHERE id = $1
       FOR UPDATE`,
      [accountId]
    );

    if (!accountRes.rows.length) {
      throw new Error('Account not found');
    }

    const account = accountRes.rows[0];
    if (account.status !== 'available') {
      throw new Error(`Account is not available: ${account.status}`);
    }

    const rentalRes = await client.query(
      `INSERT INTO rentals (account_id, buyer, order_id, ends_at, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [accountId, buyer, orderId, endsAt]
    );

    await client.query(
      `UPDATE accounts
       SET status = 'rented'
       WHERE id = $1`,
      [accountId]
    );

    await client.query('COMMIT');
    return rentalRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
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