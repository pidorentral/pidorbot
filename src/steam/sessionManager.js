import SteamTotp from 'steam-totp';

export function getSteamBrowserFailureReason(error) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error || '');

  if (!message) {
    return 'browser-launch-error';
  }

  if (/Executable doesn't exist|browserType\.launch|Please run the following command to download new browsers|ms-playwright/i.test(message)) {
    return 'browser-not-installed';
  }

  return 'browser-launch-error';
}

export function isSteamSessionLogoutEnabled(value = process.env.STEAM_SESSION_LOGOUT_ENABLED) {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export function isSteamPasswordChangeEnabled(value = process.env.STEAM_PASSWORD_CHANGE_ENABLED ?? process.env.STEAM_SESSION_LOGOUT_ENABLED) {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export function buildSteamLogoutUrl(steamId = null, username = null) {
  if (steamId) {
    return `https://steamcommunity.com/profiles/${steamId}/`;
  }

  if (username) {
    return `https://steamcommunity.com/id/${encodeURIComponent(username)}`;
  }

  return 'https://steamcommunity.com/';
}

export function buildSteamPasswordChangeUrl(steamId = null, username = null) {
  if (steamId) {
    return `https://steamcommunity.com/profiles/${steamId}/edit`;
  }

  if (username) {
    return `https://steamcommunity.com/id/${encodeURIComponent(username)}/edit`;
  }

  return 'https://store.steampowered.com/account/manage';
}

async function openSteamLoginPage(page, { logger = console } = {}) {
  const candidates = [
    'https://store.steampowered.com/login/',
    'https://steamcommunity.com/login',
    'https://steamcommunity.com/login/home/?goto=',
  ];

  const selectors = [
    'input[name="username"]',
    'input[name="steamAccountName"]',
    'input[type="email"]',
    'input[id="input_username"]',
    'input[name="account_name"]',
    'input[name="password"]',
  ];

  let lastError = null;

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.count().then((count) => count > 0)) {
          return { ok: true, url: page.url(), selector };
        }
      }
      lastError = new Error(`Steam login page did not expose known login fields at ${url}`);
    } catch (err) {
      lastError = err;
      logger.warn(`Steam login navigation failed for ${url}: ${err.message}`);
    }
  }

  return { ok: false, reason: 'login-form-not-found', url: page.url(), error: lastError?.message || 'unknown' };
}

export async function changeSteamPassword(account, { newPassword = null, logger = console, notifyAdmin = null } = {}) {
  if (!account) {
    return { ok: false, reason: 'missing-account' };
  }

  const steamId = account.steamId || account.steam_id || null;
  const manualUrl = buildSteamPasswordChangeUrl(steamId, account.login || account.username || null);

  if (!isSteamPasswordChangeEnabled()) {
    logger.info(`Steam password change disabled for account ${account.login || account.id}. Manual password URL: ${manualUrl}`);
    return { ok: false, reason: 'disabled', manualUrl };
  }

  const login = account.login || account.username || null;
  const oldPassword = account.password || null;
  const sharedSecret = account.sharedSecret || account.shared_secret || null;

  if (!login || !oldPassword || !newPassword) {
    return { ok: false, reason: 'missing-credentials', manualUrl };
  }

  try {
    const browserModule = await import('playwright').catch(() => null);
    if (!browserModule) {
      logger.warn(`Steam password change driver unavailable; manual change required: ${manualUrl}`);
      if (notifyAdmin) {
        await notifyAdmin(`⚠️ Требуется ручная смена пароля Steam для аккаунта ${login}. Ссылка: ${manualUrl}`);
      }
      return { ok: false, reason: 'browser-driver-missing', manualUrl };
    }

    const { chromium } = browserModule;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const openResult = await openSteamLoginPage(page, { logger });
      if (!openResult.ok) {
        return { ok: false, reason: 'login-form-not-found', url: openResult.url, error: openResult.error, manualUrl };
      }

      const usernameField = page.locator('input[name="username"], input[name="steamAccountName"], input[type="email"], input[id="input_username"], input[name="account_name"]').first();
      await usernameField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
        throw new Error('Steam login form did not become visible');
      });
      await usernameField.fill(login);

      const passwordField = page.locator('input[name="password"]').first();
      await passwordField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
        throw new Error('Steam password field did not become visible');
      });
      await passwordField.fill(oldPassword);

      if (sharedSecret) {
        const code = SteamTotp.generateAuthCode(sharedSecret);
        const twoFactorField = page.locator('input[name="twofactorcode"], input[name="twofactor_code"], input[data-testid="twofactorcode"]').first();
        if (await twoFactorField.count().then((count) => count > 0)) {
          await twoFactorField.fill(code);
        }
      }

      await page.locator('button[type="submit"], input[type="submit"]').first().click();
      await page.waitForTimeout(3_000);

      await page.goto('https://store.steampowered.com/account/manage', { waitUntil: 'domcontentloaded', timeout: 30_000 });

      const changePasswordLink = page.locator('a[href*="change_password"], a[href*="account/manage"], text=/change password|изменить пароль/i').first();
      if (await changePasswordLink.count().then((count) => count > 0)) {
        await changePasswordLink.click();
        await page.waitForTimeout(2_000);
      }

      const oldPasswordInput = page.locator('input[name="oldPassword"], input[name="current_password"], input[id="oldPassword"], input[id="current_password"]').first();
      const newPasswordInput = page.locator('input[name="newPassword"], input[name="new_password"], input[id="newPassword"], input[id="new_password"]').first();
      const confirmPasswordInput = page.locator('input[name="confirmPassword"], input[name="confirm_new_password"], input[id="confirmPassword"], input[id="confirm_new_password"]').first();

      if (await oldPasswordInput.count().then((count) => count > 0)) {
        await oldPasswordInput.fill(oldPassword);
      }
      if (await newPasswordInput.count().then((count) => count > 0)) {
        await newPasswordInput.fill(newPassword);
      }
      if (await confirmPasswordInput.count().then((count) => count > 0)) {
        await confirmPasswordInput.fill(newPassword);
      }

      const submitButton = page.locator('button:has-text("Change Password"), button:has-text("Изменить пароль"), button[type="submit"], input[type="submit"]').first();
      if (await submitButton.count().then((count) => count > 0)) {
        await submitButton.click();
        await page.waitForTimeout(4_000);
      }

      const pageText = await page.textContent('body');
      const success = /password changed|пароль измен|change successful|saved successfully|updated successfully/i.test(pageText || '');

      if (success) {
        logger.info(`Steam password change succeeded for ${login}`);
        return { ok: true, manualUrl };
      }

      const finalUrl = page.url();
      logger.warn(`Steam password change flow finished without clear success signal for ${login}; final page: ${finalUrl}`);
      return { ok: true, manualUrl, url: finalUrl, note: 'manual-verification-may-be-required' };
    } finally {
      await browser.close();
    }
  } catch (err) {
    const reason = getSteamBrowserFailureReason(err);
    logger.error(`Steam password change failed for ${login}: ${err.message}`);
    if (notifyAdmin) {
      await notifyAdmin(`⚠️ Ошибка смены пароля Steam для аккаунта ${login}. Требуется ручная проверка. Ссылка: ${manualUrl}`);
    }
    return { ok: false, reason, error: err.message, manualUrl };
  }
}

