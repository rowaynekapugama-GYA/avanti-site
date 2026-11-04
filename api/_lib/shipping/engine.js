// Avanti shipping engine. Pure functions, no database, no network, no framework.
// Checkout, the admin simulator and the tests all call `quoteShipping`.
//
// Spec: client Shipping Calculator Specification v1.0 (3 Nov 2026), sections 2 to 13.
// Money is exact: amounts are BigInt "units" where 1 cent = UNIT. Percentages are basis points.
// Lengths are whole millimetres, weights whole grams.

export const UNAVAILABLE = 'Delivery pricing is currently unavailable for your postcode. Please contact us for a shipping quote.';
export const METHOD = 'Standard Delivery';

const UNIT = 10n ** 16n;                 // 1 cent; leaves room for exact %, m² and markup arithmetic
const cents = c => BigInt(Math.round(Number(c))) * UNIT;
const bps = (x, b) => x * BigInt(Math.round(Number(b))) / 10000n;   // exact for our scale
const MM2_PER_M2 = 1000000n;
const areaCost = (mm2, centsPerM2) => BigInt(Math.ceil(mm2)) * BigInt(Math.round(centsPerM2)) * UNIT / MM2_PER_M2;
const ceilDiv = (a, b) => (a + b - 1n) / b;
// for display: units -> dollars with 4 decimals (e.g. "43.9875")
export const money4 = u => { const neg = u < 0n; const v = neg ? -u : u; const c100 = v * 100n / UNIT;   // hundredths of a cent
  const s = (c100 / 10000n).toString() + '.' + (c100 % 10000n).toString().padStart(4, '0'); return (neg ? '-' : '') + s; };
const toCents = u => Number(u / UNIT);

class Unavailable extends Error { constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail || null; } }
const fail = (reason, detail) => { throw new Unavailable(reason, detail); };

