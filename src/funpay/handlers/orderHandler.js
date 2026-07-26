import { listAccounts, getAccountById, getOrderByFunpayId } from '../../dao/read.js';
import { createOrder, reserveAccount, updateOrderStatus } from '../../dao/write.js';
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
  const { funpayOrderId, buyerId, buyerUsername: buyer, price, lotId } = order;

  const existing = await getOrderByFunpayId(funpayOrderId);
  if (existing && existing.status === 'fulfilled') {
    logger.info(`Order #${funpayOrderId} already fulfilled, skipping`);
    return;
  }

  if (ALLOWED_LOT_IDS.length > 0 && !ALLOWED_LOT_IDS.includes(String(lotId))) {
    logger.info(`Order #${funpayOrderId} skipped: lot ${lotId} not in allowed list`);
    return;
  }

  const accounts = await listAccounts({ status: 'available', limit: 1 });
  if (accounts.length === 0) {
    logger.error(`No available accounts for order #${funpayOrderId}`);
    if (notifyAdmin) await notifyAdmin(`🚨 Нет свободных аккаунтов! Заказ #${funpayOrderId} от ${buyer}`);
    if (!existing) await createOrder({ funpayOrderId, buyer, price, status: 'pending_no_account' });
    return;
  }

  const account = accounts[0];

  // Создаём/обновляем заказ как "processing", а не сразу "fulfilled"
  const dbOrder = existing
  ? existing
  : await createOrder({ funpayOrderId, buyer, accountId: account.id, price, status: 'paid' });

  const nodeId = await client.getChatNodeId(buyer);
  logger.info(`getChatNodeId(${buyer}) → ${nodeId}`);

  if (!nodeId) {
    logger.error(`Cannot find chat node for buyer: ${buyer} (id ${buyerId})`);
    if (notifyAdmin) await notifyAdmin(`⚠️ Не нашёл чат с ${buyer}, заказ #${funpayOrderId} остался в processing`);
    return; // статус остаётся 'processing' — заказ переобработается на следующем цикле
  }

  const endsAt = new Date(Date.now() + RENTAL_DURATION_HOURS * 60 * 60 * 1000);
  const rental = await reserveAccount({ accountId: account.id, buyer, endsAt, orderId: dbOrder.id, nodeId });

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

  // Только теперь — финальный статус
  await updateOrderStatus(dbOrder.id, 'fulfilled'); // нужна такая функция в write.js

  logger.info(`Order #${funpayOrderId}: account #${account.id} reserved for ${buyer} until ${endsAt.toISOString()}`);
  if (notifyAdmin) await notifyAdmin(`✅ Заказ #${funpayOrderId}: аккаунт #${account.id} выдан ${buyer}`);
}