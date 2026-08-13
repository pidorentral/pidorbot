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
  bindAccountOffer,
  unbindAccountOffer,
  listAccountOffers,
  createReview,
  getOrderByFunpayId,
  getPendingReviews,
  getReviewById,
  verifyReview,
  extendActiveRental,
} from './services/rentalStore.js';
import { parseMafile } from '../steam/mafile.js';
import { generateSteamGuardCode } from '../steam/steamGuard.js';

const COMMANDS = [
  { command: 'stats', description: 'Summary: accounts, rentals, orders' },
  { command: 'reviews', description: 'Pending review claims' },
  { command: 'accs', description: 'Accounts list' },
  { command: 'active_rentals', description: 'Active rentals' },
  { command: 'add_acc', description: 'Add account draft' },
  { command: 'bind_offer', description: 'Bind account: /bind_offer <account> <offer> <hours>' },
  { command: 'unbind_offer', description: 'Remove account-offer binding' },
  { command: 'offers', description: 'List offer bindings' },
  { command: 'orders', description: 'Orders list' },
  { command: 'settings', description: 'Bot settings' },
  { command: 'claim_review', description: 'Claim review bonus' },
];

function buildRentalExtensionKeyboard(rentalId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('+1h', `rental_extend:${rentalId}:1`),
      Markup.button.callback('+2h', `rental_extend:${rentalId}:2`),
      Markup.button.callback('+4h', `rental_extend:${rentalId}:4`),
    ],
    [Markup.button.callback('Custom hours', `rental_extend_custom:${rentalId}`)],
  ]);
}

