import 'dotenv/config';
import { addAccount, attachMafileToAccount, getAccountById } from '../tgBot/services/rentalStore.js';
import { generateSteamGuardCode } from '../steam/steamGuard.js';

async function main() {
  try {
    console.log('Running DB smoke test...');

    const account = await addAccount({
      title: 'Smoke Test Account',
      login: `smoke_${Date.now()}`,
      password: 'test_password',
      notes: 'created-by-smoke-test',
    });

    console.log('Created account:', account);

    // Optionally attach a mafile (replace sharedSecret with a valid one to test codes)
    const sharedSecret = process.env.SMOKE_SHARED_SECRET || null;
    if (sharedSecret) {
      await attachMafileToAccount(account.id, {
        sharedSecret,
        identitySecret: null,
        rawJson: { test: true },
      });

      const full = await getAccountById(account.id, { includeSecrets: true });
      console.log('Account with secrets:', { id: full.id, login: full.login });

      if (full.sharedSecret) {
        const code = generateSteamGuardCode(full.sharedSecret);
        console.log('Generated Steam Guard code:', code);
      }
    } else {
      console.log('No SMOKE_SHARED_SECRET set — skipping mafile attach and code generation.');
    }

    console.log('DB smoke test finished successfully.');
  } catch (err) {
    console.error('DB smoke test failed:', err);
    process.exit(1);
  }
}

main();
