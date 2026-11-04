// Shipping engine tests (no database). Run: node --test tests/shipping.test.mjs
// Covers the spec's section 17 checks that can be automated, and the reference test case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteShipping, priceOrder, pack, bandFor, findZone, resolveItem, rollDiameter, money4, UNIT, UNAVAILABLE, customerView } from '../api/_lib/shipping/engine.js';
import { SEED } from '../api/_lib/shipping/seed.js';
import { validateConfig } from '../api/_lib/shipping/validate.js';

const cfg = (fn) => { const c = structuredClone(SEED); if (fn) fn(c); return c; };
const SYD = () => SEED.zones.find(z => z.id === 'syd-metro');
const pkg = (n, l, w, h, g, packagingCents = 0) => ({ n, length_mm: l, width_mm: w, height_mm: h, weight_g: g, packaging: { cost: BigInt(packagingCents) * UNIT } });
const quote = (lines, postcode = '2164', c = SEED, requireApproval = false) => quoteShipping({ lines, postcode, config: c, requireApproval });
const FOAM = (qty, size = '600mm x 400mm', t = 'Foamboard 5mm') => ({ slug: 'foamboard', category: 'foamboard', name: 'Foamboard', qty, opts: { Thickness: t, Size: size } });

test('reference case: Sydney Metro, two packages = $107.00 ex GST, $117.70 inc GST', () => {
  const r = priceOrder([pkg(1, 1200, 650, 100, 12000, 2000), pkg(2, 500, 400, 100, 3000, 1200)], SYD(), SEED);
  assert.equal(r.packages[0].band, 'large'); assert.equal(r.packages[1].band, 'small');
  assert.equal(money4(r.totals.base_subtotal), '38.2500');        // 30 + 0.75 x 11
  assert.equal(money4(r.totals.freight_selling), '43.9875');      // x 1.15
  assert.equal(money4(r.totals.surcharges), '24.5000');           // 4.50 + 20 + 0
  assert.equal(money4(r.totals.packaging_selling), '38.4000');    // 32 x 1.2
  assert.equal(money4(r.totals.before_minimum), '106.8875');
  assert.equal(r.ex_gst_cents, 10700); assert.equal(r.gst_cents, 1070); assert.equal(r.inc_gst_cents, 11770);
});

test('length bands at every boundary', () => {
  const cases = { 600: 'small', 601: 'medium', 1000: 'medium', 1001: 'large', 1500: 'large', 1501: 'os1', 2000: 'os1', 2001: 'os2' };
  for (const [mm, band] of Object.entries(cases)) assert.equal(bandFor(Number(mm), SEED).key, band, `${mm}mm`);
  // and the rate actually charged
  const base = mm => priceOrder([pkg(1, mm, 100, 50, 1000)], SYD(), SEED).packages[0].base;
  assert.equal(base(600), 1100n * UNIT); assert.equal(base(601), 1600n * UNIT); assert.equal(base(1501), 8500n * UNIT); assert.equal(base(2001), 12500n * UNIT);
});

test('width surcharge at 600, 900 and 1200 mm and the next millimetre, on the full base rate', () => {
  const pct = w => priceOrder([pkg(1, 1300, w, 50, 1000)], SYD(), SEED).packages[0];
  const cases = { 600: 0, 601: 1500, 900: 1500, 901: 3000, 1200: 3000, 1201: 5000 };
  for (const [w, bps] of Object.entries(cases)) assert.equal(pct(Number(w)).width_bps, bps, `${w}mm`);
  assert.equal(money4(pct(650).width_surcharge), '4.5000');   // 15% of $30, not of a discounted rate
  // second package: discounted base, but the surcharge is on its full base and not marked up
  const r = priceOrder([pkg(1, 1300, 100, 50, 1000), pkg(2, 1300, 650, 50, 1000)], SYD(), SEED);
  assert.equal(r.packages[1].charge_bps, 7500); assert.equal(money4(r.packages[1].width_surcharge), '4.5000');
  assert.equal(money4(r.totals.surcharges), '4.5000');
});