async function showActiveRentals(ctx) {
  const rentals = await getActiveRentals();

  if (!rentals || rentals.length === 0) {
    await answer(ctx, 'No active rentals.');
    return;
  }

  const lines = rentals.map((r) => `#${r.id} account #${r.accountId}\nBuyer: ${r.buyer}\nUntil: ${r.endsAt}`);
  const keyboard = Markup.inlineKeyboard(
    rentals.map((r) => [Markup.button.callback(`#${r.id} · extend`, `rental_extend_custom:${r.id}`)])
  );

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

async function showSettings(ctx) {
  await answer(ctx, ['Settings', '', 'No configurable settings yet.'].join('\n'));
}

async function bindOfferCommand(ctx) {
  const [, accountIdRaw, offerId, hoursRaw] = ctx.message.text.trim().split(/\s+/);
  const accountId = Number(accountIdRaw);
  const hoursPerLot = Number(hoursRaw);

  if (!Number.isSafeInteger(accountId) || accountId < 1 || !/^\d+$/.test(offerId || '') || !Number.isFinite(hoursPerLot) || hoursPerLot <= 0) {
    return ctx.reply('Использование: /bind_offer <account_id> <funpay_offer_id> <часов_за_лот>');
  }

  const binding = await bindAccountOffer(accountId, offerId, hoursPerLot);
  return ctx.reply(`Аккаунт #${binding.accountId} привязан к офферу ${binding.offerId}: ${binding.hoursPerLot} ч. за лот.`);
}

async function unbindOfferCommand(ctx) {
  const [, accountIdRaw, offerId] = ctx.message.text.trim().split(/\s+/);
  const accountId = Number(accountIdRaw);
  if (!Number.isSafeInteger(accountId) || accountId < 1 || !/^\d+$/.test(offerId || '')) {
    return ctx.reply('Использование: /unbind_offer <account_id> <funpay_offer_id>');
  }

  const binding = await unbindAccountOffer(accountId, offerId);
  return ctx.reply(binding ? `Привязка #${accountId} → ${offerId} удалена.` : 'Такая привязка не найдена.');
}

async function showOffers(ctx) {
  const [, accountIdRaw] = ctx.message.text.trim().split(/\s+/);
  const accountId = accountIdRaw ? Number(accountIdRaw) : null;
  if (accountIdRaw && (!Number.isSafeInteger(accountId) || accountId < 1)) {
    return ctx.reply('Использование: /offers [account_id]');
  }

  const offers = await listAccountOffers(accountId);
  if (!offers.length) return ctx.reply('Привязок офферов пока нет.');
  return ctx.reply(offers.map((offer) => `#${offer.accountId} (${offer.accountTitle}) → ${offer.offerId}: ${offer.hoursPerLot} ч./лот`).join('\n'));
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
  bot.command('bind_offer', bindOfferCommand);
  bot.command('unbind_offer', unbindOfferCommand);
  bot.command('offers', showOffers);
  bot.command('orders', showOrders);
  bot.command('settings', showSettings);
  bot.command('claim_review', startClaimReview);
  bot.command('reviews', showReviews);

  bot.hears(/^\/active-rentals(?:\s|$)/i, showActiveRentals);
  bot.hears(/^\/add-acc(?:\s|$)/i, addAccountCommand);

  bot.action('stats', showStats);
  bot.action('accs', showAccounts);
  bot.action('active_rentals', showActiveRentals);
  bot.action('orders', showOrders);
  bot.action('settings', showSettings);
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

    const account = await addAccount({
      title: session.data.title,
      login: session.data.login,
      password: session.data.password,
      notes: null,
      steamId: session.data.steamId || null,
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
      return ctx.editMessageText(`Failed to extend rental: ${err.message || err}`, mainMenu());
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

    // perform auto verification
    const verifier = await import('../src/reviewVerifier.js');
    const result = await verifier.autoVerifyReviewById(review);

    if (result.confidence >= 0.7) {
      // auto-approve
      await verifyReview(review.id, 'auto');
      return ctx.editMessageText(`Auto-verified (confidence=${result.confidence.toFixed(2)}): bonus granted.`, mainMenu());
    }

    return ctx.editMessageText(`Auto-check result: confidence=${result.confidence.toFixed(2)} reason=${result.reason}. Please review manually.`, Markup.inlineKeyboard([[Markup.button.callback('Confirm', `review_confirm:${review.id}`), Markup.button.callback('Reject', `review_reject:${review.id}`), Markup.button.callback('Back', 'reviews')]]));
  });

  bot.action(/^review_confirm:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    try {
      const res = await verifyReview(id, 'admin');
      return ctx.editMessageText(`Review #${id} verified. Rental extended.${res.rental ? ' Rental ID: ' + res.rental.id : ''}`, mainMenu());
    } catch (err) {
      return ctx.editMessageText(`Failed to verify: ${err.message || err}`, mainMenu());
    }
  });

  bot.action(/^review_reject:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await safeAnswerCb(ctx);
    try {
      await rejectReview(id, 'admin', 'rejected by admin');
      return ctx.editMessageText(`Review #${id} rejected.`, mainMenu());
    } catch (err) {
      return ctx.editMessageText(`Failed to reject: ${err.message || err}`, mainMenu());
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
            // ignore send failures to individual admins
          }
        }
      } catch (e) {
        // don't fail user flow on notify errors
      }

      return ctx.editMessageText('Review submitted. Admins will review and grant bonus if valid.', mainMenu());
    } catch (err) {
      console.error('createReview failed', err);
      return ctx.editMessageText('Failed to submit review: ' + (err.message || err), mainMenu());
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

    const currentMessageText = ctx.update?.callback_query?.message?.text;
    const targetText = formatAccountCard(account, { showPassword: true });
    if (currentMessageText === targetText) {
      await safeAnswerCb(ctx);
      return;
    }

    await safeAnswerCb(ctx);

    try {
      return ctx.editMessageText(
        targetText,
        accountCardKeyboard(account),
      );
    } catch (err) {
      // Ignore message-not-modified and other edit failures for duplicate presses
      const desc = err?.response?.description || err?.message || '';
      if (typeof desc === 'string' && desc.includes('Message is not modified')) {
        return;
      }
      throw err;
    }
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
    try {
      await deleteAccount(accountId);
      return ctx.editMessageText(`Account #${accountId} deleted.`, mainMenu());
    } catch (err) {
      // If delete failed due to existing rentals, show friendly message and the account card
      console.error('deleteAccount failed', err?.message || err);
      const account = await getAccountById(accountId, { includeSecrets: true }).catch(() => null);
      const message = err?.message && typeof err.message === 'string' && err.message.includes('referenced by rentals')
        ? `Cannot delete account: it is referenced by active or historical rentals. End or remove rentals first. (${err.message})`
        : `Failed to delete account: ${err?.message || 'unknown error'}`;

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
        const notifyText = `⏳ Администратор продлил аренду на ${result.hours} час(а). Новое время окончания: ${new Date(result.newEndsAt).toISOString()}`;

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
        ].filter(Boolean).join('\n'));
      } catch (err) {
        return ctx.reply(`Failed to extend rental: ${err.message || err}`);
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

  bot.telegram.setMyCommands(COMMANDS)
    .then(() => console.log('✅ Список команд успешно обновлен в Telegram'))
    .catch((err) => console.error('❌ Ошибка обновления команд:', err));

  bot.telegram.setChatMenuButton({
    menuButton: { type: 'commands' }
  })
    .then(() => console.log('✅ Кнопка меню сброшена к стандартному списку команд'))
    .catch((err) => console.error('❌ Ошибка кнопки меню:', err));

  return bot;
}

export async function launchBot() {
  const bot = createBot();

  await bot.telegram.setMyCommands(COMMANDS);

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
          session.data.raw = mafileData.raw;
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
