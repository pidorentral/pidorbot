import { FunpayClient, FunpayAuthError } from './client.js';

const DEFAULT_INTERVAL_MS = 10_000;

export function createChatPoller({
  client = new FunpayClient(),
  intervalMs = Number(process.env.FUNPAY_CHAT_POLL_MS) || DEFAULT_INTERVAL_MS,
  onMessages = logMessages,
  logger = console,
} = {}) {
  let timer = null;
  let polling = false;
  let lastEventId = 0;

  async function pollOnce() {
    if (polling) return [];
    polling = true;

    try {
      const messages = await client.getNewMessages(lastEventId);

      if (messages.length > 0) {
        // track the latest event id for next poll
        const maxId = Math.max(...messages.map((m) => m.id || 0));
        if (maxId > lastEventId) lastEventId = maxId;

        await onMessages(messages, logger);
      }

      return messages;
    } catch (err) {
      if (err instanceof FunpayAuthError) {
        logger.error('FunPay session expired during chat poll');
      }
      throw err;
    } finally {
      polling = false;
    }
  }

  function start() {
    if (timer) return;
    logger.info(`FunPay chat poller started (interval: ${intervalMs}ms)`);
    void pollOnce().catch((e) => logger.error(`Chat poll error: ${e.message}`));
    timer = setInterval(() => {
      void pollOnce().catch((e) => logger.error(`Chat poll error: ${e.message}`));
    }, intervalMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { pollOnce, start, stop };
}

async function logMessages(messages, logger) {
  for (const msg of messages) {
    logger.info(`Chat message from ${msg.author} in node ${msg.nodeId}: ${msg.text}`);
  }
}
