import 'dotenv/config';
import { completeRental } from '../src/dao/write.js';

(async () => {
  try {
    const rentalId = Number(process.argv[2]);
    if (!rentalId) throw new Error('Usage: node scripts/completeRental.js <rentalId>');
    const res = await completeRental(rentalId);
    console.log('Completed:', res);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();