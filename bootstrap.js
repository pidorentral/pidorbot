import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '.env') });

try {
  await import('./main.js');
} catch (error) {
  console.error('Bootstrap fatal:', error);
  process.exit(1);
}
