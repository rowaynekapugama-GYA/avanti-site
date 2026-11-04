// Checks shipping settings before they are saved, and powers the "Validation" panel in the
// dashboard. Errors block saving; warnings are shown so the team can fix gaps.

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];
// postcode ranges that belong to each state/territory (Australia Post allocation)
export const STATE_RANGES = {
  NSW: [[1000, 1999], [2000, 2599], [2619, 2899], [2921, 2999]], ACT: [[200, 299], [2600, 2618], [2900, 2920]],
  VIC: [[3000, 3999], [8000, 8999]], QLD: [[4000, 4999], [9000, 9999]], SA: [[5000, 5999]],
  WA: [[6000, 6999]], TAS: [[7000, 7999]], NT: [[800, 999]],
};
const int = v => Number.isInteger(v);
const nonNeg = v => typeof v === 'number' && isFinite(v) && v >= 0;

export function validateConfig(c) {
  const errors = [], warnings = [];
  const err = m => errors.push(m), warn = m => warnings.push(m);
  if (!c || typeof c !== 'object') return { errors: ['Settings are missing.'], warnings };
  const p = c.pricing || {};
  for (const k of ['freight_markup_bps', 'packaging_markup_bps', 'additional_package_bps', 'minimum_ex_gst_cents', 'gst_bps'])
    if (!int(p[k]) || p[k] < 0) err(`Pricing: ${k.replace(/_/g, ' ')} must be a whole number of 0 or more.`);
  if (p.additional_package_bps > 10000) err('Pricing: the additional-package percentage cannot be more than 100%.');
  if (int(p.additional_package_bps) && p.additional_package_bps < 1000) warn(`Pricing: additional packages pay only ${p.additional_package_bps / 100}% of their rate. Check this isn't meant to be ${p.additional_package_bps}%.`);
  for (const k of ['freight_markup_bps', 'packaging_markup_bps']) if (int(p[k]) && p[k] > 0 && p[k] < 100) warn(`Pricing: ${k.replace(/_bps$/, '').replace(/_/g, ' ')} is only ${p[k] / 100}%. Check this isn't meant to be ${p[k]}%.`);
  if (int(p.minimum_ex_gst_cents) && p.minimum_ex_gst_cents === 0) warn('Pricing: there is no minimum delivery charge, so delivery could be $0.');
  if (!['ceil_dollar', 'none'].includes(p.rounding)) err('Pricing: rounding must be "round up to the next dollar" or "none".');

  const bands = c.bands || [];
  if (bands.length !== 5 || bands[4].up_to_mm != null) err('There must be five freight bands, the last with no upper limit.');
  // every limit but the last must be a whole number of mm above 0, going up in order (a blank limit would price everything as Small)
  for (let i = 0; i < 4; i++) if (!(bands[i] && int(bands[i].up_to_mm) && bands[i].up_to_mm > (i ? bands[i - 1].up_to_mm : 0))) { err('Freight band limits must be whole millimetres above 0, going up in order.'); break; }

  const f = c.feasibility || {};
  for (const k of ['max_length_mm', 'max_width_mm', 'max_height_mm', 'max_weight_g']) if (!(f[k] > 0)) err(`Package limits: ${k.replace(/_/g, ' ')} must be more than 0.`);
  if (f.max_packages != null && !(int(f.max_packages) && f.max_packages > 0 && f.max_packages <= 200)) err('Package limits: the most packages per order must be a whole number from 1 to 200.');

  const ids = new Set();
  const ranges = [];   // [a, b, zoneIndex]
  for (const [i, z] of (c.zones || []).entries()) {
    const label = z.name || z.id || `zone ${i + 1}`;
    if (!z.id || ids.has(z.id)) err(`${label}: needs a unique id.`); ids.add(z.id);
    if (!STATES.includes(z.state)) err(`${label}: state must be one of ${STATES.join(', ')}.`);
    if (!['metro', 'regional', 'remote'].includes(z.class)) err(`${label}: class must be Metro, Regional or Remote.`);
    for (const r of z.ranges || []) {
      if (!Array.isArray(r) || r.length !== 2 || !int(r[0]) || !int(r[1]) || r[0] > r[1] || r[0] < 200 || r[1] > 9999) { err(`${label}: postcode range ${JSON.stringify(r)} is not valid.`); continue; }
      ranges.push([r[0], r[1], i]);
    }
    const rates = z.rates || {};
    const missing = bands.filter(b => rates[b.key] == null || rates[b.key] === '');
    for (const b of bands) if (rates[b.key] != null && rates[b.key] !== '' && !(int(rates[b.key]) && rates[b.key] >= 0)) err(`${label}: the ${b.label} rate must be a whole number of cents.`);
    if (z.enabled && missing.length) warn(`${label} is enabled but has no ${missing.map(b => b.label).join(', ')} rate. Packages in ${missing.length > 1 ? 'those bands' : 'that band'} will show "unavailable".`);
    if (z.enabled && !(z.ranges || []).length) warn(`${label} is enabled but has no postcodes.`);
    if (z.enabled && !(z.approval && z.approval.status === 'approved')) warn(`${label} is enabled but not approved, so it shows "unavailable" on the live site until approved.`);
    const wt = z.width_tiers || [], gt = z.weight_tiers || [];
    if (!wt.length || wt[wt.length - 1].up_to_mm != null) err(`${label}: width surcharges must end with an "over" tier.`);
    for (const t of wt) if (!int(t.bps) || t.bps < 0) err(`${label}: width surcharge percentages must be whole numbers.`);
    for (let k = 0; k < wt.length - 1; k++) if (!(int(wt[k].up_to_mm) && wt[k].up_to_mm > (k ? wt[k - 1].up_to_mm : 0))) { err(`${label}: width surcharge limits must be whole millimetres above 0, going up in order.`); break; }
    for (const t of gt) if (!int(t.cents) || t.cents < 0 || !(t.up_to_g > 0)) err(`${label}: weight surcharges need a weight limit and a whole-cent amount.`);
    if (!gt.length) err(`${label}: needs at least one weight surcharge tier.`);
    for (let k = 1; k < gt.length; k++) if (!(gt[k].up_to_g > gt[k - 1].up_to_g)) err(`${label}: weight surcharge limits must go up in order.`);
    if (z.feasibility != null) {
      if (typeof z.feasibility !== 'object') err(`${label}: package limits are not valid.`);
      else for (const [k, v] of Object.entries(z.feasibility)) if (['max_length_mm', 'max_width_mm', 'max_height_mm', 'max_weight_g'].includes(k) && v != null && !(int(v) && v > 0)) err(`${label}: package limit ${k.replace(/_/g, ' ')} must be a whole number above 0, or blank.`);
    }
  }
  // two zones claiming the same postcodes with equally narrow ranges cannot be told apart
  for (let a = 0; a < ranges.length; a++) for (let b = a + 1; b < ranges.length; b++) {
    const [a1, a2, za] = ranges[a], [b1, b2, zb] = ranges[b];
    if (a1 > b2 || b1 > a2) continue;
    const A = c.zones[za], B = c.zones[zb];
    if (za === zb) warn(`${A.name}: postcode ranges ${a1}-${a2} and ${b1}-${b2} overlap.`);
    else if (a2 - a1 === b2 - b1) err(`${A.name} and ${B.name} both cover ${Math.max(a1, b1)}-${Math.min(a2, b2)} with the same range size, so the postcode can't be assigned. Use a postcode override or change a range.`);
  }
  // gaps: postcodes in a state that no zone covers (they show "unavailable")
  for (const [st, list] of Object.entries(STATE_RANGES)) {
    const gaps = [];
    for (const [s, e] of list) {
      let from = null;
      for (let n = s; n <= e + 1; n++) {
        const covered = n <= e && ranges.some(([x, y]) => n >= x && n <= y);
        if (!covered && n <= e && from == null) from = n;
        if ((covered || n > e) && from != null) { gaps.push(from === n - 1 ? String(from).padStart(4, '0') : `${String(from).padStart(4, '0')}-${String(n - 1).padStart(4, '0')}`); from = null; }
      }
    }
    if (gaps.length) warn(`${st}: no zone covers ${gaps.slice(0, 8).join(', ')}${gaps.length > 8 ? ` and ${gaps.length - 8} more ranges` : ''}. These postcodes show "unavailable".`);
  }
  const seen = new Set();
  for (const o of c.postcode_overrides || []) {
    if (!/^\d{3,4}$/.test(String(o.postcode || ''))) err(`Postcode override "${o.postcode}" is not a valid postcode.`);
    if (seen.has(String(o.postcode).padStart(4, '0'))) err(`Postcode ${o.postcode} has more than one override.`); seen.add(String(o.postcode).padStart(4, '0'));
    if (!ids.has(o.zone_id)) err(`Postcode override ${o.postcode} points to a zone that doesn't exist.`);
  }
  for (const [k, m] of Object.entries(c.materials || {})) if (!(m.thickness_mm > 0) || !(m.g_m2 > 0)) err(`Material ${m.label || k}: thickness and weight must be more than 0.`);
  for (const [k, u] of Object.entries(c.units || {})) if (!(u.length_mm > 0 && u.width_mm > 0 && u.height_mm > 0 && u.weight_g > 0 && u.per_package >= 1)) err(`Parcel ${u.label || k}: size, weight and units per package must be more than 0.`);
  for (const [k, b] of Object.entries((c.flatpack && c.flatpack.boards) || {})) if (!(b.thickness_mm > 0 && b.g_m2 > 0)) err(`Board ${k}: thickness and weight must be more than 0.`);
  const pk = c.packaging || {};
  for (const k of ['cardboard_cents_m2', 'bubble_cents_m2', 'labour_cents', 'tape_cents', 'waste_bps', 'cardboard_g_m2', 'bubble_g_m2']) if (!nonNeg(pk[k])) err(`Packaging: ${k.replace(/_/g, ' ')} must be 0 or more.`);
  const pr = c.profiles || {};
  if (!(pr.rigid && pr.rigid.max_height_mm > pr.rigid.height_allowance_mm)) err('Rigid signage: the maximum height must be more than the packaging allowance.');
  if (pr.rigid && !['same_size', 'fit_within'].includes(pr.rigid.stacking)) err('Rigid signage: stacking must be "same size only" or "smaller boards on larger".');
  if (!(pr.rolled && pr.rolled.max_diameter_mm - pr.rolled.diameter_allowance_mm > pr.rolled.core_mm)) err('Rolled prints: the maximum diameter must leave room around the core.');
  if (!(pr.flatpack && pr.flatpack.max_stack_mm > pr.flatpack.protection_mm)) err('Flat-pack: the maximum stack height must be more than the protection allowance.');
  const cat = c.catalogue || {};
  for (const [k, m] of [...Object.entries(cat.categories || {}), ...Object.entries(cat.products || {})]) {
    if (m.material && !(c.materials || {})[m.material]) err(`${k}: material "${m.material}" doesn't exist.`);
    if (m.unit && !(c.units || {})[m.unit]) err(`${k}: parcel "${m.unit}" doesn't exist.`);
    for (const u of Object.values(m.unit_by_size || {})) if (!(c.units || {})[u]) err(`${k}: parcel "${u}" doesn't exist.`);
  }
  for (const r of c.material_rules || []) if (!(c.materials || {})[r.material]) err(`Material rule "${(r.match || []).join(' + ')}" points to a material that doesn't exist.`);
  return { errors, warnings };
}
