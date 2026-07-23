import 'dotenv/config';
import { FunpayClient, FunpayAuthError } from '../src/funpay/client.js';

async function main() {
  const client = new FunpayClient();
  const profile = await client.getProfile();
  const newOrders = await client.getNewOrders();

  console.log('FunPay session is valid.');
  console.log(`Seller: ${profile.username || 'unknown'} (#${profile.userId})`);
  console.log(`New order IDs found: ${newOrders.length ? newOrders.map((o) => o.funpayOrderId).join(', ') : 'none'}`);

  // тест чата
  const nodeId = await client.getChatNodeId(profile.userId);
  console.log('Chat node:', nodeId);
}

main().catch((error) => {
  if (error instanceof FunpayAuthError) {
    console.error('FunPay session is invalid or expired. Get a new FUNPAY_GOLDEN_KEY and retry.');
  } else {
    console.error(`FunPay check failed: ${error.message}`);
  }
  process.exit(1);
});

const nodeId = await client.getChatNodeId(profile.userId); // свой ID для теста
console.log('Chat node:', nodeId);
