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
  desiredMmr = null,
  lotId = null,
  lotCount = 1,
}) {
  const res = await query(
    `INSERT INTO orders (funpay_order_id, buyer, account_id, price, status, desired_mmr, lot_id, lot_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [funpayOrderId, buyer, accountId, price, status, desiredMmr, lotId, lotCount]
  );

  return res.rows[0];
}

function normalizeTextForMatch(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/[^a-z0-9а-яё\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a = '', b = '') {
  const na = normalizeTextForMatch(a).split(' ').filter(Boolean);
  const nb = normalizeTextForMatch(b).split(' ').filter(Boolean);
  if (!na.length || !nb.length) return 0;
  const aset = new Set(na);
  let common = 0;
  for (const w of nb) if (aset.has(w)) common++;
  // similarity measured as common / words in desired (b)
  return common / nb.length;
}

function findAccountByTitle(accounts, desiredTitle) {
  if (!desiredTitle) return null;
  function normalizeForEquality(text = '') {
    return normalizeTextForMatch(String(text || ''))
      // remove numbers and mmr/k tokens which usually encode strength
      .replace(/\b(\d+|k|к|ммр|mmr)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const desiredEq = normalizeForEquality(desiredTitle);
  if (desiredEq) {
    for (const acc of accounts) {
      const accEq = normalizeForEquality(acc.title || '') || normalizeForEquality(acc.notes || '');
      if (accEq === desiredEq) {
        acc._matchReason = 'exactNormalizedTitle';
        acc._matchScore = 1;
        return acc;
      }
    }
  }
  let best = null;
  let bestScore = 0;
  for (const acc of accounts) {
    const score = (titleSimilarity(acc.title || '', desiredTitle) || titleSimilarity(acc.notes || '', desiredTitle)) || 0;
    if (score > bestScore) {
      bestScore = score;
      best = acc;
    }
  }
  // require reasonable match
  if (best) best._matchScore = bestScore;
  if (best && !best._matchReason) best._matchReason = 'fuzzy';
  if (bestScore >= 0.5) return best;
  return null;
}

export async function ensureRental({
  buyer,
  endsAt,
  orderId,
  nodeId,
  desiredTitle
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


    // Ищем свободные аккаунты (более широкий набор для сравнения по тайтлу)
    const accountRes = await client.query(
      `SELECT *
         FROM accounts
         WHERE status = 'available'
         ORDER BY id
         LIMIT 200
         FOR UPDATE SKIP LOCKED`
    );

    if (!accountRes.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    // Подбор исключительно по тайтлу (если указан), иначе берём первый доступный
    let account = null;
    if (desiredTitle) {
      account = findAccountByTitle(accountRes.rows, desiredTitle);
    } else {
      account = accountRes.rows[0] || null;
    }

    if (!account) {
      await client.query("ROLLBACK");
      return null;
    }

    // Логируем причину выбора аккаунта
    try {
      if (desiredTitle && account._matchScore !== undefined) {
        const reason = account._matchReason ? `reason=${account._matchReason}` : '';
        console.info(`ensureRental: selected account #${account.id} (${account.title}) by title match score=${account._matchScore} ${reason}`);
      } else {
        console.info(`ensureRental: selected account #${account.id} (${account.title}) as first available`);
      }
    } catch (e) {
      // logging must not break flow
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

export async function createReview({ orderId, userId = null, platform = null, rating = null, text = null, link = null }) {
  const res = await query(
    `INSERT INTO reviews (order_id, user_id, platform, rating, text, link_or_screenshot)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [orderId, userId, platform, rating, text, link]
  );
  return res.rows[0];
}

export async function getReviewById(reviewId) {
  const res = await query(`SELECT * FROM reviews WHERE id = $1`, [reviewId]);
  return res.rows[0] || null;
}

export async function verifyReviewAndGrantBonus(reviewId, verifier = 'admin') {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const r = await client.query(`SELECT * FROM reviews WHERE id = $1 FOR UPDATE`, [reviewId]);
    if (!r.rows.length) throw new Error('Review not found');
    const review = r.rows[0];

    if (review.verified_at) {
      // Already verified — idempotent return (no-op)
      return { reviewId, alreadyVerified: true };
    }

    // Ensure no other review for this order was already verified
    const prev = await client.query(`SELECT id FROM reviews WHERE order_id = $1 AND verified_at IS NOT NULL`, [review.order_id]);
    if (prev.rows.length) {
      throw new Error('Bonus already granted for this order');
    }

    // Grant bonus: extend active rental for this order by 1 hour
    const bonusRes = await client.query(
      `UPDATE rentals
       SET ends_at = ends_at + INTERVAL '1 hour'
       WHERE order_id = $1 AND status = 'active'
       RETURNING id, ends_at`,
      [review.order_id]
    );

    // Mark review as verified
    await client.query(
      `UPDATE reviews SET verified_by = $1, verified_at = NOW() WHERE id = $2`,
      [verifier, reviewId]
    );

    // Insert audit row
    await client.query(
      `INSERT INTO review_audits (review_id, action, performed_by, details)
       VALUES ($1, $2, $3, $4)`,
      [reviewId, 'verify', verifier, JSON.stringify({ grantedRentalId: bonusRes.rows[0]?.id || null })]
    );

    await client.query('COMMIT');
    return { reviewId, rental: bonusRes.rows[0] || null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectReview(reviewId, verifier = 'admin', reason = null) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const r = await client.query(`SELECT * FROM reviews WHERE id = $1 FOR UPDATE`, [reviewId]);
    if (!r.rows.length) throw new Error('Review not found');
    const review = r.rows[0];

    if (review.verified_at) {
      return { reviewId, alreadyVerified: true };
    }

    await client.query(
      `UPDATE reviews SET verified_by = $1, verified_at = NOW() WHERE id = $2`,
      [verifier, reviewId]
    );

    await client.query(
      `INSERT INTO review_audits (review_id, action, performed_by, details)
       VALUES ($1, $2, $3, $4)`,
      [reviewId, 'reject', verifier, JSON.stringify({ reason })]
   );

    await client.query('COMMIT');
    return { reviewId, rejected: true };
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
    // Check rentals referencing this account
    const refRes = await client.query(
      `SELECT id, status FROM rentals WHERE account_id = $1`,
      [accountId]
    );

    if (refRes.rows.length) {
      const active = refRes.rows.filter((r) => r.status === 'active');
      if (active.length) {
        await client.query('ROLLBACK');
        const refs = active.map((r) => `#${r.id}(${r.status})`).join(', ');
        throw new Error(`Account is referenced by active rentals: ${refs}`);
      }

      // Only historical/ended rentals reference the account — try to disassociate them.
      // Try to disassociate historical rentals using a SAVEPOINT. If the UPDATE fails
      // (e.g., because account_id is NOT NULL), rollback to the savepoint and delete those rentals.
      await client.query('SAVEPOINT unlink_rentals');
      try {
        await client.query(`UPDATE rentals SET account_id = NULL WHERE account_id = $1`, [accountId]);
        await client.query('RELEASE SAVEPOINT unlink_rentals');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT unlink_rentals');
        await client.query(`DELETE FROM rentals WHERE account_id = $1`, [accountId]);
        await client.query('RELEASE SAVEPOINT unlink_rentals');
      }
    }

    // remove account (no active rentals remain)
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