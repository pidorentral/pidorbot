import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFunpayOrderIdFromUrl, parseLotId, parseNewOrders, parseSelectedLotsCount } from '../src/funpay/orderParser.js';
import { normalizeSelectedLotsCount } from '../src/funpay/handlers/orderHandler.js';

test('parses new FunPay orders from trade page markup', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#ABC-123</div>
      <a data-href="/users/42/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 234,50 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'ABC-123',
    buyerId: 42,
    buyerUsername: 'buyer_name',
    price: 1234.5,
    status: 'Paid',
    description: 'Steam account',
    lotId: null,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('ignores rating mentions in order description', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#DEF-456</div>
      <a data-href="/users/100/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">999 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Dota 2 аккаунт 5к рейтинг</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'DEF-456',
    buyerId: 100,
    buyerUsername: 'buyer_name',
    price: 999,
    status: 'Paid',
    description: 'Dota 2 аккаунт 5к рейтинг',
    lotId: null,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('ignores #1 and 1 hour as quantity indicators when the order is a single lot', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#NSGQQLZC</div>
      <a data-href="/users/20395268/"></a>
      <div class="media-user-name">bambino7771</div>
      <div class="tc-price">1 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">💖✅❗️АВТО-АРЕНДА 24/7✅【7000 ПОРЯДЫ】【1 ЧАС】❗️✅💖【#1】, Аренда, 7013 порядочности, 7013 вежливости, 434 матчей</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'NSGQQLZC',
    buyerId: 20395268,
    buyerUsername: 'bambino7771',
    price: 1,
    status: 'Paid',
    description: '💖✅❗️АВТО-АРЕНДА 24/7✅【7000 ПОРЯДЫ】【1 ЧАС】❗️✅💖【#1】, Аренда, 7013 порядочности, 7013 вежливости, 434 матчей',
    lotId: null,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('ignores explicit quantity words in descriptions when using the single-lot runtime model', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#GHI-789</div>
      <a data-href="/users/100/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">999 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account x2</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'GHI-789',
    buyerId: 100,
    buyerUsername: 'buyer_name',
    price: 999,
    status: 'Paid',
    description: 'Steam account x2',
    lotId: null,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('ignores Russian quantity words in descriptions when runtime quantity is fixed to one', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#MNO-345</div>
      <a data-href="/users/100/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 200 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account 2 лота</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'MNO-345',
    buyerId: 100,
    buyerUsername: 'buyer_name',
    price: 1200,
    status: 'Paid',
    description: 'Steam account 2 лота',
    lotId: null,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('parses lot id from order link', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#JKL-012</div>
      <a href="https://funpay.com/offer/123456/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 500 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'JKL-012',
    buyerId: null,
    buyerUsername: 'buyer_name',
    price: 1500,
    status: 'Paid',
    description: 'Steam account',
    lotId: 123456,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('parses lot id from lots/offer?id= URL format', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#LLWUVCSD</div>
      <a href="https://funpay.com/lots/offer?id=73721885"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 200 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'LLWUVCSD',
    buyerId: null,
    buyerUsername: 'buyer_name',
    price: 1200,
    status: 'Paid',
    description: 'Steam account',
    lotId: 73721885,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('parses lot id from data-href lots/offer?id= URL format', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#LLWUVCSD</div>
      <a data-href="https://funpay.com/lots/offer?id=73721885"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 200 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'LLWUVCSD',
    buyerId: null,
    buyerUsername: 'buyer_name',
    price: 1200,
    status: 'Paid',
    description: 'Steam account',
    lotId: 73721885,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('prefers the real offer id from offer edit URLs instead of the internal node id', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#EDIT-URL</div>
      <a href="https://funpay.com/lots/offerEdit?node=81&offer=77733347"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 200 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'EDIT-URL',
    buyerId: null,
    buyerUsername: 'buyer_name',
    price: 1200,
    status: 'Paid',
    description: 'Steam account',
    lotId: 77733347,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('prefers the offer parameter over node when parsing offer edit URLs', () => {
  assert.equal(parseLotId('<a href="https://funpay.com/lots/offerEdit?node=81&offer=77733347"></a>'), 77733347);
  assert.equal(parseLotId('<a href="https://funpay.com/lots/offerEdit?node=81&id=77733347"></a>'), 77733347);
});

test('ignores unrelated generic ids before a real offerEdit offer id in mixed markup', () => {
  const html = `
    <a href="https://funpay.com/other?id=81"></a>
    <a href="https://funpay.com/lots/offerEdit?node=81&offer=77733347"></a>
  `;
  assert.equal(parseLotId(html), 77733347);
});

test('extracts selected lots count from the real FunPay quantity label markup', () => {
  assert.equal(parseSelectedLotsCount('<div>Количество: <span>2</span></div>'), 2);
  assert.equal(parseSelectedLotsCount('<div class="param-item"><h5>Количество</h5><div class="text-bold">4 шт.</div></div>'), 4);
});

test('ignores unrelated numeric values when there is no valid lot id', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#PQR-999</div>
      <a data-href="/users/100/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 200 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account 4 часа 2к рейтинг</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'PQR-999',
    buyerId: 100,
    buyerUsername: 'buyer_name',
    price: 1200,
    status: 'Paid',
    description: 'Steam account 4 часа 2к рейтинг',
    lotId: null,
    selectedLotsCount: null,
    createdLabel: 'today',
  }]);
});

test('extracts FunPay order id from order and chat URLs without treating them as lot ids', () => {
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/orders/123456/'), 123456);
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/order/123456/'), 123456);
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/chats/123456/'), 123456);
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/orders/LHJBDGCA/'), 'LHJBDGCA');
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/posts/123456/'), null);
  assert.equal(parseLotId('https://funpay.com/orders/123456/'), null);
  assert.equal(parseLotId('https://funpay.com/orders/LHJBDGCA/'), null);
  assert.equal(parseLotId('https://funpay.com/chats/123456/'), null);
});

test('parses selected lots only from structured order metadata', () => {
  assert.equal(parseSelectedLotsCount('<div data-quantity="3"></div>'), 3);
  // Exact stable structure from FunPay's order detail page:
  // <h5>Количество</h5><div class="text-bold">3 шт.</div>
  assert.equal(parseSelectedLotsCount('<div class="param-item"><h5>Количество</h5><div class="text-bold">4 шт.</div></div>'), 4);
  assert.equal(parseSelectedLotsCount('<div class="order-desc">Аренда 24 часа x3</div>'), null);
  assert.equal(parseSelectedLotsCount('<div data-qty="0"></div>'), null);
});

test('exposes selected lots count from a FunPay trade row data attribute', () => {
  const html = `
    <div class="tc-item info" data-selected-lots-count="3">
      <div class="tc-order">#QTY-123</div>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">300 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account 12 hours</div>
    </div>
  `;

  assert.equal(parseNewOrders(html)[0].selectedLotsCount, 3);
});

test('prefers the full offer id over an internal lot id', () => {
  assert.equal(
    parseLotId('<div data-lot-id="7" data-offer-id="77300004"></div>'),
    77300004,
  );
});

test('prefers the real offer url over an internal trade-row lot id', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#JTXBW7EN</div>
      <a href="https://funpay.com/lots/offer?id=77733347"></a>
      <div data-lot-id="7"></div>
    </div>
  `;

  assert.equal(parseLotId(html), 77733347);
});

test('ignores incidental short numeric ids without a canonical FunPay offer URL', () => {
  assert.equal(parseLotId('<div data-offer-id="4"></div>'), null);
  assert.equal(parseLotId('<div data-lot-id="7"></div>'), null);
  assert.equal(parseLotId('<a href="https://example.com?id=4"></a>'), null);
});

test('ignores order pages and still throws on malformed offer URLs', () => {
  assert.doesNotThrow(() => parseLotId('<div>No FunPay offer here</div>'));
  assert.equal(parseLotId('https://funpay.com/orders/not-a-valid-offer-id/'), null);
  assert.equal(parseLotId('https://funpay.com/chat/'), null);
  assert.equal(parseLotId('<a href="https://funpay.com/chat/"></a>'), null);
  assert.equal(parseLotId('<a href="https://funpay.com/chat/?node=276018342"></a>'), null);
  assert.equal(parseLotId('<a href="https://funpay.com/other?id=81"></a>'), null);
  assert.equal(parseLotId('<a href="https://funpay.com/lots/offer?id=81"></a>'), null);
  assert.equal(parseLotId('<a href="https://funpay.com/lots/offer?id=77733347"></a>'), 77733347);
  assert.throws(() => parseLotId('<a href="https://funpay.com/lots/offer?offer_id=abc"></a>'), /FunPay|offer/i);
});

test('uses a single lot fallback when FunPay omits the selected-lots count', () => {
  const warnLogs = [];
  assert.equal(normalizeSelectedLotsCount(null, {
    funpayOrderId: 'TEST-42',
    effectiveLotId: '77733347',
    logger: { warn: (message) => warnLogs.push(message) },
  }), 1);
  assert.equal(warnLogs.length, 1);
  assert.match(warnLogs[0], /используем 1 по умолчанию/i);
});

test('ignores items without an order number', () => {
  assert.deepEqual(parseNewOrders('<div class="tc-item info"><div>missing</div></div>'), []);
});
