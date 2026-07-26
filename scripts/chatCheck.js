import 'dotenv/config';
import { FunpayClient } from '../src/funpay/client.js';

async function main() {
  const client = new FunpayClient();
  await client.getProfile();

  const html = await client.getChatList();

  // Собрать пары [nodeId, lastMsgId] со страницы
  const pairs = [...html.matchAll(/data-id="(\d+)"[^>]*data-node-msg="(\d+)"/g)]
    .map(m => [Number(m[1]), Number(m[2])]);

  console.log('Chat pairs:', pairs.length);

  while (true) {
    const json = await client.getNewMessages(pairs);

    // Если пришёл новый data — обновить pairs
    const bookmarks = json.objects?.find(o => o.type === 'chat_bookmarks');
    if (bookmarks?.data && Array.isArray(bookmarks.data) && bookmarks.data.length > 0) {
      console.log('NEW DATA:', JSON.stringify(bookmarks.data, null, 2));
      // обновить pairs для следующего poll
      for (const [nodeId, msgId] of bookmarks.data) {
        const idx = pairs.findIndex(p => p[0] === nodeId);
        if (idx >= 0) pairs[idx][1] = msgId;
        else pairs.push([nodeId, msgId]);
      }
    }

    await new Promise(r => setTimeout(r, 3000));
  }
}

main().catch(console.error);