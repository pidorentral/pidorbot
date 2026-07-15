import 'dotenv/config';
import { createOrderAndReserveAccount } from '../src/dao/transactional.js';
import * as read from '../src/dao/read.js';

(async () => {
  try {
    const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1 hour
    const result = await createOrderAndReserveAccount({
      funpayOrderId: `test-${Date.now()}`,
      buyer: 'tester',
      accountId: 1,         // <- поставь id существующего аккаунта
      price: 5.0,
      endsAt,
    });
    console.log('CREATE RESULT:', result);

    console.log('ORDERS:', await read.getOrders({ limit: 20 }));
    console.log('ACTIVE RENTALS:', await read.getActiveRentals());
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();