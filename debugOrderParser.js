import('./src/funpay/orderParser.js').then((m) => {
  const html = '<div class="tc-item info"><div class="tc-order">#DEF-456</div><a data-href="/users/100/"></a><div class="media-user-name">buyer_name</div><div class="tc-price">999 ₽</div><div class="tc-status">Paid</div><div class="order-desc">Dota 2 аккаунт 5к ММР</div><div class="tc-date-time">today</div></div>';
  console.log(JSON.stringify(m.parseNewOrders(html), null, 2));
});