export async function logoutSteamSession(account, { logger = console, notifyAdmin = null } = {}) {
  if (!account) {
    return { ok: false, reason: 'missing-account' };
  }

  const steamId = account.steamId || account.steam_id || null;
  const manualUrl = buildSteamLogoutUrl(steamId, account.login || account.username || null);

  if (!isSteamSessionLogoutEnabled()) {
    logger.info(`Steam session logout disabled for account ${account.login || account.id}. Manual reset URL: ${manualUrl}`);
    return { ok: false, reason: 'disabled', manualUrl };
  }

  const login = account.login || account.username || null;
  const password = account.password || null;
  const sharedSecret = account.sharedSecret || account.shared_secret || null;

  if (!login || !password) {
    return { ok: false, reason: 'missing-credentials', manualUrl };
  }

  try {
    const browserModule = await import('playwright').catch(() => null);
    if (!browserModule) {
      logger.warn(`Steam logout driver unavailable; manual logout required: ${manualUrl}`);
      if (notifyAdmin) {
        await notifyAdmin(`⚠️ Требуется ручной выход из Steam для аккаунта ${login}. Ссылка: ${manualUrl}`);
      }
      return { ok: false, reason: 'browser-driver-missing', url: manualUrl };
    }

    const { chromium } = browserModule;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const openResult = await openSteamLoginPage(page, { logger });
      if (!openResult.ok) {
        return { ok: false, reason: 'login-form-not-found', url: openResult.url, error: openResult.error, manualUrl };
      }

      const usernameField = page.locator('input[name="username"], input[name="steamAccountName"], input[type="email"], input[id="input_username"], input[name="account_name"]').first();
      await usernameField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
        throw new Error('Steam login form did not become visible');
      });
      await usernameField.fill(login);

      const passwordField = page.locator('input[name="password"]').first();
      await passwordField.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
        throw new Error('Steam password field did not become visible');
      });
      await passwordField.fill(password);

      if (sharedSecret) {
        const code = SteamTotp.generateAuthCode(sharedSecret);
        const twoFactorField = page.locator('input[name="twofactorcode"], input[name="twofactor_code"], input[data-testid="twofactorcode"]').first();
        if (await twoFactorField.count().then((count) => count > 0)) {
          await twoFactorField.fill(code);
        }
      }

      await page.locator('button[type="submit"], input[type="submit"]').first().click();
      await page.waitForTimeout(2_000);
      await page.goto('https://steamcommunity.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

      const logoutLink = page.locator('a[href*="logout"], a[href*="login/logout"], a[href*="login?"], text=/log out|logout/i').first();
      if (await logoutLink.count().then((count) => count > 0)) {
        await logoutLink.click();
        await page.waitForTimeout(2_000);
      }

      const finalUrl = page.url();
      logger.info(`Steam logout attempted for ${login}; final page: ${finalUrl}`);
      return { ok: true, url: finalUrl, manualUrl };
    } finally {
      await browser.close();
    }
  } catch (err) {
    const reason = getSteamBrowserFailureReason(err);
    logger.error(`Steam logout failed for ${login}: ${err.message}`);
    if (notifyAdmin) {
      await notifyAdmin(`⚠️ Ошибка выхода из Steam для аккаунта ${login}. Требуется ручная проверка. Ссылка: ${manualUrl}`);
    }
    return { ok: false, reason, error: err.message, url: manualUrl };
  }
}
