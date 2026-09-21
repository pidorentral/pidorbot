import { Telegraf, Markup } from 'telegraf';
import { getConfig } from './config.js';
import { query } from '../src/db.js';
import { SteamAccountRecoverer, isPasswordChangeEnabled } from '../steam/accountRecoverer.js';
import {
  addAccount,
  attachMafileToAccount,
  updateMafileCookies,
  getAccounts,
  getAccountById,
  getActiveRentals,
  getRentalCleanupHistory,
  getOrders,
  getStats,
  setAccountStatus,
  deleteAccount,
  updateAccount,
  bindAccountOffer,
  unbindAccountOffer,
  listAccountOffers,
  createReview,
  getOrderByFunpayId,
  getOrderById,
  getPendingReviews,
  getReviewById,
  verifyReview,
  rejectReview,
  extendActiveRental,
} from './services/rentalStore.js';
import { parseMafile } from '../steam/mafile.js';
import { generateSteamGuardCode } from '../steam/steamGuard.js';
import * as crypto from '../src/crypto.js';
import { getGoldenKey, setGoldenKey, getProxyUrl, setProxyUrl, clearProxyUrl } from '../src/funpay/client.js';

const COMMANDS = [
  { command: 'stats', description: 'Summary: accounts, rentals, orders' },
  { command: 'reviews', description: 'Pending review claims' },
  { command: 'accs', description: 'Accounts list' },
  { command: 'active_rentals', description: 'Active rentals' },
  { command: 'add_acc', description: 'Add account draft' },
  { command: 'recover_test', description: 'Run Steam recovery smoke test: /recover_test <account_id>' },
  { command: 'bind_offer', description: 'Bind account: /bind_offer <account> <offer> <hours>' },
  { command: 'unbind_offer', description: 'Remove account-offer binding' },
  { command: 'offers', description: 'List offer bindings' },
  { command: 'orders', description: 'Orders list' },
  { command: 'settings', description: 'Bot settings' },
  { command: 'claim_review', description: 'Claim review bonus' },
];

export function parseSteamCookiesInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    return null;
  }

  const text = rawInput.trim();
  if (!text || text.toLowerCase() === 'skip') {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const result = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) {
      continue;
    }
    const stringValue = String(value).trim();
    if (stringValue.length > 0) {
      result[key] = stringValue;
    }
  }

  if (!result.sessionid || !result.steamLoginSecure) {
    return null;
  }

  return result;
}

function hasWhitespace(value) {
  return Array.from(value).some((character) => character.trim() === '');
}

export function validateSteamCookieValue(name, rawValue) {
  const value = typeof rawValue === 'string' ? rawValue : '';

  if (!value || hasWhitespace(value)) {
    return { ok: false, message: `${name} не должно быть пустым и не должно содержать пробелы или переносы строк.` };
  }

  if (name === 'sessionid') {
    if (value.length < 10) {
      return { ok: false, message: '❌ sessionid слишком короткий (минимум 10 символов).\nУбедитесь, что вы скопировали полное значение.\nПопробуйте снова или нажмите «Отмена».' };
    }

    const hasOnlyAllowedCharacters = Array.from(value).every((character) => (
      (character >= 'a' && character <= 'z')
      || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9')
      || character === '-'
    ));
    if (!hasOnlyAllowedCharacters) {
      return { ok: false, message: '❌ sessionid содержит недопустимые символы.\nРазрешены только буквы, цифры и дефис.\nПопробуйте снова или нажмите «Отмена».' };
    }
  }

  if (name === 'steamLoginSecure' && value.length < 20) {
    return { ok: false, message: '❌ steamLoginSecure слишком короткий (минимум 20 символов).\nУбедитесь, что вы скопировали полное значение.\nПопробуйте снова или нажмите «Отмена».' };
  }

  return { ok: true, value };
}

export function extractSteamCookiesFromMafile(rawValue) {
  if (!rawValue) {
    return null;
  }

  try {
    const tryDecryptString = (candidate) => {
      if (typeof candidate !== 'string') {
        return null;
      }

      const decrypted = crypto.decrypt(candidate);
      if (!decrypted) {
        return null;
      }

      try {
        const parsed = JSON.parse(decrypted);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed.cookies || parsed;
        }
      } catch {
        // fall through to plain decrypted text inspection below
      }

      try {
        const parsed = JSON.parse(decrypted.replace(/^['"]|['"]$/g, ''));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed.cookies || parsed;
        }
      } catch {
        // no-op
      }

      return null;
    };

    let raw = rawValue;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') {
          const decrypted = tryDecryptString(parsed);
          if (decrypted) {
            return decrypted;
          }
          raw = parsed;
        } else if (parsed && typeof parsed === 'object') {
          raw = parsed;
        }
      } catch {
        // raw is already a plain cookie JSON string, keep it as is
      }
    }

    if (typeof raw === 'string') {
      const decrypted = tryDecryptString(raw);
      if (decrypted) {
        return decrypted;
      }
    }

    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed.cookies || parsed;
        }
      } catch {
        // raw is not JSON
      }
    }

    if (raw && typeof raw === 'object') {
      return raw.cookies || raw;
    }

    if (typeof rawValue === 'string') {
      try {
        const decrypted = JSON.parse(rawValue);
        if (typeof decrypted === 'string') {
          const nested = tryDecryptString(decrypted);
          if (nested) {
            return nested;
          }
        }
      } catch {
        // no-op: rawValue is not decrypted text
      }
    }

    return null;
  } catch {
    return null;
  }
}

function buildRentalExtensionKeyboard(rentalId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('+1h', `rental_extend:${rentalId}:1`),
      Markup.button.callback('+2h', `rental_extend:${rentalId}:2`),
      Markup.button.callback('+4h', `rental_extend:${rentalId}:4`),
    ],
    [Markup.button.callback('Custom hours', `rental_extend_custom:${rentalId}`)],
    [Markup.button.callback('Main menu', 'main_menu')],
  ]);
}

function reviewDecisionKeyboard(reviewId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Confirm', `review_confirm:${reviewId}`),
      Markup.button.callback('Reject', `review_reject:${reviewId}`),
    ],
    [Markup.button.callback('Back', 'reviews')],
    [Markup.button.callback('Main menu', 'main_menu')],
  ]);
}

function yesSkipKeyboard(yesAction, skipAction) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Yes', yesAction), Markup.button.callback('Skip', skipAction)],
  ]);
}

async function showActiveRentals(ctx) {
  const rentals = await getActiveRentals();

  if (!rentals || rentals.length === 0) {
    await answer(ctx, 'No active rentals.');
    return;
  }

  const lines = rentals.map((r) => `#${r.id} account #${r.accountId}\nBuyer: ${r.buyer}\nUntil: ${r.endsAt}`);
  const keyboard = Markup.inlineKeyboard([
    ...rentals.map((r) => [Markup.button.callback(`#${r.id} · extend`, `rental_extend_custom:${r.id}`)]),
    [Markup.button.callback('Main menu', 'main_menu')],
  ]);

  await answer(ctx, ['Active rentals', '', ...lines].join('\n\n'), keyboard);
}

async function showOrders(ctx) {
  const orders = await getOrders();
  await answer(ctx, [
    'Orders',
    '',
    ...orders.map((o) => `#${o.id} ${o.status} ${o.funpayOrderId || ''}`),
  ].join('\n'));
}

