import { query, getClient } from '../db.js';
import * as crypto from '../crypto.js';
import { generatePassword } from './utils.js';

const CHECK_INTERVAL_MS = Number(process.env.RENTAL_EXPIRY_CHECK_MS) || 30_000;

export function createExpiryChecker({ client, notifyAdmin, logger = console } = {}) {
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
    logger.info(`Rental expiry checker started (interval: ${CHECK_INTERVAL_MS}ms)`);
    void checkOnce().catch((e) => logger.error(`Expiry check error: ${e.message}`));
    timer = setInterval(() => {
      void checkOnce().catch((e) => logger.error(`Expiry check error: ${e.message}`));
    }, CHECK_INTERVAL_MS);
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

    // 1. Завершить аренду
    await dbClient.query(
      `UPDATE rentals SET status = 'ended', state = 'completed' WHERE id = $1`,
      [rental.id]
    );

    // 2. Сгенерировать новый пароль и обновить аккаунт
    const newPassword = generatePassword();
    const encrypted = crypto.encrypt(newPassword);

    await dbClient.query(
      `UPDATE accounts SET password = $1, status = 'available' WHERE id = $2`,
      [encrypted, rental.accountId]
    );

    await dbClient.query('COMMIT');

    logger.info(`Rental #${rental.id} expired. Account #${rental.accountId} password changed, status → available`);

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