test('weight surcharge at 5, 10, 15 and 20 kg; over 20 kg is never priced as one package', () => {
  const w = g => priceOrder([pkg(1, 500, 300, 50, g)], SYD(), SEED).packages[0].weight_surcharge;
  const cases = { 5000: 0, 5001: 1000, 10000: 1000, 10001: 2000, 15000: 2000, 15001: 3500, 20000: 3500 };
  for (const [g, c] of Object.entries(cases)) assert.equal(w(Number(g)), BigInt(c) * UNIT, `${g}g`);
  assert.throws(() => priceOrder([pkg(1, 500, 300, 50, 20001)], SYD(), SEED), /package_not_feasible/);
  // a heavy order is split into packages of 20 kg or less, and each gets its own weight surcharge
  const q = quote([{ slug: 'acm-panels', category: 'acm-panels', name: 'ACM', qty: 3, opts: { Size: '1200mm x 2400mm' } }]);
  assert.ok(q.ok, q.reason); assert.equal(q.packages.length, 3);   // 10.9 kg each: two would be over 20 kg
  assert.ok(q.packages.every(p => p.weight_g <= 20000 && p.weight_surcharge === 2000n * UNIT));
});

test('rigid signage: packed size, 30 mm minimum, 150 mm height cap and splitting', () => {
  let q = quote([FOAM(1)]);
  assert.deepEqual([q.packages[0].length_mm, q.packages[0].width_mm, q.packages[0].height_mm], [620, 420, 33]);   // +20, +20, 5 + 28
  q = quote([{ slug: 'corflute-signs', category: 'corflute', name: 'Corflute', qty: 1, opts: { Material: 'Corflute Signs 3mm', Size: '600mm x 400mm' } }]);
  assert.equal(q.packages[0].height_mm, 31);
  q = quote([{ slug: 'foam-pvc', category: 'foam-pvc', name: 'PVC', qty: 1, opts: { Thickness: 'PVC 2mm', Size: '600mm x 400mm' } }]);
  assert.equal(q.packages[0].height_mm, 30);                       // 2 + 28 = 30, the minimum
  q = quote([FOAM(12, '600mm x 400mm', 'Foamboard 10mm')]);        // 120 + 28 = 148: fits
  assert.equal(q.packages.length, 1); assert.equal(q.packages[0].height_mm, 148);
  q = quote([FOAM(13, '600mm x 400mm', 'Foamboard 10mm')]);        // 130 + 28 = 158: split
  assert.equal(q.packages.length, 2); assert.ok(q.packages.every(p => p.height_mm <= 150));
  assert.deepEqual(q.packages.map(p => p.contents[0].qty).sort(), [1, 12]);
  // weight: material area x kg/m2 plus packaging, never material alone
  const one = quote([FOAM(1)]).packages[0];
  assert.ok(one.weight_g > 0.6 * 0.4 * 650);
});

test('rigid stacking of different sizes follows the configurable rule', () => {
  const lines = [FOAM(1, '600mm x 400mm'), FOAM(1, '800mm x 1200mm')];
  assert.equal(quote(lines).packages.length, 2);                                   // default: same size only
  const fit = cfg(c => { c.profiles.rigid.stacking = 'fit_within'; });
  const q = quote(lines, '2164', fit);
  assert.equal(q.packages.length, 1); assert.equal(q.packages[0].length_mm, 1220); assert.equal(q.packages[0].width_mm, 820);
  const noMix = cfg(c => { c.profiles.rigid.stacking = 'fit_within'; c.profiles.rigid.mix_materials = false; });
  assert.equal(quote([FOAM(1, '800mm x 1200mm'), { slug: 'corflute-signs', category: 'corflute', name: 'C', qty: 1, opts: { Material: 'Corflute Signs 3mm', Size: '600mm x 400mm' } }], '2164', noMix).packages.length, 2);
});

