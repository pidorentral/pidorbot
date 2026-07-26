import { listAccounts, getAccountById } from '../../dao/read.js';
import { createOrder, reserveAccount } from '../../dao/write.js';
import { generateSteamGuardCode } from '../../../steam/steamGuard.js';

const RENTAL_DURATION_HOURS = Number(process.env.RENTAL_DURATION_HOURS) || 24;

const ALLOWED_LOT_IDS = (process.env.FUNPAY_ALLOWED_LOT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function handleNewOrders(orders, logger, { client, notifyAdmin }) {
  for (const order of orders) {
    try {
      await processOrder(order, { client, logger, notifyAdmin });
    } catch (err) {
      logger.error(`Failed to process order #${order.funpayOrderId}: ${err.message}`);
      if (notifyAdmin) {
        await notifyAdmin(`⚠️ Order #${order.funpayOrderId} failed: ${err.message}`);
      }
    }
  }
}

async function processOrder(order, { client, logger, notifyAdmin }) {
  const { funpayOrderId, buyer, price, lotId } = order;

  // 1. Фильтр по лотам (если настроен)
  if (ALLOWED_LOT_IDS.length > 0 && !ALLOWED_LOT_IDS.includes(String(lotId))) {
    logger.info(`Order #${funpayOrderId} skipped: lot ${lotId} not in allowed list`);
    return;
  }

  // 2. Найти свободный аккаунт
  const accounts = await listAccounts({ status: 'available', limit: 1 });

  if (accounts.length === 0) {
    logger.error(`No available accounts for order #${funpayOrderId}`);
    if (notifyAdmin) {
      await notifyAdmin(`🚨 Нет свободных аккаунтов! Заказ #${funpayOrderId} от ${buyer}`);
    }
    // Сохраняем заказ со статусом pending, обработаем вручную
    await createOrder({ funpayOrderId, buyer, price, status: 'pending_no_account' });
    return;
  }

  const account = accounts[0];

  // 3. Создать заказ в БД
  const dbOrder = await createOrder({
    funpayOrderId,
    buyer,
    accountId: account.id,
    price,
    status: 'fulfilled',
  });

  // 4. Зарезервировать аккаунт + создать аренду
  const endsAt = new Date(Date.now() + RENTAL_DURATION_HOURS * 60 * 60 * 1000);

  const rental = await reserveAccount({
    accountId: account.id,
    buyer,
    endsAt,
    orderId: dbOrder.id,
    nodeId,
  });

  logger.info(`Order #${funpayOrderId}: account #${account.id} reserved for ${buyer} until ${endsAt.toISOString()}`);

  // 5. Получить nodeId чата с покупателем и отправить данные
  const nodeId = await client.getChatNodeId(buyer);

  if (!nodeId) {
    logger.error(`Cannot find chat node for buyer: ${buyer}`);
    if (notifyAdmin) {
      await notifyAdmin(`⚠️ Не нашёл чат с ${buyer}, аккаунт #${account.id} зарезервирован но данные не отправлены`);
    }
    return;
  }

  // 6. Отправить credentials
  const fullAccount = await getAccountById(account.id, { includeSecrets: true });
  const code = generateSteamGuardCode(fullAccount.sharedSecret);

  const message = [
    `✅ Оплата получена! Данные для входа:`,
    ``,
    `Логин: ${fullAccount.login}`,
    `Пароль: ${fullAccount.password}`,
    `Steam Guard: ${code}`,
    ``,
    `Для получения нового кода напишите !code`,
    `Аренда до: ${endsAt.toLocaleString('ru-RU', { timeZone: 'Europe/Kiev' })}`,
  ].join('\n');

  await client.sendMessage(nodeId, message);

  logger.info(`Credentials sent to ${buyer} in node ${nodeId}`);

  if (notifyAdmin) {
    await notifyAdmin(`✅ Заказ #${funpayOrderId}: аккаунт #${account.id} выдан ${buyer}`);
  }
}