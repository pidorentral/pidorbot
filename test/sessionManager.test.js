import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STEAM_SESSION_LOGOUT_ENABLED = 'false';

const { isSteamSessionLogoutEnabled, buildSteamLogoutUrl, logoutSteamSession, changeSteamPassword, getSteamBrowserFailureReason } = await import('../src/steam/sessionManager.js');
const { parseMafile } = await import('../steam/mafile.js');

test('steam logout is disabled by default when env is false', () => {
  assert.equal(isSteamSessionLogoutEnabled('false'), false);
  assert.equal(isSteamSessionLogoutEnabled('0'), false);
  assert.equal(isSteamSessionLogoutEnabled('no'), false);
});

test('steam logout URL prefers a Steam profile when steamId is known', () => {
  const url = buildSteamLogoutUrl('76561198000000000');
  assert.match(url, /steamcommunity\.com/i);
  assert.match(url, /76561198000000000/i);
});

test('mafile parser reads SteamID from nested Session.SteamID and normalizes instance offsets', () => {
  const payload = JSON.stringify({
    shared_secret: 'secret',
    Session: {
      SteamID: 76561198405948820,
    },
  });

  const result = parseMafile(payload);
  assert.equal(result.steamId, '76561198405948812');
});

test('disabled logout returns a manual reset URL and explicit reason', async () => {
  const result = await logoutSteamSession({ login: 'demo-user', steamId: '76561198000000000' }, { logger: { info() {}, warn() {}, error() {} } });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
  assert.ok(result.manualUrl);
  assert.match(result.manualUrl, /steamcommunity\.com/i);
});

test('steam password change is disabled by default and returns manual guidance', async () => {
  const result = await changeSteamPassword(
    { login: 'demo-user', password: 'old-pass', steamId: '76561198000000000' },
    { newPassword: 'NewPass!123', logger: { info() {}, warn() {}, error() {} } }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
  assert.ok(result.manualUrl);
  assert.match(result.manualUrl, /steamcommunity\.com/i);
});

test('playwright browser missing detection identifies the install error correctly', () => {
  const error = new Error('browserType.launch: Executable doesn\'t exist at /root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
  assert.equal(getSteamBrowserFailureReason(error), 'browser-not-installed');
});
