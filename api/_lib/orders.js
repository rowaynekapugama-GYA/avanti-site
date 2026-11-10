// Pricing, delivery and orders. Totals are always recalculated here from the database;
// whatever the browser says a line costs is ignored.
import { HttpError, cents, audit, config } from './core.js';
import { loadShippingConfig, shippingFor } from './shipping/store.js';
import { UNAVAILABLE, METHOD, serialiseQuote } from './shipping/engine.js';
import { STATE_RANGES } from './shipping/validate.js';
import { normaliseCode, CODE_RE, MESSAGES as DISCOUNT_MESSAGES, checkCode, discountAmounts, discountsReady, findCode, usesByEmail, gstIn } from './discounts.js';

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---- catalogue ----
export async function loadCatalogue(d, slugs) {
  const list = [...new Set(slugs)].map(s => `"${String(s).replace(/"/g, '')}"`).join(',');
  const [products, variations, tiers, cats, classes, rates, options] = await Promise.all([
    d.select('products', `select=slug,name,category_slug,pricing_mode,base_price,wall_dims,dims_config,variation_keys,sold_out,published&slug=in.(${list})`),
    d.select('product_variations', `select=product_slug,option_values,price,available&product_slug=in.(${list})`),
    d.select('product_price_tiers', `select=product_slug,min_qty,unit_price&product_slug=in.(${list})&order=min_qty`),
    d.select('categories', 'select=slug,name,shipping_class'),
    d.select('shipping_classes', 'select=slug,label,courier,note,position&order=position'),
    d.select('shipping_rates', 'select=class_slug,label,amount,position&order=position'),
    d.select('product_options', `select=product_slug,name,choices&product_slug=in.(${list})`),
  ]);
  const bySlug = Object.fromEntries(products.map(p => [p.slug, { ...p, variations: [], tiers: [], choices: {} }]));
  options.forEach(o => { if (bySlug[o.product_slug]) bySlug[o.product_slug].choices[o.name] = (o.choices || []).map(String); });
  variations.forEach(v => bySlug[v.product_slug] && bySlug[v.product_slug].variations.push(v));
  tiers.forEach(t => bySlug[t.product_slug] && bySlug[t.product_slug].tiers.push(t));
  return {
    products: bySlug,
    categories: Object.fromEntries(cats.map(c => [c.slug, c])),
    classes: classes.map(c => ({ ...c, rates: rates.filter(r => r.class_slug === c.slug) })),
  };
}

// "1200 × 2400 mm" (also x, X or *, decimals allowed) -> [1200, 2400]; anything else -> null
export function parseWH(text) {
  const m = String(text || '').trim().match(/^(\d{1,6}(?:\.\d+)?)\s*(?:mm)?\s*[×xX*]\s*(\d{1,6}(?:\.\d+)?)\s*(?:mm)?$/);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return w > 0 && h > 0 && w <= 100000 && h <= 100000 ? [w, h] : null;
}
// The options the shipping calculator may look at: only this product's own options with one of their listed
// choices (or a priced variation), plus the wall or custom size for products that take one, in whole millimetres.
// Anything else the browser adds (free text, made-up option names) can't change the delivery price.
export function shippingOptions(p, opts) {
  const out = {};
  for (const [name, choices] of Object.entries(p.choices || {})) if (opts[name] != null && choices.includes(String(opts[name]))) out[name] = String(opts[name]);
  for (const k of p.variation_keys || []) if (opts[k] != null && p.variations.length) out[k] = String(opts[k]);   // already matched to a variation by unitCents
  if (p.wall_dims) { const wh = parseWH(opts.Wall); if (wh) out.Wall = `${Math.ceil(wh[0])} × ${Math.ceil(wh[1])} mm`; }
  if (isCustomSize(p)) { const wh = parseWH(opts['Custom size']); if (wh) out['Custom size'] = `${Math.ceil(wh[0])} × ${Math.ceil(wh[1])} mm`; }
  return out;
}
// Custom-size products: the size must be there and within the product's maximum (also checked in the browser)
const isCustomSize = p => p.dims_config != null && !p.wall_dims;   // storefront: p.cdims (= dims_config)
function checkCustomSize(p, opts) {
  if (!isCustomSize(p)) return;
  const wh = parseWH(opts['Custom size']), mx = p.dims_config || {};
  if (!wh) throw new HttpError(400, `Please enter the width and height in millimetres for ${p.name}.`);
  if (wh[0] < 50 || wh[1] < 50) throw new HttpError(400, `The smallest size for ${p.name} is 50 × 50 mm.`);
  // the same sheet either way round: 2400 wide x 1200 high fits a 1200 x 2400 limit (same rule as cdimsCheck in the storefront)
  if (mx.maxW && mx.maxH) {
    const lo = Math.min(mx.maxW, mx.maxH), hi = Math.max(mx.maxW, mx.maxH);
    if (Math.max(...wh) > hi || Math.min(...wh) > lo) throw new HttpError(400, `The maximum size for ${p.name} is ${lo} × ${hi} mm (either way round).`);
  } else if ((mx.maxW && wh[0] > mx.maxW) || (mx.maxH && wh[1] > mx.maxH)) throw new HttpError(400, `The maximum ${mx.maxW ? 'width' : 'height'} for ${p.name} is ${mx.maxW || mx.maxH} mm.`);
}

