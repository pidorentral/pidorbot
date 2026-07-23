import { FunpayClient } from './client.js';

const DEFAULT_INTERVAL_MS = 5_000;

function getIntervalMs(value = process.env.FUNPAY_POLL_INTERVAL_MS) {
  const interval = Number.parseInt(value || `${DEFAULT_INTERVAL_MS}`, 10);
  if (!Number.isSafeInteger(interval) || interval < 2_000) {
    throw new Error('FUNPAY_POLL_INTERVAL_MS must be an integer of at least 2000');
  }
  return interval;
}

export function isFunpayPollingEnabled(value = process.env.FUNPAY_POLLING_ENABLED) {
  return value?.trim().toLowerCase() === 'true';
}

export function createFunpayPoller({
  client = new FunpayClient(),
  intervalMs = getIntervalMs(),
  onNewOrders = logObservedOrders,
  logger = console,
} = {}) {
  let timer = null;
  let polling = false;
  let initialSnapshotLoaded = false;
  const seenOrderIds = new Set();

  async function pollOnce() {
    if (polling) return [];
    polling = true;

    try {
      const orders = await client.getNewOrders();
      const unseenOrders = orders.filter((order) => !seenOrderIds.has(order.funpayOrderId));
      orders.forEach((order) => seenOrderIds.add(order.funpayOrderId));

      if (!initialSnapshotLoaded) {
        initialSnapshotLoaded = true;
        logger.info(`FunPay observer started; existing new orders: ${orders.length}`);
        return [];
      }

      if (unseenOrders.length) await onNewOrders(unseenOrders, logger);
      return unseenOrders;
    } finally {
      polling = false;
    }
  }

  function start() {
    if (timer) return;
    void pollOnce().catch((error) => logger.error(`FunPay polling error: ${error.message}`));
    timer = setInterval(() => {
      void pollOnce().catch((error) => logger.error(`FunPay polling error: ${error.message}`));
    }, intervalMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { pollOnce, start, stop };
}

async function logObservedOrders(orders, logger) {
  for (const order of orders) {
    logger.info(`FunPay order observed: #${order.funpayOrderId} (${order.status || 'unknown status'})`);
  }
}
