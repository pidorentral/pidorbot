import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOfferAuditSummary } from '../src/funpay/handlers/orderHandler.js';

test('buildOfferAuditSummary explains when the order offer is not bound to the account', () => {
  const summary = buildOfferAuditSummary({
    funpayOrderId: 'LM4CJCXA',
    effectiveLotId: '4',
    accountId: 12,
    bindingAudit: [
      { accountId: 7, offerId: '7', hoursPerLot: 8, isActive: true },
      { accountId: 9, offerId: '4', hoursPerLot: 4, isActive: false },
    ],
  });

  assert.match(summary, /LM4CJCXA/);
  assert.match(summary, /offer 4/i);
  assert.match(summary, /account #12/i);
  assert.match(summary, /bound/i);
  assert.match(summary, /account #7.*offer 7/i);
});
