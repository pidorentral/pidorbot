import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNewOrders } from '../src/funpay/orderParser.js';

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
    desiredMmr: null,
    lotId: null,
    lotCount: 1,
    createdLabel: 'today',
  }]);
});

test('parses desiredMmr from order description', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#DEF-456</div>
      <a data-href="/users/100/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">999 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Dota 2 аккаунт 5к ММР</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'DEF-456',
    buyerId: 100,
    buyerUsername: 'buyer_name',
    price: 999,
    status: 'Paid',
    description: 'Dota 2 аккаунт 5к ММР',
    desiredMmr: 5000,
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
    desiredMmr: null,
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
    desiredMmr: null,
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
    desiredMmr: null,
    lotId: 123456,
    lotCount: 1,
    createdLabel: 'today',
  }]);
});

test('ignores other numeric values when lot count is absent', () => {
  const html = `
    <div class="tc-item info">
      <div class="tc-order">#PQR-999</div>
      <a data-href="/users/100/"></a>
      <div class="media-user-name">buyer_name</div>
      <div class="tc-price">1 200 ₽</div>
      <div class="tc-status">Paid</div>
      <div class="order-desc">Steam account 4 часа 2к ммр</div>
      <div class="tc-date-time">today</div>
    </div>
  `;

  assert.deepEqual(parseNewOrders(html), [{
    funpayOrderId: 'PQR-999',
    buyerId: 100,
    buyerUsername: 'buyer_name',
    price: 1200,
    status: 'Paid',
    description: 'Steam account 4 часа 2к ммр',
    desiredMmr: 2000,
    lotId: null,
    lotCount: 1,
    createdLabel: 'today',
  }]);
});

test('ignores items without an order number', () => {
  assert.deepEqual(parseNewOrders('<div class="tc-item info"><div>missing</div></div>'), []);
});
