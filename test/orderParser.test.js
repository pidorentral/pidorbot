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
    createdLabel: 'today',
  }]);
});

test('ignores items without an order number', () => {
  assert.deepEqual(parseNewOrders('<div class="tc-item info"><div>missing</div></div>'), []);
});
