import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFunpayOrderIdFromUrl, parseLotId, parseNewOrders } from '../src/funpay/orderParser.js';

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
    lotCount: 1,
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
    lotCount: 1,
    createdLabel: 'today',
  }]);
});

test('ignores #1 and 1 hour as lot count when the order is a single lot', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#NSGQQLZC</div>
      <a data-href="/users/20395268/"></a>
      <div class="media-user-name">bambino7771</div>
      <div class="tc-price">1 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">💖✅❗️АВТО-АРЕНДА 24/7✅【1700 MMR】✅【7000 ПОРЯДЫ】【1 ЧАС】❗️✅💖【#1】, Аренда, 2000 MMR, 7013 порядочности, 7013 вежливости, 434 матчей</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'NSGQQLZC',
    buyerId: 20395268,
    buyerUsername: 'bambino7771',
    price: 1,
    status: 'Paid',
    description: '💖✅❗️АВТО-АРЕНДА 24/7✅【1700 MMR】✅【7000 ПОРЯДЫ】【1 ЧАС】❗️✅💖【#1】, Аренда, 2000 MMR, 7013 порядочности, 7013 вежливости, 434 матчей',
    lotId: null,
    lotCount: 1,
    createdLabel: 'today',
  }]);
});

test('parses lot count from order description', () => {
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
    lotCount: 2,
    createdLabel: 'today',
  }]);
});

test('parses lot count from Russian quantity words', () => {
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
    lotCount: 2,
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
    lotCount: 1,
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
    lotCount: 1,
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
    lotCount: 1,
    createdLabel: 'today',
  }]);
});

test('ignores unrelated numeric values when lot count is absent', () => {
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
    lotCount: 1,
    createdLabel: 'today',
  }]);
});

test('extracts FunPay order id from order and chat URLs without treating them as lot ids', () => {
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/orders/123456/'), 123456);
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/order/123456/'), 123456);
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/chats/123456/'), 123456);
  assert.equal(parseFunpayOrderIdFromUrl('https://funpay.com/posts/123456/'), null);
  assert.equal(parseLotId('https://funpay.com/orders/123456/'), null);
  assert.equal(parseLotId('https://funpay.com/chats/123456/'), null);
});

test('ignores items without an order number', () => {
  assert.deepEqual(parseNewOrders('<div class="tc-item info"><div>missing</div></div>'), []);
});
