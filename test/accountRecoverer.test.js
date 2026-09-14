/**
 * Unit tests for SteamAccountRecoverer
 * Run with: npm test test/accountRecoverer.test.js
 */

import test from 'node:test';
import assert from 'node:assert';
import { SteamAccountRecoverer, SteamPasswordChangeError, recoverSteamAccount, extractRecoveryParams, isPasswordChangeEnabled, formatSteamError, isDeauthorizationSuccessPage, isSteamLoginPageUrl, buildSteamBrowserCookieEntries, deauthorizeAllDevices } from '../steam/accountRecoverer.js';

/**
 * Test: Constructor validates input
 */
test('SteamAccountRecoverer - stores provided configuration without throwing', () => {
    const config = {
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'test' }
    };

    const recoverer = new SteamAccountRecoverer(config);
    assert.equal(recoverer.login, 'testuser', 'Should store login');
    assert.equal(recoverer.oldPassword, 'old123', 'Should store oldPassword');
    assert.equal(recoverer.newPassword, 'new456', 'Should store newPassword');
    assert.equal(recoverer.sharedSecret, 'JBSWY3DPEBLW64TMMQ======', 'Should store sharedSecret');
});

/**
 * Test: Password encryption works
 */
test('SteamAccountRecoverer - RSA password encryption', () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: {}
    });

    // Set fake RSA key for testing
    recoverer.rsaKey = {
        modulus: '1234567890',
        exponent: '65537'
    };

    // Should not throw
    const encrypted = recoverer._encryptPassword('testpassword');
    assert(typeof encrypted === 'string', 'Encrypted password should be string');
    assert(encrypted.length > 0, 'Encrypted password should not be empty');
    assert(/^[A-Za-z0-9+/=]+$/.test(encrypted), 'Should be valid base64');
});

/**
 * Test: Cookies are converted correctly
 */
test('SteamAccountRecoverer - cookie management', () => {
    const cookies = {
        sessionid: 'abc123',
        steamLoginSecure: 'xyz789',
        other: 'value'
    };

    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: cookies
    });

    const cookieHeader = recoverer._cookiesToHeader(cookies);
    assert(cookieHeader.includes('sessionid=abc123'), 'Should include sessionid');
    assert(cookieHeader.includes('steamLoginSecure=xyz789'), 'Should include steamLoginSecure');
    assert(cookieHeader.includes('other=value'), 'Should include other cookies');
});

test('SteamAccountRecoverer - rejects unsafe cookie header values without exposing them', () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'safe\nvalue' },
    });

    assert.throws(
        () => recoverer._cookiesToHeader(recoverer.cookies),
        (error) => error instanceof SteamPasswordChangeError
            && /invalid characters/i.test(error.message)
            && !error.message.includes('safe'),
    );
});

test('formatSteamError - includes safe fetch cause diagnostics only', () => {
    const error = new SteamPasswordChangeError('Request failed: fetch failed', null, { causeName: 'TypeError', causeMessage: 'connect timeout' });
    assert.match(formatSteamError(error), /cause connect timeout/);
    assert.doesNotMatch(formatSteamError(error), /sessionid|steamLoginSecure|password/i);
});

test('isDeauthorizationSuccessPage - rejects generic Steam management pages', () => {
    assert.equal(isDeauthorizationSuccessPage('Steam Guard settings and authorized devices'), false);
    assert.equal(isDeauthorizationSuccessPage('Successfully deauthorized all devices'), true);
});

test('isSteamLoginPageUrl - recognizes stale Steam login redirects', () => {
    assert.equal(isSteamLoginPageUrl('https://store.steampowered.com/login/?redir=twofactor/manage'), true);
    assert.equal(isSteamLoginPageUrl('https://store.steampowered.com/twofactor/manage'), false);
    assert.equal(isSteamLoginPageUrl('Steam Guard settings and authorized devices'), false);
});

test('buildSteamBrowserCookieEntries - mirrors fresh Steam auth across host families', () => {
    const entries = buildSteamBrowserCookieEntries({ sessionid: 'abc', steamLoginSecure: 'xyz' });
    const domains = entries.map((entry) => entry.domain);

    assert.equal(entries.length >= 8, true);
    assert.equal(domains.includes('.steamcommunity.com'), true);
    assert.equal(domains.includes('.steampowered.com'), true);
    assert.equal(entries.some((entry) => entry.name === 'sessionid' && entry.domain === '.steamcommunity.com'), true);
    assert.equal(entries.some((entry) => entry.name === 'steamLoginSecure' && entry.domain === '.steampowered.com'), true);
});