test('rolled prints: diameter formula, width limits and splitting into rolls', () => {
  assert.equal(Math.round(rollDiameter(80, 0.25, 1000, 0) * 1000) / 1000, Math.round(Math.sqrt(80 ** 2 + 4 * 0.25 * 1000 / Math.PI) * 1000) / 1000);
  const win = (qty, size) => ({ slug: 'window-graphics', category: 'window-graphics', name: 'Window', qty, opts: { 'Material Type': 'Window Graphics - Short Term', Size: size } });
  let q = quote([win(1, '1000mm x 1200mm')]);
  assert.ok(q.ok); assert.equal(q.packages[0].profile, 'rolled'); assert.equal(q.packages[0].length_mm, 1050);   // width + end allowance
  // 1350 mm printed width is the limit; 1351 can't be rolled (and is not priced some other cheaper way)
  const custom = (w, h) => ({ slug: 'window-graphics-custom-dimensions', category: 'window-graphics', name: 'Window', qty: 1, opts: { 'Material Type': 'Window Graphics - Short Term', 'Custom size': `${w} × ${h} mm` } });
  assert.ok(quote([custom(1350, 3000)]).ok);
  q = quote([custom(1351, 3000)]); assert.equal(q.ok, false); assert.equal(q.reason, 'roll_too_wide'); assert.equal(q.message, UNAVAILABLE);
  // lots of floor decals: several rolls, none over 200 mm diameter
  q = quote([{ slug: 'floor-decals', category: 'floor-decals', name: 'Decal', qty: 120, opts: { Material: 'Floor decals with anti slip lam', Size: '1000mm x 1000mm' } }]);
  assert.ok(q.ok, q.reason); assert.ok(q.packages.length > 1); assert.ok(q.packages.every(p => p.width_mm <= 200 && p.height_mm <= 200 && p.weight_g <= 20000));
  assert.equal(q.packages.reduce((t, p) => t + p.contents[0].qty, 0), 120);
});

test('posters: A4 and A3 ship flat, A2 and up are rolled', () => {
  const poster = size => quote([{ slug: 'posters', category: 'posters', name: 'Poster', qty: 1, opts: { Material: 'Poster paper 220GSM, matte or gloss finish', Size: size } }]).packages[0].profile;
  assert.equal(poster('A4'), 'flat'); assert.equal(poster('A3'), 'flat'); assert.equal(poster('A2'), 'rolled'); assert.equal(poster('A0'), 'rolled');
});

test('flat-pack mailers: 300 mm stack cap, never assembled size', () => {
  const mailer = qty => ({ slug: 'custom-branded-mailer-boxes', category: 'mailer-boxes', name: 'Mailer', qty, opts: { Material: 'White E Flute 1.5mm', 'Size (mm)': '225 × 160 × 80' } });
  let q = quote([mailer(100)]);
  assert.equal(q.packages.length, 1); assert.equal(q.packages[0].height_mm, 190);   // 100 x 1.5 + 40
  q = quote([mailer(400)]);
  assert.ok(q.packages.length >= 3); assert.ok(q.packages.every(p => p.height_mm <= 300 && p.weight_g <= 20000));
  assert.equal(q.packages.reduce((t, p) => t + p.contents[0].qty, 0), 400);
  assert.ok(q.packages[0].length_mm > 225 + 20);   // flat blank, not the 225 x 160 x 80 box
});

