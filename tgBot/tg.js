import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import {
  addAccount,
  getAccounts,
  getAccountById,
  getActiveRentals,
  getOrders,
  getStats,
} from './services/rentalStore.js';
import { parseMafile } from '../steam/mafile.js';
import { generateSteamGuardCode } from '../steam/steamGuard.js';

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
        'Use /add_acc to add a temporary account draft.',
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
  bot.action(/^acc_code:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = getAccountById(accountId);

    if(!account) {
      await ctx.answerCbQuery('Account not found');
      return ctx.editMessageText('Account not found');
    }

    if (!account.sharedSecret) {
      return ctx.answerCbQuery('Steam Guard is not connected');
    }

    const code = generateSteamGuardCode(account.sharedSecret)

    await ctx.answerCbQuery();
    return ctx.reply(code)
  })

  bot.action('accs_back', async (ctx) => {
    const accounts = getAccounts();

    await ctx.answerCbQuery();

    if (accounts.length === 0) {
      return ctx.editMessageText(
        'No accounts yet. Add one with: \n/add_acc',
        mainMenu(),
      );
    }

    return ctx.editMessageText(
      formatAccountsList(accounts),
      accountsListKeyboard(accounts),
    );
  });


  bot.action('add_acc_save', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if(!session || session.flow !== 'add_account') {
      return ctx.answerCbQuery('No active add account flow pizdabol')
    }

    const account = addAccount({
      title: session.data.title,
      login: session.data.login,
      password: session.data.password,
      sharedSecret: session.data.sharedSecret,
      identitySecret: session.data.identitySecret,
      steamId: session.data.steamId,
      accountName: session.data.accountName,
    })

    console.log(account)

    sessions.delete(ctx.from.id);

    await ctx.answerCbQuery();
    return ctx.editMessageText(`Account #${account.id} added`)
  });

  bot.action('add_acc_cancel', async (ctx) => {
    sessions.delete(ctx.from.id);

    await ctx.answerCbQuery()
    return ctx.editMessageText('Account adding canceled')
  });

  bot.action(/^acc_open:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = getAccountById(accountId);

    if (!account) {
      await ctx.answerCbQuery('Account not found.');
      return ctx.editMessageText('Account not found.');
    }

    await ctx.answerCbQuery();

    return ctx.editMessageText(
      formatAccountCard(account),
      accountCardKeyboard(account),
    );
    }
  );

  bot.action(/^acc_password:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = getAccountById(accountId);

    if (!account) {
      await ctx.answerCbQuery('Account not found.');
      return ctx.editMessageText('Account not found.');
    }

    console.log(`Admin ${ctx.from.id} viewed password for account #${account.id}`)

    await ctx.answerCbQuery();

    return ctx.editMessageText(
      formatAccountCard(account, { showPassword: true}),
      accountCardKeyboard(account),
    );
    }
  );

  bot.action('add_acc_mafile_yes', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if (!session || session.flow !== 'add_account') {
      return ctx.answerCbQuery('No active add account flow');
    }

    session.step = 'mafile';

    await ctx.answerCbQuery();
    return ctx.editMessageText('Send mafile JSON text:');
  });

  bot.action('add_acc_mafile_skip', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if (!session || session.flow !== 'add_account') {
      return ctx.answerCbQuery('No active add account flow');
    }

    session.step = 'confirm';

    await ctx.answerCbQuery();
    return ctx.editMessageText(formatAddAccountConfirm(session.data), addAccountConfirmKeyboard());
  });

  bot.on('text', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if (session?.flow === 'add_account') {
      return continueAddAccount(ctx, session);
    }

    return ctx.reply('Unknown command');
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

// /stats

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

// /accs

async function showAccounts(ctx) {
  const accounts = getAccounts();

  if (accounts.length === 0) {
    await answer(ctx, 'No accounts yet. Add one with:\n/add_acc');
    return;
  }

  return answer(
    ctx,
    formatAccountsList(accounts),
    accountsListKeyboard(accounts),
  );
}

function formatAccountCard(account, options = {}) {
  const password = options.showPassword ? account.password : '********';

  return [
    `Account #${account.id}`,
    '',
    `Title: ${account.title}`,
    `Login: ${account.login}`,
    `Password: ${password}`,
    `Status: ${account.status}`,
    `Steam Guard: ${account.sharedSecret ? 'connected' : 'not connected'}`,
  ].join('\n');
}

function formatAccountsList(accounts) {
  return [
    'Accounts:',
    '',
    ...accounts.map((account) => (
      `#${account.id} ${account.title}\nStatus: ${account.status}`
    )),
  ].join('\n\n')
}

function accountCardKeyboard(account) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Show password', `acc_password:${account.id}`),
      Markup.button.callback('Get code', `acc_code:${account.id}`),
    ],
    [
      Markup.button.callback('Edit', `acc_edit:${account.id}`),
      Markup.button.callback('Disable', `acc_disable:${account.id}`),
    ],
    [
      Markup.button.callback('Delete', `acc_delete:${account.id}`),
      Markup.button.callback('Back', 'accs_back'),
    ],
  ]);
}

