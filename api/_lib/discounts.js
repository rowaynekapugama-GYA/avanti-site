// Discount codes: one code per order, taking a percentage or a flat amount off the shipping or off the
// products (all products, or selected products). Everything here runs on the server; the browser only
// shows what the server works out.
//
// All money is in whole cents. Prices include GST, so a discount reduces the GST-inclusive amount and the
// GST is worked out again on what is left.
import { HttpError, money } from './core.js';

export const MESSAGES = {
  invalid: "That code isn't valid",
  expired: 'That code has expired',
  used_up: 'That code has already been used the maximum number of times',
  min: c => `Your order needs to be at least ${money(c)} to use this code`,
};

// (A code for selected products with none of them in the cart also gets "isn't valid", so nobody can tell it exists.)

// Codes are letters and digits; customers can type them in any case, with spaces around them.
export const normaliseCode = s => String(s == null ? '' : s).trim().toUpperCase();
export const CODE_RE = /^[A-Z0-9]{2,32}$/;

// Percentage of an amount in cents, rounded to the cent, half up. Percent may have two decimals (12.5).
export function percentOf(cents, percent) {
  const bp = Math.round(Number(percent) * 100);          // basis points, exact integer
  return Math.floor((cents * bp + 5000) / 10000);
}

// "YYYY-MM-DD" in Sydney time -> the UTC instant that day starts (or ends). Handles daylight saving.
export function sydneyDayBoundary(day, end = false, tz = 'Australia/Sydney') {
  if (!day) return null;
  const m = String(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new HttpError(400, 'Please enter dates as day, month and year.');
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new HttpError(400, `${day} isn't a real date.`);
  // start from midnight UTC on that day, then correct by the zone offset at that moment (twice, for DST edges)
  let t = Date.UTC(y, mo - 1, d + (end ? 1 : 0), 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map(p => [p.type, p.value]));
    const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    t -= local - Date.UTC(y, mo - 1, d + (end ? 1 : 0));
  }
  return new Date(end ? t - 1 : t).toISOString();   // end of day = one millisecond before the next midnight
}
export const sydneyDay = (iso, tz = 'Australia/Sydney') => iso ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso)) : null;

// Active, Scheduled, Expired, Inactive or Used up, for the dashboard list.
export function codeStatus(c, now = Date.now()) {
  if (!c.active) return 'Inactive';
  if (c.usage_limit && c.uses >= c.usage_limit) return 'Used up';
  if (c.ends_at && Date.parse(c.ends_at) < now) return 'Expired';
  if (c.starts_at && Date.parse(c.starts_at) > now) return 'Scheduled';
  return 'Active';
}

// Can this code be used right now for this cart? Returns { ok } or { ok: false, message }.
// usesByEmail: how many paid orders this email has already used the code on (null = email not known yet).
export function checkCode(c, { subtotalCents, now = Date.now(), usesByEmail = null }) {
  if (!c || !c.active) return { ok: false, reason: 'invalid', message: MESSAGES.invalid };
  if (c.starts_at && Date.parse(c.starts_at) > now) return { ok: false, reason: 'not_started', message: MESSAGES.invalid };
  if (c.ends_at && Date.parse(c.ends_at) < now) return { ok: false, reason: 'expired', message: MESSAGES.expired };
  if (c.usage_limit && c.uses >= c.usage_limit) return { ok: false, reason: 'used_up', message: MESSAGES.used_up };
  if (c.per_email_limit && usesByEmail != null && usesByEmail >= c.per_email_limit) return { ok: false, reason: 'used_up_email', message: MESSAGES.used_up };
  if (c.min_subtotal_cents && subtotalCents < c.min_subtotal_cents) return { ok: false, reason: 'min', message: MESSAGES.min(c.min_subtotal_cents) };
  return { ok: true };
}

// How much the code takes off. lines: [{ product_slug, line_cents }]; shippingCents: delivery inc GST (or null if
// not priced yet). Returns the cents off the products and off the shipping, never more than the amount they apply to.
export function discountAmounts(c, { lines, shippingCents }) {
  const off = (base) => Math.min(base, c.kind === 'percent' ? percentOf(base, c.percent) : c.amount_cents);
  if (c.applies_to === 'shipping') {
    return { product_cents: 0, shipping_cents: shippingCents > 0 ? off(shippingCents) : 0, eligible: [], shipping_pending: shippingCents == null };
  }
  const selected = c.product_scope === 'selected' ? new Set(c.product_slugs || []) : null;
  const eligible = lines.map((l, i) => i).filter(i => !selected || selected.has(lines[i].product_slug));
  const base = eligible.reduce((t, i) => t + lines[i].line_cents, 0);
  if (!eligible.length) return { product_cents: 0, shipping_cents: 0, eligible, no_products: true };
  return { product_cents: off(base), shipping_cents: 0, eligible };   // a flat amount comes off once, not per item
}

// Split a product discount across the eligible lines in proportion to their value (largest remainder),
// so line amounts sent to the card provider add up exactly to the discounted total.
export function allocate(lines, eligible, discountCents) {
  const out = lines.map(() => 0);
  const base = eligible.reduce((t, i) => t + lines[i].line_cents, 0);
  if (!discountCents || !base) return out;
  const shares = eligible.map(i => { const exact = discountCents * lines[i].line_cents / base; return { i, cents: Math.floor(exact), rem: exact - Math.floor(exact) }; });
  let left = discountCents - shares.reduce((t, s) => t + s.cents, 0);
  shares.sort((a, b) => b.rem - a.rem || a.i - b.i).forEach(s => { if (left > 0) { s.cents++; left--; } });
  shares.forEach(s => { out[s.i] = Math.min(s.cents, lines[s.i].line_cents); });
  return out;
}

// GST included in a GST-inclusive amount (one eleventh), to the cent.
export const gstIn = cents => Math.round(cents / 11);

// ---------- database ----------
// The feature is off unless DISCOUNTS_ENABLED=true, and stays off (checkout as before) if the table is missing.
const missing = e => ['PGRST205', '42P01'].includes(e && e.code) || /(could not find the table|does not exist|schema cache)/i.test(String(e && e.message));
export async function discountsReady(d, cfg) {
  if (!cfg.discounts.enabled) return false;
  try { await d.select('discount_codes', 'select=id&limit=1'); return true; }
  catch (e) { if (missing(e)) return false; throw e; }
}
export async function findCode(d, code) {
  return d.one('discount_codes', `select=*&code=eq.${d.q(code)}`);
}
export async function usesByEmail(d, codeId, email) {
  if (!email) return null;
  const rows = await d.select('discount_redemptions', `select=id&code_id=eq.${d.q(codeId)}&email=eq.${d.q(String(email).trim().toLowerCase())}`);
  return rows.length;
}
// Called when an order becomes paid. Never throws: a failure is written to the order's timeline instead.
export async function redeem(d, order) {
  if (!order.discount_code_id) return false;
  try { return await d.rpc('discount_redeem', { p_order: order.id }); }
  catch (e) {
    console.error('discount redeem failed', order.id, e.message);
    try { await d.insert('order_events', { order_id: order.id, from_status: order.status, to_status: order.status, actor: 'system',
      note: `Discount code ${order.discount_code} could not be counted as used (${e.message}). The order and payment are fine.` }); } catch (er) {}
    return false;
  }
}