test('A-frames: one per package, mixed cart keeps profiles apart, multi-package discount applies', () => {
  const q = quote([
    { slug: 'metal-face-a-frame', category: 'a-frames', name: 'A-frame', qty: 2, opts: { Size: '600mmW x 900mmH' } },
    FOAM(3), { slug: 'floor-decals', category: 'floor-decals', name: 'Decal', qty: 2, opts: { Material: 'Floor decals with anti slip lam', Size: '600mm x 600mm' } },
    { slug: 'plain-shipping-cartons', category: 'shipping-cartons', name: 'Carton', qty: 20, opts: { Material: 'Kraft B Flute 3mm', 'Size (mm)': '250 × 150 × 200' } },
  ]);
  assert.ok(q.ok, q.reason);
  const kinds = q.packages.map(p => p.profile);
  assert.equal(kinds.filter(k => k === 'unit').length, 2);
  for (const p of q.packages) assert.equal(new Set(p.contents.map(c => c.name)).size, 1);   // nothing mixed across profiles
  const full = q.packages.filter(p => p.charge_bps === 10000);
  assert.equal(full.length, 1);                                                             // only the dearest at 100%
  assert.ok(q.packages.every(p => p.charge_bps === 10000 || p.charge_bps === 7500));
  assert.equal(full[0].base, q.packages.reduce((m, p) => p.base > m ? p.base : m, 0n));
});

test('ties for the highest base: the first package pays 100%, the rest 75%', () => {
  const r = priceOrder([pkg(1, 500, 100, 50, 1000), pkg(2, 500, 100, 50, 1000)], SYD(), SEED);
  assert.deepEqual(r.packages.map(p => p.charge_bps), [10000, 7500]);
});

test('oversized packages and the additional-package discount are configurable', () => {
  const two = c => priceOrder([pkg(1, 2100, 100, 50, 1000), pkg(2, 1800, 100, 50, 1000)], SYD(), c).packages.map(p => p.charge_bps);
  assert.deepEqual(two(SEED), [10000, 7500]);
  assert.deepEqual(two(cfg(c => { c.pricing.oversized_discount_eligible = false; })), [10000, 10000]);
  assert.deepEqual(two(cfg(c => { c.pricing.additional_package_bps = 5000; })), [10000, 5000]);
  // feasibility: an infeasible package is unavailable, never priced on ordinary rates
  assert.throws(() => priceOrder([pkg(1, 2600, 100, 50, 1000)], SYD(), SEED), /package_not_feasible/);
});

test('minimum charge, rounding up to the dollar, and GST', () => {
  let r = priceOrder([pkg(1, 300, 200, 50, 500, 0)], SYD(), SEED);       // 11 x 1.15 = 12.65 -> $15 minimum
  assert.equal(r.totals.minimum_applied, true); assert.equal(r.ex_gst_cents, 1500); assert.equal(r.gst_cents, 150); assert.equal(r.inc_gst_cents, 1650);
  r = priceOrder([pkg(1, 300, 200, 50, 500, 300)], SYD(), cfg(c => { c.pricing.minimum_ex_gst_cents = 0; }));   // 12.65 + 3.60 = 16.25 -> 17
  assert.equal(money4(r.totals.before_minimum), '16.2500'); assert.equal(r.ex_gst_cents, 1700);
  // a whole-dollar amount stays as it is
  const c2 = cfg(c => { c.pricing.minimum_ex_gst_cents = 0; c.pricing.freight_markup_bps = 0; c.zones[0].rates.small = 2000; });
  r = priceOrder([pkg(1, 300, 200, 50, 500, 0)], c2.zones[0], c2);
  assert.equal(r.ex_gst_cents, 2000);
});

