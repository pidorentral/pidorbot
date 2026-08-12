import { query, getClient } from '../db.js';
import * as crypto from '../crypto.js';
import { getAccountById } from '../dao/read.js';
import { changeSteamPassword, logoutSteamSession } from '../steam/sessionManager.js';
import { generatePassword } from './utils.js';

const DEFAULT_CHECK_INTERVAL_MS = 30_000;

export function getExpiryCheckIntervalMs(value = process.env.RENTAL_EXPIRY_CHECK_MS) {
  const interval = Number.parseInt(value || `${DEFAULT_CHECK_INTERVAL_MS}`, 10);
  if (!Number.isSafeInteger(interval) || interval < 2_000) {
    throw new Error('RENTAL_EXPIRY_CHECK_MS must be an integer of at least 2000');
  }
  return interval;
}

export function createExpiryChecker({
  client,
  notifyAdmin,
  logger = console,
  intervalMs = getExpiryCheckIntervalMs(),
} = {}) {
  let timer = null;

  async function checkOnce() {
    // Найти все аренды где ends_at < now и статус active
    const res = await query(
      `SELECT r.id, r.account_id AS "accountId", r.buyer, r.node_id AS "nodeId",
              a.title, a.login
       FROM rentals r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.status = 'active' AND r.ends_at <= NOW()`
    );

    if (res.rows.length === 0) return;

    logger.info(`Expiry checker: ${res.rows.length} rental(s) to complete`);

    for (const rental of res.rows) {
      try {
        await expireRental(rental, { client, notifyAdmin, logger });
      } catch (err) {
        logger.error(`Failed to expire rental #${rental.id}: ${err.message}`);
      }
    }
  }

  function start() {
    if (timer) return;
    logger.info(`Rental expiry checker started (interval: ${intervalMs}ms)`);
    void checkOnce().catch((e) => logger.error(`Expiry check error: ${e.message}`));
    timer = setInterval(() => {
      void checkOnce().catch((e) => logger.error(`Expiry check error: ${e.message}`));
    }, intervalMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { checkOnce, start, stop };
}

async function expireRental(rental, { client, notifyAdmin, logger }) {
  const dbClient = await getClient();

  try {
    await dbClient.query('BEGIN');

    const accountBeforeReset = await getAccountById(rental.accountId, { includeSecrets: true });

    // 1. Завершить аренду
    const expiredRental = await dbClient.query(
      `UPDATE rentals
       SET status = 'ended', state = 'completed'
       WHERE id = $1
         AND status = 'active'
         AND ends_at <= NOW()
       RETURNING id, account_id AS "accountId"`,
      [rental.id]
    );

    if (!expiredRental.rows.length) {
      await dbClient.query('COMMIT');
      return false;
    }

    // 2. Сгенерировать новый пароль и обновить аккаунт
    const newPassword = generatePassword();
    const encrypted = crypto.encrypt(newPassword);

    await dbClient.query(
      `UPDATE accounts SET password = $1, status = 'available' WHERE id = $2`,
      [encrypted, rental.accountId]
    );

    await dbClient.query('COMMIT');

    logger.info(`Rental #${rental.id} expired. Account #${rental.accountId} password changed, status → available`);

    if (accountBeforeReset) {
      const steamPasswordResult = await changeSteamPassword(
        {
          ...accountBeforeReset,
          password: accountBeforeReset.password,
        },
        { newPassword, logger, notifyAdmin }
      );

      if (!steamPasswordResult.ok) {
        logger.warn(
          `Steam password change not completed for account #${rental.accountId} (reason: ${steamPasswordResult.reason})`
        );
      } else {
        logger.info(`Steam password change completed for account #${rental.accountId}`);
      }

      const steamLogoutResult = await logoutSteamSession(
        {
          ...accountBeforeReset,
          password: newPassword,
        },
        { logger, notifyAdmin }
      );

      if (!steamLogoutResult.ok) {
        logger.warn(
          `Steam session logout not completed for account #${rental.accountId} (reason: ${steamLogoutResult.reason})`
        );
      } else {
        logger.info(`Steam session logout completed for account #${rental.accountId}`);
      }
    }

    // 3. Уведомить покупателя в чате FunPay
    if (rental.nodeId && client) {
      try {
        await client.sendMessage(rental.nodeId, [
          `⏰ Время аренды истекло.`,
          ``,
          `Аккаунт "${rental.title}" больше недоступен.`,
          `Спасибо за использование! Если нужен ещё, оформите новый заказ.`,
        ].join('\n'));
      } catch (err) {
        logger.error(`Failed to notify buyer ${rental.buyer}: ${err.message}`);
      }
    }

    // 4. Уведомить админа
    if (notifyAdmin) {
      await notifyAdmin(
        `🔒 Аренда #${rental.id} завершена\n` +
        `Аккаунт: #${rental.accountId} (${rental.login})\n` +
        `Покупатель: ${rental.buyer}\n` +
        `Новый пароль: ${newPassword}`
      );
    }
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
}
