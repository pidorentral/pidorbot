import dotenv from 'dotenv';

dotenv.config();

export function getConfig() {
  const botToken = process.env.BOT_TOKEN;
  const adminIds = parseAdminIds(process.env.TG_ADMIN_IDS);

  if (!botToken) {
    throw new Error('BOT_TOKEN is not set. Add it to .env before starting the bot.');
  }

  return {
    botToken,
    adminIds,
  };
}

function parseAdminIds(value = '') {
  return value
    .split(',')
    .map((id) => Number(id.trim()))
    .filter(Number.isSafeInteger);
}
