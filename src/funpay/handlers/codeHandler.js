import { generateSteamGuardCode } from '../../../steam/steamGuard.js';
import { getAccountById } from '../../dao/read.js';
import { getActiveRentalByNodeId, incrementCodeCount } from '../../dao/read.js';

const MAX_CODES = 5; // лимит кодов до автолока

export async function handleCodeCommand({ message, ctx }) {
  const { client, logger } = ctx;
  const { nodeId, authorId } = message;

  // 1. Найти активную аренду по nodeId (или по buyerId)
  const rental = await getActiveRentalByNodeId(nodeId);

  if (!rental) {
    await client.sendMessage(nodeId, 'У вас нет активной аренды.');
    return;
  }

  // 2. Проверить не залочена ли
  if (rental.state === 'locked') {
    await client.sendMessage(nodeId, 'Выдача кодов завершена. Обратитесь к продавцу.');
    return;
  }

  if (rental.state !== 'active') {
    await client.sendMessage(nodeId, 'Аренда ещё не активирована. Дождитесь подтверждения оплаты.');
    return;
  }

  // 3. Проверить лимит
  if (rental.codeCount >= MAX_CODES) {
    await client.sendMessage(nodeId, 'Лимит кодов исчерпан. Обратитесь к продавцу.');
    // автолок
    await setRentalState(rental.id, 'locked');
    return;
  }

  // 4. Сгенерировать и отправить
  const account = await getAccountById(rental.accountId, { includeSecrets: true });
  if (!account?.sharedSecret) {
    await client.sendMessage(nodeId, 'Steam Guard не подключён. Обратитесь к продавцу.');
    logger.error(`Account #${rental.accountId} missing sharedSecret`);
    return;
  }

  const code = generateSteamGuardCode(account.sharedSecret);
  await client.sendMessage(nodeId, `Код: ${code}`);
  await incrementCodeCount(rental.id);

  logger.info(`Code sent for rental #${rental.id} (${rental.codeCount + 1}/${MAX_CODES})`);
}