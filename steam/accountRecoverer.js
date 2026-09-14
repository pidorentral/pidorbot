import crypto from 'crypto';
import SteamTotp from 'steam-totp';

export function extractRecoveryParams(response) {
    const params = {};
    const source = typeof response === 'string' ? response : JSON.stringify(response || {});
    const keys = ['s', 'account', 'reset', 'lost', 'issueid'];

    for (const key of keys) {
        const attributePattern = new RegExp(
            `<input\\b[^>]*?(?:name\\s*=\\s*["']${key}["'][^>]*?value\\s*=\\s*["']([^"']+)["']|value\\s*=\\s*["']([^"']+)["'][^>]*?name\\s*=\\s*["']${key}["'])`,
            'i'
        );
        const attributeMatch = source.match(attributePattern);
        params[key] = attributeMatch?.[1] || attributeMatch?.[2] || '';

        if (!params[key]) {
            const urlPattern = new RegExp(`[?&]${key}=([^&#"'\\s]+)`, 'i');
            const urlMatch = source.match(urlPattern);
            params[key] = urlMatch ? decodeURIComponent(urlMatch[1]) : '';
        }

        if (!params[key]) {
                const jsPattern = new RegExp(`(?:["']${key}["']\\s*[:=]|\\b${key}\\s*[:=])\\s*["']([^"']+)["']`, 'i');
            const jsMatch = source.match(jsPattern);
            params[key] = jsMatch?.[1] || '';
        }
    }

    return params;
}

