// Pricing, delivery and orders. Totals are always recalculated here from the database;
// whatever the browser says a line costs is ignored.
import { HttpError, cents, audit } from './core.js';

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---- catalogue ----
export async function loadCatalogue(d, slugs) {
  const list = [...new Set(slugs)].map(s => `"${String(s).replace(/"/g, '')}"`).join(',');
  const [products, variations, tiers, cats, classes, rates] = await Promise.all([
    d.select('products', `select=slug,name,category_slug,pricing_mode,base_price,wall_dims,variation_keys,sold_out,published&slug=in.(${list})`),
    d.select('product_variations', `select=product_slug,option_values,price,available&product_slug=in.(${list})`),
    d.select('product_price_tiers', `select=product_slug,min_qty,unit_price&product_slug=in.(${list})&order=min_qty`),
    d.select('categories', 'select=slug,name,shipping_class'),
    d.select('shipping_classes', 'select=slug,label,courier,note,position&order=position'),
    d.select('shipping_rates', 'select=class_slug,label,amount,position&order=position'),
  ]);
  const bySlug = Object.fromEntries(products.map(p => [p.slug, { ...p, variations: [], tiers: [] }]));
  variations.forEach(v => bySlug[v.product_slug] && bySlug[v.product_slug].variations.push(v));
  tiers.forEach(t => bySlug[t.product_slug] && bySlug[t.product_slug].tiers.push(t));
  return {
    products: bySlug,
    categories: Object.fromEntries(cats.map(c => [c.slug, c])),
    classes: classes.map(c => ({ ...c, rates: rates.filter(r => r.class_slug === c.slug) })),
  };
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
    const m = String(opts.Wall || '').match(/(\d+)\D+(\d+)/);
    if (!m) throw new HttpError(400, `Please enter your wall size for ${p.name}.`);
    const m2 = Math.max(0.5, (+m[1] * +m[2]) / 1e6);
    return cents(Math.round(m2 * p.base_price * 100) / 100);
  }
  if (p.tiers.length) { let u = p.tiers[0].unit_price; p.tiers.forEach(t => { if (qty >= t.min_qty) u = t.unit_price; }); return cents(u); }
  return cents(p.base_price);
}

// Delivery: one choice per delivery group in the cart (e.g. cake toppers AND banner stands).
// Items whose category has no delivery rates are flagged for a quote.
export function deliveryOptions(cat, lines) {
  const groups = [], seen = new Set(); let quote = false;
  for (const l of lines) {
    const c = cat.categories[l.category_slug], cls = c && c.shipping_class && cat.classes.find(x => x.slug === c.shipping_class);
    if (!cls || !cls.rates.length) { quote = true; continue; }
    if (seen.has(cls.slug)) continue; seen.add(cls.slug);
    groups.push({ group: cls.slug, label: cls.label, courier: !!cls.courier, note: cls.note,
      options: cls.rates.map(r => ({ label: r.label, cents: cents(r.amount) })) });
  }
  return { groups, quote };
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
    const unit = unitCents(p, qty, opts);
    const art = l.art || null;
    const artwork = art ? {
      later: !!art.later, design: art.design ? String(art.design).slice(0, 200) : null,
      files: (art.files || []).slice(0, 4).map(f => ({ side: String(f.side || 'Artwork').slice(0, 40), name: String(f.name || '').slice(0, 200),
        path: /^incoming\/[\w-]{8,64}\/[^/]{1,240}$/.test(f.path || '') ? f.path : null, info: String(f.info || '').slice(0, 200) })),
    } : null;
    return { position: i, product_slug: p.slug, name: p.name, category_slug: p.category_slug, options: opts, qty,
      unit_cents: unit, line_cents: unit * qty, artwork };
  });
  const delivery = deliveryOptions(cat, lines);
  const chosen = body.delivery || {};
  let deliveryCents = 0; const picked = [];
  for (const g of delivery.groups) {
    const o = g.options.find(o => o.label === chosen[g.group]) || null;
    if (body.requireDelivery && !o) throw new HttpError(400, `Please choose a delivery option for ${g.label}.`);
    const use = o || g.options[0];
    deliveryCents += use.cents; picked.push(`${g.label}: ${use.label}`);
  }
  const subtotal = lines.reduce((s, l) => s + l.line_cents, 0), total = subtotal + deliveryCents;
  return { lines, delivery, deliveryCents, deliveryMethod: picked.join('; ') || null, subtotal, total,
    gst: Math.round(total / 11),   // prices include GST
    quoteRequired: delivery.quote };
}

export async function createPendingOrder(d, body) {
  const cust = validateCustomer(body.customer);
  const q = await quote(d, { ...body, requireDelivery: true });
  const campaign = /^[0-9a-f-]{36}$/.test(body.campaign_id || '') ? body.campaign_id : null;
  const [order] = await d.insert('orders', {
    email: cust.email, name: cust.name, phone: cust.phone, company: cust.company, shipping_address: cust.address,
    delivery_method: q.deliveryMethod, delivery_cents: q.deliveryCents, delivery_quote_required: q.quoteRequired,
    subtotal_cents: q.subtotal, total_cents: q.total, gst_cents: q.gst, currency: 'AUD',
    provider: body.provider, marketing_opt_in: !!body.marketing_opt_in, campaign_id: campaign,
    customer_note: String(body.note || '').trim().slice(0, 1000) || null,
  });
  await d.insert('order_items', q.lines.map(l => ({ ...l, order_id: order.id })));
  await d.insert('order_events', { order_id: order.id, from_status: null, to_status: 'pending_payment', actor: 'customer',
    note: `Checkout started with ${body.provider}`, data: { total_cents: q.total } });
  return { order, quote: q };
}

// ---- status changes ----
const MESSAGES = {
  invalid_transition: 'That status change is not allowed from the order’s current status.',
  carrier_and_tracking_required: 'Enter the carrier and tracking number to mark the order as dispatched.',
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