// Same rules as unitPrice() in the storefront (checked by the parity test for every combination).
export function unitCents(p, qty, opts = {}) {
  const keys = p.variation_keys || [];
  if (p.variations.length && keys.length) {
    if (keys.some(k => !opts[k])) throw new HttpError(400, `Please choose all options for ${p.name}.`);
    const v = p.variations.find(v => keys.every(k => String(v.option_values[k]) === String(opts[k])));
    if (!v || v.available === false) throw new HttpError(400, `That combination of ${p.name} is not available.`);
    return cents(v.price);
  }
  if (p.wall_dims) {
    const m = parseWH(opts.Wall);
    if (!m) throw new HttpError(400, `Please enter your wall size for ${p.name}.`);
    const m2 = Math.max(0.5, (m[0] * m[1]) / 1e6);
    return cents(Math.round(m2 * p.base_price * 100) / 100);
  }
  // Custom-size products: base price is the rate per m² (Avanti's price list), so price = width × height × rate.
  // Same rule as unitPrice() in the storefront.
  if (isCustomSize(p)) {
    const m = parseWH(opts['Custom size']);
    if (!m) throw new HttpError(400, `Please enter the width and height in millimetres for ${p.name}.`);
    return cents(Math.round((m[0] * m[1]) / 1e6 * p.base_price * 100) / 100);
  }
  if (p.tiers.length) { let u = p.tiers[0].unit_price; p.tiers.forEach(t => { if (qty >= t.min_qty) u = t.unit_price; }); return cents(u); }
  return cents(p.base_price);
}

// Delivery: one choice per delivery group in the cart (e.g. cake toppers AND banner stands).
// Items whose category has no delivery rates are flagged for a quote.
export function deliveryOptions(cat, lines) {
  const groups = [], seen = new Set(), quoteItems = []; let quote = false;
  for (const l of lines) {
    const c = cat.categories[l.category_slug], cls = c && c.shipping_class && cat.classes.find(x => x.slug === c.shipping_class);
    if (!cls || !cls.rates.length) { quote = true; if (!quoteItems.includes(l.name)) quoteItems.push(l.name); continue; }
    if (seen.has(cls.slug)) continue; seen.add(cls.slug);
    groups.push({ group: cls.slug, label: cls.label, courier: !!cls.courier, note: cls.note,
      options: cls.rates.map(r => ({ label: r.label, cents: cents(r.amount) })) });
  }
  return { groups, quote, quoteItems };
}

