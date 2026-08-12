import SteamTotp from 'steam-totp';

export function isSteamSessionLogoutEnabled(value = process.env.STEAM_SESSION_LOGOUT_ENABLED) {
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
      await page.goto('https://store.steampowered.com/login/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

      await page.locator('input[name="username"]').fill(login);
      await page.locator('input[name="password"]').fill(password);

      if (sharedSecret) {
        const code = SteamTotp.generateAuthCode(sharedSecret);
        const twoFactorField = page.locator('input[name="twofactorcode"], input[name="twofactor_code"], input[data-testid="twofactorcode"]').first();
        if (await twoFactorField.count().then((count) => count > 0)) {
          await twoFactorField.fill(code);
        }
      }

      await Promise.all([
        page.locator('button[type="submit"], input[type="submit"]').first().click(),
      ]);

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
    logger.error(`Steam logout failed for ${login}: ${err.message}`);
    if (notifyAdmin) {
      await notifyAdmin(`⚠️ Ошибка выхода из Steam для аккаунта ${login}. Требуется ручная проверка. Ссылка: ${manualUrl}`);
    }
    return { ok: false, reason: 'logout-error', error: err.message, url: manualUrl };
  }
}