function accountsListKeyboard(accounts) {
  return Markup.inlineKeyboard([
    ...accounts.map((account) => [
      Markup.button.callback(
        `Open #${account.id}`,
        `acc_open:${account.id}`,
      ),
    ]),
  ]);
}

// /add_acc

const sessions = new Map();

function formatAddAccountConfirm(data) {
  return [
    'Check account data: ',
    '',
    `Title: ${data.title}`,
    `Login: ${data.login}`,
    `Password: ********`,
    `Steam Guard: ${data.sharedSecret ? 'connected' : 'not_connected'}`,
    data.steamId ? `SteamID: ${data.steamId}` : null,
    '',
    'Save account?',
  ].filter(Boolean).join('\n')
}

function addAccountConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Save', 'add_acc_save'),
      Markup.button.callback('Cancel', 'add_acc_cancel'),
    ],
  ]);
}

async function addAccountCommand(ctx) {
  let session = sessions.get(ctx.from.id);

  sessions.set(ctx.from.id, {
    flow: 'add_account',
    step: 'title',
    data: {},
  });

  return ctx.reply('Enter title:');
}

async function continueAddAccount(ctx, session) {
  const text = ctx.message?.text?.trim();

  if (!text) {
    return ctx.reply('Send text value gandon')
  }

  switch (session.step) {
    case 'title':
      session.data.title = text;
      session.step = 'login';
      return ctx.reply('Enter login:');

    case 'login':
      session.data.login = text;
      session.step = 'password';
      return ctx.reply('Enter password:');

    // case 'password':
    //   session.data.password = text;
    //   session.step = 'confirm';

    //   return ctx.reply(
    //     [
    //       'Check account data:',
    //       '',
    //       `Title: ${session.data.title}`,
    //       `Login: ${session.data.login}`,
    //       `Password: ********`,
    //       '',
    //       'Save account?',
    //     ].join('\n'),
    //   Markup.inlineKeyboard([
    //     [Markup.button.callback('Save', 'add_acc_save'),
    //       Markup.button.callback('Cancel', 'add_acc_cancel'),
    //     ],
    //   ]),
    // );

    case 'password':
      session.data.password = text;
      session.step = 'mafile_choice';

      return ctx.reply(
        'Attach mafile now?',
        Markup.inlineKeyboard([
          [
            Markup.button.callback('Yes', 'add_acc_mafile_yes'),
            Markup.button.callback('Skip', 'add_acc_mafile_skip'),
          ],
        ]),
      );
    
    case 'mafile':
      try{
        const mafileData = parseMafile(text);

        session.data.sharedSecret = mafileData.sharedSecret;
        session.data.identitySecret = mafileData.identitySecret;
        session.data.steamId = mafileData.steamId;
        session.data.accountName = mafileData.accountName;

        if (!session.data.login && mafileData.accountName) {
          session.data.login = mafileData.accountName;
        }

        session.step = 'confirm';

        return ctx.reply(
          formatAddAccountConfirm(session.data),
          addAccountConfirmKeyboard(),
        );
      } catch (error) {
        return ctx.reply(`Error: ${error.message}`)
      }

    default:
      sessions.delete(ctx.from.id);
      return ctx.reply("Add account flow was reset. Use /add_acc again")
  }
}

// /active_rentals

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

// async function handleText(ctx) {
//   const session = sessions.get(ctx.from.id);

//   if (session?.flow === 'add_account') {
//     return continueAddAccount(ctx, session);
//   }

//   await ctx.reply('Unknown command. Use /help.');
// }

// /orders

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

// /settings

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
    '/add_acc - add an account',
    '/orders - orders list',
    '/settings - bot settings',
  ].join('\n');
}

function getMessageText(ctx) {
  return ctx.message?.text ?? ctx.update?.message?.text ?? '';
}

async function answer(ctx, text, keyboard = mainMenu()) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery();
    await ctx.editMessageText(text, keyboard);
    return;
  }

  await ctx.reply(text, keyboard);
}