export function validateCustomer(c = {}) {
  const email = String(c.email || '').trim().toLowerCase();
  const a = c.address || {};
  const errs = [];
  if (!EMAIL_RE.test(email)) errs.push('a valid email address');
  if (!String(c.name || '').trim()) errs.push('your name');
  if (!String(a.line1 || '').trim()) errs.push('a street address');
  if (!String(a.suburb || '').trim()) errs.push('a suburb');
  if (!STATES.includes(a.state)) errs.push('a state');
  if (!/^\d{4}$/.test(String(a.postcode || '').trim())) errs.push('a 4-digit postcode');
  if (errs.length) throw new HttpError(400, 'Please enter ' + errs.join(', ') + '.');
  return {
    email, name: String(c.name).trim().slice(0, 120), phone: String(c.phone || '').trim().slice(0, 40) || null,
    company: String(c.company || '').trim().slice(0, 120) || null,
    address: { line1: String(a.line1).trim().slice(0, 160), line2: String(a.line2 || '').trim().slice(0, 160),
      suburb: String(a.suburb).trim().slice(0, 80), state: a.state, postcode: String(a.postcode).trim(), country: 'AU' },
  };
}

// Build a priced quote from the cart. Used by checkout, and returned to the browser to display.
export async function quote(d, body) {
  const raw = Array.isArray(body.lines) ? body.lines.slice(0, 100) : [];
  if (!raw.length) throw new HttpError(400, 'Your cart is empty.');
  const cat = await loadCatalogue(d, raw.map(l => l.slug));
  const lines = raw.map((l, i) => {
    const p = cat.products[l.slug];
    if (!p || !p.published) throw new HttpError(400, 'An item in your cart is no longer available. Please remove it and try again.');
    if (p.sold_out) throw new HttpError(400, `${p.name} is sold out.`);
    const qty = Math.floor(Number(l.qty));
    if (!(qty >= 1 && qty <= 100000)) throw new HttpError(400, `Please check the quantity for ${p.name}.`);
    const opts = Object.fromEntries(Object.entries(l.opts || {}).slice(0, 40).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 500)]));
    checkCustomSize(p, opts);
    const unit = unitCents(p, qty, opts);
    const art = l.art || null;
    const artwork = art ? {
      later: !!art.later, design: art.design ? String(art.design).slice(0, 200) : null,
      files: (art.files || []).slice(0, 4).map(f => ({ side: String(f.side || 'Artwork').slice(0, 40), name: String(f.name || '').slice(0, 200),
        path: /^incoming\/[\w-]{8,64}\/[^/]{1,240}$/.test(f.path || '') ? f.path : null, info: String(f.info || '').slice(0, 200),
        size: Number.isFinite(+f.size) && +f.size > 0 ? Math.round(+f.size) : null,
        copy: !!f.copy || f.name === 'Same as front' })),   // "copy": one artwork printed on both sides, nothing to upload
    } : null;
    return { position: i, product_slug: p.slug, name: p.name, category_slug: p.category_slug, options: opts, qty,
      unit_cents: unit, line_cents: unit * qty, artwork, ship_opts: shippingOptions(p, opts) };
  });
  // Delivery: one "Standard Delivery" price from the shipping calculator, for the customer's postcode.
  // Product prices include GST; the delivery price is worked out ex GST and GST is added to it.
  const postcode = body.postcode || (body.customer && body.customer.address && body.customer.address.postcode) || '';
  let shipping = null;
  if (String(postcode).trim()) {
    const loaded = await loadShippingConfig(d);
    shipping = shippingFor(lines.map(l => ({ slug: l.product_slug, category: l.category_slug, name: l.name, qty: l.qty, opts: l.ship_opts })), postcode, loaded, config());
  }
  lines.forEach(l => { delete l.ship_opts; });
  const deliveryCents = shipping && shipping.ok ? shipping.inc_gst_cents : 0;
  const subtotal = lines.reduce((s, l) => s + l.line_cents, 0);
  // Discount code (one per order), checked and priced here, never trusted from the browser
  const discount = await quoteDiscount(d, body, { lines, subtotal, shippingCents: shipping && shipping.ok ? deliveryCents : null });
  const productDiscount = discount && discount.ok ? discount.product_cents : 0;
  const shippingDiscount = discount && discount.ok ? discount.shipping_cents : 0;
  const total = subtotal - productDiscount + deliveryCents - shippingDiscount;
  // Prices include GST: GST is one eleventh of what is actually charged. Without a discount this is
  // exactly the calculation used before discounts existed.
  const gst = gstIn(subtotal - productDiscount) + (shipping && shipping.ok ? (shippingDiscount ? gstIn(deliveryCents - shippingDiscount) : shipping.gst_cents) : 0);
  return { lines, shipping, deliveryCents, deliveryMethod: shipping && shipping.ok ? METHOD : null, subtotal, total, gst,
    discount, productDiscount, shippingDiscount };
}