async function showCleanupHistory(ctx) {
  const rentals = await getRentalCleanupHistory();
  if (!rentals.length) {
    await answer(ctx, 'Cleanup history is empty.');
    return;
  }

  const lines = rentals.map((rental) => [
    `#${rental.id} · account #${rental.accountId} (${rental.title})`,
    `Rental status: ${rental.status || 'unknown'}`,
    `Cleanup: ${formatCleanupStatus(rental)}`,
    rental.cleanupAttempts ? `Attempts: ${rental.cleanupAttempts}` : null,
    rental.cleanupNextRetryAt ? `Next retry: ${rental.cleanupNextRetryAt}` : null,
    rental.cleanupLastError ? `Error: ${rental.cleanupLastError}` : null,
  ].filter(Boolean).join('\n'));

  await answer(ctx, ['Cleanup history', '', ...lines].join('\n\n'));
}

function formatCleanupStatus(rental) {
  if (rental.cleanupStatus === 'failed_permanent') return '🚨 permanently failed';
  if (rental.cleanupStatus === 'scheduled_retry') return '🔁 retry scheduled';
  if (rental.cleanupCompletedAt) return '✅ completed';
  if (rental.cleanupStatus) return rental.cleanupStatus;
  return '⏳ pending';
}

function formatProxyDisplay(proxyValue) {
  if (typeof proxyValue !== 'string') {
    return 'not configured';
  }

  const value = proxyValue.trim();
  if (!value) {
    return 'not configured';
  }

  try {
    const parsed = new URL(value);
    return parsed.hostname || parsed.host || value;
  } catch {
    const withoutScheme = value.replace(/^.*:\/\//, '').replace(/^[^@]+@/, '');
    const hostAndPort = withoutScheme.split('/')[0];
    return hostAndPort.replace(/:\d+$/, '');
  }
}

async function showSettings(ctx) {
  let currentKey = 'not configured';
  try {
    const value = await getGoldenKey();
    currentKey = `${value.slice(0, 6)}********`;
  } catch {
    // keep the safe fallback above
  }

  let currentProxy = 'not configured';
  let hasProxy = false;
  try {
    const proxy = await getProxyUrl();
    if (proxy) {
      hasProxy = true;
      currentProxy = formatProxyDisplay(proxy);
    }
  } catch {
    // keep the safe fallback above
  }

  const actions = [
    [Markup.button.callback('Update FunPay key', 'settings_update_funpay_key')],
    [Markup.button.callback('Update FunPay proxy', 'settings_update_funpay_proxy')],
    [Markup.button.callback('Main menu', 'main_menu')],
  ];

  await answer(
    ctx,
    ['Settings', '', `FunPay key: ${currentKey}`, `Proxy: ${currentProxy}`, '', 'Update the active key or proxy securely in the database.'].join('\n'),
    Markup.inlineKeyboard(actions),
  );
}

async function bindOfferCommand(ctx) {
  const [, accountIdRaw, offerId, hoursRaw] = ctx.message.text.trim().split(/\s+/);
  const accountId = Number(accountIdRaw);
  const hoursPerLot = Number(hoursRaw);

  if (!Number.isSafeInteger(accountId) || accountId < 1 || !/^\d+$/.test(offerId || '') || !Number.isFinite(hoursPerLot) || hoursPerLot <= 0) {
    return ctx.reply('Usage: /bind_offer <account_id> <funpay_offer_id> <hours_per_lot>');
  }

  const binding = await bindAccountOffer(accountId, offerId, hoursPerLot);
  return ctx.reply(`Account #${binding.accountId} bound to offer ${binding.offerId}: ${binding.hoursPerLot} hour(s) per lot.`);
}

async function unbindOfferCommand(ctx) {
  const [, accountIdRaw, offerId] = ctx.message.text.trim().split(/\s+/);
  const accountId = Number(accountIdRaw);
  if (!Number.isSafeInteger(accountId) || accountId < 1 || !/^\d+$/.test(offerId || '')) {
    return ctx.reply('Usage: /unbind_offer <account_id> <funpay_offer_id>');
  }

  const binding = await unbindAccountOffer(accountId, offerId);
  return ctx.reply(binding ? `Binding #${accountId} → ${offerId} removed.` : 'Binding not found.');
}

async function showOffers(ctx) {
  const [, accountIdRaw] = ctx.message.text.trim().split(/\s+/);
  const accountId = accountIdRaw ? Number(accountIdRaw) : null;
  if (accountIdRaw && (!Number.isSafeInteger(accountId) || accountId < 1)) {
    return ctx.reply('Usage: /offers [account_id]');
  }

  const offers = await listAccountOffers(accountId);
  if (!offers.length) return ctx.reply('No offer bindings yet.');
  return ctx.reply(offers.map((offer) => `#${offer.accountId} (${offer.accountTitle}) → ${offer.offerId}: ${offer.hoursPerLot} hour(s)/lot`).join('\n'));
}

export function createBot(config = getConfig()) {
  const bot = new Telegraf(config.botToken);

  bot.catch((error, ctx) => {
    const description = error?.response?.description || error?.message || '';
    if (isMessageNotModifiedError(description)) {
      return;
    }
    console.error('Telegram update processing failed', {
      updateId: ctx?.update?.update_id,
      callbackData: ctx?.callbackQuery?.data,
      error,
    });
  });

  bot.use(adminOnly(config.adminIds));

  bot.start(async (ctx) => {
    await showAdminHome(ctx);
  });

  bot.help(async (ctx) => {
    await ctx.reply(formatHelp(), mainMenu());
  });

  bot.command('stats', showStats);
  bot.command('accs', (ctx) => showAccounts(ctx, 'all'));
  bot.command('active_rentals', showActiveRentals);
  bot.command('add_acc', addAccountCommand);
  bot.command('recover_test', recoverTestCommand);
  bot.command('bind_offer', bindOfferCommand);
  bot.command('unbind_offer', unbindOfferCommand);
  bot.command('offers', showOffers);
  bot.command('orders', showOrders);
  bot.command('cleanup_history', showCleanupHistory);
  bot.command('settings', showSettings);
  bot.command('claim_review', startClaimReview);
  bot.command('reviews', showReviews);

  bot.hears(/^\/active-rentals(?:\s|$)/i, showActiveRentals);
  bot.hears(/^\/add-acc(?:\s|$)/i, addAccountCommand);

  bot.action('stats', showStats);
  bot.action('accs', (ctx) => showAccounts(ctx, 'all'));
  bot.action('accounts_all', (ctx) => showAccounts(ctx, 'all'));
  bot.action('accounts_available', (ctx) => showAccounts(ctx, 'available'));
  bot.action('accounts_rented', (ctx) => showAccounts(ctx, 'rented'));
  bot.action('accounts_needs_cookies', (ctx) => showAccounts(ctx, 'needs_cookies'));
  bot.action('accounts_disabled', (ctx) => showAccounts(ctx, 'disabled'));
  bot.action('active_rentals', showActiveRentals);
  bot.action('main_menu', async (ctx) => {
    return showAdminHome(ctx);
  });
  bot.action('add_acc', addAccountCommand);
  bot.action('orders', showOrders);
  bot.action('cleanup_history', showCleanupHistory);
  bot.action('settings', showSettings);
  bot.action('settings_update_funpay_key', async (ctx) => {
    sessions.set(ctx.from.id, { flow: 'update_funpay_key', step: 'golden_key' });
    await safeAnswerCb(ctx);
    return ctx.editMessageText(
      'Send the new FunPay golden_key value. It will be encrypted and stored in the database, then applied immediately.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Cancel', 'settings')],
      ]),
    );
  });
  bot.action('settings_update_funpay_proxy', async (ctx) => {
    sessions.set(ctx.from.id, { flow: 'update_funpay_proxy', step: 'proxy' });
    await safeAnswerCb(ctx);
    return ctx.editMessageText(
      'Send the new FunPay proxy URL. Example: http://login:password@95.135.50.108:50100. Type remove to delete it.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Cancel', 'settings')],
      ]),
    );
  });
  bot.action('settings_remove_funpay_proxy', async (ctx) => {
    await safeAnswerCb(ctx);
    try {
      await clearProxyUrl();
      if (globalThis.__FUNPAY_CLIENT__ && typeof globalThis.__FUNPAY_CLIENT__.clearProxyUrl === 'function') {
        await globalThis.__FUNPAY_CLIENT__.clearProxyUrl();
      }
      return ctx.editMessageText('FunPay proxy removed successfully.', mainMenu());
    } catch (err) {
      return ctx.editMessageText(`Failed to remove FunPay proxy: ${err.message || err}`, mainMenu());
    }
  });
  bot.action('claim_review', startClaimReview);
  bot.action('reviews', showReviews);
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

    await showTyping(ctx);
    const account = await addAccount({
      title: session.data.title,
      login: session.data.login,
      password: session.data.password,
      notes: null,
      steamId: session.data.steamId || null,
    });

    const attachMafileData = (() => {
      const hasMafile = Boolean(session.data.raw || session.data.sharedSecret || session.data.identitySecret);
      const hasCookies = Boolean(session.data.cookies && Object.keys(session.data.cookies).length > 0);
      if (!hasMafile && !hasCookies) {
        return null;
      }

      const rawJson = hasMafile
        ? { ...(session.data.raw || {}), ...(hasCookies ? { cookies: session.data.cookies } : {}) }
        : { ...(hasCookies ? { cookies: session.data.cookies } : {}) };

      return {
        sharedSecret: session.data.sharedSecret || null,
        identitySecret: session.data.identitySecret || null,
        rawJson,
      };
    })();

    if (attachMafileData) {
      await attachMafileToAccount(account.id, attachMafileData);
    }

    sessions.delete(ctx.from.id);

    await safeAnswerCb(ctx);
    return ctx.editMessageText(`Account #${account.id} added`, mainMenu());
  });

  bot.action('add_acc_cancel', async (ctx) => {
    sessions.delete(ctx.from.id);

    await safeAnswerCb(ctx)
    return ctx.editMessageText('Account adding canceled', mainMenu())
  });

  // Reviews flow (admin)
  bot.action('reviews_back', async (ctx) => {
    await safeAnswerCb(ctx);
    return ctx.editMessageText('Admin menu', mainMenu());
  });

  bot.action(/^rental_extend_custom:(\d+)$/, async (ctx) => {
    const rentalId = Number(ctx.match[1]);
    sessions.set(ctx.from.id, { flow: 'extend_rental', step: 'hours', rentalId, data: { rentalId } });
    await safeAnswerCb(ctx);
    return ctx.editMessageText(`Enter extension hours for rental #${rentalId} (for example: 1, 2, 0.5):`, buildRentalExtensionKeyboard(rentalId));
  });

  bot.action(/^rental_extend:(\d+):(\d+(?:\.\d+)?)$/, async (ctx) => {
    const rentalId = Number(ctx.match[1]);
    const hours = Number(ctx.match[2]);
    await safeAnswerCb(ctx);

    try {
      const result = await extendActiveRental(rentalId, hours, { reason: 'telegram-admin' });
      const rental = await getActiveRentals().then((items) => items.find((it) => Number(it.id) === Number(result.rentalId)) || null);
      const message = [
        `Rental #${result.rentalId} extended by ${result.hours} hour(s).`,
        `New end: ${new Date(result.newEndsAt).toISOString()}`,
        rental?.buyer ? `Buyer: ${rental.buyer}` : null,
      ].filter(Boolean).join('\n');

      return ctx.editMessageText(message, mainMenu());
    } catch (err) {
      return ctx.editMessageText(uiError('extend rental', err, 'Failed to extend rental. Check the rental status and try again.'), mainMenu());
    }
  });

  async function showReviews(ctx) {
    const reviews = await getPendingReviews();
    if (!reviews || reviews.length === 0) {
      await answer(ctx, 'No pending reviews.');
      return;
    }

    const lines = reviews.map((r) => `#${r.id} order:${r.order_id} by:${r.user_id || 'unknown'} ${r.platform ? '(' + r.platform + ')' : ''}`);
    await answer(ctx, ['Pending reviews', '', ...lines].join('\n'), Markup.inlineKeyboard([
      ...reviews.map((r) => [Markup.button.callback(`Open #${r.id}`, `review_open:${r.id}`)]),
      [Markup.button.callback('Back', 'reviews_back')],
      [Markup.button.callback('Main menu', 'main_menu')],
    ]));
  }

  bot.action(/^review_open:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const review = await getReviewById(id);
    if (!review) {
      await safeAnswerCb(ctx);
      return ctx.editMessageText('Review not found');
    }

    const text = [
      `Review #${review.id}`,
      `Order: ${review.order_id}`,
      `User: ${review.user_id || 'unknown'}`,
      `Platform: ${review.platform || 'unknown'}`,
      `Rating: ${review.rating || 'n/a'}`,
      `Text: ${review.text || ''}`,
      `Link: ${review.link_or_screenshot || ''}`,
    ].join('\n');

    await safeAnswerCb(ctx);
    return ctx.editMessageText(text, Markup.inlineKeyboard([
      [Markup.button.callback('Auto-check', `review_auto:${review.id}`), Markup.button.callback('Confirm', `review_confirm:${review.id}`)],
      [Markup.button.callback('Reject', `review_reject:${review.id}`), Markup.button.callback('Back', 'reviews')],
    ]));
  });

  bot.action(/^review_auto:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    const review = await getReviewById(id);
    if (!review) return ctx.editMessageText('Review not found');

    // Show progress while the external review verifier is running.
    await showTyping(ctx);
    const verifier = await import('../src/reviewVerifier.js');
    const result = await verifier.autoVerifyReviewById(review);

    if (result.confidence >= 0.7) {
      // auto-approve
      await verifyReview(review.id, 'auto');
      return ctx.editMessageText(`Auto-verified (confidence=${result.confidence.toFixed(2)}): bonus granted.`, mainMenu());
    }

    return ctx.editMessageText(`Auto-check result: confidence=${result.confidence.toFixed(2)} reason=${result.reason}. Please review manually.`, reviewDecisionKeyboard(review.id));
  });

  bot.action(/^review_confirm:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    try {
      const res = await verifyReview(id, 'admin');
      return ctx.editMessageText(`Review #${id} verified. Rental extended.${res.rental ? ' Rental ID: ' + res.rental.id : ''}`, mainMenu());
    } catch (err) {
      return ctx.editMessageText(uiError('verify review', err, 'Failed to verify review. Please try again.'), mainMenu());
    }
  });

  bot.action(/^review_reject:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    try {
      await rejectReview(id, 'admin', 'rejected by admin');
      return ctx.editMessageText(`Review #${id} rejected.`, mainMenu());
    } catch (err) {
      return ctx.editMessageText(uiError('reject review', err, 'Failed to reject review. Please try again.'), mainMenu());
    }
  });

  bot.action('claim_review_confirm', async (ctx) => {
    const session = sessions.get(ctx.from.id);
    await safeAnswerCb(ctx);
    if (!session || session.flow !== 'claim_review' || session.step !== 'confirm') {
      return ctx.editMessageText('No claim session found.');
    }
    try {
      const payload = {
        orderId: session.data.orderId,
        userId: ctx.from.username || String(ctx.from.id),
        platform: 'funpay',
        rating: session.data.rating,
        text: session.data.text,
        link: session.data.link,
      };
      const newReview = await createReview({ orderId: payload.orderId, userId: payload.userId, platform: payload.platform, rating: payload.rating, text: payload.text, link: payload.link });
      sessions.delete(ctx.from.id);

      // notify admins with a quick action button
      try {
        const admins = config.adminIds || [];
        // include funpay order id and link if available
        const orderInfo = await getOrderById(newReview.order_id).catch(() => null);
        const funpayId = orderInfo?.funpayOrderId;
        const orderLink = funpayId ? `https://funpay.ru/orders/${funpayId}` : null;
        const submitter = newReview.user_id || (ctx.from?.username ? `@${ctx.from.username}` : String(ctx.from.id));

        const msg = [
          `New review submitted #${newReview.id}`,
          `Order: ${newReview.order_id}` + (funpayId ? ` (FunPay ID: ${funpayId})` : ''),
          orderLink ? `Order link: ${orderLink}` : null,
          `From: ${submitter}`,
          `Rating: ${newReview.rating || 'n/a'}`,
          `${newReview.link_or_screenshot ? 'Review link: ' + newReview.link_or_screenshot : ''}`,
        ].filter(Boolean).join('\n');

        const keyboard = Markup.inlineKeyboard([[Markup.button.callback(`Open #${newReview.id}`, `review_open:${newReview.id}`)]]);
        for (const id of admins) {
          try {
            await ctx.telegram.sendMessage(id, msg, keyboard);
          } catch (e) {
            console.error(`[telegram] failed to notify admin #${id}`, e);
          }
        }
      } catch (e) {
        console.error('[telegram] failed to prepare review notification', e);
      }

      return ctx.editMessageText('Review submitted. Admins will review and grant bonus if valid.', mainMenu());
    } catch (err) {
      return ctx.editMessageText(uiError('create review', err, 'Failed to submit review. Please try again.'), mainMenu());
    }
  });

  bot.action('claim_review_cancel', async (ctx) => {
    sessions.delete(ctx.from.id);
    await safeAnswerCb(ctx);
    return ctx.editMessageText('Review submission canceled.', mainMenu());
  });

  bot.action(/^acc_open:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId, { includeSecrets: true });

    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return ctx.editMessageText('Account not found.');
    }

    await safeAnswerCb(ctx);
    const uiAccount = await getAccountUiModel(account);

    return ctx.editMessageText(
      formatAccountCard(uiAccount),
      accountCardKeyboard(uiAccount),
    );
    }
  );

  bot.action(/^acc_offers:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId);
    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return;
    }

    const offers = await listAccountOffers(accountId);
    await safeAnswerCb(ctx);
    return ctx.editMessageText(formatAccountOffers(account, offers), accountOffersKeyboard(accountId, offers));
  });

  bot.action(/^acc_offer_add:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId);
    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return;
    }

    sessions.set(ctx.from.id, { flow: 'bind_offer_ui', step: 'binding', accountId });
    await safeAnswerCb(ctx);
    return ctx.reply('Send offer ID and hours per lot, for example: 123456 2');
  });

  bot.action(/^acc_offer_unbind:(\d+):(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const offerId = ctx.match[2];
    await safeAnswerCb(ctx);
    return ctx.editMessageText(
      `Unbind offer ${offerId} from account #${accountId}?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Confirm', `acc_offer_unbind_confirm:${accountId}:${offerId}`),
          Markup.button.callback('Cancel', `acc_offers:${accountId}`),
        ],
      ]),
    );
  });

  bot.action(/^acc_offer_unbind_confirm:(\d+):(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const offerId = ctx.match[2];
    await safeAnswerCb(ctx);
    await unbindAccountOffer(accountId, offerId);
    const account = await getAccountById(accountId);
    const offers = await listAccountOffers(accountId);
    return ctx.editMessageText(formatAccountOffers(account, offers), accountOffersKeyboard(accountId, offers));
  });

  bot.action(/^acc_password:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId, { includeSecrets: true });

    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return ctx.editMessageText('Account not found.');
    }

    const uiAccount = await getAccountUiModel(account);
    const currentMessageText = ctx.update?.callback_query?.message?.text;
    const targetText = formatAccountCard(uiAccount);
    await safeAnswerCb(ctx, 'Passwords are hidden for security.');
    if (currentMessageText === targetText) return;
    return ctx.editMessageText(targetText, accountCardKeyboard(uiAccount));
  });

  bot.action(/^acc_test_recovery:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId, { includeSecrets: true });

    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return ctx.editMessageText('Account not found.');
    }

    await safeAnswerCb(ctx, 'Starting recovery test...');
    await showTyping(ctx);

    const result = await runRecoverySmokeTest(accountId);
    const updatedAccount = await getAccountUiModel(await getAccountById(accountId, { includeSecrets: true }));
    const currentMessageText = ctx.update?.callback_query?.message?.text;
    if (currentMessageText === result.message) {
      return;
    }
    try {
      return ctx.editMessageText(result.message, accountCardKeyboard(updatedAccount || account));
    } catch (err) {
      const desc = err?.response?.description || err?.message || '';
      if (typeof desc === 'string' && desc.includes('Message is not modified')) {
        return;
      }
      throw err;
    }
  });

  bot.action(/^acc_update_cookies:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId);
    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return;
    }

    sessions.set(ctx.from.id, {
      flow: 'update_cookies',
      step: 'sessionid',
      accountId,
      data: {},
      messageIds: [],
    });
    await safeAnswerCb(ctx);
    return ctx.editMessageText(
      `Update cookies for ${account.login}.\nEnter sessionid:`,
      cookieUpdateKeyboard(accountId),
    );
  });

  bot.action(/^acc_update_cookies_json:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    const account = await getAccountById(accountId);
    if (!account) {
      await safeAnswerCb(ctx, 'Account not found.');
      return;
    }
    sessions.set(ctx.from.id, {
      flow: 'update_cookies',
      step: 'sessionid',
      accountId,
      data: {},
      messageIds: [],
    });
    await safeAnswerCb(ctx);
    return ctx.editMessageText(
      `Update cookies for ${account.login}.\nEnter sessionid:`,
      cookieUpdateKeyboard(accountId),
    );
  });

  bot.action(/^acc_update_cookies_header:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    return ctx.editMessageText(
      'Legacy cookie-header format is no longer supported. Paste a JSON object with sessionid and steamLoginSecure only.',
      Markup.inlineKeyboard([
        [Markup.button.callback('Paste JSON', `acc_update_cookies_json:${accountId}`)],
        [Markup.button.callback('Cancel', `acc_open:${accountId}`)],
      ]),
    );
  });

  bot.action(/^acc_update_cookies_cancel:(\d+)$/, async (ctx) => {
    const accountId = Number(ctx.match[1]);
    await cleanupCookieInputMessages(ctx, sessions.get(ctx.from.id));
    sessions.delete(ctx.from.id);
    await safeAnswerCb(ctx);
    const account = await getAccountById(accountId, { includeSecrets: true });
    const uiAccount = await getAccountUiModel(account);
    return ctx.editMessageText(formatAccountCard(uiAccount), accountCardKeyboard(uiAccount));
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
    const cookies = await readStoredMafileCookies(accountId);
    if (!cookies?.sessionid || !cookies?.steamLoginSecure) {
      return ctx.reply('Account remains disabled until fresh Steam cookies are updated.');
    }
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
    try {
      await showTyping(ctx);
      await deleteAccount(accountId);
      return ctx.editMessageText(`Account #${accountId} deleted.`, mainMenu());
    } catch (err) {
      // If delete failed due to existing rentals, show friendly message and the account card
      const account = await getAccountById(accountId, { includeSecrets: true }).catch(() => null);
      const isReferencedByRentals = typeof err?.message === 'string' && err.message.includes('referenced by rentals');
      const message = isReferencedByRentals
        ? 'Cannot delete account: it is referenced by active or historical rentals. End or remove rentals first.'
        : uiError('delete account', err, 'Failed to delete account. Please try again.');
      if (isReferencedByRentals) {
        uiError('delete account with rentals', err);
      }

      if (account) {
        await safeAnswerCb(ctx);
        return ctx.editMessageText(message, accountCardKeyboard(account));
      }

      await safeAnswerCb(ctx);
      return ctx.editMessageText(message, mainMenu());
    }
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
    return ctx.reply('Edit cancelled.', mainMenu());
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

    session.step = 'cookies_choice';

    await safeAnswerCb(ctx);
    return ctx.editMessageText('Attach active Steam cookies now?', yesSkipKeyboard('add_acc_cookies_yes', 'add_acc_cookies_skip'));
  });

  bot.action('add_acc_cookies_yes', async (ctx) => {
    const session = sessions.get(ctx.from.id);

    if (!session || session.flow !== 'add_account') {
      return safeAnswerCb(ctx, 'No active add account flow');
    }

    session.step = 'cookies';

    await safeAnswerCb(ctx);
    return ctx.editMessageText('Send Steam cookies as JSON only. Required keys: sessionid and steamLoginSecure. Example: {"sessionid":"...","steamLoginSecure":"..."}');
  });

  bot.action('add_acc_cookies_skip', async (ctx) => {
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

    if (session?.flow === 'update_cookies') {
      const text = ctx.message?.text || '';
      session.messageIds ??= [];
      if (ctx.message?.message_id) {
        session.messageIds.push(ctx.message.message_id);
      }

      const fieldName = session.step === 'sessionid' ? 'sessionid' : 'steamLoginSecure';
      const validation = validateSteamCookieValue(fieldName, text);
      if (!validation.ok) {
        return ctx.reply(validation.message, cookieUpdateKeyboard(session.accountId));
      }

      session.data[fieldName] = validation.value;
      if (session.step === 'sessionid') {
        session.step = 'steamLoginSecure';
        return ctx.reply('Enter steamLoginSecure:', cookieUpdateKeyboard(session.accountId));
      }

      try {
        await showTyping(ctx);
        const cookies = {
          sessionid: session.data.sessionid,
          steamLoginSecure: session.data.steamLoginSecure,
        };
        await updateMafileCookies(session.accountId, cookies);
        await setAccountStatus(session.accountId, 'available');
        await cleanupCookieInputMessages(ctx, session);
        sessions.delete(ctx.from.id);
        const updatedAccount = await getAccountById(session.accountId, { includeSecrets: true });
        return ctx.reply(
          `✅ Cookies updated for account ${updatedAccount.login}`,
          accountCardKeyboard(await getAccountUiModel(updatedAccount)),
        );
      } catch (err) {
        return ctx.reply(uiError('update cookies', err, 'Failed to update cookies. Please check the values and try again.'));
      }
    }

    if (session?.flow === 'bind_offer_ui') {
      const [offerId, hoursRaw] = String(ctx.message?.text || '').trim().split(/\s+/);
      const hoursPerLot = Number(hoursRaw);
      if (!/^\d+$/.test(offerId || '') || !Number.isFinite(hoursPerLot) || hoursPerLot <= 0) {
        return ctx.reply('Invalid input. Send: <offer_id> <hours_per_lot>, for example: 123456 2');
      }

      try {
        await bindAccountOffer(session.accountId, offerId, hoursPerLot);
        sessions.delete(ctx.from.id);
        const account = await getAccountById(session.accountId);
        const offers = await listAccountOffers(session.accountId);
        return ctx.reply(formatAccountOffers(account, offers), accountOffersKeyboard(session.accountId, offers));
      } catch (err) {
        return ctx.reply(uiError('bind offer', err, 'Failed to bind offer. Check the offer ID and hours, then try again.'));
      }
    }

    if (session?.flow === 'extend_rental') {
      const raw = ctx.message?.text?.trim();
      if (!raw) return ctx.reply('Send extension hours value.');

      const hours = Number(raw);
      if (!Number.isFinite(hours) || hours <= 0) {
        return ctx.reply('Value must be a positive number, for example 1, 2, or 0.5.');
      }

      const rentalId = Number(session.rentalId || session.data?.rentalId);
      try {
        const result = await extendActiveRental(rentalId, hours, { reason: 'telegram-admin' });
        const rental = await getActiveRentals().then((items) => items.find((it) => Number(it.id) === Number(result.rentalId)) || null);
        const notifyText = `⏳ An administrator extended your rental by ${result.hours} hour(s). New end time: ${new Date(result.newEndsAt).toISOString()}`;

        if (rental?.buyer && process.env.FUNPAY_GOLDEN_KEY) {
          try {
            const { FunpayClient } = await import('../src/funpay/client.js');
            const funpayClient = new FunpayClient();
            if (rental.nodeId) {
              await funpayClient.sendMessage(rental.nodeId, notifyText).catch(() => {});
            }
          } catch (err) {
            console.warn('Buyer notification failed during rental extension:', err.message || err);
          }
        }

        sessions.delete(ctx.from.id);
        return ctx.reply([
          `Rental #${result.rentalId} extended by ${result.hours} hour(s).`,
          `New end: ${new Date(result.newEndsAt).toISOString()}`,
          rental?.buyer ? `Buyer: ${rental.buyer}` : null,
        ].filter(Boolean).join('\n'), mainMenu());
      } catch (err) {
        return ctx.reply(uiError('extend rental from text flow', err, 'Failed to extend rental. Check the rental status and try again.'));
      }
    }

    if (session?.flow === 'update_funpay_key') {
      const text = ctx.message?.text?.trim();
      const key = text?.replace(/^golden_key\s*[:=]?\s*/i, '').trim();

      if (!key) {
        return ctx.reply('FunPay golden_key is empty. Send the value again or type /settings to cancel.');
      }

      try {
        const nextKey = await setGoldenKey(key);
        if (globalThis.__FUNPAY_CLIENT__ && typeof globalThis.__FUNPAY_CLIENT__.setGoldenKey === 'function') {
          await globalThis.__FUNPAY_CLIENT__.setGoldenKey(nextKey);
        }
        sessions.delete(ctx.from.id);
        return ctx.reply('FunPay golden_key updated successfully and applied. Use /settings to verify it.', mainMenu());
      } catch (err) {
        return ctx.reply(uiError('update FunPay key', err, 'Failed to update FunPay key. Please try again.'));
      }
    }

    if (session?.flow === 'update_funpay_proxy') {
      const text = ctx.message?.text?.trim();
      const proxyInput = text?.replace(/^proxy\s*[:=]?\s*/i, '').trim();
      const normalized = (proxyInput || '').toLowerCase();

      if (!proxyInput || ['remove', 'delete', 'clear', 'none', 'null'].includes(normalized)) {
        try {
          await clearProxyUrl();
          if (globalThis.__FUNPAY_CLIENT__ && typeof globalThis.__FUNPAY_CLIENT__.clearProxyUrl === 'function') {
            await globalThis.__FUNPAY_CLIENT__.clearProxyUrl();
          }
          sessions.delete(ctx.from.id);
          return ctx.reply('FunPay proxy removed successfully.', mainMenu());
        } catch (err) {
          return ctx.reply(uiError('remove FunPay proxy', err, 'Failed to remove FunPay proxy. Please try again.'));
        }
      }

      try {
        const nextProxy = await setProxyUrl(proxyInput);
        if (globalThis.__FUNPAY_CLIENT__ && typeof globalThis.__FUNPAY_CLIENT__.setProxyUrl === 'function') {
          await globalThis.__FUNPAY_CLIENT__.setProxyUrl(nextProxy);
        }
        sessions.delete(ctx.from.id);
        return ctx.reply('FunPay proxy updated successfully and applied. Use /settings to verify it.', mainMenu());
      } catch (err) {
        return ctx.reply(uiError('update FunPay proxy', err, 'Failed to update FunPay proxy. Please try again.'));
      }
    }

    if (session?.flow === 'claim_review') {
      const text = ctx.message?.text?.trim();
      if (!text) return ctx.reply('Send text value');

      switch (session.step) {
        case 'order': {
          const funpayOrderId = text.trim();
          const order = await getOrderByFunpayId(funpayOrderId);
          if (!order) return ctx.reply('Order not found. Please re-enter FunPay order id.');
          session.data.orderId = order.id;
          session.step = 'link';
          return ctx.reply('Paste review link (or type skip to skip):');
        }
        case 'link': {
          if (text.toLowerCase() !== 'skip') session.data.link = text;
          session.step = 'text';
          return ctx.reply('Paste review text or short excerpt:');
        }
        case 'text': {
          session.data.text = text;
          session.step = 'rating';
          return ctx.reply('Rating (1-5) or type skip:');
        }
        case 'rating': {
          const v = text.toLowerCase().trim();
          if (v === 'skip') session.data.rating = null;
          else {
            const rating = Number(v);
            session.data.rating = (Number.isFinite(rating) && rating >= 1 && rating <= 5) ? rating : null;
          }
          session.step = 'confirm';
          await ctx.reply(['Review submission preview:', '', `Order: ${session.data.orderId}`, `Link: ${session.data.link || 'none'}`, `Text: ${session.data.text || 'none'}`, `Rating: ${session.data.rating || 'none'}`, '', 'Confirm submission?'].join('\n'), Markup.inlineKeyboard([[Markup.button.callback('Confirm', `claim_review_confirm`), Markup.button.callback('Cancel', `claim_review_cancel`)]]));
          return;
        }
        default:
          sessions.delete(ctx.from.id);
          return ctx.reply('Claim flow reset. Use /claim_review to start again.');
      }
    }

    return ctx.reply('Unknown command');
  });

  return bot;
}

