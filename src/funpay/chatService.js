import { generateSteamGuardCode } from '../../steam/steamGuard.js';
import { getAccountById } from '../dao/read.js';

export function formatRentalMessage(account, code) {
  return [
    `Данные для входа:`,
    ``,
    `Логин: ${account.login}`,
    `Пароль: ${account.password}`,
    `Steam Guard код: ${code}`,
    ``,
    `Код обновляется каждые 30 сек. Если не подойдёт — напишите, пришлю новый.`,
  ].join('\n');
}

export async function sendAccountTobuyer(client, { nodeId, accountId }) {
  const account = await getAccountById(accountId, { includeSecrets: true });
  if (!account) throw new Error(`Account #${accountId} not found`);
  if (!account.sharedSecret) throw new Error(`Account #${accountId} has no Steam Guard`);

  const code = generateSteamGuardCode(account.sharedSecret);
  const message = formatRentalMessage(account, code);

  return client.sendMessage(nodeId, message);
}