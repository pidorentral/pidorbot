import { query } from '../db.js';
import * as crypto from '../crypto.js';

export async function listAccounts({ status = null, limit = 50, offset = 0 } = {}) {
  const res = await query(
    `
    SELECT id, title, login, status, steam_id AS "steamId", mafile_id AS "mafileId", notes, created_at AS "createdAt"
    FROM accounts
    WHERE ($1::text IS NULL OR status = $1)
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
    `,
    [status, limit, offset]
  );
  return res.rows;
}

export async function findAvailableAccount() {
  const res = await query(
    `
    SELECT id, title, login, status, steam_id AS "steamId", mafile_id AS "mafileId", notes, created_at AS "createdAt"
    FROM accounts
    WHERE status = 'available'
    ORDER BY created_at ASC
    LIMIT 1
    `
  );
  return res.rows[0] || null;
}

export async function getOrderByFunpayId(funpayOrderId) {
  const res = await query(
    `
    SELECT id, funpay_order_id AS "funpayOrderId", buyer, account_id AS "accountId", status, price, created_at AS "createdAt"
    FROM orders
    WHERE funpay_order_id = $1
    LIMIT 1
    `,
    [funpayOrderId]
  );
  return res.rows[0] || null;
}

export async function getAccountById(id, { includeSecrets = false } = {}) {
  const res = await query(
    `
        SELECT a.id, a.title, a.login, a.status, a.steam_id AS "steamId", a.mafile_id AS "mafileId", a.notes, a.created_at AS "createdAt", a.password,
          m.shared_secret, m.identity_secret, m.raw_json AS "rawJson"
    FROM accounts a
    LEFT JOIN mafiles m ON m.id = a.mafile_id
    WHERE a.id = $1
    `,
    [id]
  );

  const row = res.rows[0] || null;
  if (!row) return null;

  if (includeSecrets) {
    if (row.shared_secret) {
      try {
        row.sharedSecret = crypto.decrypt(row.shared_secret);
      } catch {
        row.sharedSecret = null;
      }
    }

    if (row.identity_secret) {
      try {
        row.identitySecret = crypto.decrypt(row.identity_secret);
      } catch {
        row.identitySecret = null;
      }
    }

    // decrypt password if present
    if (row.password) {
      try {
        row.password = crypto.decrypt(row.password);
      } catch {
        row.password = null;
      }
    }
  }

  // remove raw encrypted fields
  delete row.shared_secret;
  delete row.identity_secret;
  return row;
}

export async function getActiveRentals() {
  const res = await query(
    `
        SELECT r.id, r.account_id AS "accountId", r.buyer, r.order_id AS "orderId", r.started_at AS "startedAt", r.ends_at AS "endsAt", r.status,
          a.title, a.login
    FROM rentals r
    JOIN accounts a ON a.id = r.account_id
    WHERE r.status = 'active'
    ORDER BY r.ends_at ASC
    `
  );
  return res.rows;
}

export async function getOrders({ status = null, limit = 50, offset = 0 } = {}) {
  const res = await query(
    `
    SELECT id, funpay_order_id AS "funpayOrderId", buyer, account_id AS "accountId", status, price, created_at AS "createdAt"
    FROM orders
    WHERE ($1::text IS NULL OR status = $1)
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
    `,
    [status, limit, offset]
  );
  return res.rows;
}

export async function getStats() {
  const res = await query(
    `
    SELECT
      (SELECT COUNT(*) FROM accounts) AS total_accounts,
      (SELECT COUNT(*) FROM accounts WHERE status = 'available') AS available,
      (SELECT COUNT(*) FROM accounts WHERE status = 'rented') AS rented,
      (SELECT COUNT(*) FROM rentals WHERE status = 'active') AS active_rentals,
      (SELECT COUNT(*) FROM orders WHERE status = 'new') AS new_orders
    `
  );
  const r = res.rows[0];
  return {
    totalAccounts: Number(r.total_accounts),
    available: Number(r.available),
    rented: Number(r.rented),
    activeRentals: Number(r.active_rentals),
    newOrders: Number(r.new_orders),
  };
}