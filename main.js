const [
  { launchBot },
  { createFunpayPoller, isFunpayPollingEnabled },
  { createChatPoller },
  { createExpiryChecker },
  { createCommandRouter },
  { handleCodeCommand },
  { handleNewOrders },
  { FunpayClient },
  { close: closeDatabase },
] = await Promise.all([
  import('./tgBot/tg.js'),
  import('./src/funpay/poller.js'),
  import('./src/funpay/chatPoller.js'),
  import('./src/funpay/rentalExpiry.js'),
  import('./src/funpay/commandRouter.js'),
  import('./src/funpay/handlers/codeHandler.js'),
  import('./src/funpay/handlers/orderHandler.js'),
  import('./src/funpay/client.js'),
  import('./src/db.js'),
]);

const client = new FunpayClient();
const logger = console;

async function main() {
  const bot = await launchBot();
  const services = [];
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; stopping services...`);

    for (const service of services) service.stop();
    bot.stop(signal);
    await closeDatabase();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  
  const adminIds = (process.env.TG_ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
  const notifyAdmin = async (text) => {
    for (const id of adminIds) {
      await bot.telegram.sendMessage(id, text).catch(() => {});
    }
  };

  if (isFunpayPollingEnabled()) {
    const orderPoller = createFunpayPoller({
      client,
      onNewOrders: (orders, log) => handleNewOrders(orders, log, { client, notifyAdmin }),
      logger,
    });
    orderPoller.start();
    services.push(orderPoller);

    const router = createCommandRouter({
      '!code': handleCodeCommand,
    });

    const chatPoller = createChatPoller({
      client,
      onMessages: async (messages) => {
        for (const msg of messages) {
          await router(msg, { client, logger });
        }
      },
      logger,
    });
    chatPoller.start();
    services.push(chatPoller);

    const expiry = createExpiryChecker({ client, notifyAdmin, logger });
    expiry.start();
    services.push(expiry);
  } else {
    console.log('FunPay polling disabled. Set FUNPAY_POLLING_ENABLED=true to enable.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
