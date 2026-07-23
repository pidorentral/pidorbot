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

function decodeHtml(value) {
  const amp = String.fromCharCode(38);

  return value
    .replaceAll(`${amp}quot;`, '"')
    .replaceAll(`${amp}#34;`, '"')
    .replaceAll(`${amp}#x22;`, '"')
    .replaceAll(`${amp}#39;`, "'")
    .replaceAll(`${amp}#x27;`, "'")
    .replaceAll(`${amp}lt;`, '<')
    .replaceAll(`${amp}gt;`, '>')
    .replaceAll(`${amp}amp;`, '&')
    .trim();
}

function getAppData(html) {
  const marker = html.indexOf('data-app-data=');
  if (marker === -1) throw new FunpayAuthError();

  const attributeStart = marker + 'data-app-data='.length;
  const quote = html[attributeStart];
  const start = attributeStart + 1;

  if (quote !== '"' && quote !== "'") {
    throw new FunpayAuthError();
  }

  const end = html.indexOf(quote, start);
  if (end === -1) throw new FunpayAuthError();

  const raw = decodeHtml(html.slice(start, end));

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.log('First chars:', [...raw.slice(0, 20)].map((c) => c.charCodeAt(0)));
    console.log('Prefix:', JSON.stringify(raw.slice(0, 100)));
    throw new Error(`Invalid FunPay app data: ${error.message}`);
  }
}

function parseChatResponse(json) {
  const result = {
    lastEventId: json.last_event ?? 0,
    chats: [],
  };

  const bookmarks = json.objects?.find((o) => o.type === 'chat_bookmarks');
  if (!bookmarks?.data?.html) return result;

  const html = bookmarks.data.html;

  // Each contact is a <a class="contact-item"> block
  const contactRegex = /<a[^>]*class="contact-item[^"]*"[^>]*href="\/chat\/\?node=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = contactRegex.exec(html)) !== null) {
    const nodeId = Number(match[1]);
    const block = match[2];

    // Username
    const nameMatch = block.match(/<div[^>]*class="media-user-name[^"]*"[^>]*>(.*?)<\/div>/i);
    const username = nameMatch ? nameMatch[1].trim() : null;

    // Last message preview
    const msgMatch = block.match(/<div[^>]*class="contact-item-message[^"]*"[^>]*>(.*?)<\/div>/is);
    const lastMessage = msgMatch ? msgMatch[1].replace(/<[^>]+>/g, '').trim() : null;

    // Unread indicator
    const unread = /unread/.test(match[0]);

    result.chats.push({ nodeId, username, lastMessage, unread });
  }

  return result;
}

export class FunpayClient {
  constructor({ goldenKey = getGoldenKey(), fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.goldenKey = goldenKey;
    this.fetch = fetchImpl;
    this._appData = null;
    this.cookies = new Map()
  }

  _buildCookieHeader() {
  const cookies = new Map(this.cookies);
  cookies.set('golden_key', this.goldenKey);
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
}

  _captureSetCookies(response) {
    const raw = response.headers.getSetCookie?.() || response.headers.raw?.()['set-cookie'] || [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const [name, ...rest] = pair.split('=');
      this.cookies.set(name.trim(), rest.join('=').trim());
    }
  }

  async request(path = '', options = {}) {
  const response = await this.fetch(new URL(path, FUNPAY_URL), {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'pidorbot/1.0',
      Cookie: this._buildCookieHeader(),
      ...options.headers,
    },
    redirect: 'follow',
    ...options,
  });

  if (!response.ok) throw new Error(`FunPay request failed with HTTP ${response.status}`);

  this._captureSetCookies(response);

  const html = await response.text();
  if (response.url.includes('/login') || response.url.includes('/auth')) throw new FunpayAuthError();
  return html;
}

  // --- App data & CSRF ---

  async getAppData() {
    if (!this._appData) {
      const html = await this.request();
      this._appData = getAppData(html);
    }
    return this._appData;
  }

  invalidateAppData() {
    this._appData = null;
  }

  async getCsrfToken() {
    const appData = await this.getAppData();
    const token = appData['csrf-token'] || appData.csrfToken;
    if (!token) throw new Error('CSRF token not found in FunPay app data');
    return token;
  }

  // --- Profile ---

  async getProfile() {
    const appData = await this.getAppData();
    const userId = Number(appData.userId);
    if (!Number.isSafeInteger(userId)) throw new FunpayAuthError();

    return {
      userId,
      username: typeof appData.username === 'string' ? appData.username : null,
    };
  }

  // Orders

  async getNewOrders() {
    const html = await this.request('orders/trade');
    return parseNewOrders(html);
  }

  // Messages
  async getNewMessages(lastEventId = 0) {
  const csrfToken = await this.getCsrfToken();

  const body = new URLSearchParams({
    request: JSON.stringify({
      action: 'chat_bookmarks',
      data: { last_event: lastEventId },
    }),
    csrf_token: csrfToken,
  });

  const response = await this.fetch(new URL('/runner/', FUNPAY_URL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'pidorbot/1.0',
      Cookie: this._buildCookieHeader(),
      'X-Requested-With': 'XMLHttpRequest',
      Origin: FUNPAY_URL,
      Referer: `${FUNPAY_URL}chat/`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chat poll failed: HTTP ${response.status}: ${text}`);
  }
  
  const json = await response.json();
  if (json.error) throw new Error(`Chat poll error: ${json.error}`);

  return parseChatResponse(json);
}

  async sendMessage(nodeId, content) {
    const csrfToken = await this.getCsrfToken();

    const body = new URLSearchParams({
      request: JSON.stringify({
        action: 'chat_message',
        data: {
          node: Number(nodeId),
          content: String(content),
        },
      }),
      csrf_token: csrfToken,
    });

    const response = await this.fetch(new URL('/runner/', FUNPAY_URL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'pidorbot/1.0',
        Cookie: this._buildCookieHeader(),
        'X-Requested-With': 'XMLHttpRequest',
        Origin: FUNPAY_URL,
        Referer: `${FUNPAY_URL}chat/`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`FunPay chat send failed: HTTP ${response.status} ${text}`);
    }

    const json = await response.json();
    if (json.error) throw new Error(`FunPay chat error: ${json.error}`);
    return json;
  }

  async getChatNodeId(buyerId) {
    const html = await this.request(`chat/?node=${buyerId}`);
    const match = html.match(/data-node=['"]([\d]+)['"]/);
    if (match) return Number(match[1]);

    // fallback: try to find in chat list
    const listMatch = html.match(
      new RegExp(`data-id=['"](\\d+)['"][^>]*data-user-id=['"]${buyerId}['"]`, 'i')
    );
    return listMatch ? Number(listMatch[1]) : null;
  }
}