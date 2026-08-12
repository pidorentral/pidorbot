import {
    getAccountById,
    getOrderByFunpayId,
    getActiveRentalByBuyer,
} from '../../dao/read.js';

import {
    createOrder,
    ensureRental,
    updateOrder,
    extendActiveRental,
} from "../../dao/write.js";
import { generateSteamGuardCode } from '../../../steam/steamGuard.js';

export function getRentalDurationHours(value = process.env.RENTAL_DURATION_HOURS) {
  const duration = Number(value || 24);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('RENTAL_DURATION_HOURS must be a positive number');
  }
  return duration;
}

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
  const { funpayOrderId, buyerId, buyerUsername: buyer, price, lotId, desiredMmr, lotCount = 1 } = order;

  const existing = await getOrderByFunpayId(funpayOrderId);
  if (existing && existing.status === 'fulfilled') {
    logger.info(`Order #${funpayOrderId} already fulfilled, skipping`);
    return true;
  }

  const quantity = Math.max(1, Number.isFinite(Number(lotCount)) ? Number(lotCount) : 1);
  const rentalBaseHours = getRentalDurationHours();
  const rentalHours = rentalBaseHours * quantity;

  logger.info(
    `Order #${funpayOrderId}: parsed lotCount=${lotCount}, quantity=${quantity}, baseHours=${rentalBaseHours}, rentalHours=${rentalHours}`
  );

  if (ALLOWED_LOT_IDS.length > 0 && !ALLOWED_LOT_IDS.includes(String(lotId))) {
    logger.info(`Order #${funpayOrderId} skipped: lot ${lotId} not in allowed list`);
    return true;
  }

  // Создаём/обновляем заказ как "paid", а не сразу "fulfilled"
  let dbOrder = existing;

  if (!dbOrder) {
      dbOrder = await createOrder({
          funpayOrderId,
          buyer,
          price,
          status: 'paid',
          desiredMmr,
          lotId,
          lotCount: quantity,
      });
  }

  const nodeId = await client.getChatNodeId(buyer);
  logger.info(`getChatNodeId(${buyer}) → ${nodeId}`);

  if (!nodeId) {
    logger.error(`Cannot find chat node for buyer: ${buyer} (id ${buyerId})`);
      if (notifyAdmin) await notifyAdmin(`⚠️ Не нашёл чат с ${buyer}, заказ #${funpayOrderId} остался в paid`);
      return; // статус остаётся 'paid' — заказ переобработается на следующем цикле
  }

  const existingActiveRental = await getActiveRentalByBuyer(buyer);
  if (existingActiveRental) {
    const extension = await extendActiveRental(existingActiveRental.id, rentalHours, {
      reason: `order:${funpayOrderId}`,
    });

    const account = await getAccountById(existingActiveRental.accountId, { includeSecrets: true });
    const message = [
      `✅ Дополнительный лот принят.`,
      ``,
      `Время аренды продлено на ${rentalHours} часов.`,
      `Новая дата окончания: ${new Date(extension.newEndsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Kiev' })}`,
      ``,
      account ? `Логин: ${account.login}\nПароль: ${account.password}` : null,
      `Для получения нового кода напишите !code`,
    ].filter(Boolean).join('\n');

    await client.sendMessage(nodeId, message);
    await updateOrder(dbOrder.id, { status: 'fulfilled' });

    logger.info(
      `Order #${funpayOrderId}: extended active rental #${existingActiveRental.id} by ${rentalHours}h for buyer ${buyer}; ends_at=${new Date(extension.newEndsAt).toISOString()}`
    );
    if (notifyAdmin) await notifyAdmin(`✅ Заказ #${funpayOrderId}: активная аренда #${existingActiveRental.id} продлена на ${rentalHours}h для ${buyer}`);
    return true;
  }

  const endsAt = new Date(Date.now() + rentalHours * 60 * 60 * 1000);

    const reservation = await ensureRental({
      buyer,
      endsAt,
      orderId: dbOrder.id,
      nodeId,
      desiredMmr,
      desiredTitle: order.description || order.title || null
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

  logger.info(
    `Order #${funpayOrderId}: reserved account #${account.id}, rentalEndsAt=${new Date(rental.ends_at).toISOString()}, durationHours=${rentalHours}`
  );

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
    quantity > 1 ? `Аренда на ${rentalHours} часов (${rentalBaseHours} × ${quantity})` : `Аренда на ${rentalBaseHours} часов`,
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
