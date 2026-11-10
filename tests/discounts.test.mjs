// Discount code maths: no database needed.   node --test tests/discounts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentOf, discountAmounts, checkCode, normaliseCode, CODE_RE, allocate, gstIn, codeStatus, sydneyDayBoundary, sydneyDay, MESSAGES } from '../api/_lib/discounts.js';
import { stripeLines } from '../api/_lib/payments.js';

const code = (o = {}) => ({ id: 'c1', code: 'SAVE10', active: true, applies_to: 'products', product_scope: 'all', product_slugs: [], kind: 'percent', percent: 10,
  amount_cents: null, min_subtotal_cents: null, starts_at: null, ends_at: null, usage_limit: null, per_email_limit: null, uses: 0, ...o });
const LINES = [{ product_slug: 'foamboard', line_cents: 4500 }, { product_slug: 'pull-up-banner', line_cents: 12000 }, { product_slug: 'corflute-signs', line_cents: 768 }];
const SUB = 17268;

test('percentage off shipping, rounded half up to the cent', () => {
  assert.deepEqual(discountAmounts(code({ applies_to: 'shipping', percent: 10 }), { lines: LINES, shippingCents: 3850 }).shipping_cents, 385);
  assert.equal(discountAmounts(code({ applies_to: 'shipping', percent: 15 }), { lines: LINES, shippingCents: 3850 }).shipping_cents, 578);   // 577.5 -> 578
  assert.equal(discountAmounts(code({ applies_to: 'shipping', percent: 100 }), { lines: LINES, shippingCents: 3850 }).shipping_cents, 3850);
  assert.equal(discountAmounts(code({ applies_to: 'shipping' }), { lines: LINES, shippingCents: 3850 }).product_cents, 0);
});
test('flat amount off shipping, capped at the shipping (free shipping)', () => {
  assert.equal(discountAmounts(code({ applies_to: 'shipping', kind: 'amount', amount_cents: 1000 }), { lines: LINES, shippingCents: 3850 }).shipping_cents, 1000);
  assert.equal(discountAmounts(code({ applies_to: 'shipping', kind: 'amount', amount_cents: 99900 }), { lines: LINES, shippingCents: 3850 }).shipping_cents, 3850);
  const pending = discountAmounts(code({ applies_to: 'shipping', kind: 'amount', amount_cents: 1000 }), { lines: LINES, shippingCents: null });
  assert.equal(pending.shipping_cents, 0); assert.equal(pending.shipping_pending, true);   // no postcode yet
});
test('percentage and flat amount off all products', () => {
  assert.equal(discountAmounts(code({ percent: 10 }), { lines: LINES, shippingCents: 3850 }).product_cents, 1727);   // 1726.8 -> 1727
  assert.equal(discountAmounts(code({ percent: 12.5 }), { lines: LINES, shippingCents: 3850 }).product_cents, 2159); // 2158.5 -> 2159 (half up)
  assert.equal(discountAmounts(code({ kind: 'amount', amount_cents: 2000 }), { lines: LINES, shippingCents: 3850 }).product_cents, 2000);
  assert.equal(discountAmounts(code({ kind: 'amount', amount_cents: 2000 }), { lines: LINES, shippingCents: 3850 }).shipping_cents, 0);
});
test('flat amount on selected products comes off once, only with an eligible product in the cart', () => {
  const sel = code({ kind: 'amount', amount_cents: 1500, product_scope: 'selected', product_slugs: ['foamboard', 'corflute-signs'] });
  const r = discountAmounts(sel, { lines: LINES, shippingCents: 3850 });
  assert.equal(r.product_cents, 1500); assert.deepEqual(r.eligible, [0, 2]);
  const none = discountAmounts(sel, { lines: [LINES[1]], shippingCents: 3850 });
  assert.equal(none.product_cents, 0); assert.equal(none.no_products, true);
  const pct = discountAmounts({ ...sel, kind: 'percent', percent: 20 }, { lines: LINES, shippingCents: 3850 });
  assert.equal(pct.product_cents, percentOf(4500 + 768, 20));   // only the eligible lines
});
test('a discount never takes more than the amount it applies to', () => {
  assert.equal(discountAmounts(code({ kind: 'amount', amount_cents: 999999 }), { lines: LINES, shippingCents: 3850 }).product_cents, SUB);
  const sel = code({ kind: 'amount', amount_cents: 999999, product_scope: 'selected', product_slugs: ['corflute-signs'] });
  assert.equal(discountAmounts(sel, { lines: LINES, shippingCents: 3850 }).product_cents, 768);
  assert.equal(discountAmounts(code({ percent: 100 }), { lines: LINES, shippingCents: 3850 }).product_cents, SUB);
});
test('minimum order subtotal', () => {
  const c = code({ min_subtotal_cents: 20000 });
  assert.deepEqual(checkCode(c, { subtotalCents: SUB }), { ok: false, reason: 'min', message: 'Your order needs to be at least $200.00 to use this code' });
  assert.equal(checkCode(c, { subtotalCents: 20000 }).ok, true);
});
test('date window: not started, running, expired', () => {
  const now = Date.parse('2026-11-10T02:00:00Z');
  const c = code({ starts_at: '2026-11-11T13:00:00.000Z', ends_at: '2026-11-30T12:59:59.999Z' });
  assert.equal(checkCode(c, { subtotalCents: SUB, now }).message, MESSAGES.invalid);    // not started: plain "isn't valid"
  assert.equal(checkCode(c, { subtotalCents: SUB, now: Date.parse('2026-11-20T00:00:00Z') }).ok, true);
  assert.equal(checkCode(c, { subtotalCents: SUB, now: Date.parse('2026-12-01T00:00:00Z') }).message, MESSAGES.expired);
  assert.equal(codeStatus(c, now), 'Scheduled'); assert.equal(codeStatus(c, Date.parse('2026-12-01T00:00:00Z')), 'Expired');
});
test('Sydney day boundaries, including daylight saving', () => {
  assert.equal(sydneyDayBoundary('2026-11-12'), '2026-11-11T13:00:00.000Z');           // AEDT, UTC+11
  assert.equal(sydneyDayBoundary('2026-11-30', true), '2026-11-30T12:59:59.999Z');
  assert.equal(sydneyDayBoundary('2026-06-15'), '2026-06-14T14:00:00.000Z');           // AEST, UTC+10
  assert.equal(sydneyDayBoundary('2026-04-05', true), '2026-04-05T13:59:59.999Z');     // DST ends 5 April 2026, 3am
  assert.equal(sydneyDay('2026-11-11T13:00:00.000Z'), '2026-11-12');
});
test('usage limits: total and per email', () => {
  assert.equal(checkCode(code({ usage_limit: 3, uses: 3 }), { subtotalCents: SUB }).message, MESSAGES.used_up);
  assert.equal(checkCode(code({ usage_limit: 3, uses: 2 }), { subtotalCents: SUB }).ok, true);
  assert.equal(checkCode(code({ per_email_limit: 1 }), { subtotalCents: SUB, usesByEmail: 1 }).message, MESSAGES.used_up);
  assert.equal(checkCode(code({ per_email_limit: 1 }), { subtotalCents: SUB, usesByEmail: 0 }).ok, true);
  assert.equal(checkCode(code({ per_email_limit: 1 }), { subtotalCents: SUB, usesByEmail: null }).ok, true);   // email not known yet: checked at payment
  assert.equal(codeStatus(code({ usage_limit: 3, uses: 3 })), 'Used up');
  assert.equal(codeStatus(code({ active: false })), 'Inactive');
  assert.equal(checkCode(code({ active: false }), { subtotalCents: SUB }).message, MESSAGES.invalid);
});
test('codes: any case, spaces trimmed, letters and digits only', () => {
  assert.equal(normaliseCode('  save10 '), 'SAVE10');
  assert.ok(CODE_RE.test(normaliseCode('FreeShip2026')));
  assert.ok(!CODE_RE.test(normaliseCode('SAVE 10'))); assert.ok(!CODE_RE.test(normaliseCode('SAVE-10'))); assert.ok(!CODE_RE.test('A'));
});
test('rounding at the cent: percentages of odd amounts', () => {
  assert.equal(percentOf(1, 50), 1);       // 0.5 -> 1 (half up)
  assert.equal(percentOf(3, 50), 2);       // 1.5 -> 2
  assert.equal(percentOf(999, 33.33), 333);
  assert.equal(percentOf(1999, 7.5), 150); // 149.925 -> 150
  for (let c = 0; c < 5000; c += 7) for (const p of [1, 5, 10, 12.5, 33.33, 50, 99.99, 100]) { const r = percentOf(c, p); assert.ok(r >= 0 && r <= c); }
});
test('GST is one eleventh of the discounted GST-inclusive amount', () => {
  assert.equal(gstIn(17268 - 1727), 1413);  // 15541 / 11 = 1412.8
  assert.equal(gstIn(3850), 350);
  assert.equal(gstIn(0), 0);
});
test('product discount spread over lines adds up exactly, and card lines add up to the order total', () => {
  for (const d of [1, 2, 3, 1727, 2000, 5267, SUB - 1, SUB]) {
    const a = allocate(LINES, [0, 1, 2], d);
    assert.equal(a.reduce((t, x) => t + x, 0), d); a.forEach((x, i) => assert.ok(x >= 0 && x <= LINES[i].line_cents));
  }
  const lines = LINES.map((l, i) => ({ ...l, name: ['Foamboard', 'Banner', 'Corflute'][i], qty: [3, 1, 1][i], unit_cents: [1500, 12000, 768][i], options: {} }));
  for (const [pd, sd] of [[1727, 0], [0, 3850], [1500, 1000], [SUB, 0]]) {
    const q = { lines, subtotal: SUB, deliveryCents: 3850, deliveryMethod: 'Standard Delivery', productDiscount: pd, shippingDiscount: sd,
      discount: { ok: true, code: 'X1', eligible: [0, 1, 2] }, total: SUB - pd + 3850 - sd };
    const items = stripeLines(q);
    assert.equal(items.reduce((t, it) => t + it.quantity * it.price_data.unit_amount, 0), q.total);
    items.forEach(it => assert.ok(it.price_data.unit_amount > 0));
  }
  const plain = stripeLines({ lines, subtotal: SUB, deliveryCents: 3850, productDiscount: 0, shippingDiscount: 0, discount: null, total: SUB + 3850 });
  assert.deepEqual(plain.map(i => [i.quantity, i.price_data.unit_amount]), [[3, 1500], [1, 12000], [1, 768], [1, 3850]]);   // unchanged without a code
});