export function isPasswordChangeEnabled(value = process.env.ENABLE_PASSWORD_CHANGE) {
    if (value === undefined || value === null || value === '') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function formatSteamError(error) {
    const cause = error?.cause;
    const nestedCause = cause?.cause;
    const causeCode = error?.responseBody?.causeCode || cause?.code || nestedCause?.code;
    const causeName = error?.responseBody?.causeName || cause?.name;
    const causeMessage = error?.responseBody?.causeMessage || cause?.message || nestedCause?.message;
    const details = [
        error?.statusCode ? `HTTP ${error.statusCode}` : null,
        causeCode ? `code ${causeCode}` : null,
        causeName && causeName !== 'Error' ? `type ${causeName}` : null,
        causeMessage && causeMessage !== error?.message ? `cause ${String(causeMessage).slice(0, 160)}` : null,
        error?.responseBody?.redirectedPath ? `redirected path ${error.responseBody.redirectedPath}` : null,
    ].filter(Boolean).join(', ');

    return `${error?.message || error || 'Unknown Steam error'}${details ? ` [${details}]` : ''}`;
}

export function isDeauthorizationSuccessPage(text = '') {
    return /successfully.*(deauthor|log(?:ged)? out)|(?:deauthor|log(?:ged)? out).*(?:all|every)|все устройства.*(?:выйти|деавтор)/i.test(text);
}

/**
 * Custom error class for Steam account recovery failures
 */
export class SteamPasswordChangeError extends Error {
    constructor(message, statusCode = null, responseBody = null) {
        super(message);
        this.name = 'SteamPasswordChangeError';
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }
}

/**
 * Steam Account Recoverer - handles password changes and session deauthorization
 * @class
 * @description Implements the complete Steam account recovery flow including password change
 * and device deauthorization after rental ends.
 */
export class SteamAccountRecoverer {
    /**
     * @param {Object} config - Configuration object
     * @param {string} config.login - Steam account login/username
     * @param {string} config.oldPassword - Current password
     * @param {string} config.newPassword - New password to set
     * @param {string} config.sharedSecret - Shared secret from mafile for 2FA code generation
     * @param {Object} config.cookies - Active cookies object containing sessionid, steamLoginSecure, etc.
     * @param {string} [config.userAgent] - Custom User-Agent string
     * @param {number} [config.timeout] - Request timeout in milliseconds (default: 15000)
     * @param {number} [config.maxRetries] - Maximum retry attempts for polling (default: 10)
     */
    constructor(config) {
        this.login = config.login;
        this.oldPassword = config.oldPassword;
        this.newPassword = config.newPassword;
        this.sharedSecret = config.sharedSecret;
        this.cookies = config.cookies || {};
        this.passwordChangeEnabled = config.passwordChangeEnabled ?? isPasswordChangeEnabled();

        this.userAgent = config.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

        this.timeout = config.timeout || 15000;
        this.maxRetries = config.maxRetries || 10;

        // State tracking across recovery flow
        this.rsaKey = null;
        this.rsaTimestamp = null;
        this.recoveryToken = null;
        this.accountRecoveryParams = {};
    }

    /**
     * Convert cookies object to cookie header string
     * @private
     * @param {Object} cookies - Cookies object
     * @returns {string} Cookie header value
     */
    _cookiesToHeader(cookies) {
        return Object.entries(cookies)
            .filter(([key, value]) => key && value !== undefined && value !== null)
            .map(([key, value]) => {
                const cookieName = String(key).trim();
                const cookieValue = String(value).trim();
                if (!cookieName || /[\r\n;]/.test(cookieName) || /[\r\n]/.test(cookieValue)) {
                    throw new SteamPasswordChangeError('Stored Steam cookies contain invalid characters; manual cookie refresh is required');
                }
                return `${cookieName}=${cookieValue}`;
            })
            .join('; ');
    }

    /**
     * Get standard headers used for all Steam API requests
     * @private
     * @param {string} [referer] - Optional referer URL
     * @returns {Object} Headers object
     */
    _getHeaders(referer) {
        const headers = {
            'User-Agent': this.userAgent,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://help.steampowered.com',
            'Cookie': this._cookiesToHeader(this.cookies),
        };

        if (referer) {
            headers['Referer'] = referer;
        }

        return headers;
    }

    /**
     * Make HTTP request with automatic cookie and header management
     * @private
     * @param {string} url - Target URL
     * @param {string} method - HTTP method (GET, POST)
     * @param {Object} [payload] - Request payload for POST
     * @param {string} [referer] - Referer header
     * @returns {Promise<Object>} Response data
     */
    async _makeRequest(url, method = 'GET', payload = null, referer = null) {
        try {
            const options = {
                method,
                headers: this._getHeaders(referer),
                timeout: this.timeout,
                // Steam can loop between help/store login pages; inspect redirects ourselves.
                redirect: 'manual',
            };

            if (method === 'POST' && payload) {
                options.body = new URLSearchParams(payload).toString();
            }

            const response = await fetch(url, options);

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location') || '';
                let redirectPath = 'unknown';
                try {
                    redirectPath = new URL(location, url).pathname;
                } catch {
                    // Keep the diagnostic generic if Steam returns a malformed Location header.
                }
                const error = new SteamPasswordChangeError(
                    'Steam redirected the request instead of completing it; authentication or protection blocked the operation',
                    response.status,
                    { redirectedPath: redirectPath }
                );
                error.requiresManualReview = true;
                throw error;
            }

            // Handle redirects and status
            if (!response.ok && response.status !== 200) {
                const error = new SteamPasswordChangeError(
                    `HTTP ${response.status}: ${response.statusText}`,
                    response.status,
                    null
                );
                error.requiresManualReview = response.status === 401 || response.status === 403;
                throw error;
            }

            // Update cookies from Set-Cookie header
            const setCookie = response.headers.get('set-cookie');
            if (setCookie) {
                this._parseAndUpdateCookies(setCookie);
            }

            // Parse response
            const contentType = response.headers.get('content-type');
            let data;

            if (contentType && contentType.includes('application/json')) {
                data = await response.json();

                // Steam returns HTTP 200 but sets success: false on errors
                if (data.success === false) {
                    throw new SteamPasswordChangeError(
                        `Steam API Error: ${data.errorMsg || 'Unknown error'}`,
                        response.status,
                        data
                    );
                }
            } else {
                data = await response.text();
            }

            return data;
        } catch (error) {
            if (error instanceof SteamPasswordChangeError) {
                throw error;
            }
            const wrapped = new SteamPasswordChangeError(
                `Request failed: ${error.message || 'network error'}${error.code ? ` (${error.code})` : ''}`,
                null,
                {
                    causeName: error.name || 'Error',
                    causeCode: error.code || error.cause?.code || null,
                    causeMessage: error.cause?.message || null,
                }
            );
            wrapped.cause = error;
            throw wrapped;
        }
    }

    /**
     * Parse Set-Cookie header and update cookies
     * @private
     * @param {string} setCookieHeader - Set-Cookie header value
     */
    _parseAndUpdateCookies(setCookieHeader) {
        const cookieParts = setCookieHeader.split(';')[0].split('=');
        if (cookieParts.length >= 2) {
            const [name, value] = cookieParts;
            this.cookies[name.trim()] = value.trim();
        }
    }

    /**
     * Encrypt password using RSA public key
     * @private
     * @param {string} password - Password to encrypt
     * @returns {string} Base64-encoded encrypted password
     */
    _encryptPassword(password) {
        if (!this.rsaKey) {
            throw new SteamPasswordChangeError('RSA key not available');
        }

        const { modulus, exponent } = this.rsaKey;

        // Convert password to buffer
        const passwordBuffer = Buffer.from(password, 'utf-8');

        // RSA encryption: (message ^ exponent) % modulus
        const message = BigInt('0x' + passwordBuffer.toString('hex'));
        const exp = BigInt(exponent);
        const mod = BigInt(modulus);

        const encrypted = this._modPow(message, exp, mod);
        const hexEncrypted = encrypted.toString(16).padStart(256, '0');
        const encryptedBuffer = Buffer.from(hexEncrypted, 'hex');

        return encryptedBuffer.toString('base64');
    }

    /**
     * Modular exponentiation for RSA encryption
     * @private
     * @param {BigInt} base - Base number
     * @param {BigInt} exponent - Exponent
     * @param {BigInt} modulus - Modulus
     * @returns {BigInt} Result of (base ^ exponent) % modulus
     */
    _modPow(base, exponent, modulus) {
        if (modulus === 1n) return 0n;

        let result = 1n;
        base = base % modulus;

        while (exponent > 0n) {
            if (exponent % 2n === 1n) {
                result = (result * base) % modulus;
            }
            exponent = exponent >> 1n;
            base = (base * base) % modulus;
        }

        return result;
    }

    /**
     * Step 1: Get RSA public key for password encryption
     * @private
     * @returns {Promise<void>}
     */
    async _getRSAKey() {
        const timestamp = Date.now().toString();
        const payload = {
            username: this.login,
            donotcache: timestamp,
        };

        const response = await this._makeRequest(
            'https://help.steampowered.com/ru/login/getrsakey/',
            'POST',
            payload,
            'https://help.steampowered.com/'
        );

        if (typeof response === 'string') {
            throw new SteamPasswordChangeError('Failed to parse RSA key response');
        }

        this.rsaKey = {
            modulus: response.publickey_mod,
            exponent: response.publickey_exp,
        };
        this.rsaTimestamp = response.timestamp;
    }

    /**
     * Step 2: Initialize password recovery wizard
     * @private
     * @returns {Promise<void>}
     */
    async _initializeRecoveryWizard() {
        const url = 'https://help.steampowered.com/ru/wizard/HelpChangePassword?redir=store/account/';

        const html = await this._makeRequest(url, 'GET', null, 'https://help.steampowered.com/');

        this.accountRecoveryParams = extractRecoveryParams(html);

        if (!this.accountRecoveryParams.s) {
            const responseText = typeof html === 'string' ? html.toLowerCase() : '';
            const isLoginPage = responseText.includes('login')
                && (responseText.includes('sign in') || responseText.includes('вход') || responseText.includes('password'));
            const message = isLoginPage
                ? 'Steam help session is not authenticated. Cookies may be valid for Steam Store but are not accepted by help.steampowered.com; refresh cookies including steamLoginSecure, steamMachineAuth, steamRememberLogin, and sessionid.'
                : 'Failed to extract recovery parameters from wizard. Steam returned an unexpected page or the recovery flow changed.';
            throw new SteamPasswordChangeError(message, null, {
                responseType: typeof html,
                containsLoginPage: isLoginPage,
            });
        }
    }

    /**
     * Step 3: Request 2FA code via mobile authenticator
     * @private
     * @returns {Promise<void>}
     */
    async _requestTwoFactorCode() {
        const payload = {
            ...this.accountRecoveryParams,
            method: '8', // Mobile authenticator method
            dont_email_recovery_code: '1',
        };

        const response = await this._makeRequest(
            'https://help.steampowered.com/ru/wizard/AjaxSendAccountRecoveryCode',
            'POST',
            payload,
            'https://help.steampowered.com/ru/wizard/HelpChangePassword?redir=store/account/'
        );

        if (response.success !== true) {
            throw new SteamPasswordChangeError(
                `Failed to request 2FA code: ${response.errorMsg || 'Unknown error'}`
            );
        }
    }

    /**
     * Step 4: Confirm 2FA code
     * Generates Steam Guard code from shared_secret and confirms it
     * @private
     * @returns {Promise<void>}
     */
    async _confirmTwoFactor() {
        // Generate current Steam Guard code (5-digit code)
        const code = SteamTotp.getAuthCode(this.sharedSecret);

        const payload = {
            ...this.accountRecoveryParams,
            code: code,
        };

        let confirmed = false;
        let retries = 0;

        while (!confirmed && retries < this.maxRetries) {
            const response = await this._makeRequest(
                'https://help.steampowered.com/ru/wizard/AjaxPollAccountRecoveryConfirmation',
                'POST',
                payload,
                'https://help.steampowered.com/ru/wizard/HelpChangePassword?redir=store/account/'
            );

            if (response.success === true) {
                confirmed = true;
                this.recoveryToken = response.recovery_token || null;
            } else {
                // Wait and try again with fresh code
                await new Promise(resolve => setTimeout(resolve, 1000));
                retries++;

                // Refresh code for retry
                const freshCode = SteamTotp.getAuthCode(this.sharedSecret);
                payload.code = freshCode;
            }
        }

        if (!confirmed) {
            throw new SteamPasswordChangeError(
                '2FA confirmation failed after maximum retries'
            );
        }
    }

    /**
     * Step 5: Verify old password
     * @private
     * @returns {Promise<void>}
     */
    async _verifyOldPassword() {
        const encryptedPassword = this._encryptPassword(this.oldPassword);

        const payload = {
            ...this.accountRecoveryParams,
            old_password: encryptedPassword,
            rsatimestamp: this.rsaTimestamp,
        };

        const response = await this._makeRequest(
            'https://help.steampowered.com/ru/wizard/AjaxAccountRecoveryVerifyPassword/',
            'POST',
            payload,
            'https://help.steampowered.com/ru/wizard/HelpChangePassword?redir=store/account/'
        );

        if (response.success !== true) {
            throw new SteamPasswordChangeError(
                `Old password verification failed: ${response.errorMsg || 'Incorrect password'}`
            );
        }
    }

    /**
     * Step 6: Set new password
     * @private
     * @returns {Promise<void>}
     */
    async _setNewPassword() {
        const encryptedPassword = this._encryptPassword(this.newPassword);

        const payload = {
            ...this.accountRecoveryParams,
            new_password: encryptedPassword,
            rsatimestamp: this.rsaTimestamp,
        };

        const response = await this._makeRequest(
            'https://help.steampowered.com/ru/wizard/AjaxAccountRecoveryChangePassword/',
            'POST',
            payload,
            'https://help.steampowered.com/ru/wizard/HelpChangePassword?redir=store/account/'
        );

        if (response.success !== true) {
            throw new SteamPasswordChangeError(
                `Password change failed: ${response.errorMsg || 'Unknown error'}`
            );
        }
    }

    /**
     * Step 7: Deauthorize all devices (force logout from all devices)
     * @private
     * @returns {Promise<void>}
     */
    async _deauthorizeAllDevices() {
        if (!this.cookies.sessionid || !this.cookies.steamLoginSecure) {
            const error = new SteamPasswordChangeError('sessionid and steamLoginSecure cookies are required for deauthorization');
            error.requiresManualReview = true;
            throw error;
        }

        const payload = {
            action: 'deauthorize',
            sessionid: this.cookies.sessionid,
        };

        let response;
        try {
            response = await this._makeRequest(
                'https://store.steampowered.com/twofactor/manage_action',
                'POST',
                payload,
                'https://store.steampowered.com/twofactor/manage'
            );
        } catch (error) {
            if (error.statusCode >= 300 && error.statusCode < 400) {
                return this._deauthorizeWithBrowser();
            }
            throw error;
        }

        // Steam may return HTML here; reject login/error pages instead of treating HTTP 200 alone as success.
        if (typeof response === 'object' && response.success === false) {
            throw new SteamPasswordChangeError(
                `Device deauthorization failed: ${response.errorMsg || 'Unknown error'}`
            );
        }

        if (!response || (typeof response === 'string' && /login|sign in|вход/i.test(response))) {
            const error = new SteamPasswordChangeError('Steam rejected device deauthorization; manual verification is required');
            error.requiresManualReview = true;
            throw error;
        }

        return { success: true };
    }

    async _deauthorizeWithBrowser() {
        let browser;
        let context;
        try {
            const { chromium } = await import('playwright');
            const profileDir = String(process.env.STEAM_BROWSER_PROFILE_DIR || '').trim();
            const headless = process.env.STEAM_BROWSER_HEADLESS !== 'false';
            if (profileDir) {
                // A persistent profile preserves Steam's browser-bound auth and anti-bot state.
                context = await chromium.launchPersistentContext(profileDir, {
                    headless,
                    userAgent: this.userAgent,
                });
                // The profile may hold a stale or expired Steam session. Playwright applies the
                // persisted auth state first, so simply adding cookies afterwards is not enough to
                // override it — the stale cookies must be wiped before fresh ones are applied.
                await context.clearCookies();
            } else {
                browser = await chromium.launch({ headless: true });
                context = await browser.newContext({ userAgent: this.userAgent });
            }

            // Always seed the fresh cookies from the account record so the browser session
            // reflects the latest known-good auth state, regardless of profile usage.
            const sessionid = this.cookies && this.cookies.sessionid;
            const steamLoginSecure = this.cookies && this.cookies.steamLoginSecure;
            console.log('Seeding browser cookies:', {
                keys: Object.keys(this.cookies || {}),
                sessionid_present: sessionid !== undefined && sessionid !== null,
                sessionid_len: sessionid !== undefined && sessionid !== null ? String(sessionid).length : 0,
                steamLoginSecure_present: steamLoginSecure !== undefined && steamLoginSecure !== null,
                steamLoginSecure_len: steamLoginSecure !== undefined && steamLoginSecure !== null ? String(steamLoginSecure).length : 0,
            });

            await context.addCookies(Object.entries(this.cookies).map(([name, value]) => ({
                name,
                value: String(value),
                domain: '.steampowered.com',
                path: '/',
            })));

            const page = await context.newPage();
            await page.goto('https://store.steampowered.com/twofactor/manage', {
                waitUntil: 'domcontentloaded',
                timeout: this.timeout,
            });

            console.log('Browser navigated to:', page.url());

            if (/\/login\//i.test(page.url()) && !headless) {
                // Headed mode is the one-time setup path: the operator can complete Steam Guard or CAPTCHA.
                await page.waitForURL((url) => !/\/login\//i.test(url.toString()), {
                    timeout: 120_000,
                });
            }

            if (/\/login\//i.test(page.url())) {
                console.log('Detected redirect to /login/, browser session is not authenticated:', page.url());
                const error = new SteamPasswordChangeError('Steam browser session is not authenticated for device deauthorization');
                error.requiresManualReview = true;
                error.responseBody = { browserPath: new URL(page.url()).pathname };
                throw error;
            }

            const form = page.locator('#deauthorize_devices_form');
            if (await form.count() === 0) {
                const error = new SteamPasswordChangeError('Steam device-management page has no deauthorization form; manual verification is required');
                error.requiresManualReview = true;
                throw error;
            }

            const navigation = page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: this.timeout,
            });
            await form.evaluate((node) => node.submit());
            const response = await navigation.catch((error) => {
                throw new SteamPasswordChangeError(`Steam deauthorization form submission failed: ${error.message || 'navigation error'}`);
            });

            if (!response) {
                throw new SteamPasswordChangeError('Steam deauthorization form submission returned no response; manual verification is required');
            }

            const result = {
                status: response.status(),
                url: page.url(),
                text: await page.locator('body').innerText(),
            };
            const loginPage = /\/login\//i.test(result.url)
                || /(?:^|\s)(?:sign in|login|вход)(?:\s|$)/i.test(result.text);

            // Deauthorize can invalidate this very browser session, leaving /twofactor/manage
            // without a success banner. That transition is positive evidence of completion.
            if (loginPage) {
                return { success: true, via: 'browser', sessionInvalidated: true };
            }

            if (result.status < 200 || result.status >= 300 || /error|failed|ошибк/i.test(result.text)) {
                const error = new SteamPasswordChangeError(
                    `Steam browser session did not confirm device deauthorization; manual verification is required [HTTP ${result.status}, path ${new URL(result.url).pathname}]`,
                    result.status,
                    {
                        browserPath: new URL(result.url).pathname,
                        loginPage: false,
                        confirmed: false,
                    }
                );
                error.requiresManualReview = true;
                throw error;
            }

            return { success: true, via: 'browser', responseAccepted: true };
        } catch (error) {
            if (error instanceof SteamPasswordChangeError) {
                throw error;
            }
            throw new SteamPasswordChangeError(`Steam browser deauthorization failed: ${error.message || 'unknown browser error'}`);
        } finally {
            await context?.close();
            await browser?.close();
        }
    }

    /**
     * Execute the complete account recovery flow
     * @public
     * @returns {Promise<Object>} Result object with completion status and details
     */
    async executeRecovery() {
        // Deauthorization is the primary safety action; password rotation is explicit opt-in.
        const steps = [
            { name: 'Deauthorizing all devices', fn: () => this._deauthorizeAllDevices() },
        ];

        if (this.passwordChangeEnabled) {
            steps.push(
                { name: 'Getting RSA key', fn: () => this._getRSAKey() },
                { name: 'Initializing recovery wizard', fn: () => this._initializeRecoveryWizard() },
                { name: 'Requesting 2FA code', fn: () => this._requestTwoFactorCode() },
                { name: 'Confirming 2FA code', fn: () => this._confirmTwoFactor() },
                { name: 'Verifying old password', fn: () => this._verifyOldPassword() },
                { name: 'Setting new password', fn: () => this._setNewPassword() },
            );
        }

        const results = {
            success: false,
            completedSteps: [],
            failedStep: null,
            error: null,
            account: this.login,
            timestamp: new Date().toISOString(),
        };

        for (const step of steps) {
            try {
                await step.fn();
                results.completedSteps.push(step.name);
                console.log(`✓ ${step.name}`);
            } catch (error) {
                results.failedStep = step.name;
                results.error = error.message;
                console.error(`✗ ${step.name}: ${formatSteamError(error)}`);
                throw error;
            }
        }

        results.success = true;
        return results;
    }
}

export async function deauthorizeAllDevices(sessionId, steamLoginSecure, options = {}) {
    // Keep this public helper small so cleanup callers do not need to know recovery internals.
    const recoverer = new SteamAccountRecoverer({
        login: options.login || '',
        oldPassword: '',
        newPassword: '',
        sharedSecret: '',
        cookies: { sessionid: sessionId, steamLoginSecure },
        userAgent: options.userAgent,
        timeout: options.timeout,
    });

    return recoverer._deauthorizeAllDevices();
}

/**
 * Convenience function for quick account recovery
 * @param {Object} config - Configuration object (same as SteamAccountRecoverer constructor)
 * @returns {Promise<Object>} Recovery result
 */
export async function recoverSteamAccount(config) {
    const recoverer = new SteamAccountRecoverer(config);
    return recoverer.executeRecovery();
}
