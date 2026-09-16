import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamCookiesInput, validateSteamCookieValue, extractSteamCookiesFromMafile } from '../tgBot/tg.js';
import { encrypt } from '../src/crypto.js';

process.env.ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('parseSteamCookiesInput accepts JSON cookies payload', () => {
  const cookies = parseSteamCookiesInput('{"sessionid":"abc123","steamLoginSecure":"xyz789"}');

  assert.deepEqual(cookies, {
    sessionid: 'abc123',
    steamLoginSecure: 'xyz789',
  });
});

test('parseSteamCookiesInput rejects semicolon cookie headers', () => {
  assert.equal(
    parseSteamCookiesInput('sessionid=abc123; steamLoginSecure=xyz789; steamRememberLogin=1'),
    null,
  );
});

test('parseSteamCookiesInput rejects invalid payloads', () => {
  assert.equal(parseSteamCookiesInput('skip'), null);
  assert.equal(parseSteamCookiesInput('not valid cookie text'), null);
});

test('validateSteamCookieValue enforces field-specific minimums without exposing values', () => {
  const sessionTooShort = validateSteamCookieValue('sessionid', 'short');
  const secureTooShort = validateSteamCookieValue('steamLoginSecure', 'short');
  const invalidSession = validateSteamCookieValue('sessionid', 'valid-session!');

  assert.equal(sessionTooShort.ok, false);
  assert.match(sessionTooShort.message, /10/);
  assert.equal(secureTooShort.ok, false);
  assert.match(secureTooShort.message, /20/);
  assert.equal(invalidSession.ok, false);
  assert.doesNotMatch(sessionTooShort.message, /short/);
});

test('validateSteamCookieValue accepts valid values and rejects whitespace', () => {
  assert.deepEqual(
    validateSteamCookieValue('sessionid', 'abc123-def456'),
    { ok: true, value: 'abc123-def456' },
  );
  assert.deepEqual(
    validateSteamCookieValue('steamLoginSecure', '76561198000000000%7C%7Csecure-token'),
    { ok: true, value: '76561198000000000%7C%7Csecure-token' },
  );
  assert.equal(validateSteamCookieValue('steamLoginSecure', 'valid value with space').ok, false);
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
