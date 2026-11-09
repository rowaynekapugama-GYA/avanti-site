// Custom-size ("Custom Dimensions") pricing on the server: no database needed.
//   node --test tests/pricing.test.mjs
// The rates below are the live base prices (per m²) of the six custom-size products. The storefront prices in
// tests/fixtures/storefront-prices.json come from unitPrice() in index.html, so this checks both sides agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unitCents, shippingOptions } from '../api/_lib/orders.js';

const RATES = { 'acm-panels-custom-dimensions': 160, 'corflute-signs-custom-dimensions': 32, 'floor-decals-custom': 160,
  'foamboard-custom': 35, 'posters-custom': 40, 'window-graphics-custom-dimensions': 40 };
const product = (slug, extra = {}) => ({ slug, name: slug, pricing_mode: 'custom_dims', base_price: RATES[slug], wall_dims: false,
  variation_keys: [], variations: [], tiers: [], choices: {}, dims_config: { maxW: 1200, maxH: 2400 }, ...extra });

test('custom sizes are priced per m², the same as the storefront shows', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/storefront-prices.json', import.meta.url))).filter(c => RATES[c.slug]);
  assert.ok(cases.length >= 300);
  const bad = cases.filter(c => unitCents(product(c.slug), c.qty, c.opts) !== Math.round(c.price * 100));
  assert.equal(bad.length, 0, JSON.stringify(bad.slice(0, 3)));
});

test('every size has its own price', () => {
  const p = product('corflute-signs-custom-dimensions');
  const at = s => unitCents(p, 1, { 'Custom size': s });
  assert.equal(at('600 × 900 mm'), 1728);       // 0.54 m² × $32
  assert.equal(at('1200 × 2400 mm'), 9216);     // 2.88 m² × $32, the same as the 1200 × 2400 fixed-size price
  assert.equal(at('300 × 450 mm'), 432);
  assert.equal(at('900 × 600 mm'), 1728);       // same area either way round
  assert.equal(at('600x900'), 1728);            // typed with an x and no "mm"
});

test('a custom-size product without a size is refused, never priced at the base rate', () => {
  assert.throws(() => unitCents(product('acm-panels-custom-dimensions'), 1, {}), /width and height/);
  assert.throws(() => unitCents(product('acm-panels-custom-dimensions'), 1, { 'Custom size': 'big' }), /width and height/);
});

test('the shipping calculator gets the same size', () => {
  const o = shippingOptions(product('posters-custom', { pricing_mode: 'custom_dims' }), { 'Custom size': '841 × 1189 mm' });
  assert.equal(o['Custom size'], '841 × 1189 mm');
});
