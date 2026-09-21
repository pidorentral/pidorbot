import {
    getAccountById,
    getOrderByFunpayId,
    getActiveRentalByBuyer,
} from '../../dao/read.js';
import { query } from '../../db.js';

import {
    createOrder,
    ensureRental,
    updateOrder,
    extendActiveRental,
    getActiveAccountOffer,
    getOfferBaseHours,
} from "../../dao/write.js";
import { parseLotId, parseSelectedLotsCount } from '../orderParser.js';
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

function normalizeOfferId(value, { funpayOrderId, logger, notifyAdmin } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) {
    const message = `⚠️ Заказ #${funpayOrderId}: не удалось извлечь valid offer_id из FunPay-данных — выдача остановлена.`;
    logger?.error?.(message);
    if (notifyAdmin) void notifyAdmin(message);
    throw new Error(message);
  }

  const normalized = Number(raw);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    const message = `⚠️ Заказ #${funpayOrderId}: получен невалидный offer_id (${raw}) — выдача остановлена.`;
    logger?.error?.(message);
    if (notifyAdmin) void notifyAdmin(message);
    throw new Error(message);
  }

  return String(normalized);
}

async function getOfferBindingAudit(offerId) {
  try {
    const result = await query(
      `SELECT account_id AS "accountId",
              funpay_offer_id AS "offerId",
              hours_per_lot AS "hoursPerLot",
              is_active AS "isActive",
              created_at AS "createdAt"
         FROM account_offers
        WHERE funpay_offer_id = $1
        ORDER BY created_at DESC, account_id DESC
        LIMIT 10`,
      [String(offerId)]
    );

    return result.rows;
  } catch (error) {
    return [{ error: String(error?.message || error || 'bind-audit-failed') }];
  }
}

export function buildOfferAuditSummary({ funpayOrderId, effectiveLotId, accountId = null, bindingAudit = [] } = {}) {
  const offerId = effectiveLotId == null ? 'unknown' : String(effectiveLotId);
  const auditRows = Array.isArray(bindingAudit) ? bindingAudit.filter(Boolean) : [];
  const rows = auditRows.length ? auditRows.slice(0, 5).map((row) => {
    const account = row.accountId ?? 'n/a';
    const offer = row.offerId ?? 'n/a';
    const hours = row.hoursPerLot ?? 'n/a';
    const isActive = row.isActive === false ? 'inactive' : 'active';
    return `account #${account}: offer ${offer} (${hours}h/lot, ${isActive})`;
  }) : ['no matching offer bindings in DB'];

  const accountText = Number.isSafeInteger(accountId) && accountId > 0 ? `account #${accountId}` : 'the account';
  const rowText = rows.join('; ');

  return [
    `Order #${funpayOrderId ?? 'unknown'}: offer ${offerId} is not bound to ${accountText}.`,
    'Exact match policy: the system validates funpay_offer_id only, not the selected lot count or URL text.',
    `DB audit: ${rowText}.`,
    'This means the order resolved to a real offer ID, but the active binding for that exact offer is missing or inactive.',
  ].join(' ');
}

function buildOfferAuditContext({ funpayOrderId, buyer, buyerId, price, resolvedLotId, effectiveLotId, selectedLotsCount, bindingAudit }) {
  return {
    funpayOrderId,
    buyer,
    buyerId,
    price,
    resolvedLotId,
    effectiveLotId,
    selectedLotsCount,
    bindingAudit,
  };
}