test('SteamAccountRecoverer - classifies authentication redirects without following them', async () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'session', steamLoginSecure: 'secure' },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, {
        status: 302,
        headers: { location: 'https://store.steampowered.com/login/?redir=twofactor/manage' },
    });

    try {
        await assert.rejects(
            () => recoverer._makeRequest('https://store.steampowered.com/twofactor/manage_action', 'POST', { action: 'deauthorize' }),
            (error) => error instanceof SteamPasswordChangeError
                && error.requiresManualReview === true
                && /redirected the request/i.test(error.message)
                && error.responseBody?.redirectedPath === '/login/',
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('SteamAccountRecoverer - falls back to browser on a deauthorization redirect', async () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'session', steamLoginSecure: 'secure' },
    });
    recoverer._makeRequest = async () => {
        const error = new SteamPasswordChangeError('redirect', 302);
        throw error;
    };
    recoverer._deauthorizeWithBrowser = async () => ({ success: true, via: 'browser' });

    const result = await recoverer._deauthorizeAllDevices();
    assert.deepEqual(result, { success: true, via: 'browser' });
});

test('deauthorizeAllDevices - preserves the full Steam cookie bundle for real rentals', async () => {
    const original = SteamAccountRecoverer.prototype._deauthorizeAllDevices;
    let seenCookies;

    SteamAccountRecoverer.prototype._deauthorizeAllDevices = async function() {
        seenCookies = { ...this.cookies };
        return { success: true, via: 'browser' };
    };

    try {
        const cookies = {
            sessionid: 'session',
            steamLoginSecure: 'secure',
            steamMachineAuth: 'mauth',
            steamRememberLogin: '1',
        };

        const result = await deauthorizeAllDevices(cookies);
        assert.deepEqual(result, { success: true, via: 'browser' });
        assert.deepEqual(seenCookies, cookies);
    } finally {
        SteamAccountRecoverer.prototype._deauthorizeAllDevices = original;
    }
});

test('SteamAccountRecoverer - recognizes persistent browser profile configuration', () => {
    assert.equal(process.env.STEAM_BROWSER_PROFILE_DIR || '', '');
    assert.equal(process.env.STEAM_BROWSER_HEADLESS || 'true', 'true');
});

/**
 * Test: Error handling for SteamPasswordChangeError
 */
test('SteamPasswordChangeError - custom error class', () => {
    const error = new SteamPasswordChangeError(
        'Test error message',
        401,
        { success: false }
    );

    assert(error instanceof Error, 'Should be instanceof Error');
    assert(error instanceof SteamPasswordChangeError, 'Should be instanceof SteamPasswordChangeError');
    assert.equal(error.name, 'SteamPasswordChangeError', 'Should have correct name');
    assert.equal(error.message, 'Test error message', 'Should have message');
    assert.equal(error.statusCode, 401, 'Should store statusCode');
    assert.deepEqual(error.responseBody, { success: false }, 'Should store responseBody');
});

/**
 * Test: Modular exponentiation (RSA core operation)
 */
test('SteamAccountRecoverer - modular exponentiation', () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: {}
    });

    // Test: (2^3) % 5 = 8 % 5 = 3
    const result = recoverer._modPow(2n, 3n, 5n);
    assert.equal(result, 3n, 'Modular exponentiation should work');

    // Test: (3^4) % 7 = 81 % 7 = 4
    const result2 = recoverer._modPow(3n, 4n, 7n);
    assert.equal(result2, 4n, 'Modular exponentiation should work');
});

/**
 * Test: Headers generation
 */
test('SteamAccountRecoverer - header generation', () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'test123' }
    });

    const headers = recoverer._getHeaders('https://example.com');

    assert(headers['User-Agent'], 'Should have User-Agent');
    assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
    assert.equal(headers['X-Requested-With'], 'XMLHttpRequest');
    assert.equal(headers['Origin'], 'https://help.steampowered.com');
    assert.equal(headers['Referer'], 'https://example.com');
    assert(headers['Cookie'], 'Should have Cookie');
});

/**
 * Test: Configuration defaults
 */
test('SteamAccountRecoverer - default configuration', () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: {}
    });

    assert.equal(recoverer.timeout, 15000, 'Should have default timeout');
    assert.equal(recoverer.maxRetries, 10, 'Should have default maxRetries');
    assert(recoverer.userAgent, 'Should have default User-Agent');
});

test('extractRecoveryParams - accepts Steam wizard HTML attribute variations', () => {
    const params = extractRecoveryParams(`
        <input type='hidden' value='wizard-token' name='s'>
        <input name="account" type="hidden" value="account-token">
        <script>window.wizard = { reset: 'reset-token', issueid: 'issue-token' };</script>
    `);

    assert.deepEqual(params, {
        s: 'wizard-token',
        account: 'account-token',
        reset: 'reset-token',
        lost: '',
        issueid: 'issue-token',
    });
});

test('SteamAccountRecoverer - identifies an unauthenticated help wizard response', async () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'session', steamLoginSecure: 'secure' },
    });
    recoverer._makeRequest = async () => '<html><title>Steam Login</title><body>Вход password</body></html>';

    await assert.rejects(
        () => recoverer._initializeRecoveryWizard(),
        (error) => error instanceof SteamPasswordChangeError
            && error.responseBody?.containsLoginPage === true
            && /help session is not authenticated/i.test(error.message),
    );
});

