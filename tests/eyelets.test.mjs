// Eyelets: the count from a sign's size, the price rules, and the storefront's copy of the count rule.
// No database needed.   node --test tests/eyelets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signSize, eyeletCount, priceEyelets, clean, publicChoices } from '../api/_lib/eyelets.js';

const C = rows => rows.map((r, i) => clean({ id: `c${i}`, position: i, amount: 0, price_rule: 'none', count_mode: 'fixed', ...r }));
const CHOICES = C([
  { label: 'No eyelets', is_default: true },
  { label: 'One in each corner', price_rule: 'per_sign', amount: 2.5, count_mode: 'fixed', fixed_count: 4 },
  { label: 'Every 500mm', price_rule: 'per_eyelet', amount: 0.5, count_mode: 'around', spacing_mm: 500 },
  { label: 'Top edge', price_rule: 'per_eyelet', amount: 0.4, count_mode: 'top', spacing_mm: 300 },
  { label: 'Four corners', price_rule: 'per_eyelet', amount: 0.75, count_mode: 'fixed', fixed_count: 4 },
]);
const STD = { name: 'Corflute Signs', eyelets: true }, NOEY = { name: 'Foamboard', eyelets: false };
const std = (Eyelets, extra = {}) => ({ Material: 'Corflute Signs 3mm', Size: '600mm x 400mm', Printing: 'Single Side', ...(Eyelets ? { Eyelets } : {}), ...extra });

test('the sign size comes from the standard size or the custom size, turned by the orientation', () => {
  assert.deepEqual(signSize({ Size: '600mm x 400mm' }), { w: 600, h: 400 });
  assert.deepEqual(signSize({ Size: '1200mm x 2400mm' }), { w: 1200, h: 2400 });
  assert.deepEqual(signSize({ 'Custom size': '1000 × 500 mm' }), { w: 1000, h: 500 });
  assert.deepEqual(signSize({ 'Custom size': '1000 × 500 mm', Orientation: 'Portrait' }), { w: 500, h: 1000 });
  assert.deepEqual(signSize({ Size: '600mm x 400mm', Orientation: 'Landscape' }), { w: 600, h: 400 });
  assert.equal(signSize({}), null);
});

test('how many eyelets: a set number, spaced around the edge, or along the top', () => {
  const around = CHOICES[2], top = CHOICES[3], four = CHOICES[4];
  assert.equal(eyeletCount(four, null), 4);
  assert.equal(eyeletCount(around, { w: 600, h: 400 }), 6);      // 4 corners + 1 in the middle of each long edge
  assert.equal(eyeletCount(around, { w: 500, h: 500 }), 4);      // exactly the spacing: corners only
  assert.equal(eyeletCount(around, { w: 1200, h: 2400 }), 16);
  assert.equal(eyeletCount(around, { w: 50, h: 50 }), 4);
  assert.equal(eyeletCount(top, { w: 600, h: 400 }), 3);
  assert.equal(eyeletCount(top, { w: 1200, h: 2400 }), 5);
  assert.equal(eyeletCount(around, null), null);
});

test('price rules: nothing, an amount per sign, an amount per eyelet', () => {
  let r = priceEyelets(STD, std('No eyelets'), CHOICES);
  assert.deepEqual([r.each_cents, r.text, r.label], [0, 'No eyelets', 'No eyelets']);
  r = priceEyelets(STD, std('One in each corner'), CHOICES);
  assert.deepEqual([r.each_cents, r.count, r.text], [250, 4, 'One in each corner (4 eyelets, +$2.50 per sign)']);
  r = priceEyelets(STD, std('Every 500mm'), CHOICES);
  assert.deepEqual([r.each_cents, r.count, r.text], [300, 6, 'Every 500mm (6 eyelets, +$3.00 per sign)']);
  r = priceEyelets(STD, { 'Custom size': '1200 × 2400 mm', Eyelets: 'every 500MM' }, CHOICES);   // label matched without case
  assert.deepEqual([r.each_cents, r.count, r.label], [800, 16, 'Every 500mm']);
  r = priceEyelets(STD, std('Four corners'), CHOICES);
  assert.equal(r.each_cents, 300);
});

test('no choice means the default; an unknown or stopped choice is refused; other products are untouched', () => {
  assert.equal(priceEyelets(STD, std(), CHOICES).label, 'No eyelets');
  assert.throws(() => priceEyelets(STD, std('Every 100mm'), CHOICES), /no longer available/);
  assert.throws(() => priceEyelets(STD, { Eyelets: 'Every 500mm' }, CHOICES), /choose a size/);
  assert.equal(priceEyelets(NOEY, std('Every 500mm'), CHOICES), null);
  assert.equal(priceEyelets(STD, std('No eyelets'), []), null);
});

test('a price or count sent by the browser is ignored', () => {
  const r = priceEyelets(STD, std('Every 500mm', { 'Eyelets price': '0.01', eyelets_count: '1', Count: '1' }), CHOICES);
  assert.deepEqual([r.each_cents, r.count], [300, 6]);
  assert.throws(() => priceEyelets(STD, std('Every 500mm (1 eyelets, +$0.01 per sign)'), CHOICES), /no longer available/);
});

test('the storefront counts eyelets exactly like the server', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const grab = name => html.match(new RegExp(`function ${name}\\(([^)]*)\\)\\{([\\s\\S]*?)\\n\\}`));
  const [, a1, b1] = grab('eySize'), [, a2, b2] = grab('eyCount');
  const eySize = new Function(...a1.split(',').map(s => s.trim()), b1), eyCount = new Function(...a2.split(',').map(s => s.trim()), b2);
  const pub = publicChoices(CHOICES);
  for (const size of ['600mm x 400mm', '1200mm x 2400mm', '800mm x 1200mm', '1000 × 500 mm', '50 × 50 mm', '1199 × 2399 mm', '501 × 499 mm'])
    for (const Orientation of ['', 'Portrait', 'Landscape']) {
      const opts = size.includes('×') ? { 'Custom size': size, Orientation } : { Size: size, Orientation };
      assert.deepEqual(eySize(opts), signSize(opts), size);
      pub.forEach((c, i) => assert.equal(eyCount(c, eySize(opts)), eyeletCount(CHOICES[i], signSize(opts)), `${c.label} ${size}`));
    }
});

test('no em dashes in the eyelets code, SQL or guide', () => {
  for (const f of ['../api/_lib/eyelets.js', '../supabase/migrations/20261126120000_eyelets_option.sql', '../docs/HOW-TO-EYELETS.md']) {
    const u = new URL(f, import.meta.url); if (!fs.existsSync(u)) continue;
    assert.ok(!fs.readFileSync(u, 'utf8').includes('\u2014'), f);
  }
});
