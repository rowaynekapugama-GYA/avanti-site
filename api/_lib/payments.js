// Stripe Checkout and PayPal Orders v2, over their REST APIs.
import crypto from 'node:crypto';
import { HttpError, dollars } from './core.js';

// ---------------- Stripe ----------------
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}
async function stripe(cfg, method, path, params, idempotencyKey) {
  const r = await fetch(`${cfg.stripe.apiBase}${path}`, {
    method, body: params ? form(params) : undefined,
    headers: { Authorization: `Bearer ${cfg.stripe.secret}`, 'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) } });
  const data = await r.json();
  if (!r.ok) throw new HttpError(502, 'Card payment could not be started. Please try again or choose PayPal.', { provider_error: data.error && data.error.message });
  return data;
}

export async function stripeCheckout(cfg, order, q) {
  const items = q.lines.map(l => ({
    quantity: l.qty,
    price_data: { currency: 'aud', unit_amount: l.unit_cents,
      product_data: { name: l.name.slice(0, 250), description: Object.values(l.options).join(' · ').slice(0, 500) || undefined } },
  }));
  if (q.deliveryCents > 0) items.push({ quantity: 1, price_data: { currency: 'aud', unit_amount: q.deliveryCents, product_data: { name: 'Delivery', description: q.deliveryMethod || undefined } } });
  const back = `${cfg.siteUrl}/#/order/${order.id}?t=${order.public_token}`;
  const session = await stripe(cfg, 'POST', '/v1/checkout/sessions', {
    mode: 'payment', currency: 'aud', customer_email: order.email, client_reference_id: order.id,
    line_items: Object.fromEntries(items.map((it, i) => [i, it])),
    metadata: { order_id: order.id, order_number: order.number },
    payment_intent_data: { metadata: { order_id: order.id, order_number: order.number }, description: `Order ${order.number}` },
    success_url: `${back}&paid=1`, cancel_url: `${cfg.siteUrl}/#/checkout?cancelled=1`,
    locale: 'en',
  }, `checkout-${order.id}`);
  return { sessionId: session.id, url: session.url };
}

// Stripe-Signature: t=timestamp,v1=hex(HMAC-SHA256(secret, `${t}.${rawBody}`))
export function stripeSign(raw, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
export function stripeVerify(raw, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!secret) throw new HttpError(500, 'Webhook secret is not configured');
  const parts = Object.create(null);
  String(header || '').split(',').forEach(p => { const [k, v] = p.split('='); (parts[k] = parts[k] || []).push(v); });
  const t = Number((parts.t || [])[0]);
  if (!t || !parts.v1) throw new HttpError(400, 'Missing signature');
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new HttpError(400, 'Signature timestamp outside tolerance');
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'));
  const ok = parts.v1.some(v => { const b = Buffer.from(v || ''); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new HttpError(400, 'Invalid signature');
  return JSON.parse(raw);
}

// ---------------- PayPal ----------------
let ppToken = null;
async function paypalToken(cfg) {
  if (ppToken && ppToken.base === cfg.paypal.apiBase && ppToken.exp > Date.now() + 60000) return ppToken.value;
  const r = await fetch(`${cfg.paypal.apiBase}/v1/oauth2/token`, { method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.paypal.clientId}:${cfg.paypal.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' } });
  const data = await r.json();
  if (!r.ok) throw new HttpError(502, 'PayPal is not available right now. Please try again or pay by card.');
  ppToken = { value: data.access_token, exp: Date.now() + (data.expires_in || 3000) * 1000, base: cfg.paypal.apiBase };
  return ppToken.value;
}
async function paypal(cfg, method, path, body, requestId) {
  const r = await fetch(`${cfg.paypal.apiBase}${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${await paypalToken(cfg)}`, 'Content-Type': 'application/json', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) } });
  const text = await r.text(); const data = text ? JSON.parse(text) : {};
  return { ok: r.ok, status: r.status, data };
}

export async function paypalCheckout(cfg, order, q) {
  const items = q.lines.map(l => ({ name: l.name.slice(0, 127), quantity: String(l.qty), category: 'PHYSICAL_GOODS',
    description: Object.values(l.options).join(' · ').slice(0, 127) || undefined,
    unit_amount: { currency_code: 'AUD', value: dollars(l.unit_cents) } }));
  const ret = `${cfg.siteUrl}/api/checkout?action=paypal-return&order=${order.id}`;
  const { ok, data } = await paypal(cfg, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: order.number, custom_id: order.id, invoice_id: order.number, description: `Order ${order.number}`,
      amount: { currency_code: 'AUD', value: dollars(q.total), breakdown: {
        item_total: { currency_code: 'AUD', value: dollars(q.subtotal) }, shipping: { currency_code: 'AUD', value: dollars(q.deliveryCents) } } },
      items }],
    payment_source: { paypal: { experience_context: { brand_name: cfg.brand.slice(0, 127), user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING',
      locale: 'en-AU', return_url: ret, cancel_url: `${cfg.siteUrl}/#/checkout?cancelled=1` } } },
  }, `order-${order.id}`);
  if (!ok) throw new HttpError(502, 'PayPal is not available right now. Please try again or pay by card.');
  const link = (data.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
  return { sessionId: data.id, url: link && link.href };
}

// Capture after the customer approves. Safe to call twice: an already-captured order is read back.
export async function paypalCapture(cfg, ppOrderId, orderId) {
  let r = await paypal(cfg, 'POST', `/v2/checkout/orders/${encodeURIComponent(ppOrderId)}/capture`, {}, `capture-${orderId}`);
  if (!r.ok && r.status === 422) r = await paypal(cfg, 'GET', `/v2/checkout/orders/${encodeURIComponent(ppOrderId)}`);
  if (!r.ok) return { completed: false, status: 'ERROR' };
  const cap = r.data.purchase_units && r.data.purchase_units[0].payments && (r.data.purchase_units[0].payments.captures || [])[0];
  return { completed: !!cap && cap.status === 'COMPLETED', status: cap ? cap.status : r.data.status, captureId: cap && cap.id,
    amount: cap && cap.amount && cap.amount.value, customId: cap && cap.custom_id };
}

// PayPal verifies its own webhook signatures (certificate chain), so we ask it.
export async function paypalVerify(cfg, req, event) {
  const h = n => req.headers.get(n);
  const { ok, data } = await paypal(cfg, 'POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'),
    webhook_id: cfg.paypal.webhookId, webhook_event: event });
  if (!ok || data.verification_status !== 'SUCCESS') throw new HttpError(400, 'Invalid signature');
  return true;
}
