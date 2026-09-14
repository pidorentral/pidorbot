import { query } from '../db.js';
import * as crypto from '../crypto.js';
import { parseNewOrders } from './orderParser.js';

const FUNPAY_URL = 'https://funpay.com/';

export class FunpayAuthError extends Error {
  constructor(message = 'FunPay session is not authorized') {
    super(message);
    this.name = 'FunpayAuthError';
  }
}

export class FunpayRateLimitError extends Error {
  constructor(message = 'FunPay rate limit exceeded') {
    super(message);
    this.name = 'FunpayRateLimitError';
  }
}

export async function resolveSettingsTable(queryFn = query) {
  const tableCheck = await queryFn(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('settings', 'app_settings')
    ORDER BY table_name = 'settings' DESC, table_name
    LIMIT 1
  `);

  if (tableCheck.rows?.length) {
    return tableCheck.rows[0].table_name;
  }

  try {
    await queryFn(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return 'settings';
  } catch {
    await queryFn(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return 'app_settings';
  }
}

export async function getGoldenKey() {
  const tableName = await resolveSettingsTable();

  const result = await query(
    `SELECT value FROM ${tableName} WHERE key = $1 LIMIT 1`,
    ['FUNPAY_GOLDEN_KEY'],
  );

  const rawValue = result.rows[0]?.value;
  const value = typeof rawValue === 'string'
    ? rawValue
    : rawValue == null
      ? null
      : JSON.stringify(rawValue);

  if (!value) {
    throw new Error('FUNPAY_GOLDEN_KEY is not configured');
  }

  return crypto.decrypt(value);
}

export async function setGoldenKey(value) {
  const key = String(value || '').trim();
  if (!key) {
    throw new Error('FUNPAY_GOLDEN_KEY cannot be empty');
  }

  const encrypted = crypto.encrypt(key);
  const tableName = await resolveSettingsTable();
  const jsonValue = JSON.stringify(encrypted);

  await query(
    `INSERT INTO ${tableName} (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    ['FUNPAY_GOLDEN_KEY', jsonValue],
  );

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

function parseBookmarksHtml(html = '') {
  const chats = [];
  const blocks = html.split(/<a /gi).slice(1);

  for (const block of blocks) {
    const nodeId = block.match(/data-id="(\d+)"/)?.[1];
    const nodeMsgId = block.match(/data-node-msg="(\d+)"/)?.[1];
    const userMsgId = block.match(/data-user-msg="(\d+)"/)?.[1];
    const username = block.match(/media-user-name">(.*?)<\/div>/)?.[1]?.trim();
    const lastMessage = block.match(/contact-item-message">([\s\S]*?)<\/div>/)?.[1]?.trim();

    if (nodeId) {
      chats.push({
        nodeId: Number(nodeId),
        lastMsgId: Number(nodeMsgId || userMsgId || 0),
        username,
        text: lastMessage || '',
      });
    }
  }

  return chats;
}

function parseChatResponse(json) {
  const objects = json?.objects || [];
  const chats = [];

  for (const obj of objects) {
    if (obj.type !== 'chat_bookmarks') continue;
    chats.push(...parseBookmarksHtml(obj.data?.html || ''));
  }

  return chats;
}
function findNodeIdByUsername(html, username) {
  const blocks = html.split(/<a /gi).slice(1);

  for (const block of blocks) {
    const name = block.match(/media-user-name">\s*([^<]+?)\s*<\/div>/)?.[1]?.trim();
    if (name === username) {
      const nodeId = block.match(/data-id="(\d+)"/)?.[1];
      if (nodeId) return Number(nodeId);
    }
  }

  return null;
}

export class FunpayClient {
  constructor({ goldenKey = null, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.goldenKey = goldenKey || '';
    this.fetch = fetchImpl;
    this._appData = null;
    this.cookies = new Map();
  }

  async ensureGoldenKey() {
    if (!this.goldenKey) {
      this.goldenKey = await getGoldenKey();
    }
    this.cookies.set('golden_key', this.goldenKey);
    return this.goldenKey;
  }

  async setGoldenKey(value) {
    this.goldenKey = await setGoldenKey(value);
    this.cookies.set('golden_key', this.goldenKey);
    return this.goldenKey;
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

  async _requestResponse(path = '', options = {}) {
    await this.ensureGoldenKey();
    const { headers = {}, ...requestOptions } = options;
    const response = await this.fetch(new URL(path, FUNPAY_URL), {
      ...requestOptions,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Cookie: this._buildCookieHeader(),
        ...headers,
      },
    });

    this._captureSetCookies(response);
    if (response.url.includes('/login') || response.url.includes('/auth')) throw new FunpayAuthError();
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const bodySnippet = bodyText.slice(0, 400).replace(/\s+/g, ' ').trim();
      const message = `FunPay request failed with HTTP ${response.status}${bodySnippet ? `: ${bodySnippet}` : ''}`;

      if (response.status === 429) {
        throw new FunpayRateLimitError(message);
      }

      throw new Error(message);
    }
    return response;
  }

  async request(path = '', options = {}) {
    const response = await this._requestResponse(path, options);
    return response.text();
  }

  async requestJson(path, options = {}) {
    const response = await this._requestResponse(path, options);
    return response.json();
  }

  // --- App data & CSRF ---

  async getAppData() {
    const html = await this.request();
    this._appData = getAppData(html);
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

  async getNewOrders(logger = console) {
    const html = await this.request('orders/trade');
    return parseNewOrders(html, logger);
  }

  // Messages
  async getNewMessages(chatPairs = []) {
    const csrfToken = await this.getCsrfToken();
    const appData = await this.getAppData();
    const userId = appData.userId;

    const objects = [
      {
        type: 'chat_bookmarks',
        id: String(userId),
        tag: '',
        data: chatPairs, // [[nodeId, lastMsgId], [nodeId, lastMsgId], ...]
      },
    ];

    const body = new URLSearchParams();
    body.append('objects', JSON.stringify(objects));
    body.append('request', 'false');
    body.append('csrf_token', csrfToken);

    const json = await this.requestJson('/runner/', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Cookie: this._buildCookieHeader(),
        'X-Requested-With': 'XMLHttpRequest',
        Origin: FUNPAY_URL,
        Referer: `${FUNPAY_URL}chat/`,
      },
      body: body.toString(),
    });

    if (json.error) throw new Error(`Chat poll error: ${json.error}`);
    return parseChatResponse(json);
}

  async getChatList() {
  const html = await this.request('chat/');
  return html;
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

    const json = await this.requestJson('/runner/', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Cookie: this._buildCookieHeader(),
        'X-Requested-With': 'XMLHttpRequest',
        Origin: FUNPAY_URL,
        Referer: `${FUNPAY_URL}chat/`,
      },
      body: body.toString(),
    });

    if (json.error) throw new Error(`FunPay chat error: ${json.error}`);
    return json;
  }

    async getChatNodeId(buyerUsername) {
    const html = await this.request('chat/');
    return findNodeIdByUsername(html, buyerUsername);
  }
}
