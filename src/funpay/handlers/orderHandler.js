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
    getActiveAccountOffer,
} from "../../dao/write.js";
import { parseLotId } from '../orderParser.js';
import { generateSteamGuardCode } from '../../../steam/steamGuard.js';

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

  logger.info(`Order #${funpayOrderId}: processing raw payload: buyer=${buyer || 'unknown'}, buyerId=${buyerId ?? 'n/a'}, price=${price ?? 'n/a'}, offerId=${lotId ?? 'n/a'}, quantity=1`);

  const existing = await getOrderByFunpayId(funpayOrderId);
  if (existing && existing.status === 'fulfilled') {
    logger.info(`Order #${funpayOrderId} already fulfilled, skipping`);
    return true;
  }

  const quantity = 1;
  let resolvedLotId = lotId;

  if (!resolvedLotId) {
    logger.warn(`Order #${funpayOrderId}: no lotId in trade row; trying detail-page fallback`);
    for (const path of [`orders/${encodeURIComponent(funpayOrderId)}/`, `order/${encodeURIComponent(funpayOrderId)}/`, `chats/${encodeURIComponent(funpayOrderId)}/`]) {
      try {
        const detailHtml = await client.request(path);
        const detailLotId = parseLotId(detailHtml, logger);
        if (detailLotId) {
          resolvedLotId = detailLotId;
          logger.info(`Order #${funpayOrderId}: resolved lotId=${detailLotId} from ${path}`);
          break;
        }
      } catch (err) {
        logger.warn(`Order #${funpayOrderId}: detail-page fallback failed for ${path}: ${err.message}`);
      }
    }
  }

  if (!resolvedLotId) {
    const message = `⚠️ Заказ #${funpayOrderId}: не удалось получить ID оффера — выдача остановлена.`;
    logger.error(`${message} | debug: buyer=${buyer || 'unknown'}, buyerId=${buyerId ?? 'n/a'}, orderPayload=${JSON.stringify({ funpayOrderId, buyer, buyerId, price })}`);
    if (notifyAdmin) await notifyAdmin(message);
    return false;
  }

  const effectiveLotId = resolvedLotId;

  // Создаём/обновляем заказ как "paid", а не сразу "fulfilled"
  let dbOrder = existing;

  if (!dbOrder) {
      dbOrder = await createOrder({
          funpayOrderId,
          buyer,
          price,
          status: 'paid',
          lotId: effectiveLotId,
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
    const offer = await getActiveAccountOffer(existingActiveRental.accountId, effectiveLotId);
    if (!offer) {
      const message = `⚠️ Заказ #${funpayOrderId}: оффер ${effectiveLotId} не привязан к активному аккаунту #${existingActiveRental.accountId}; выдача остановлена.`;
      logger.error(message);
      if (notifyAdmin) await notifyAdmin(message);
      return false;
    }
    const rentalBaseHours = Number(offer.hoursPerLot);
    const rentalHours = rentalBaseHours * quantity;
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

    const reservation = await ensureRental({
      buyer,
      orderId: dbOrder.id,
      nodeId,
      offerId: effectiveLotId,
      quantity,
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

  const { account, rental, hoursPerLot: rentalBaseHours, rentalHours } = reservation;

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
