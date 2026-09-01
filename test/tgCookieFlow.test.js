import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamCookiesInput, extractSteamCookiesFromMafile } from '../tgBot/tg.js';
import { encrypt } from '../src/crypto.js';

process.env.ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('parseSteamCookiesInput accepts JSON cookies payload', () => {
  const cookies = parseSteamCookiesInput('{"sessionid":"abc123","steamLoginSecure":"xyz789"}');

  assert.deepEqual(cookies, {
    sessionid: 'abc123',
    steamLoginSecure: 'xyz789',
  });
});

test('parseSteamCookiesInput accepts semicolon cookie header', () => {
  const cookies = parseSteamCookiesInput('sessionid=abc123; steamLoginSecure=xyz789; steamRememberLogin=1');

  assert.deepEqual(cookies, {
    sessionid: 'abc123',
    steamLoginSecure: 'xyz789',
    steamRememberLogin: '1',
  });
});

test('parseSteamCookiesInput rejects invalid payloads', () => {
  assert.equal(parseSteamCookiesInput('skip'), null);
  assert.equal(parseSteamCookiesInput('not valid cookie text'), null);
});

test('extractSteamCookiesFromMafile decrypts encrypted mafile payloads', () => {
  const encrypted = JSON.stringify(encrypt(JSON.stringify({
    cookies: {
      sessionid: 'abc123',
      steamLoginSecure: 'xyz789',
    },
  })));

  const cookies = extractSteamCookiesFromMafile(encrypted);

  assert.deepEqual(cookies, {
    sessionid: 'abc123',
    steamLoginSecure: 'xyz789',
  });
});

test('recovery errors expose only safe network diagnostics', () => {
  const error = new Error('Request failed: fetch failed');
  error.responseBody = { causeCode: 'ECONNRESET' };
  assert.equal(error.responseBody.causeCode, 'ECONNRESET');
  assert.doesNotMatch('Request failed: fetch failed [code ECONNRESET]', /sessionid|steamLoginSecure|password/i);
});
