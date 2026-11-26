// Eyelets on corflute: the dropdown's choices, how many eyelets a sign gets, and what they cost.
// Everything is worked out here from the database and the sign's size; whatever the browser sends as a
// price or a count is ignored. The storefront repeats eyeletCount() only to show the customer the count
// before they add to cart (same rule, see eyeletCount in index.html).
import { HttpError, cents } from './core.js';

const missing = e => ['PGRST205', '42P01', '42703', 'PGRST204'].includes(e && e.code)
  || /(could not find the table|does not exist|schema cache|column .* does not exist)/i.test(String(e && e.message));
export const HELP = 'Metal rings punched through the sign so you can hang it or tie it to a fence. Choose No eyelets if you don\'t need them.';
const RULES = ['none', 'per_sign', 'per_eyelet'], MODES = ['fixed', 'around', 'top'];

// On when EYELETS_ENABLED=true and the table and product column exist. Never throws for a missing table.
export async function eyeletsReady(d, cfg) {
  if (!cfg.eyelets || !cfg.eyelets.enabled) return false;
  try { await d.select('eyelet_choices', 'select=id&limit=1'); await d.select('products', 'select=eyelets&limit=1'); return true; }
  catch (e) { if (missing(e)) return false; throw e; }
}

// The active choices, in dropdown order. The default ("No eyelets") is first unless staff moved it.
export async function loadChoices(d) {
  const rows = await d.select('eyelet_choices', 'select=id,label,price_rule,amount,count_mode,fixed_count,spacing_mm,position,is_default&active=is.true&order=position,label');
  return rows.map(clean);
}
export function clean(r) {
  return { id: r.id, label: String(r.label || '').trim(), rule: RULES.includes(r.price_rule) ? r.price_rule : 'none',
    amount_cents: cents(r.amount || 0), mode: MODES.includes(r.count_mode) ? r.count_mode : 'fixed',
    fixed: r.fixed_count == null ? null : +r.fixed_count, spacing: r.spacing_mm == null ? null : +r.spacing_mm, default: !!r.is_default };
}
// What the storefront needs to draw the dropdown (prices in cents, GST included).
export function publicChoices(list) {
  return list.map(c => ({ label: c.label, rule: c.rule, amount_cents: c.amount_cents, mode: c.mode, fixed: c.fixed, spacing: c.spacing, default: c.default }));
}

// The sign's width and height in mm, top edge first: the custom size, or a standard "600mm x 400mm" size.
// Portrait or landscape (chosen in the artwork step) decides which side is the top.
export function signSize(opts = {}) {
  const src = opts['Custom size'] || opts.Size || '';
  const m = String(src).match(/(\d{1,5}(?:\.\d+)?)\s*(?:mm)?\s*W?\s*[×xX*]\s*(\d{1,5}(?:\.\d+)?)/);
  if (!m) return null;
  let w = Number(m[1]), h = Number(m[2]);
  const o = String(opts.Orientation || '');
  if (/portrait/i.test(o) && w > h) [w, h] = [h, w];
  if (/landscape/i.test(o) && h > w) [w, h] = [h, w];
  return w > 0 && h > 0 ? { w, h } : null;
}
// How many eyelets one sign gets. 'around': a corner eyelet each corner, then no more than `spacing` mm apart
// along every edge. 'top': along the top edge only, both top corners included. Same rule in the storefront.
export function eyeletCount(c, size) {
  if (c.mode === 'fixed') return c.fixed || 0;
  if (!(c.spacing > 0) || !size) return null;
  const sw = Math.max(1, Math.ceil(size.w / c.spacing)), sh = Math.max(1, Math.ceil(size.h / c.spacing));
  return c.mode === 'top' ? sw + 1 : 2 * (sw + sh);
}
const money = c => `$${(c / 100).toFixed(2)}`;

// The choice for one cart line, priced. Returns null for products without the dropdown.
// opts.Eyelets is the label the customer picked; missing means the default. An unknown label is refused.
export function priceEyelets(p, opts, choices) {
  if (!p.eyelets || !choices.length) return null;
  const want = String(opts.Eyelets || '').trim().toLowerCase();
  const c = want ? choices.find(x => x.label.toLowerCase() === want) : (choices.find(x => x.default) || choices[0]);
  if (!c) throw new HttpError(400, `That eyelets choice for ${p.name} is no longer available. Please choose again.`);
  let count = c.mode === 'fixed' ? (c.fixed || null) : eyeletCount(c, signSize(opts));
  let each = 0;
  if (c.rule === 'per_sign') each = c.amount_cents;
  if (c.rule === 'per_eyelet') {
    if (count == null) throw new HttpError(400, `Please choose a size for ${p.name} so we can work out the eyelets.`);
    each = c.amount_cents * count;
  }
  if (c.rule !== 'per_eyelet' && c.mode !== 'fixed') count = eyeletCount(c, signSize(opts));
  // What the customer, Avanti, Stripe, PayPal and the tax invoice all see on the line. No "$0.00" anywhere.
  const parts = [];
  if (count) parts.push(`${count} eyelet${count === 1 ? '' : 's'}`);
  if (each > 0) parts.push(`+${money(each)} per sign`);
  const text = c.label + (each > 0 && parts.length ? ` (${parts.join(', ')})` : '');
  return { label: c.label, count: count || null, each_cents: each, text };
}