// The discount for this cart, or null when no code was entered (or discount codes are switched off).
// An unusable code comes back as { ok: false, message } so checkout can show the message.
async function quoteDiscount(d, body, { lines, subtotal, shippingCents }) {
  const code = normaliseCode(body.discount_code);
  if (!code) return null;
  if (!(await discountsReady(d, config()))) return null;     // switched off: checkout exactly as before
  const fail = message => ({ ok: false, code, message });
  if (!CODE_RE.test(code)) return fail(DISCOUNT_MESSAGES.invalid);
  const c = await findCode(d, code);
  if (!c) return fail(DISCOUNT_MESSAGES.invalid);                      // same message whether or not the code exists
  const email = body.customer && body.customer.email ? String(body.customer.email).trim().toLowerCase() : (body.email ? String(body.email).trim().toLowerCase() : '');
  const check = checkCode(c, { subtotalCents: subtotal, usesByEmail: c.per_email_limit && email ? await usesByEmail(d, c.id, email) : null });
  if (!check.ok) return fail(check.message);
  const amt = discountAmounts(c, { lines, shippingCents });
  if (amt.no_products) return fail(DISCOUNT_MESSAGES.no_products);
  return { ok: true, code, id: c.id, applies_to: c.applies_to, kind: c.kind,
    value: c.kind === 'percent' ? Number(c.percent) : c.amount_cents / 100,
    product_cents: amt.product_cents, shipping_cents: amt.shipping_cents, eligible: amt.eligible, shipping_pending: !!amt.shipping_pending };
}

export async function createPendingOrder(d, body) {
  const cust = validateCustomer(body.customer);
  const q = await quote(d, { ...body, postcode: cust.address.postcode });
  // no delivery price for this postcode (or this cart): never fall back to a cheaper rate
  if (!q.shipping || !q.shipping.ok) throw new HttpError(400, UNAVAILABLE);
  // a code that can't be used is never silently dropped: the customer must see the real total before paying
  if (q.discount && !q.discount.ok) throw new HttpError(400, `${q.discount.message}. Please remove it and try again.`, { discount_error: true });
  // card and PayPal payments need at least 50 cents
  if (q.discount && q.total < 50) throw new HttpError(400, 'With this code the order total is too low to pay online. Please call us on (02) 9729 0139 and we\'ll look after it.');
  // artwork the customer chose to upload must have arrived (Lauren's order, 27 Oct 2026: files lost on reload)
  const noFile = q.lines.find(l => l.artwork && !l.artwork.later && !l.artwork.design && (l.artwork.files || []).some(f => !f.path && !f.copy));
  if (noFile) throw new HttpError(400, `The artwork for ${noFile.name} didn't upload. Please remove it from your cart and add it again with your file, or choose "supply artwork later".`);
  const campaign = /^[0-9a-f-]{36}$/.test(body.campaign_id || '') ? body.campaign_id : null;
  const row = {
    email: cust.email, name: cust.name, phone: cust.phone, company: cust.company, shipping_address: cust.address,
    delivery_method: q.deliveryMethod, delivery_cents: q.deliveryCents, delivery_quote_required: false,
    subtotal_cents: q.subtotal, total_cents: q.total, gst_cents: q.gst, currency: 'AUD',
    provider: body.provider, marketing_opt_in: !!body.marketing_opt_in, campaign_id: campaign,
    customer_note: String(body.note || '').trim().slice(0, 1000) || null,
  };
  if (q.discount && q.discount.ok) Object.assign(row, { discount_code: q.discount.code, discount_code_id: q.discount.id, discount_type: q.discount.kind,
    discount_applies_to: q.discount.applies_to, discount_value: q.discount.value, product_discount_cents: q.productDiscount, shipping_discount_cents: q.shippingDiscount });
  // the full shipping calculation, saved with the order and never changed afterwards
  const ship = { shipping_quote: serialiseQuote(q.shipping), shipping_config_version: q.shipping.config_version,
    shipping_postcode: q.shipping.postcode, shipping_zone: q.shipping.zone && q.shipping.zone.name, shipping_ex_gst_cents: q.shipping.ex_gst_cents };
  let order, saved = true;
  try { [order] = await d.insert('orders', { ...row, ...ship }); }
  catch (e) {   // database update 005 not run yet (the columns don't exist): take the order anyway, and say so on its timeline
    const msg = String(e.message);
    if (!(/shipping_/.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg))) throw e;
    [order] = await d.insert('orders', row); saved = false;
  }
  if (!saved) await d.insert('order_events', { order_id: order.id, from_status: null, to_status: 'pending_payment', actor: 'system',
    note: `Shipping calculation not saved (run database update 005): ${q.shipping.zone && q.shipping.zone.name}, settings version ${q.shipping.config_version}, ${q.shipping.packages.length} package(s), $${(q.shipping.ex_gst_cents / 100).toFixed(2)} ex GST.` });
  // delivery is priced by postcode; flag it for staff if the postcode isn't normally in the chosen state
  // (not blocked: some border towns use the neighbouring state's postcodes)
  const pcN = Number(cust.address.postcode), inState = (STATE_RANGES[cust.address.state] || []).some(([a, b]) => pcN >= a && pcN <= b);
  if (!inState) await d.insert('order_events', { order_id: order.id, from_status: null, to_status: 'pending_payment', actor: 'system',
    note: `Check the address: postcode ${cust.address.postcode} isn't normally in ${cust.address.state}. Delivery was priced for ${cust.address.postcode} (${q.shipping.zone && q.shipping.zone.name}).` });
  await d.insert('order_items', q.lines.map(l => ({ ...l, order_id: order.id })));
  await d.insert('order_events', { order_id: order.id, from_status: null, to_status: 'pending_payment', actor: 'customer',
    note: `Checkout started with ${body.provider}${q.discount && q.discount.ok ? `, discount code ${q.discount.code}` : ''}`, data: { total_cents: q.total } });
  return { order, quote: q };
}