test('postcodes: valid, invalid, unknown, disabled, not approved and overridden', () => {
  assert.equal(findZone('2164', SEED).zone.id, 'syd-metro');
  assert.equal(findZone('2850', SEED).zone.id, 'nsw-regional');      // narrower metro range wins where both match
  assert.equal(findZone('4217', SEED).zone.id, 'seq-outer');         // Gold Coast is not Brisbane Metro
  for (const bad of ['', 'abc', '12345', '21 64']) { const q = quote([FOAM(1)], bad); assert.equal(q.ok, false); assert.equal(q.reason, 'invalid_postcode'); }
  let q = quote([FOAM(1)], '1950'); assert.equal(q.ok, false); assert.equal(q.reason, 'unknown_postcode');
  q = quote([FOAM(1)], '2850'); assert.equal(q.ok, false); assert.equal(q.reason, 'zone_disabled'); assert.equal(q.ex_gst_cents, undefined);
  q = quote([FOAM(1)], '2000', SEED, true); assert.equal(q.ok, false); assert.equal(q.reason, 'zone_not_approved'); assert.equal(q.message, UNAVAILABLE);
  const approved = cfg(c => { c.zones[0].approval = { status: 'approved', by: 'test', at: 'now' }; });
  assert.equal(quote([FOAM(1)], '2000', approved, true).ok, true);
  // an override sends one postcode to a chosen zone
  const ov = cfg(c => { c.postcode_overrides.push({ postcode: '2850', zone_id: 'syd-metro' }); });
  q = quote([FOAM(1)], '2850', ov); assert.equal(q.ok, true); assert.equal(q.zone.id, 'syd-metro'); assert.equal(q.zone.via, 'override');
  // two zones with the same range: ambiguous, so unavailable (never the cheaper one)
  const amb = cfg(c => { c.zones.push({ ...structuredClone(c.zones[0]), id: 'dup', name: 'Duplicate', ranges: [[2000, 2239]] }); });
  q = quote([FOAM(1)], '2100', amb); assert.equal(q.ok, false); assert.equal(q.reason, 'ambiguous_postcode');
  assert.ok(validateConfig(amb).errors.some(e => /same range size/.test(e)));
});

test('no disabled or unapproved zone can ever return a price', () => {
  const tempt = cfg(c => { for (const z of c.zones) { z.enabled = false; z.rates = { small: 100, medium: 100, large: 100, os1: 100, os2: 100 }; } });
  for (const z of tempt.zones) for (const [a, b] of z.ranges) for (const pc of [a, b, Math.floor((a + b) / 2)]) {
    const q = quote([FOAM(1)], String(pc), tempt);
    assert.equal(q.ok, false, `${z.name} ${pc}`); assert.equal(q.ex_gst_cents, undefined); assert.equal(q.inc_gst_cents, undefined);
    assert.deepEqual(customerView(q), { ok: false, method: 'Standard Delivery', message: UNAVAILABLE });
  }
  const enabledNotApproved = cfg(c => { for (const z of c.zones) { z.enabled = true; z.rates = { small: 100, medium: 100, large: 100, os1: 100, os2: 100 }; } });
  for (const z of enabledNotApproved.zones) for (const [a] of z.ranges) assert.equal(quote([FOAM(1)], String(a), enabledNotApproved, true).ok, false, z.name);
});

test('every product in the shop resolves to a packing profile', async () => {
  const { readFileSync } = await import('node:fs');
  const seed = JSON.parse(readFileSync(new URL('../scripts/seed-data.json', import.meta.url)));
  const bad = [];
  for (const p of seed.products) {
    const opts = {}; for (const o of p.options || []) opts[o.name] = o.choices[0];
    if (p.wall_dims) opts.Wall = '3000 × 2400 mm';
    if (p.pricing_mode === 'custom_dims' && !opts['Size']) opts['Custom size'] = '600 × 400 mm';
    try { resolveItem({ slug: p.slug, category: p.category_slug, name: p.name, qty: 1, opts }, SEED); } catch (e) { bad.push(`${p.slug}: ${e.message}`); }
  }
  assert.deepEqual(bad, []);
});

test('the seed settings pass validation', () => {
  assert.deepEqual(validateConfig(SEED).errors, []);
});

// ---- from the independent review (4 Nov 2026)
test('a blank first band or width limit is refused, and never prices everything as Small', () => {
  const noBand = cfg(c => { c.bands[0].up_to_mm = null; });
  assert.ok(validateConfig(noBand).errors.some(e => /band limits/.test(e)));
  assert.throws(() => bandFor(2400, noBand), /bad_settings/);
  assert.equal(quote([{ slug: 'acm-panels', category: 'acm-panels', name: 'ACM', qty: 1, opts: { Size: '1200mm x 2400mm' } }], '2164', noBand).ok, false);
  const noWidth = cfg(c => { c.zones[0].width_tiers[0].up_to_mm = null; });
  assert.ok(validateConfig(noWidth).errors.some(e => /width surcharge limits/.test(e)));
  const r = quote([FOAM(1, '1200mm x 900mm')], '2164', noWidth);
  assert.equal(r.ok, false); assert.equal(r.reason, 'bad_settings');
});