async function syncBotCommands(bot) {
  try {
    await bot.telegram.setMyCommands([], { scope: { type: 'default' } });
  } catch (err) {
    console.warn('Warning: failed to clear stale bot commands', err?.message || err);
  }

  try {
    await bot.telegram.setMyCommands(COMMANDS, { scope: { type: 'default' } });
  } catch (err) {
    console.error('❌ Failed to update bot commands:', err);
  }

  // try {
  //   await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
  // } catch (err) {
  //   console.error('❌ Failed to update chat menu button:', err);
  // }
}

export async function launchBot() {
  const bot = createBot();

  await syncBotCommands(bot);

  bot.launch().catch((err) => {
    console.error('Bot launch failed:', err);
    process.exit(1);
  });
  console.log('Telegram bot launched');

  return bot;
}

function adminOnly(adminIds) {
  return async (ctx, next) => {
    if (adminIds.length === 0) {
      return next();
    }
    // Allow public access to review claim flow (buyers)
    const msgText = ctx.message?.text || ctx.update?.message?.text || '';
    const cbData = ctx.callbackQuery?.data || '';
    if (typeof msgText === 'string' && msgText.startsWith('/claim_review')) {
      return next();
    }
    if (typeof cbData === 'string' && cbData.startsWith('claim_review')) {
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
    // swallow Telegram callback query errors
    const desc = err?.response?.description || err?.message || '';
    if (typeof desc === 'string' && (
      desc.includes('query is too old') ||
      desc.includes('query ID is invalid') ||
      desc.includes('QUERY_ID') ||
      desc.includes('message is not modified') ||
      desc.includes('Bad Request: query is too old')
    )) {
      return;
    }
    // otherwise log and continue
    console.error('answerCbQuery failed', err?.response || err?.message || err);
  }
}

function isMessageNotModifiedError(description) {
  return typeof description === 'string'
    && description.toLowerCase().includes('message is not modified');
}

function uiError(context, error, fallback = 'Operation failed. Please try again.') {
  console.error(`[telegram] ${context}`, error);
  return fallback;
}

// Sends Telegram's typing status without allowing a notification failure to break the UI flow.
async function showTyping(ctx) {
  try {
    await ctx.sendChatAction('typing');
  } catch (err) {
    console.warn('[telegram] failed to send typing status', err);
  }
}

// /stats

async function runRecoverySmokeTest(accountId) {
  const account = await getAccountById(accountId, { includeSecrets: true });

  if (!account) {
    return { ok: false, message: 'Account not found.' };
  }

  if (!account.sharedSecret) {
    return { ok: false, message: 'Recovery test requires a valid Steam mafile. Add mafile first.' };
  }

  let cookies = null;
  try {
    const mafileRes = await query(
      `SELECT raw_json AS "rawJson" FROM mafiles WHERE account_id = $1 LIMIT 1`,
      [accountId]
    );
    const raw = mafileRes.rows[0]?.rawJson;

    if (raw) {
      const direct = extractSteamCookiesFromMafile(raw);
      if (direct) {
        cookies = direct;
      }
    }
  } catch (err) {
    console.warn('Could not read mafile raw cookies for account', accountId, err.message || err);
  }

  if (!cookies || !cookies.sessionid || !cookies.steamLoginSecure) {
    return { ok: false, message: 'Recovery test needs active Steam cookies (sessionid + steamLoginSecure). Add cookies to the mafile or account.' };
  }

  if (!account.password) {
    return { ok: false, message: 'This account has no stored password, so recovery test cannot run.' };
  }

  const tempPassword = `Test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}!`;
  const recoverer = new SteamAccountRecoverer({
    login: account.login,
    oldPassword: account.password,
    newPassword: tempPassword,
    sharedSecret: account.sharedSecret,
    cookies,
  });

  try {
    await recoverer.executeRecovery();
    await setAccountStatus(account.id, 'disabled');
    const passwordChanged = isPasswordChangeEnabled();
    return {
      ok: true,
      message: [
        `Recovery test completed for account #${account.id}.`,
        passwordChanged
          ? 'Temporary password was generated and is not displayed in Telegram.'
          : 'Steam password was not changed. Device sessions were deauthorized only.',
        'Account status: disabled until fresh cookies are updated.',
        'Result: success',
      ].join('\n'),
    };
  } catch (err) {
    return {
      ok: false,
      message: [
        `Recovery test failed for account #${account.id}.`,
        uiError('recovery test', err, 'Steam recovery failed. Check the account cookies and server logs.'),
      ].join('\n'),
    };
  }
}

async function readStoredMafileCookies(accountId) {
  try {
    const result = await query(
      `SELECT raw_json AS "rawJson" FROM mafiles WHERE account_id = $1 LIMIT 1`,
      [accountId],
    );
    return extractSteamCookiesFromMafile(result.rows[0]?.rawJson);
  } catch {
    return null;
  }
}

async function getAccountUiModel(account) {
  if (!account) return null;

  const cookies = await readStoredMafileCookies(account.id);
  const offers = await listAccountOffers(account.id);
  const hasRequiredCookies = Boolean(cookies?.sessionid && cookies?.steamLoginSecure);

  return {
    ...account,
    cookieStatus: account.status === 'disabled'
      ? '⚠️ needs update'
      : hasRequiredCookies
        ? '✅ up to date'
        : '⚠️ needs update',
    offerBindingCount: offers.length,
  };
}

async function recoverTestCommand(ctx) {
  const [, rawAccountId] = ctx.message.text.trim().split(/\s+/);
  const accountId = Number(rawAccountId);

  if (!Number.isSafeInteger(accountId) || accountId < 1) {
    return ctx.reply('Usage: /recover_test <account_id>');
  }

  await showTyping(ctx);
  const result = await runRecoverySmokeTest(accountId);
  return ctx.reply(result.message);
}

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

async function showAdminHome(ctx) {
  const stats = await getStats();
  return answer(ctx, [
    'Admin panel',
    '',
    `Accounts: ${stats.totalAccounts}`,
    `🟢 Available: ${stats.available}`,
    `🟡 Rented: ${stats.rented}`,
    `Active rentals: ${stats.activeRentals}`,
    `New orders: ${stats.newOrders}`,
  ].join('\n'), mainMenu());
}

async function showAccounts(ctx, filter = 'all') {
  const rawAccounts = await getAccounts();
  const accounts = filter === 'all'
    ? rawAccounts
    : await Promise.all(rawAccounts.map((account) => getAccountUiModel(account)));
  const filteredAccounts = filterAccounts(accounts, filter);

  if (filteredAccounts.length === 0) {
    await answer(ctx, filter === 'all' ? 'No accounts yet. Add one with /add_acc.' : 'No accounts match this filter.', accountFiltersKeyboard(filter));
    return;
  }

  return answer(
    ctx,
    formatAccountsList(filteredAccounts),
    accountsListKeyboard(filteredAccounts, filter),
  );
}

function filterAccounts(accounts, filter) {
  if (filter === 'needs_cookies') {
    return accounts.filter((account) => account.cookieStatus === '⚠️ needs update');
  }
  if (filter === 'all') return accounts;
  return accounts.filter((account) => account.status === filter);
}

export function formatAccountCard(account) {
  const status = account.status === 'available'
    ? '🟢 available'
    : account.status === 'rented'
      ? '🟡 rented'
      : account.status === 'disabled'
        ? '🔴 disabled'
        : `⚪ ${account.status}`;

  return [
    `Account #${account.id}`,
    '',
    `Title: ${account.title}`,
    `Login: ${account.login}`,
    'Password: *** (hidden)',
    `Status: ${status}`,
    account.status === 'disabled'
      ? 'Disabled reason: Steam sessions revoked. Cookies update required.'
      : null,
    `Cookies: ${account.cookieStatus || '⚠️ needs update'}`,
    `Steam Guard: ${account.sharedSecret || account.steamId ? 'connected' : 'not connected'}`,
    `Offer bindings: ${account.offerBindingCount ?? 0}`,
  ].filter(Boolean).join('\n');
}

function formatAccountsList(accounts) {
  return [
    'Accounts:',
    '',
    ...accounts.map((account) => (
      `#${account.id} ${account.title}\nStatus: ${formatAccountStatus(account.status)}`
    )),
  ].join('\n\n')
}

function formatAccountStatus(status) {
  if (status === 'available') return '🟢 available';
  if (status === 'rented') return '🟡 rented';
  if (status === 'disabled') return '🔴 disabled';
  return `⚪ ${status}`;
}

function accountCardKeyboard(account) {
  const firstRow = [];
  const hasSteamSecrets = Boolean(
    account.sharedSecret || account.identitySecret || account.mafileId || account.steamId
  );

  if (hasSteamSecrets) {
    firstRow.push(Markup.button.callback('Get code', `acc_code:${account.id}`));
  } else {
    firstRow.push(Markup.button.callback('Add mafile', `acc_add_mafile:${account.id}`));
  }

  const canTestRecovery = Boolean(account.sharedSecret || account.mafileId) && Boolean(account.password);
  const disableButtonLabel = account.status === 'disabled' ? 'Enable' : 'Disable';

  return Markup.inlineKeyboard([
    firstRow,
    [
      Markup.button.callback('Manage offers', `acc_offers:${account.id}`),
    ],
    [
      ...(canTestRecovery ? [Markup.button.callback('Test recovery', `acc_test_recovery:${account.id}`)] : []),
      Markup.button.callback('Update cookies', `acc_update_cookies:${account.id}`),
      Markup.button.callback(disableButtonLabel, `acc_disable:${account.id}`),
    ],
    [
      Markup.button.callback('Edit', `acc_edit:${account.id}`),
      Markup.button.callback('Delete', `acc_delete:${account.id}`),
    ],
    [
      Markup.button.callback('Back', 'accs_back'),
      Markup.button.callback('Main menu', 'main_menu'),
    ],
  ]);
}

function formatAccountOffers(account, offers) {
  const availability = account.status === 'available'
    ? '🟢 Available for rental'
    : account.status === 'rented'
      ? '🟡 Currently rented'
      : '🔴 Not available for rental';

  return [
    `Offers for account #${account.id}`,
    `Status: ${availability}`,
    '',
    ...(offers.length
      ? offers.map((offer) => `${offer.offerId}: ${offer.hoursPerLot} hour(s)/lot`)
      : ['No offer bindings.']),
  ].join('\n');
}

function accountOffersKeyboard(accountId, offers) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Add offer', `acc_offer_add:${accountId}`)],
    ...offers.map((offer) => [Markup.button.callback(`Unbind ${offer.offerId}`, `acc_offer_unbind:${accountId}:${offer.offerId}`)]),
    [Markup.button.callback('Back to account', `acc_open:${accountId}`)],
    [Markup.button.callback('Main menu', 'main_menu')],
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

function accountFiltersKeyboard(activeFilter = 'all') {
  const label = (text, filter) => Markup.button.callback(
    filter === activeFilter ? `• ${text}` : text,
    `accounts_${filter}`,
  );

  return Markup.inlineKeyboard([
    [label('All', 'all'), label('Available', 'available')],
    [label('Rented', 'rented'), label('Needs cookies', 'needs_cookies')],
    [label('Disabled', 'disabled')],
    [Markup.button.callback('Main menu', 'main_menu')],
  ]);
}

function accountsListKeyboard(accounts, activeFilter = 'all') {
  return Markup.inlineKeyboard([
    ...accounts.map((account) => [
      Markup.button.callback(
        `Open #${account.id}`,
        `acc_open:${account.id}`,
      ),
    ]),
    ...accountFiltersKeyboard(activeFilter).reply_markup.inline_keyboard,
  ]);
}

// /add_acc

const sessions = new Map();

function cookieUpdateKeyboard(accountId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', `acc_update_cookies_cancel:${accountId}`)],
  ]);
}

