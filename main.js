import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '.env') });

import { launchBot } from './tgBot/tg.js';
import { createFunpayPoller, isFunpayPollingEnabled } from './src/funpay/poller.js';
import { createChatPoller } from './src/funpay/chatPoller.js';
import { createExpiryChecker } from './src/funpay/rentalExpiry.js';
import { createCommandRouter } from './src/funpay/commandRouter.js';
import { handleCodeCommand } from './src/funpay/handlers/codeHandler.js';
import { handleNewOrders } from './src/funpay/handlers/orderHandler.js';
import { FunpayClient } from './src/funpay/client.js';

const client = new FunpayClient();
const logger = console;

async function main() {
  // console.log("BOT START")
  const bot = await launchBot();
  
  // console.log("BOT READY")
  const adminIds = (process.env.TG_ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
  const notifyAdmin = async (text) => {
    for (const id of adminIds) {
      await bot.telegram.sendMessage(id, text).catch(() => {});
    }
  };

  console.log('FUNPAY_POLLING_ENABLED =', process.env.FUNPAY_POLLING_ENABLED);

  if (isFunpayPollingEnabled()) {
    const orderPoller = createFunpayPoller({
      client,
      onNewOrders: (orders, log) => handleNewOrders(orders, log, { client, notifyAdmin }),
      logger,
    });
    orderPoller.start();

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

    const expiry = createExpiryChecker({ client, notifyAdmin, logger });
    expiry.start();

    console.log('FunPay integration started: orders + chat + expiry');
  } else {
    console.log('FunPay polling disabled. Set FUNPAY_POLLING_ENABLED=true to enable.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});