test('a blank per-zone package limit falls back to the general limit', () => {
  const c = cfg(x => { x.zones[0].feasibility = { max_length_mm: null, max_width_mm: null, max_height_mm: null, max_weight_g: null }; });
  assert.deepEqual(validateConfig(c).errors, []);
  assert.equal(quote([FOAM(1)], '2164', c).ok, true);
  const tight = cfg(x => { x.zones[0].feasibility = { max_length_mm: 500 }; });
  assert.equal(quote([FOAM(1)], '2164', tight).reason, 'package_not_feasible');   // 620 mm packed
  assert.ok(validateConfig(cfg(x => { x.zones[0].feasibility = { max_length_mm: -1 }; })).errors.length);
});

test('separate cart lines of the same thing share packages, as one line would', () => {
  const mailer = qty => ({ slug: 'custom-branded-mailer-boxes', category: 'mailer-boxes', name: 'Mailer', qty, opts: { Material: 'White E Flute 1.5mm', 'Size (mm)': '225 × 160 × 80' } });
  const one = quote([mailer(200)]), two = quote([mailer(100), mailer(100)]);
  assert.equal(two.packages.length, one.packages.length); assert.equal(two.ex_gst_cents, one.ex_gst_cents);
  const wall = { slug: 'wallpaper', category: 'wallpaper', name: 'Wallpaper', qty: 1, opts: { Wall: '2000 × 2400 mm' } };
  const w1 = quote([{ ...wall, qty: 2 }]), w2 = quote([wall, wall]);
  assert.equal(w2.packages.length, w1.packages.length); assert.equal(w2.ex_gst_cents, w1.ex_gst_cents);
  const topper = slug => ({ slug, category: 'cake-toppers', name: slug, qty: 2, opts: {} });
  const t = quote([topper('name-and-age-cake-topper'), topper('custom-text-cake-topper')]);
  assert.equal(t.packages.length, 1); assert.equal(t.packages[0].contents.length, 2);   // 4 toppers, 5 per mailer
});

test('more packages than the limit is unavailable, and stays quick', () => {
  const t0 = Date.now();
  const r = quote(Array.from({ length: 100 }, () => FOAM(100000, '100mm x 100mm', 'Foamboard 10mm')));
  assert.equal(r.ok, false); assert.equal(r.reason, 'too_many_packages'); assert.ok(!('ex_gst_cents' in r));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(quote([FOAM(10)]).ok, true);
});

test('a $0 delivery is never quoted', () => {
  const free = cfg(c => { c.pricing.minimum_ex_gst_cents = 0; for (const k of Object.keys(c.zones[0].rates)) c.zones[0].rates[k] = 0;
    c.zones[0].weight_tiers.forEach(t => { t.cents = 0; }); Object.assign(c.packaging, { cardboard_cents_m2: 0, bubble_cents_m2: 0, labour_cents: 0, tape_cents: 0 }); });
  assert.ok(validateConfig(free).warnings.some(w => /\$0/.test(w)));
  const r = quote([FOAM(1)], '2164', free); assert.equal(r.ok, false); assert.equal(r.reason, 'zero_price');
});

test('rolls of different materials can be kept apart', () => {
  const item = (mat, l) => ({ spec: { profile: 'rolled', material: mat, length_mm: l, width_mm: 600 }, qty: 1, name: mat });
  const lines = [item('floor_decal', 1000), item('poster_paper', 1000)];
  assert.equal(quote(lines).packages.length, 1);
  assert.equal(quote(lines, '2164', cfg(c => { c.profiles.rolled.mix_materials = false; })).packages.length, 2);
});
