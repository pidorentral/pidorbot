import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STEAM_SESSION_LOGOUT_ENABLED = 'false';

const { isSteamSessionLogoutEnabled, buildSteamLogoutUrl } = await import('../src/steam/sessionManager.js');

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