/**
 * Test: Custom configuration
 */
test('SteamAccountRecoverer - custom configuration', () => {
    const customUA = 'Mozilla/5.0 Custom';
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: {},
        userAgent: customUA,
        timeout: 30000,
        maxRetries: 20
    });

    assert.equal(recoverer.userAgent, customUA, 'Should use custom User-Agent');
    assert.equal(recoverer.timeout, 30000, 'Should use custom timeout');
    assert.equal(recoverer.maxRetries, 20, 'Should use custom maxRetries');
});

/**
 * Test: State tracking during recovery
 */
test('SteamAccountRecoverer - state tracking', () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: {}
    });

    // Initially state should be empty
    assert.equal(recoverer.rsaKey, null, 'Should start with null RSA key');
    assert.equal(recoverer.rsaTimestamp, null, 'Should start with null timestamp');
    assert.equal(recoverer.recoveryToken, null, 'Should start with null token');
    assert.deepEqual(recoverer.accountRecoveryParams, {}, 'Should start with empty params');

    // Simulate setting state
    recoverer.rsaKey = { modulus: '123', exponent: '456' };
    recoverer.rsaTimestamp = '789';
    recoverer.accountRecoveryParams = { s: 'value' };

    assert(recoverer.rsaKey, 'Should store RSA key');
    assert.equal(recoverer.rsaTimestamp, '789', 'Should store timestamp');
    assert.equal(recoverer.accountRecoveryParams.s, 'value', 'Should store params');
});

/**
 * Integration test: Full recovery flow (mocked)
 */
test('SteamAccountRecoverer - recovery flow structure', () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'test123', steamLoginSecure: 'secure123' }
    });

    // Verify all private methods exist
    assert(typeof recoverer._getRSAKey === 'function', 'Should have _getRSAKey method');
    assert(typeof recoverer._initializeRecoveryWizard === 'function', 'Should have _initializeRecoveryWizard');
    assert(typeof recoverer._requestTwoFactorCode === 'function', 'Should have _requestTwoFactorCode');
    assert(typeof recoverer._confirmTwoFactor === 'function', 'Should have _confirmTwoFactor');
    assert(typeof recoverer._verifyOldPassword === 'function', 'Should have _verifyOldPassword');
    assert(typeof recoverer._setNewPassword === 'function', 'Should have _setNewPassword');
    assert(typeof recoverer._deauthorizeAllDevices === 'function', 'Should have _deauthorizeAllDevices');
    assert(typeof recoverer.executeRecovery === 'function', 'Should have executeRecovery method');
});

/**
 * Test: Cookie requirement validation
 */
test('SteamAccountRecoverer - validates required cookies', async () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'new456',
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: {} // Empty cookies
    });

    await assert.rejects(
        () => recoverer._deauthorizeAllDevices(),
        (error) => error instanceof SteamPasswordChangeError && /sessionid and steamLoginSecure cookies are required/i.test(error.message),
        'Should reject when required cookies are missing'
    );
});

test('SteamAccountRecoverer - deauthorizes first and skips password change by default', async () => {
    const previous = process.env.ENABLE_PASSWORD_CHANGE;
    delete process.env.ENABLE_PASSWORD_CHANGE;

    try {
        const recoverer = new SteamAccountRecoverer({
            login: 'testuser',
            oldPassword: 'old123',
            newPassword: 'new456',
            sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
            cookies: { sessionid: 'session', steamLoginSecure: 'secure' },
        });
        const calls = [];
        recoverer._deauthorizeAllDevices = async () => calls.push('deauthorize');
        recoverer._getRSAKey = async () => calls.push('rsa');

        const result = await recoverer.executeRecovery();

        assert.deepEqual(calls, ['deauthorize']);
        assert.deepEqual(result.completedSteps, ['Deauthorizing all devices']);
        assert.equal(isPasswordChangeEnabled(), false);
    } finally {
        if (previous === undefined) delete process.env.ENABLE_PASSWORD_CHANGE;
        else process.env.ENABLE_PASSWORD_CHANGE = previous;
    }
});

test('SteamAccountRecoverer - cleanup can explicitly disable password change', async () => {
    const recoverer = new SteamAccountRecoverer({
        login: 'testuser',
        oldPassword: 'old123',
        newPassword: 'must-not-be-used',
        passwordChangeEnabled: false,
        sharedSecret: 'JBSWY3DPEBLW64TMMQ======',
        cookies: { sessionid: 'session', steamLoginSecure: 'secure' },
    });
    const calls = [];
    recoverer._deauthorizeAllDevices = async () => calls.push('deauthorize');
    recoverer._setNewPassword = async () => calls.push('password');

    await recoverer.executeRecovery();
    assert.deepEqual(calls, ['deauthorize']);
});

/**
 * Test: Convenience function
 */
test('recoverSteamAccount - convenience function signature', () => {
    assert(typeof recoverSteamAccount === 'function', 'Should export convenience function');
});

console.log('✓ All tests completed');
