import { getClient } from '../db.js';

export async function createOrderAndReserveAccount({
  funpayOrderId,
  buyer,
  accountId,
  price,
  endsAt,
  orderStatus = 'new'
}) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `INSERT INTO orders (funpay_order_id, buyer, account_id, price, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [funpayOrderId, buyer, accountId, price, orderStatus]
    );
    const order = orderRes.rows[0];

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
      [accountId, buyer, order.id, endsAt]
    );

    await client.query(
      `UPDATE accounts
       SET status = 'rented'
       WHERE id = $1`,
      [accountId]
    );

    await client.query('COMMIT');

    return {
      order,
      rental: rentalRes.rows[0]
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}