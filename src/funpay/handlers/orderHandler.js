import {
    getAccountById,
    getOrderByFunpayId
} from '../../dao/read.js';

import {
    createOrder,
    ensureRental,
    updateOrder
} from "../../dao/write.js";
import { generateSteamGuardCode } from '../../../steam/steamGuard.js';

export function getRentalDurationHours(value = process.env.RENTAL_DURATION_HOURS) {
  const duration = Number(value || 24);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('RENTAL_DURATION_HOURS must be a positive number');
  }
  return duration;
}

const RENTAL_DURATION_HOURS = getRentalDurationHours();

const ALLOWED_LOT_IDS = (process.env.FUNPAY_ALLOWED_LOT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function handleNewOrders(orders, logger, { client, notifyAdmin }) {
  const processedOrderIds = [];

  for (const order of orders) {
    try {
      const processed = await processOrder(order, { client, logger, notifyAdmin });
      if (processed) processedOrderIds.push(order.funpayOrderId);
    } catch (err) {
      logger.error(`Failed to process order #${order.funpayOrderId}: ${err.message}`);
      if (notifyAdmin) {
        await notifyAdmin(`⚠️ Order #${order.funpayOrderId} failed: ${err.message}`);
      }
    }
  }

  return processedOrderIds;
}

async function processOrder(order, { client, logger, notifyAdmin }) {
  const { funpayOrderId, buyerId, buyerUsername: buyer, price, lotId } = order;

  const existing = await getOrderByFunpayId(funpayOrderId);
  if (existing && existing.status === 'fulfilled') {
    logger.info(`Order #${funpayOrderId} already fulfilled, skipping`);
    return true;
  }

  if (ALLOWED_LOT_IDS.length > 0 && !ALLOWED_LOT_IDS.includes(String(lotId))) {
    logger.info(`Order #${funpayOrderId} skipped: lot ${lotId} not in allowed list`);
    return true;
  }

  // Создаём/обновляем заказ как "processing", а не сразу "fulfilled"
  let dbOrder = existing;

  if (!dbOrder) {
      dbOrder = await createOrder({
          funpayOrderId,
          buyer,
          price,
          status: 'processing'
      });
  }

  const nodeId = await client.getChatNodeId(buyer);
  logger.info(`getChatNodeId(${buyer}) → ${nodeId}`);

  if (!nodeId) {
    logger.error(`Cannot find chat node for buyer: ${buyer} (id ${buyerId})`);
    if (notifyAdmin) await notifyAdmin(`⚠️ Не нашёл чат с ${buyer}, заказ #${funpayOrderId} остался в processing`);
    return; // статус остаётся 'processing' — заказ переобработается на следующем цикле
  }

  const endsAt = new Date(
    Date.now() + RENTAL_DURATION_HOURS * 60 * 60 * 1000
);

  const reservation = await ensureRental({
      buyer,
      endsAt,
      orderId: dbOrder.id,
      nodeId
  });

  if (!reservation) {

      logger.error(`No available accounts for order #${funpayOrderId}`);

      if (notifyAdmin) {
          await notifyAdmin(
              `🚨 Нет свободных аккаунтов! Заказ #${funpayOrderId}`
          );
      }

      return;
  }

  const { account, rental } = reservation;

  const fullAccount = await getAccountById(account.id, {
    includeSecrets: true
  });

  const code = generateSteamGuardCode(fullAccount.sharedSecret);

  const message = [
    `✅ Оплата получена! Данные для входа:`,
    ``,
    `Логин: ${fullAccount.login}`,
    `Пароль: ${fullAccount.password}`,
    `Steam Guard: ${code}`,
    ``,
    `Для получения нового кода напишите !code`,
    `Аренда до: ${new Date(rental.ends_at).toLocaleString('ru-RU', {
      timeZone: 'Europe/Kiev'
    })}`
  ].join('\n');

  await client.sendMessage(nodeId, message);

  await updateOrder(dbOrder.id, { status: 'fulfilled' });

  logger.info(
    `Order #${funpayOrderId}: account #${account.id} reserved for ${buyer} until ${new Date(rental.ends_at).toISOString()}`
  );
  if (notifyAdmin) await notifyAdmin(`✅ Заказ #${funpayOrderId}: аккаунт #${account.id} выдан ${buyer}`);
  return true;
}
