import { launchBot } from './tgBot/tg.js';

launchBot().catch((error) => {
  console.error('Failed to launch Telegram bot:', error);
  process.exit(1);
});
