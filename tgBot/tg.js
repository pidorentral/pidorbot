import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import {
  addAccount,
  attachMafileToAccount,
  getAccounts,
  getAccountById,
  getActiveRentals,
  getOrders,
  getStats,
  setAccountStatus,
  deleteAccount,
  updateAccount,
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

// Handlers must be defined before createBot registers them.
async function showActiveRentals(ctx) {
  const rentals = await getActiveRentals();

  if (!rentals || rentals.length === 0) {
    await answer(ctx, 'No active rentals.');
    return;
  }

  await answer(ctx, [
    'Active rentals',
    '',
    ...rentals.map((r) => `#${r.id} account #${r.accountId}\nBuyer: ${r.buyer}\nUntil: ${r.endsAt}`),
  ].join('\n\n'));
}

async function showOrders(ctx) {
  const orders = await getOrders();

  if (!orders || orders.length === 0) {
    await answer(ctx, 'No orders yet.');
    return;
  }

  await answer(ctx, [
    'Orders',
    '',
    ...orders.map((o) => `#${o.id} ${o.status} ${o.funpayOrderId || ''}`),
  ].join('\n'));
}

async function showSettings(ctx) {
  await answer(ctx, ['Settings', '', 'No configurable settings yet.'].join('\n'));
}

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
    const account = await getAccountById(accountId, { includeSecrets: true });

    if(!account) {
      await safeAnswerCb(ctx, 'Account not found');
      return ctx.editMessageText('Account not found');
    }

    if (!account.sharedSecret) {
      return safeAnswerCb(ctx, 'Steam Guard is not connected');
    }

    const code = generateSteamGuardCode(account.sharedSecret);

    await safeAnswerCb(ctx);
    return ctx.reply(code);
  });

  bot.action('accs_back', async (ctx) => {
    const accounts = await getAccounts();

    await safeAnswerCb(ctx);

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
      return safeAnswerCb(ctx, 'No active add account flow pizdabol')
    }

    const account = await addAccount({
      title: session.data.title,
      login: session.data.login,
      password: session.data.password,
      notes: null,
    });

    if (session.data.sharedSecret) {
      await attachMafileToAccount(account.id, {
        sharedSecret: session.data.sharedSecret,
        identitySecret: session.data.identitySecret,
        rawJson: session.data.raw,
      });
    }

    //console.log(account)

    sessions.delete(ctx.from.id);

    await safeAnswerCb(ctx);
    return ctx.editMessageText(`Account #${account.id} added`)
  });

  bot.action('add_acc_cancel', async (ctx) => {
    sessions.delete(ctx.from.id);

    await safeAnswerCb(ctx)
    return ctx.editMessageText('Account adding canceled')
  });

  bot.action(/^acc_open:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId, { includeSecrets: true });

    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return ctx.editMessageText('Account not found.');
    }

    await safeAnswerCb(ctx);

    return ctx.editMessageText(
      formatAccountCard(account),
      accountCardKeyboard(account),
    );
    }
  );

  bot.action(/^acc_password:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId, { includeSecrets: true });

    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return ctx.editMessageText('Account not found.');
    }

    console.log(`Admin ${ctx.from.id} viewed password for account #${account.id}`);

    await safeAnswerCb(ctx);

    return ctx.editMessageText(
      formatAccountCard(account, { showPassword: true }),
      accountCardKeyboard(account),
    );
  });

  // Disable / enable flow: ask for confirmation
  bot.action(/^acc_disable:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId, { includeSecrets: true });
    await safeAnswerCb(ctx);

    if (account?.status === 'disabled') {
      return ctx.editMessageText(
        'Enable this account again?',
        confirmKeyboard('acc_enable', accountId),
      );
    }

    return ctx.editMessageText(
      'Disable this account? It will become inactive and unusable until enabled.',
      confirmKeyboard('acc_disable', accountId),
    );
  });

  bot.action(/^acc_disable_confirm:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    await setAccountStatus(accountId, 'disabled');
    const account = await getAccountById(accountId, { includeSecrets: true });
    return ctx.editMessageText(
      formatAccountCard(account),
      accountCardKeyboard(account),
    );
  });

  bot.action(/^acc_enable_confirm:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    await setAccountStatus(accountId, 'available');
    const account = await getAccountById(accountId, { includeSecrets: true });
    return ctx.editMessageText(
      formatAccountCard(account),
      accountCardKeyboard(account),
    );
  });

  bot.action(/^acc_disable_cancel:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    const account = await getAccountById(accountId, { includeSecrets: true });
    return ctx.editMessageText(formatAccountCard(account), accountCardKeyboard(account));
  });

  bot.action(/^acc_enable_cancel:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    const account = await getAccountById(accountId, { includeSecrets: true });
    return ctx.editMessageText(formatAccountCard(account), accountCardKeyboard(account));
  });

  // Delete flow: confirmation required
  bot.action(/^acc_delete:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    return ctx.editMessageText('Delete this account? This action cannot be undone.', confirmKeyboard('acc_delete', accountId));
  });

  bot.action(/^acc_delete_confirm:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    await deleteAccount(accountId);
    return ctx.editMessageText(`Account #${accountId} deleted.`, mainMenu());
  });

  bot.action(/^acc_delete_cancel:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    const account = await getAccountById(accountId, { includeSecrets: true });
    return ctx.editMessageText(formatAccountCard(account), accountCardKeyboard(account));
  });

  // Add mafile quick flow
  bot.action(/^acc_add_mafile:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    sessions.set(ctx.from.id, { flow: 'add_mafile', step: 'mafile', accountId, data: {} });
    await safeAnswerCb(ctx);
    return ctx.reply('Send mafile JSON text:');
  });

  // Edit flow: start interactive edit
  bot.action(/^acc_edit:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId);
    sessions.set(ctx.from.id, {
      flow: 'edit_account',
      step: 'title',
      accountId,
      data: { title: account.title, login: account.login, password: null, notes: account.notes },
    });
    await safeAnswerCb(ctx);
    return ctx.reply(`Editing account #${accountId}. Enter new title (current: ${account.title}):`);
  });

  bot.action('edit_acc_save', async (ctx) => {
    await safeAnswerCb(ctx);
    const session = sessions.get(ctx.from.id);
    if (!session || session.flow !== 'edit_account') {
      return ctx.reply('No edit session found.');
    }
    const updates = {};
    if (session.data.title) updates.title = session.data.title;
    if (session.data.login) updates.login = session.data.login;
    if (session.data.password && session.data.password.length > 0) updates.password = session.data.password;
    if (session.data.notes !== undefined) updates.notes = session.data.notes;

    await updateAccount(session.accountId, updates);
    sessions.delete(ctx.from.id);
    const account = await getAccountById(session.accountId);
    return ctx.reply('Account updated.', accountCardKeyboard(account));
  });

  bot.action('edit_acc_cancel', async (ctx) => {
    await safeAnswerCb(ctx);
    sessions.delete(ctx.from.id);
    return ctx.reply('Edit cancelled.');
  });

  bot.action('add_acc_mafile_yes', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if (!session || session.flow !== 'add_account') {
      return safeAnswerCb(ctx, 'No active add account flow');
    }

    session.step = 'mafile';

    await safeAnswerCb(ctx);
    return ctx.editMessageText('Send mafile JSON text:');
  });

  bot.action('add_acc_mafile_skip', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if (!session || session.flow !== 'add_account') {
      return safeAnswerCb(ctx, 'No active add account flow');
    }

    session.step = 'confirm';

    await safeAnswerCb(ctx);
    return ctx.editMessageText(formatAddAccountConfirm(session.data), addAccountConfirmKeyboard());
  });

  bot.on('text', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if (session?.flow === 'add_account' || session?.flow === 'edit_account' || session?.flow === 'add_mafile') {
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

async function safeAnswerCb(ctx, ...args) {
  try {
    // use apply to preserve arguments
    await ctx.answerCbQuery(...args);
  } catch (err) {
    // swallow Telegram "query is too old" / invalid callback errors
    const desc = err?.response?.description || err?.message || '';
    if (typeof desc === 'string' && (desc.includes('query is too old') || desc.includes('query ID is invalid') || desc.includes('QUERY_ID')) ) {
      return;
    }
    // otherwise log and continue
    console.error('answerCbQuery failed', err?.response || err?.message || err);
  }
}

// /stats

async function showStats(ctx) {
  const stats = await getStats();

  await answer(ctx, [
    'Stats',
    '',
    `Accounts: ${stats.totalAccounts}`,
    `Available: ${stats.available}`,
    `Rented: ${stats.rented}`,
    `Active rentals: ${stats.activeRentals}`,
    `New orders: ${stats.newOrders}`,
  ].join('\n'));
}

// /accs

async function showAccounts(ctx) {
  const accounts = await getAccounts();

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
    `Steam Guard: ${account.sharedSecret || account.steamId ? 'connected' : 'not connected'}`,
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
  const firstRow = [Markup.button.callback('Show password', `acc_password:${account.id}`)];
  const hasSteamSecrets = Boolean(
    account.sharedSecret || account.identitySecret || account.mafileId || account.steamId
  );

  if (hasSteamSecrets) {
    firstRow.push(Markup.button.callback('Get code', `acc_code:${account.id}`));
  } else {
    firstRow.push(Markup.button.callback('Add mafile', `acc_add_mafile:${account.id}`));
  }

  const disableButtonLabel = account.status === 'disabled' ? 'Enable' : 'Disable';

  return Markup.inlineKeyboard([
    firstRow,
    [
      Markup.button.callback('Edit', `acc_edit:${account.id}`),
      Markup.button.callback(disableButtonLabel, `acc_disable:${account.id}`),
    ],
    [
      Markup.button.callback('Delete', `acc_delete:${account.id}`),
      Markup.button.callback('Back', 'accs_back'),
    ],
  ]);
}

function confirmKeyboard(actionPrefix, id) {
  const cancelAction = actionPrefix === 'acc_enable' ? 'acc_enable_cancel' : 'acc_disable_cancel';
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Confirm', `${actionPrefix}_confirm:${id}`),
      Markup.button.callback('Cancel', `${cancelAction}:${id}`),
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
    return ctx.reply('Send text value');
  }

  // add_account flow (creates new account)
  if (session.flow === 'add_account') {
    switch (session.step) {
      case 'title':
        session.data.title = text;
        session.step = 'login';
        return ctx.reply('Enter login:');

      case 'login':
        session.data.login = text;
        session.step = 'password';
        return ctx.reply('Enter password:');

      case 'password':
        session.data.password = text;
        session.step = 'mafile_choice';
        return ctx.reply(
          'Attach mafile now?',
          Markup.inlineKeyboard([
            [Markup.button.callback('Yes', 'add_acc_mafile_yes'), Markup.button.callback('Skip', 'add_acc_mafile_skip')],
          ]),
        );

      case 'mafile':
        try {
          const mafileData = parseMafile(text);
          session.data.sharedSecret = mafileData.sharedSecret;
          session.data.identitySecret = mafileData.identitySecret;
          session.data.steamId = mafileData.steamId;
          session.data.accountName = mafileData.accountName;

          if (!session.data.login && mafileData.accountName) {
            session.data.login = mafileData.accountName;
          }

          session.step = 'confirm';
          return ctx.reply(formatAddAccountConfirm(session.data), addAccountConfirmKeyboard());
        } catch (err) {
          return ctx.reply(`Error parsing mafile: ${err.message}`);
        }

      default:
        sessions.delete(ctx.from.id);
        return ctx.reply('Add account flow was reset. Use /add_acc again');
    }
  }

  // add_mafile flow (attach mafile to existing account)
  if (session.flow === 'add_mafile') {
    try {
      const mafileData = parseMafile(text);
      await attachMafileToAccount(session.accountId, {
        sharedSecret: mafileData.sharedSecret,
        identitySecret: mafileData.identitySecret,
        rawJson: mafileData.raw,
      });
      sessions.delete(ctx.from.id);
      await ctx.reply('Mafile attached successfully.');
      return;
    } catch (err) {
      return ctx.reply(`Error parsing mafile: ${err.message}`);
    }
  }

  // edit_account flow
  if (session.flow === 'edit_account') {
    switch (session.step) {
      case 'title':
        session.data.title = text;
        session.step = 'login';
        return ctx.reply(`Enter login (current: ${session.data.login || ''}):`);

      case 'login':
        session.data.login = text;
        session.step = 'password';
        return ctx.reply('Enter password (send blank to keep unchanged):');

      case 'password':
        session.data.password = text;
        session.step = 'notes';
        return ctx.reply(`Enter notes (current: ${session.data.notes || ''}):`);

      case 'notes':
        session.data.notes = text;
        session.step = 'confirm';
        await ctx.reply(formatAddAccountConfirm(session.data), Markup.inlineKeyboard([[Markup.button.callback('Save', 'edit_acc_save'), Markup.button.callback('Cancel', 'edit_acc_cancel')]]));
        return;

      default:
        sessions.delete(ctx.from.id);
        return ctx.reply('Edit flow was reset.');
    }
  }

  return ctx.reply('No active session flow.');
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
    await safeAnswerCb(ctx);
    await ctx.editMessageText(text, keyboard);
    return;
  }

  await ctx.reply(text, keyboard);
}