// Telegram may reject deletion when the bot lacks permission or the message is already gone.
async function cleanupCookieInputMessages(ctx, session) {
  for (const messageId of session?.messageIds || []) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
    } catch {
      // Best effort only: never block cookie persistence because cleanup failed.
    }
  }
}

function formatAddAccountConfirm(data) {
  return [
    'Check account data: ',
    '',
    `Title: ${data.title}`,
    `Login: ${data.login}`,
    `Password: ********`,
    `Steam Guard: ${data.sharedSecret ? 'connected' : 'not_connected'}`,
    `Steam cookies: ${data.cookies && Object.keys(data.cookies).length ? 'connected' : 'not_connected'}`,
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

async function startClaimReview(ctx) {
  sessions.set(ctx.from.id, { flow: 'claim_review', step: 'order', data: {} });
  await answer(ctx, 'To claim a review bonus, send the FunPay order ID (the number shown on FunPay):');
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
          yesSkipKeyboard('add_acc_mafile_yes', 'add_acc_mafile_skip'),
        );

      case 'mafile':
        try {
          const mafileData = parseMafile(text);
          session.data.sharedSecret = mafileData.sharedSecret;
          session.data.identitySecret = mafileData.identitySecret;
          session.data.steamId = mafileData.steamId;
          session.data.raw = mafileData.raw;
          session.data.accountName = mafileData.accountName;

          if (!session.data.login && mafileData.accountName) {
            session.data.login = mafileData.accountName;
          }

          session.step = 'cookies_choice';
          return ctx.reply('Attach active Steam cookies now?', yesSkipKeyboard('add_acc_cookies_yes', 'add_acc_cookies_skip'));
        } catch (err) {
          return ctx.reply(uiError('parse mafile during add account', err, 'Invalid mafile. Check the JSON and send it again.'));
        }

      case 'cookies': {
        const cookies = parseSteamCookiesInput(text);
        if (!cookies) {
          return ctx.reply('Invalid Steam cookies. Send valid JSON or a semicolon-separated cookie string, or type skip.');
        }

        session.data.cookies = cookies;
        session.step = 'confirm';
        return ctx.reply(formatAddAccountConfirm(session.data), addAccountConfirmKeyboard());
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
      await ctx.reply('Mafile attached successfully.', mainMenu());
      return;
    } catch (err) {
      return ctx.reply(uiError('parse mafile during attach', err, 'Invalid mafile. Check the JSON and send it again.'));
    }
  }

  // update_funpay_key flow
  if (session.flow === 'update_funpay_key') {
    const key = text.trim().replace(/^golden_key\s*[:=]?\s*/i, '').trim();
    if (!key) {
      return ctx.reply('FunPay golden_key is empty. Send the value again or type /settings to cancel.');
    }

    try {
      const nextKey = await setGoldenKey(key);
      if (globalThis.__FUNPAY_CLIENT__ && typeof globalThis.__FUNPAY_CLIENT__.setGoldenKey === 'function') {
        await globalThis.__FUNPAY_CLIENT__.setGoldenKey(nextKey);
      }
      sessions.delete(ctx.from.id);
      return ctx.reply('FunPay golden_key updated successfully and applied. Use /settings to verify it.', mainMenu());
    } catch (err) {
      return ctx.reply(uiError('update FunPay key', err, 'Failed to update FunPay key. Please try again.'));
    }
  }

  if (session.flow === 'update_funpay_proxy') {
    const rawProxy = text.trim().replace(/^proxy\s*[:=]?\s*/i, '').trim();
    const normalized = rawProxy.toLowerCase();

    if (!rawProxy || ['remove', 'delete', 'clear', 'none', 'null'].includes(normalized)) {
      try {
        await clearProxyUrl();
        if (globalThis.__FUNPAY_CLIENT__ && typeof globalThis.__FUNPAY_CLIENT__.clearProxyUrl === 'function') {
          await globalThis.__FUNPAY_CLIENT__.clearProxyUrl();
        }
        sessions.delete(ctx.from.id);
        return ctx.reply('FunPay proxy removed successfully.', mainMenu());
      } catch (err) {
        return ctx.reply(uiError('remove FunPay proxy', err, 'Failed to remove FunPay proxy. Please try again.'));
      }
    }

    try {
      const nextProxy = await setProxyUrl(rawProxy);
      if (globalThis.__FUNPAY_CLIENT__ && typeof globalThis.__FUNPAY_CLIENT__.setProxyUrl === 'function') {
        await globalThis.__FUNPAY_CLIENT__.setProxyUrl(nextProxy);
      }
      sessions.delete(ctx.from.id);
      return ctx.reply('FunPay proxy updated successfully and applied. Use /settings to verify it.', mainMenu());
    } catch (err) {
      return ctx.reply(uiError('update FunPay proxy', err, 'Failed to update FunPay proxy. Please try again.'));
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
      Markup.button.callback('Accounts', 'accs'),
    ],
    [
      Markup.button.callback('Rentals', 'active_rentals'),
      Markup.button.callback('Orders', 'orders'),
    ],
    [
      Markup.button.callback('Reviews', 'reviews'),
      Markup.button.callback('Add account', 'add_acc'),
    ],
    [Markup.button.callback('Cleanup history', 'cleanup_history')],
    [Markup.button.callback('Settings', 'settings')],
  ]);
}

function formatHelp() {
  return [
    'Available commands:',
    '',
    '/stats - summary',
    '/reviews - pending review claims',
    '/accs - accounts list',
    '/active_rentals - active rentals',
    '/add_acc - add an account',
    '/recover_test - run Steam recovery test',
    '/bind_offer - bind an account offer',
    '/unbind_offer - remove an account offer',
    '/offers - list offer bindings',
    '/orders - orders list',
    '/cleanup_history - cleanup history',
    '/settings - bot settings',
    '/claim_review - claim review bonus',
  ].join('\n');
}

function getMessageText(ctx) {
  return ctx.message?.text ?? ctx.update?.message?.text ?? '';
}

async function answer(ctx, text, keyboard = mainMenu()) {
  if (ctx.callbackQuery) {
    await safeAnswerCb(ctx);
    try {
      await ctx.editMessageText(text, keyboard);
    } catch (error) {
      const description = error?.response?.description || error?.message || '';
      if (!isMessageNotModifiedError(description)) {
        throw error;
      }
    }
    return;
  }

  await ctx.reply(text, keyboard);
}