async function processOrder(order, { client, logger, notifyAdmin }) {
  const { funpayOrderId, buyerId, buyerUsername: buyer, price, lotId, selectedLotsCount: parsedSelectedLotsCount } = order;

  logger.info(`Order #${funpayOrderId}: processing raw payload: buyer=${buyer || 'unknown'}, buyerId=${buyerId ?? 'n/a'}, price=${price ?? 'n/a'}, offerId=${lotId ?? 'n/a'}, selectedLotsCount=${parsedSelectedLotsCount ?? 'n/a'}`);

  const existing = await getOrderByFunpayId(funpayOrderId);
  if (existing && existing.status === 'fulfilled') {
    logger.info(`Order #${funpayOrderId} already fulfilled, skipping`);
    return true;
  }

  let resolvedLotId = lotId;
  let resolvedSelectedLotsCount = parsedSelectedLotsCount;

  if (!resolvedLotId || resolvedSelectedLotsCount === null || resolvedSelectedLotsCount === undefined) {
    logger.warn(`Order #${funpayOrderId}: incomplete trade-row metadata; trying detail-page fallback`);
    for (const path of [`orders/${encodeURIComponent(funpayOrderId)}/`, `order/${encodeURIComponent(funpayOrderId)}/`, `chats/${encodeURIComponent(funpayOrderId)}/`]) {
      try {
        const detailHtml = await client.request(path);
        const detailLotId = parseLotId(detailHtml, logger);
        const detailSelectedLotsCount = parseSelectedLotsCount(detailHtml);
        if (detailLotId) {
          resolvedLotId = detailLotId;
        }
        if (detailSelectedLotsCount !== null) resolvedSelectedLotsCount = detailSelectedLotsCount;
        if (resolvedLotId && resolvedSelectedLotsCount !== null && resolvedSelectedLotsCount !== undefined) break;
      } catch (err) {
        logger.warn(`Order #${funpayOrderId}: detail-page fallback failed for ${path}: ${err.message}`);
      }
    }
  }

  let effectiveLotId;
  try {
    effectiveLotId = normalizeOfferId(resolvedLotId, { funpayOrderId, logger, notifyAdmin });
  } catch (error) {
    logger.error(`${error.message} | debug: buyer=${buyer || 'unknown'}, buyerId=${buyerId ?? 'n/a'}, orderPayload=${JSON.stringify({ funpayOrderId, buyer, buyerId, price, rawLotId: lotId ?? null, resolvedLotId: resolvedLotId ?? null, rawSelectedLotsCount: parsedSelectedLotsCount ?? null, resolvedSelectedLotsCount: resolvedSelectedLotsCount ?? null })}`);
    return false;
  }

  logger.info(`Order #${funpayOrderId}: offer resolution debug: rawLotId=${lotId ?? 'n/a'}, resolvedLotId=${resolvedLotId ?? 'n/a'}, effectiveLotId=${effectiveLotId}, rawSelectedLotsCount=${parsedSelectedLotsCount ?? 'n/a'}, resolvedSelectedLotsCount=${resolvedSelectedLotsCount ?? 'n/a'}`);
  const parsedLotsCount = Number(resolvedSelectedLotsCount);
  const selectedLotsCount = Number.isSafeInteger(parsedLotsCount) && parsedLotsCount > 0
    ? parsedLotsCount
    : 1;
  if (selectedLotsCount === 1 && !(Number.isSafeInteger(parsedLotsCount) && parsedLotsCount > 0)) {
    logger.warn(`Не удалось определить selectedLotsCount для заказа ${funpayOrderId} (offer_id=${effectiveLotId}), используем 1 по умолчанию`);
  }

  // Fail before inserting an order when this offer has no valid base duration.
  const configuredBaseHours = await getOfferBaseHours(effectiveLotId);
  if (configuredBaseHours === null) {
    const bindingAudit = await getOfferBindingAudit(effectiveLotId);
    const auditContext = buildOfferAuditContext({
      funpayOrderId,
      buyer,
      buyerId,
      price,
      resolvedLotId: resolvedLotId ?? null,
      effectiveLotId,
      selectedLotsCount,
      bindingAudit,
    });
    const message = buildOfferAuditSummary({
      funpayOrderId,
      effectiveLotId,
      bindingAudit,
    });
    logger.error(`${message} | offerAudit=${JSON.stringify(auditContext)} | resolvedLotId=${resolvedLotId ?? 'n/a'} | rawLotId=${lotId ?? 'n/a'} | selectedLotsCount=${selectedLotsCount}`);
    if (notifyAdmin) await notifyAdmin(`${message} | offerAudit=${JSON.stringify(auditContext)}`);
    return false;
  }

  // Создаём/обновляем заказ как "paid", а не сразу "fulfilled"
  let dbOrder = existing;

  if (!dbOrder) {
      dbOrder = await createOrder({
          funpayOrderId,
          buyer,
          price,
          status: 'paid',
          lotId: effectiveLotId,
          lotCount: selectedLotsCount,
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
      const bindingAudit = await getOfferBindingAudit(effectiveLotId);
      const message = buildOfferAuditSummary({
        funpayOrderId,
        effectiveLotId,
        accountId: existingActiveRental.accountId,
        bindingAudit,
      });
      logger.error(`${message} | activeRentalAccount=${existingActiveRental.accountId}`);
      if (notifyAdmin) await notifyAdmin(`${message} | activeRentalAccount=${existingActiveRental.accountId}`);
      return false;
    }
    const offerBaseHours = Number(offer.hoursPerLot);
    if (!Number.isFinite(offerBaseHours) || offerBaseHours <= 0) {
      const message = `⚠️ Заказ #${funpayOrderId}: у оффера ${effectiveLotId} некорректное базовое количество часов — выдача остановлена.`;
      logger.error(message);
      if (notifyAdmin) await notifyAdmin(message);
      return false;
    }
    // Business calculation for an existing rental: base offer duration × selected lots.
    const totalHours = offerBaseHours * selectedLotsCount;
    const extension = await extendActiveRental(existingActiveRental.id, totalHours, {
      reason: `order:${funpayOrderId}`,
    });

    const account = await getAccountById(existingActiveRental.accountId, { includeSecrets: true });
    const message = [
      `✅ Дополнительный лот принят.`,
      ``,
      `Ваша аренда продлена на ${totalHours} часов.`,
      `Новая дата окончания: ${new Date(extension.newEndsAt).toLocaleString('ru-RU', { timeZone: 'Europe/Kiev' })}`,
      ``,
      account ? `Логин: ${account.login}\nПароль: ${account.password}` : null,
      `Для получения нового кода напишите !code`,
    ].filter(Boolean).join('\n');

    await client.sendMessage(nodeId, message);
    await updateOrder(dbOrder.id, { status: 'fulfilled' });

    logger.info(
      `Order #${funpayOrderId}: extended active rental #${existingActiveRental.id} by ${totalHours}h for buyer ${buyer}; ends_at=${new Date(extension.newEndsAt).toISOString()}`
    );
    if (notifyAdmin) await notifyAdmin(`✅ Заказ #${funpayOrderId}: активная аренда #${existingActiveRental.id} продлена на ${totalHours}h для ${buyer}`);
    return true;
  }

    const reservation = await ensureRental({
      buyer,
      orderId: dbOrder.id,
      nodeId,
      offerId: effectiveLotId,
      quantity: selectedLotsCount,
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

  const { account, rental, hoursPerLot: offerBaseHours, totalHours } = reservation;

  logger.info(
    `Order #${funpayOrderId}: reserved account #${account.id}, rentalEndsAt=${new Date(rental.ends_at).toISOString()}, totalHours=${totalHours}`
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
    `Ваша аренда на ${totalHours} часов активирована${selectedLotsCount > 1 ? ` (${offerBaseHours} × ${selectedLotsCount})` : ''}.`,
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