// ---- status changes ----
const MESSAGES = {
  invalid_transition: 'That status change is not allowed from the order’s current status.',
  carrier_and_tracking_required: 'Choose a carrier to mark the order as dispatched. If a carrier is already chosen, add a tracking number too (the database update that makes it optional has not been run yet).',
  order_not_found: 'Order not found.',
};
export async function transition(d, orderId, to, actor, note = null, data = {}, hooks = {}) {
  let res;
  try { res = await d.rpc('order_transition', { p_order: orderId, p_to: to, p_actor: actor, p_note: note, p_data: data }); }
  catch (e) {
    const key = Object.keys(MESSAGES).find(k => String(e.message).includes(k));
    if (key) throw new HttpError(key === 'order_not_found' ? 404 : 409, MESSAGES[key]);
    throw e;
  }
  if (res.changed && hooks.after) await hooks.after(orderId, res.from, res.status, { actor, note, data });
  return res;
}

export async function loadOrder(d, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) return null;
  const o = await d.one('orders', `select=*&id=eq.${d.q(id)}`);
  if (!o) return null;
  o.items = await d.select('order_items', `select=*&order_id=eq.${d.q(id)}&order=position`);
  return o;
}

// When an order is paid: record the customer (and their marketing choice, if they opted in).
export async function recordCustomer(d, order, ip) {
  const a = order.shipping_address || {};
  const [c] = await d.insert('customers', { email: order.email, name: order.name, phone: order.phone, state: a.state || null, postcode: a.postcode || null },
    { onConflict: 'email' });
  await d.update('orders', `id=eq.${order.id}`, { customer_id: c.id });
  if (order.marketing_opt_in) {
    const { subscribe } = await import('./marketing.js');
    await subscribe(d, { email: order.email, basis: 'checkout_opt_in', source: `Checkout, order ${order.number}`, ip, actor: 'customer' });
  }
  return c;
}

export { audit };
