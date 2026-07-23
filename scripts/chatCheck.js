import 'dotenv/config';
import { FunpayClient } from '../src/funpay/client.js';

async function main() {
  const client = new FunpayClient();
  const csrf = await client.getCsrfToken();
  console.log('CSRF:', csrf);

  const body = new URLSearchParams({
    request: JSON.stringify({ action: 'chat_bookmarks', data: { last_event: 0 } }),
    csrf_token: csrf,
  });

  const messages = await client.getNewMessages(0);
  console.log(JSON.stringify(messages, null, 2));
}

main().catch(console.error);