// ---------------------------------------------------------------------------------------------
// Zones
export function normalisePostcode(pc) {
  const s = String(pc == null ? '' : pc).trim();
  return /^\d{3,4}$/.test(s) ? s.padStart(4, '0') : null;
}
// The zone for a postcode: a postcode override wins; otherwise the zone whose matching range is
// narrowest (so "Sydney Metro 2000-2239" beats "NSW Regional 2000-2999"). Two zones matching with
// equally narrow ranges is ambiguous and returns no zone (never guess a cheaper one).
export function findZone(postcode, config) {
  const pc = normalisePostcode(postcode);
  if (!pc) return { zone: null, reason: 'invalid_postcode' };
  const n = Number(pc), zones = config.zones || [];
  const ov = (config.postcode_overrides || []).find(o => normalisePostcode(o.postcode) === pc);
  if (ov) { const z = zones.find(x => x.id === ov.zone_id); return z ? { zone: z, via: 'override' } : { zone: null, reason: 'override_zone_missing' }; }
  let best = null, span = Infinity, tie = false;
  for (const z of zones) for (const [a, b] of z.ranges || []) {
    if (n < a || n > b) continue;
    const s = b - a;
    if (s < span) { best = z; span = s; tie = false; } else if (s === span && best && best.id !== z.id) tie = true;
  }
  if (!best) return { zone: null, reason: 'unknown_postcode' };
  if (tie) return { zone: null, reason: 'ambiguous_postcode' };
  return { zone: best, via: 'range' };
}
export function zoneAvailable(zone, { requireApproval = true } = {}) {
  if (!zone) return { ok: false, reason: 'no_zone' };
  if (!zone.enabled) return { ok: false, reason: 'zone_disabled' };
  if (requireApproval && !(zone.approval && zone.approval.status === 'approved')) return { ok: false, reason: 'zone_not_approved' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Items: turn a cart line into a physical item for packing.
const lc = s => String(s || '').toLowerCase();
export function parseDims(text) {   // "600mm x 400mm", "600mmW x 900mmH", "225 × 160 × 80", "1200 × 2400 mm"
  const nums = String(text || '').replace(/,/g, '').match(/\d+(\.\d+)?/g);
  return nums ? nums.map(Number) : [];
}
function materialFor(opts, config, fallback) {
  const text = lc(Object.values(opts || {}).join(' | '));
  for (const r of config.material_rules || []) if ((r.match || []).every(w => text.includes(lc(w)))) return r.material;
  return fallback || null;
}
function profileFor(line, config) {
  const cat = (config.catalogue && config.catalogue.categories) || {}, prod = (config.catalogue && config.catalogue.products) || {};
  return { ...(cat[line.category] || {}), ...(prod[line.slug] || {}) };
}
function sizeOf(opts, config) {
  if (!opts) return null;
  const custom = opts['Custom size'] || opts['Wall'];
  const raw = custom || opts['Size'] || opts['Size (mm)'];
  if (!raw) return null;
  const paper = (config.paper_sizes || {})[String(raw).trim().toUpperCase()];
  if (paper) return { dims: paper.slice(), paper: String(raw).trim().toUpperCase() };
  const d = parseDims(raw);
  return d.length >= 2 ? { dims: d } : null;
}
// Simulator custom item: { profile, material, length_mm, width_mm } (rigid/flat/rolled),
// { profile:'unit', length_mm, width_mm, height_mm, weight_g, per_package } or { profile:'unit', unit },
// { profile:'flatpack', board, formula, box_mm:[L,W,H] }, { profile:'wallpaper', material, wall_w_mm, wall_h_mm }
function customItem(spec, qty, name, config) {
  const n = v => Math.round(Number(v));
  const pos = v => n(v) > 0;
  const p = spec.profile;
  if (p === 'rigid' || p === 'flat' || p === 'rolled') {
    if (!(config.materials || {})[spec.material]) fail('no_material', name);
    if (!pos(spec.length_mm) || !pos(spec.width_mm)) fail('no_size', name);
    return { profile: p, name, qty, material: spec.material, length_mm: Math.max(n(spec.length_mm), n(spec.width_mm)), width_mm: Math.min(n(spec.length_mm), n(spec.width_mm)) };
  }
  if (p === 'unit') {
    if (spec.unit) { if (!(config.units || {})[spec.unit]) fail('no_unit_model', name); return { profile: p, name, qty, unit: spec.unit }; }
    if (![spec.length_mm, spec.width_mm, spec.height_mm, spec.weight_g].every(pos)) fail('no_size', name);
    return { profile: p, name, qty, model: { label: name, length_mm: n(spec.length_mm), width_mm: n(spec.width_mm), height_mm: n(spec.height_mm), weight_g: n(spec.weight_g), per_package: Math.max(1, n(spec.per_package) || 1) } };
  }
  if (p === 'flatpack') {
    if (!((config.flatpack && config.flatpack.boards) || {})[spec.board]) fail('no_board', name);
    const box = (spec.box_mm || []).map(n);
    if (box.length !== 3 || !box.every(v => v > 0)) fail('no_size', name);
    return { profile: p, name, qty, board: spec.board, formula: spec.formula === 'mailer' ? 'mailer' : 'rsc', box_mm: box, size_key: box.join(' × ') };
  }
  if (p === 'wallpaper') {
    if (!pos(spec.wall_w_mm) || !pos(spec.wall_h_mm)) fail('no_size', name);
    return { profile: p, name, qty, material: (config.materials || {})[spec.material] ? spec.material : 'wallpaper_smooth', wall_w_mm: n(spec.wall_w_mm), wall_h_mm: n(spec.wall_h_mm) };
  }
  fail('unknown_profile', name);
}
// line: { slug, name, category, qty, opts } from the cart, or { spec } (simulator custom item)
export function resolveItem(line, config) {
  const qty = Math.floor(Number(line.qty));
  if (!(qty >= 1)) fail('bad_quantity', line.name);
  if (line.spec) return customItem(line.spec, qty, line.name || line.spec.name || 'Custom item', config);
  const m = profileFor(line, config), name = line.name || line.slug;
  let profile = m.profile;
  if (!profile) fail('no_shipping_profile', name);
  const size = sizeOf(line.opts, config);
  if (profile === 'poster') {
    if (!size) fail('no_size', name);
    const flat = size.paper ? (config.poster_flat_sizes || []).includes(size.paper)
      : Math.max(...size.dims) <= 420 && Math.min(...size.dims) <= 297;
    profile = flat ? 'flat' : 'rolled';
  }
  if (profile === 'rigid' || profile === 'flat' || profile === 'rolled') {
    if (!size) fail('no_size', name);
    const material = m.material || materialFor(line.opts, config);
    if (!material || !(config.materials || {})[material]) fail('no_material', name);
    const [a, b] = size.dims;
    return { profile, name, qty, material, length_mm: Math.max(a, b), width_mm: Math.min(a, b) };
  }
  if (profile === 'wallpaper') {
    if (!size) fail('no_size', name);
    const material = m.material || materialFor(line.opts, config, 'wallpaper_smooth');
    return { profile, name, qty, material, wall_w_mm: size.dims[0], wall_h_mm: size.dims[1] };
  }
  if (profile === 'unit') {
    const unit = m.unit || (m.unit_by_size && m.unit_by_size[(line.opts || {})['Size']]);
    if (!unit || !(config.units || {})[unit]) fail('no_unit_model', name);
    return { profile, name, qty, unit };
  }
  if (profile === 'flatpack') {
    const dimsRaw = (line.opts || {})['Size (mm)'] || (line.opts || {})['Size'];
    const d = parseDims(dimsRaw);
    if (d.length < 3) fail('no_size', name);
    const boardName = Object.keys((config.flatpack && config.flatpack.boards) || {}).find(b => lc(Object.values(line.opts || {}).join('|')).includes(lc(b)));
    if (!boardName) fail('no_board', name);
    return { profile, name, qty, board: boardName, formula: m.formula || 'rsc', box_mm: d.slice(0, 3), size_key: String(dimsRaw).trim() };
  }
  fail('unknown_profile', name);
}

// ---------------------------------------------------------------------------------------------
// Packaging (section 10). Areas in mm² from the package's actual packed dimensions:
//   'box'  = surface of the packed box, 2(LW + LH + WH)
//   'wrap' = same surface, for bubble wrap around the contents
//   'tube' = side of the tube, pi x D x L (plus two end caps for cardboard)
//   'none' = not used
// Each area gets the waste factor. Cost = cardboard m² x rate + bubble m² x rate + labour + tape.
function surface(L, W, H) { return 2 * (L * W + L * H + W * H); }
function packagingFor(pkg, prof, config) {
  const pk = config.packaging, waste = 1 + (pk.waste_bps || 0) / 10000;
  const roll = pkg.shape === 'roll', D = pkg.diameter_mm || 0, L = pkg.length_mm, W = pkg.width_mm, H = pkg.height_mm;
  const side = roll ? Math.PI * D * L : 0, caps = roll ? 2 * Math.PI * (D / 2) ** 2 : 0;
  const outer = roll ? side + caps : surface(L, W, H);
  const card = prof.cardboard === 'none' ? 0 : prof.cardboard === 'tube' ? side + caps : outer;
  const bub = prof.bubble === 'none' ? 0 : prof.bubble === 'tube' ? side : outer;
  const cardboard_mm2 = Math.ceil(card * waste), bubble_mm2 = Math.ceil(bub * waste);
  const cost = areaCost(cardboard_mm2, pk.cardboard_cents_m2) + areaCost(bubble_mm2, pk.bubble_cents_m2) + cents(pk.labour_cents) + cents(pk.tape_cents);
  const weight_g = Math.ceil(cardboard_mm2 / 1e6 * (pk.cardboard_g_m2 || 0) + bubble_mm2 / 1e6 * (pk.bubble_g_m2 || 0));
  return { cardboard_mm2, bubble_mm2, cost, weight_g };
}

// ---------------------------------------------------------------------------------------------
// Packing: the fewest practical packages, respecting compatibility, size and weight limits.
const areaM2 = (l, w) => l * w / 1e6;

function packRigid(items, config, profileKey) {
  const prof = config.profiles[profileKey], mats = config.materials;
  const maxStack = prof.max_height_mm - prof.height_allowance_mm;   // material thickness that fits under the height cap
  const groups = prof.mix_materials ? [items] : Object.values(items.reduce((g, i) => ((g[i.material] = g[i.material] || []).push(i), g), {}));
  const out = [];
  for (const group of groups) {
    // largest boards first, so smaller ones can sit on them when stacking is 'fit_within'
    const units = group.slice().sort((a, b) => b.length_mm * b.width_mm - a.length_mm * a.width_mm || b.length_mm - a.length_mm);
    const open = [];
    for (const it of units) {
      const m = mats[it.material], t = m.thickness_mm, unitG = areaM2(it.length_mm, it.width_mm) * m.g_m2;
      if (t > maxStack) fail('item_too_thick', it.name);
      let left = it.qty;
      const fits = p => prof.stacking === 'fit_within' ? it.length_mm <= p.base_l && it.width_mm <= p.base_w
        : it.length_mm === p.base_l && it.width_mm === p.base_w;
      const tryAdd = p => {   // how many more of this item fit in package p (height and weight)
        if (!fits(p)) return 0;
        let n = Math.min(left, Math.floor((maxStack - p.stack_mm + 1e-9) / t));
        while (n > 0) {
          const dims = rigidDims(p.base_l, p.base_w, p.stack_mm + n * t, prof);
          const pkg = packagingFor({ ...dims }, prof, config);
          if (p.goods_g + n * unitG + pkg.weight_g <= prof.max_weight_g) break;
          n--;
        }
        return n;
      };
      for (const p of open) { if (!left) break; const n = tryAdd(p); if (n > 0) { p.items.push({ ...it, qty: n }); p.stack_mm += n * t; p.goods_g += n * unitG; left -= n; } }
      while (left > 0) {
        const p = { base_l: it.length_mm, base_w: it.width_mm, stack_mm: 0, goods_g: 0, items: [] };
        const n = tryAdd(p);
        if (n < 1) fail('item_too_heavy', it.name);
        p.items.push({ ...it, qty: n }); p.stack_mm += n * t; p.goods_g += n * unitG; left -= n; open.push(p);
      }
    }
    for (const p of open) {
      const dims = rigidDims(p.base_l, p.base_w, p.stack_mm, prof);
      out.push(finish({ profile: profileKey, shape: 'box', ...dims, goods_g: p.goods_g, contents: p.items.map(i => ({ name: i.name, qty: i.qty, size_mm: [i.length_mm, i.width_mm], material: i.material })) }, prof, config));
    }
  }
  return out;
}
const rigidDims = (l, w, stack, prof) => ({ length_mm: l + prof.edge_allowance_mm, width_mm: w + prof.edge_allowance_mm,
  height_mm: Math.max(prof.min_height_mm, Math.ceil(stack + prof.height_allowance_mm)) });

// Roll diameter: D = sqrt(core² + 4 x thickness x length / pi), plus the packaging allowance.
export const rollDiameter = (coreMm, thicknessMm, lengthMm, allowanceMm) => Math.sqrt(coreMm ** 2 + 4 * thicknessMm * lengthMm / Math.PI) + allowanceMm;

function packRolled(items, config) {
  const prof = config.profiles.rolled, mats = config.materials;
  const units = items.map(it => {
    // roll across the shorter side when it fits the printer width, otherwise the longer side
    let w = it.width_mm, l = it.length_mm;
    if (w > prof.max_printed_width_mm) fail('roll_too_wide', it.name);
    return { ...it, roll_w: w, roll_l: l };
  }).sort((a, b) => b.roll_w - a.roll_w);
  const groups = prof.mix_widths ? [units] : Object.values(units.reduce((g, i) => ((g[i.roll_w] = g[i.roll_w] || []).push(i), g), {}));
  const out = [];
  for (const group of groups) {
    const open = [];
    for (const it of group) {
      const m = mats[it.material]; if (!m) fail('no_material', it.name);
      const unitG = areaM2(it.roll_w, it.roll_l) * m.g_m2;
      let left = it.qty;
      const tryAdd = r => {
        const width = Math.max(r.width, it.roll_w);
        if (width + prof.end_allowance_mm > prof.max_packed_width_mm) return 0;
        // how many fit under the diameter cap: solve D(len) <= max for the extra length
        const room = ((prof.max_diameter_mm - prof.diameter_allowance_mm) ** 2 - prof.core_mm ** 2) * Math.PI / 4;   // = thickness x length budget
        let n = Math.min(left, Math.floor((room - r.thick_len) / (m.thickness_mm * it.roll_l) + 1e-9));
        while (n > 0) {
          const dims = rollDims(width, r.thick_len + n * m.thickness_mm * it.roll_l, prof);
          const pkg = packagingFor({ shape: 'roll', ...dims }, prof, config);
          const core = Math.ceil((width + prof.end_allowance_mm) / 1000 * prof.core_g_per_m);
          if (r.goods_g + n * unitG + core + pkg.weight_g <= prof.max_weight_g) break;
          n--;
        }
        return n;
      };
      for (const r of open) { if (!left) break; const n = tryAdd(r); if (n > 0) { r.width = Math.max(r.width, it.roll_w); r.thick_len += n * m.thickness_mm * it.roll_l; r.goods_g += n * unitG; r.items.push({ ...it, qty: n }); left -= n; } }
      while (left > 0) {
        const r = { width: it.roll_w, thick_len: 0, goods_g: 0, items: [] };
        const n = tryAdd(r);
        if (n < 1) fail(it.roll_w + prof.end_allowance_mm > prof.max_packed_width_mm ? 'roll_too_wide' : 'roll_too_long', it.name);
        r.thick_len += n * m.thickness_mm * it.roll_l; r.goods_g += n * unitG; r.items.push({ ...it, qty: n }); left -= n; open.push(r);
      }
    }
    for (const r of open) {
      const dims = rollDims(r.width, r.thick_len, prof);
      const core = Math.ceil(dims.length_mm / 1000 * prof.core_g_per_m);
      out.push(finish({ profile: 'rolled', shape: 'roll', ...dims, goods_g: r.goods_g + core,
        contents: r.items.map(i => ({ name: i.name, qty: i.qty, size_mm: [i.roll_w, i.roll_l], material: i.material })) }, prof, config));
    }
  }
  return out;
}
const rollDims = (width, thickLen, prof) => {
  const D = Math.ceil(rollDiameter(prof.core_mm, 1, thickLen, prof.diameter_allowance_mm));   // thickness folded into thickLen
  return { length_mm: width + prof.end_allowance_mm, width_mm: D, height_mm: D, diameter_mm: D };
};

function packWallpaper(items, config) {
  const prof = config.profiles.wallpaper, mats = config.materials, out = [];
  for (const it of items) {
    const m = mats[it.material] || mats.wallpaper_smooth;
    const area = areaM2(it.wall_w_mm, it.wall_h_mm) * it.qty * (1 + (prof.waste_bps || 0) / 10000);
    let rolls = Math.max(1, Math.ceil(area / prof.roll_area_m2 - 1e-9));
    const rollG = Math.min(area, prof.roll_area_m2) * m.g_m2;
    const c = prof.carton;
    while (rolls > 0) {
      let n = Math.min(rolls, prof.rolls_per_carton);
      const pkg = packagingFor({ shape: 'box', length_mm: c.length_mm, width_mm: c.width_mm, height_mm: c.height_mm }, prof, config);
      while (n > 0 && n * rollG + pkg.weight_g > prof.max_weight_g) n--;
      if (n < 1) fail('item_too_heavy', it.name);
      out.push(finish({ profile: 'wallpaper', shape: 'box', length_mm: c.length_mm, width_mm: c.width_mm, height_mm: c.height_mm, goods_g: n * rollG,
        contents: [{ name: it.name, qty: n, note: `${n} roll${n > 1 ? 's' : ''} for ${it.wall_w_mm} x ${it.wall_h_mm} mm` }] }, prof, config));
      rolls -= n;
    }
  }
  return out;
}

function packUnits(items, config) {
  const prof = config.profiles.unit, out = [];
  for (const it of items) {
    const u = it.model || config.units[it.unit];
    let left = it.qty;
    while (left > 0) {
      let n = Math.min(left, Math.max(1, u.per_package || 1));
      const pkg = packagingFor({ shape: 'box', length_mm: u.length_mm, width_mm: u.width_mm, height_mm: u.height_mm }, prof, config);
      while (n > 0 && n * u.weight_g + pkg.weight_g > prof.max_weight_g) n--;
      if (n < 1) fail('item_too_heavy', it.name);
      out.push(finish({ profile: 'unit', shape: 'box', length_mm: u.length_mm, width_mm: u.width_mm, height_mm: u.height_mm, goods_g: n * u.weight_g,
        contents: [{ name: it.name, qty: n, model: it.unit }] }, prof, config));
      left -= n;
    }
  }
  return out;
}

export function flatSize(item, config) {
  const exact = (config.flatpack.sizes || {})[item.size_key];
  const board = config.flatpack.boards[item.board];
  const [L, W, H] = item.box_mm;
  if (exact) return { l: Math.max(exact.length_mm, exact.width_mm), w: Math.min(exact.length_mm, exact.width_mm), thickness: board.thickness_mm * (item.formula === 'rsc' ? 2 : 1), unit_g: exact.weight_g };
  let a, b, layers;
  if (item.formula === 'mailer') { a = 2 * W + 3 * H + 40; b = L + 2 * H + 20; layers = 1; }
  else { a = L + W + 35; b = H + W; layers = 2; }
  return { l: Math.max(a, b), w: Math.min(a, b), thickness: board.thickness_mm * layers, unit_g: areaM2(a, b) * layers * board.g_m2 };
}
function packFlatpack(items, config) {
  const prof = config.profiles.flatpack, out = [];
  for (const it of items) {
    const f = flatSize(it, config);
    const maxN = Math.floor((prof.max_stack_mm - prof.protection_mm + 1e-9) / f.thickness);
    if (maxN < 1) fail('item_too_thick', it.name);
    let left = it.qty;
    while (left > 0) {
      let n = Math.min(left, maxN);
      for (;;) {
        const dims = { length_mm: f.l + prof.edge_allowance_mm, width_mm: f.w + prof.edge_allowance_mm, height_mm: Math.ceil(n * f.thickness + prof.protection_mm) };
        const pkg = packagingFor({ shape: 'box', ...dims }, prof, config);
        if (n * f.unit_g + pkg.weight_g <= prof.max_weight_g || n < 1) break;
        n--;
      }
      if (n < 1) fail('item_too_heavy', it.name);
      out.push(finish({ profile: 'flatpack', shape: 'box', length_mm: f.l + prof.edge_allowance_mm, width_mm: f.w + prof.edge_allowance_mm,
        height_mm: Math.ceil(n * f.thickness + prof.protection_mm), goods_g: n * f.unit_g,
        contents: [{ name: it.name, qty: n, note: `flat ${Math.round(f.l)} x ${Math.round(f.w)} mm, ${f.thickness} mm each` }] }, prof, config));
      left -= n;
    }
  }
  return out;
}

// Final packed figures for one package: sorted dimensions, weight with packaging, packaging cost.
function finish(p, prof, config) {
  const pkg = packagingFor(p, prof, config);
  const dims = [p.length_mm, p.width_mm, p.height_mm].map(Math.ceil).sort((a, b) => b - a);
  return { ...p, length_mm: dims[0], width_mm: dims[1], height_mm: dims[2], weight_g: Math.ceil(p.goods_g + pkg.weight_g),
    packaging: { cardboard_m2: +(pkg.cardboard_mm2 / 1e6).toFixed(4), bubble_m2: +(pkg.bubble_mm2 / 1e6).toFixed(4), cost: pkg.cost } };
}

export function pack(items, config) {
  const by = p => items.filter(i => i.profile === p);
  return [...packRigid(by('rigid'), config, 'rigid'), ...packRigid(by('flat'), config, 'flat'), ...packRolled(by('rolled'), config),
    ...packWallpaper(by('wallpaper'), config), ...packUnits(by('unit'), config), ...packFlatpack(by('flatpack'), config)]
    .map((p, i) => ({ n: i + 1, ...p }));
}

// ---------------------------------------------------------------------------------------------
// Pricing (sections 3, 4, 5, 11, 12)
export function bandFor(longestMm, config) {
  for (const b of config.bands) if (b.up_to_mm == null || longestMm <= b.up_to_mm) return b;
  return config.bands[config.bands.length - 1];
}
const tierFor = (tiers, value, key) => tiers.find(t => t[key] == null || value <= t[key]);

export function priceOrder(packages, zone, config) {
  const pr = config.pricing, feas = { ...config.feasibility, ...(zone.feasibility || {}) };
  const priced = packages.map(p => {
    if (p.length_mm > feas.max_length_mm || p.width_mm > feas.max_width_mm || p.height_mm > feas.max_height_mm || p.weight_g > feas.max_weight_g)
      fail('package_not_feasible', `package ${p.n}: ${p.length_mm} x ${p.width_mm} x ${p.height_mm} mm, ${p.weight_g} g`);
    const band = bandFor(p.length_mm, config);
    const rate = zone.rates && zone.rates[band.key];
    if (rate == null || rate === '' || !(Number(rate) >= 0)) fail('no_rate_for_band', `${zone.name}: ${band.label}`);
    const wt = tierFor(zone.width_tiers || [], p.width_mm, 'up_to_mm');
    const gt = tierFor(zone.weight_tiers || [], p.weight_g, 'up_to_g');
    if (!wt || !gt) fail('no_surcharge_tier', `package ${p.n}`);
    const base = cents(rate);
    return { ...p, band: band.key, band_label: band.label, base, width_bps: wt.bps, width_surcharge: bps(base, wt.bps), weight_surcharge: cents(gt.cents) };
  });
  // the package with the highest base pays 100%; the first one wins a tie. Others pay the additional-package rate.
  let top = 0; priced.forEach((p, i) => { if (p.base > priced[top].base) top = i; });
  for (const [i, p] of priced.entries()) {
    const oversized = p.band === 'os1' || p.band === 'os2';
    const discounted = i !== top && (!oversized || pr.oversized_discount_eligible);
    p.charge_bps = discounted ? pr.additional_package_bps : 10000;
    p.base_charged = bps(p.base, p.charge_bps);
  }
  const base_subtotal = priced.reduce((t, p) => t + p.base_charged, 0n);
  const freight_selling = bps(base_subtotal, 10000 + pr.freight_markup_bps);
  const surcharges = priced.reduce((t, p) => t + p.width_surcharge + p.weight_surcharge, 0n);
  const packaging_cost = priced.reduce((t, p) => t + p.packaging.cost, 0n);
  const packaging_selling = bps(packaging_cost, 10000 + pr.packaging_markup_bps);
  const before_minimum = freight_selling + surcharges + packaging_selling;
  const minimum = cents(pr.minimum_ex_gst_cents);
  const after_minimum = before_minimum < minimum ? minimum : before_minimum;
  const ex = pr.rounding === 'none' ? after_minimum : ceilDiv(after_minimum, 100n * UNIT) * 100n * UNIT;   // round up to the next whole dollar
  const ex_cents = Math.ceil(Number(ex * 100n / UNIT) / 100);   // whole cents (exact for whole dollars)
  const gst_cents = Math.round(ex_cents * pr.gst_bps / 10000);
  return {
    packages: priced,
    totals: { base_subtotal, freight_selling, surcharges, packaging_cost, packaging_selling, before_minimum, minimum_applied: before_minimum < minimum },
    ex_gst_cents: ex_cents, gst_cents, inc_gst_cents: ex_cents + gst_cents,
  };
}

// ---------------------------------------------------------------------------------------------
// The one entry point. lines: cart lines (or simulator custom items); postcode: destination.
// Returns { ok: true, ... } with the price and full working, or { ok: false, message, reason }.
export function quoteShipping({ lines, postcode, config, version = null, requireApproval = true }) {
  const base = { method: METHOD, postcode: normalisePostcode(postcode), config_version: version };
  const z = findZone(postcode, config);
  const zinfo = z.zone ? { id: z.zone.id, name: z.zone.name, state: z.zone.state, class: z.zone.class, enabled: !!z.zone.enabled,
    approval: (z.zone.approval && z.zone.approval.status) || 'provisional', via: z.via } : null;
  const avail = z.zone ? zoneAvailable(z.zone, { requireApproval }) : { ok: false, reason: z.reason };
  try {
    if (!z.zone) fail(z.reason);
    const items = (lines || []).map(l => resolveItem(l, config));
    if (!items.length) fail('empty_cart');
    const priced = priceOrder(pack(items, config), z.zone, config);
    if (avail.ok) return { ...base, zone: zinfo, ok: true, available: true, ...priced };
    // Not available here: no price at the top level, ever. The working is kept only for the simulator.
    return { ...base, zone: zinfo, ok: false, available: false, reason: avail.reason, message: UNAVAILABLE, would_be: priced };
  } catch (err) {
    if (!(err instanceof Unavailable)) throw err;
    // a disabled or unapproved zone reports that first; the packing/pricing problem goes in the detail
    return { ...base, zone: zinfo, ok: false, available: false, reason: avail.ok ? err.reason : avail.reason,
      detail: avail.ok ? err.detail : [err.reason, err.detail].filter(Boolean).join(': '), message: UNAVAILABLE };
  }
}

// A plain-JSON copy of a quote (BigInt units become dollar strings with 4 decimals) for storing
// with the order, showing in the simulator, or sending to the browser.
export function serialiseQuote(q) {
  const conv = v => typeof v === 'bigint' ? money4(v) : Array.isArray(v) ? v.map(conv) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])) : v;
  return conv(q);
}
// What a customer may see: one method and the price, never the working.
export function customerView(q) {
  return q.ok ? { ok: true, method: METHOD, ex_gst_cents: q.ex_gst_cents, gst_cents: q.gst_cents, inc_gst_cents: q.inc_gst_cents }
    : { ok: false, method: METHOD, message: q.message || UNAVAILABLE };
}
export { UNIT, toCents };
