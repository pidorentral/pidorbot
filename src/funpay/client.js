import { parseNewOrders } from './orderParser.js';

const FUNPAY_URL = 'https://funpay.com/';

export class FunpayAuthError extends Error {
  constructor(message = 'FunPay session is not authorized') {
    super(message);
    this.name = 'FunpayAuthError';
  }
}

function getGoldenKey() {
  const key = process.env.FUNPAY_GOLDEN_KEY?.trim();
  if (!key) throw new Error('FUNPAY_GOLDEN_KEY is not configured');
  return key;
}

function decodeHtmlAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function getAppData(html) {
  const match = html.match(/data-app-data=(['"])([\s\S]*?)\1/);
  if (!match) throw new FunpayAuthError();

  try {
    return JSON.parse(decodeHtmlAttribute(match[2]));
  } catch {
    throw new Error('FunPay returned an unsupported profile page');
  }
}

export class FunpayClient {
  constructor({ goldenKey = getGoldenKey(), fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.goldenKey = goldenKey;
    this.fetch = fetchImpl;
  }

  async request(path = '') {
    const response = await this.fetch(new URL(path, FUNPAY_URL), {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'pidorbot/1.0 (+FunPay session check)',
        Cookie: `golden_key=${this.goldenKey}`,
      },
      redirect: 'follow',
    });

    if (!response.ok) throw new Error(`FunPay request failed with HTTP ${response.status}`);

    const html = await response.text();
    if (response.url.includes('/login') || response.url.includes('/auth')) throw new FunpayAuthError();
    return html;
  }

  async getProfile() {
    const appData = getAppData(await this.request());
    const userId = Number(appData.userId);
    if (!Number.isSafeInteger(userId)) throw new FunpayAuthError();

    return {
      userId,
      username: typeof appData.username === 'string' ? appData.username : null,
    };
  }

  async getNewOrders() {
    const html = await this.request('orders/trade');
    return parseNewOrders(html);
  }
}
