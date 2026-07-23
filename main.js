import dotenv from 'dotenv';
import { launchBot } from './tgBot/tg.js';
import { init } from './src/db.js';
import { createFunpayPoller, isFunpayPollingEnabled } from './src/funpay/poller.js';
import { createChatPoller } from './src/funpay/chatPoller.js';
import { createCommandRouter } from './src/funpay/commandRouter.js';
import { handleCodeCommand } from './src/funpay/handlers/codeHandler.js';
import { FunpayClient } from './src/funpay/client.js';

dotenv.config();

async function start() {
  await init();
  await launchBot();

  const client = new FunpayClient();

  // Order poller
  const orderPoller = isFunpayPollingEnabled() ? createFunpayPoller({ client }) : null;
  if (orderPoller) orderPoller.start();

  // Chat poller + command router
  const router = createCommandRouter({
    '!code': handleCodeCommand,
    '!help': async ({ message, ctx }) => {
      await ctx.client.sendMessage(message.nodeId, 'Команды:\n!code — получить код Steam Guard');
    },
  });

  const chatPoller = isFunpayPollingEnabled()
    ? createChatPoller({
        client,
        onMessages: async (messages, logger) => {
          const profile = await client.getProfile();
          for (const msg of messages) {
            // Игнорировать свои сообщения
            if (msg.authorId === profile.userId) continue;
            await router(msg, { client, logger });
          }
        },
      })
    : null;

  if (chatPoller) chatPoller.start();

  process.once('SIGINT', () => {
    orderPoller?.stop();
    chatPoller?.stop();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    orderPoller?.stop();
    chatPoller?.stop();
    process.exit(0);
  });
}

start().catch((error) => {
  console.error('Application failed to start:', error);
  process.exit(1);
});