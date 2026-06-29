import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import {
  addAccount,
  getAccounts,
  getActiveRentals,
  getOrders,
  getStats,
} from './services/rentalStore.js';

const COMMANDS = [
  { command: 'stats', description: 'Summary: accounts, rentals, orders' },
  { command: 'accs', description: 'Accounts list' },
  { command: 'active_rentals', description: 'Active rentals' },
  { command: 'add_acc', description: 'Add account draft' },
  { command: 'orders', description: 'Orders list' },
  { command: 'settings', description: 'Bot settings' },
];

export function createBot(config = getConfig()) {
  const bot = new Telegraf(config.botToken);

  bot.use(adminOnly(config.adminIds));

  bot.start(async (ctx) => {
    await ctx.reply(
      [
        'Rental bot is online.',
        '',
        'Use /stats to see the current state.',
        'Use /add_acc title | login | password to add a temporary account draft.',
      ].join('\n'),
      mainMenu(),
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(formatHelp(), mainMenu());
  });

  bot.command('stats', showStats);
  bot.command('accs', showAccounts);
  bot.command('active_rentals', showActiveRentals);
  bot.command('add_acc', addAccountCommand);
  bot.command('orders', showOrders);
  bot.command('settings', showSettings);

  bot.hears(/^\/active-rentals(?:\s|$)/i, showActiveRentals);
  bot.hears(/^\/add-acc(?:\s|$)/i, addAccountCommand);

  bot.action('stats', showStats);
  bot.action('accs', showAccounts);
  bot.action('active_rentals', showActiveRentals);
  bot.action('orders', showOrders);
  bot.action('settings', showSettings);

  bot.on('text', async (ctx) => {
    await ctx.reply('Unknown command. Use /help to see available commands.', mainMenu());
  });

  return bot;
}

export async function launchBot() {
  const bot = createBot();

  await bot.telegram.setMyCommands(COMMANDS);
  await bot.launch();

  console.log('Telegram bot launched');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

function adminOnly(adminIds) {
  return async (ctx, next) => {
    if (adminIds.length === 0) {
      return next();
    }

    if (adminIds.includes(ctx.from?.id)) {
      return next();
    }

    await ctx.reply('Access denied.');
  };
}

async function showStats(ctx) {
  const stats = getStats();

  await answer(ctx, [
    'Stats',
    '',
    `Accounts: ${stats.totalAccounts}`,
    `Available: ${stats.availableAccounts}`,
    `Rented: ${stats.rentedAccounts}`,
    `Active rentals: ${stats.activeRentals}`,
    `Orders: ${stats.totalOrders}`,
  ].join('\n'));
}

async function showAccounts(ctx) {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    await answer(ctx, 'No accounts yet. Add one with:\n/add_acc title | login | password');
    return;
  }

  await answer(ctx, [
    'Accounts',
    '',
    ...accounts.map((account) => (
      `#${account.id} ${account.title} - ${account.status}\nLogin: ${account.login}`
    )),
  ].join('\n\n'));
}

async function showActiveRentals(ctx) {
  const rentals = getActiveRentals();

  if (rentals.length === 0) {
    await answer(ctx, 'No active rentals.');
    return;
  }

  await answer(ctx, [
    'Active rentals',
    '',
    ...rentals.map((rental) => (
      `#${rental.id} account #${rental.accountId}\nBuyer: ${rental.buyer}\nUntil: ${rental.endsAt}`
    )),
  ].join('\n\n'));
}

async function addAccountCommand(ctx) {
  const rawText = getMessageText(ctx);
  const payload = rawText.replace(/^\/add[_-]acc(?:@\w+)?\s*/i, '').trim();

  if (!payload) {
    await answer(ctx, [
      'Send account data in this format:',
      '',
      '/add_acc title | login | password',
      '',
      'Example:',
      '/add_acc CS2 Prime #1 | user_login | user_password',
    ].join('\n'));
    return;
  }

  const [title, login, password] = payload.split('|').map((part) => part.trim());

  if (!title || !login || !password) {
    await answer(ctx, 'Invalid format. Use: /add_acc title | login | password');
    return;
  }

  const account = addAccount({ title, login, password });

  await answer(ctx, [
    `Account #${account.id} added as a temporary draft.`,
    '',
    `Title: ${account.title}`,
    `Login: ${account.login}`,
    'Status: available',
  ].join('\n'));
}

async function showOrders(ctx) {
  const orders = getOrders();

  if (orders.length === 0) {
    await answer(ctx, 'No orders yet. FunPay integration will fill this later.');
    return;
  }

  await answer(ctx, [
    'Orders',
    '',
    ...orders.map((order) => `#${order.id} ${order.status} - ${order.title}`),
  ].join('\n'));
}

async function showSettings(ctx) {
  await answer(ctx, [
    'Settings',
    '',
    'Storage: in-memory draft',
    'FunPay: not connected',
    'Steam: not connected',
    'Security: admin allowlist via TG_ADMIN_IDS',
  ].join('\n'));
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Stats', 'stats'),
      Markup.button.callback('Accounts', 'accs'),
    ],
    [
      Markup.button.callback('Rentals', 'active_rentals'),
      Markup.button.callback('Orders', 'orders'),
    ],
    [Markup.button.callback('Settings', 'settings')],
  ]);
}

function formatHelp() {
  return [
    'Available commands:',
    '',
    '/stats - summary',
    '/accs - accounts list',
    '/active_rentals - active rentals',
    '/add_acc title | login | password - add account draft',
    '/orders - orders list',
    '/settings - bot settings',
  ].join('\n');
}

function getMessageText(ctx) {
  return ctx.message?.text ?? ctx.update?.message?.text ?? '';
}

async function answer(ctx, text) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    await ctx.editMessageText(text, mainMenu());
    return;
  }

  await ctx.reply(text, mainMenu());
}
