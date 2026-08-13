import dotenv from 'dotenv';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lockPath = resolve(__dirname, '.bot.lock');

dotenv.config({ path: resolve(__dirname, '.env') });

function removeLockFile() {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore cleanup errors
  }
}

function acquireSingletonLock() {
  try {
    if (fs.existsSync(lockPath)) {
      const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          console.error(`Another bot instance is already running (pid ${pid}). Stopping this one.`);
          process.exit(1);
        } catch {
          // stale lock file; remove it and continue
          removeLockFile();
        }
      }
    }

    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    process.on('exit', removeLockFile);
    process.on('SIGINT', removeLockFile);
    process.on('SIGTERM', removeLockFile);
  } catch (error) {
    console.error('Failed to acquire bot singleton lock:', error.message || error);
    process.exit(1);
  }
}

acquireSingletonLock();

try {
  await import('./main.js');
} catch (error) {
  console.error('Bootstrap fatal:', error);
  process.exit(1);
}
