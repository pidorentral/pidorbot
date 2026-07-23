import dotenv from 'dotenv';
import { launchBot } from './tgBot/tg.js';
import { init } from './src/db.js';
import { createFunpayPoller, isFunpayPollingEnabled } from './src/funpay/poller.js';

dotenv.config();

async function start() {
  await init();
  await launchBot();

  const poller = isFunpayPollingEnabled() ? createFunpayPoller() : null;
  if (poller) poller.start();

  process.once('SIGINT', () => {
    poller?.stop();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    poller?.stop();
    process.exit(0);
  });
}

start().catch((error) => {
  console.error('Application failed to start:', error);
  process.exit(1);
});
