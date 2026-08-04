import { FunpayClient, FunpayAuthError } from './client.js';

const DEFAULT_INTERVAL_MS = 10_000;

export function getChatPollIntervalMs(value = process.env.FUNPAY_CHAT_POLL_MS) {
  const interval = Number.parseInt(value || `${DEFAULT_INTERVAL_MS}`, 10);
  if (!Number.isSafeInteger(interval) || interval < 2_000) {
    throw new Error('FUNPAY_CHAT_POLL_MS must be an integer of at least 2000');
  }
  return interval;
}

export function createChatPoller({
  client = new FunpayClient(),
  intervalMs = getChatPollIntervalMs(),
  onMessages = logMessages,
  logger = console,
} = {}) {
  let timer = null;
  let polling = false;
  let lastMsgIdByNode = new Map;

  async function pollOnce() {
    if (polling) return [];
    polling = true;

    try {
      const chatPairs = [...lastMsgIdByNode.entries()];
      const chats = await client.getNewMessages(chatPairs);
      const newMessages = [];

      for (const chat of chats) {
        const prevId = lastMsgIdByNode.get(chat.nodeId) ?? chat.lastMsgId; 
        // ^ при первом запуске просто запоминаем текущее состояние, чтобы не
        //   среагировать на старую переписку задним числом

        if (!lastMsgIdByNode.has(chat.nodeId)) {
          lastMsgIdByNode.set(chat.nodeId, chat.lastMsgId);
          continue;
        }

        if (chat.lastMsgId > prevId) {
          lastMsgIdByNode.set(chat.nodeId, chat.lastMsgId);
          newMessages.push({
            id: chat.lastMsgId,
            nodeId: chat.nodeId,
            author: chat.username,
            text: chat.text,
          });
        }
      }
      if (newMessages.length > 0) {
        await onMessages(newMessages, logger);
      }

      return newMessages;
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
