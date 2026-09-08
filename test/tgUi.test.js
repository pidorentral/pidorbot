import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAccountCard } from '../tgBot/tg.js';

test('account card masks sensitive credentials', () => {
  const text = formatAccountCard({
    id: 7,
    title: 'UI test account',
    login: 'steam-login',
    password: 'super-secret-password',
    status: 'available',
    sharedSecret: 'shared-secret',
    cookieStatus: 'connected',
    offerBindingCount: 1,
    sessionid: 'session-secret',
    steamLoginSecure: 'secure-cookie',
  });

  assert.match(text, /Password: \*\*\* \(hidden\)/);
  assert.doesNotMatch(text, /super-secret-password|session-secret|secure-cookie/);
});
