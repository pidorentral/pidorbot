import { parseNewOrders } from './src/funpay/orderParser.js';

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

console.log(JSON.stringify(parseNewOrders(html), null, 2));
