// /api/checkout?action=config|quote|create|status|paypal-return|simulate
import { config, db, handle, json, html, redirect, readJson, HttpError, escHtml as e, money, clientIp } from './_lib/core.js';
import { quote, createPendingOrder, loadOrder } from './_lib/orders.js';
import { stripeCheckout, paypalCheckout, paypalCapture, stripeSign } from './_lib/payments.js';
import { markPaid } from './_lib/effects.js';
import { receive } from './webhooks.js';

function providers(cfg) {
  const list = [];
  if (cfg.stripe.enabled) list.push({ id: 'stripe', label: 'Card, Apple Pay or Google Pay', test: cfg.stripe.testMode });
  if (cfg.paypal.enabled) list.push({ id: 'paypal', label: 'PayPal', test: cfg.paypal.env !== 'live' });
  if (cfg.simulator) list.push({ id: 'simulator', label: 'Test payment (no money changes hands)', test: true });
  return list;
}

export const GET = handle(async (req) => {
  const cfg = config(), u = new URL(req.url), action = u.searchParams.get('action');
  if (action === 'config') return json({ providers: cfg.supabaseUrl && cfg.serviceKey ? providers(cfg) : [], currency: 'AUD' });

  if (action === 'status') {
    const d = db(cfg), o = await loadOrder(d, u.searchParams.get('id') || '');
    if (!o || o.public_token !== u.searchParams.get('t')) throw new HttpError(404, 'Order not found.');
    const { trackingUrl } = await import('./_lib/email.js');
    return json({ number: o.number, status: o.status, email: o.email, created_at: o.created_at, paid_at: o.paid_at,
      items: o.items.map(i => ({ name: i.name, options: i.options, qty: i.qty, line_cents: i.line_cents, artwork_later: !!(i.artwork && i.artwork.later) })),
      subtotal_cents: o.subtotal_cents, delivery_cents: o.delivery_cents, delivery_method: o.delivery_method, total_cents: o.total_cents, gst_cents: o.gst_cents,
      delivery_quote_required: o.delivery_quote_required, carrier: o.carrier, tracking_number: o.tracking_number, tracking_url: trackingUrl(o) || null });
  }

  // PayPal sends the customer back here after they approve. We capture server-side; the payment
  // only counts once PayPal confirms the capture (and the webhook would do the same if this fails).
  if (action === 'paypal-return') {
    const d = db(cfg), o = await loadOrder(d, u.searchParams.get('order') || '');
    if (!o) return redirect(`${cfg.siteUrl}/#/checkout?cancelled=1`);
    const page = `${cfg.siteUrl}/#/order/${o.id}?t=${o.public_token}&paid=1`;
    if (o.status !== 'pending_payment' || u.searchParams.get('token') !== o.provider_session_id) return redirect(page);
    const cap = await paypalCapture(cfg, o.provider_session_id, o.id);
    if (cap.completed) await markPaid(d, o, { actor: 'paypal:capture', providerRef: cap.captureId, providerStatus: cap.status, amountCents: Math.round(Number(cap.amount) * 100) }, cfg);
    else await d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: 'paypal:capture', note: `PayPal capture not completed (${cap.status})` });
    return redirect(page);
  }

  if (action === 'simulate') {
    if (!cfg.simulator) throw new HttpError(404, 'Not found');
    const d = db(cfg), o = await loadOrder(d, u.searchParams.get('order') || '');
    if (!o || o.public_token !== u.searchParams.get('t')) throw new HttpError(404, 'Order not found.');
    return html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test payment</title>
<body style="font-family:system-ui,sans-serif;background:#f4f2ee;margin:0;padding:40px 16px"><div style="max-width:440px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.08)">
<p style="margin:0 0 6px;font:600 12px monospace;color:#C41E2A;letter-spacing:.08em">TEST PAYMENT · NO MONEY CHANGES HANDS</p>
<h1 style="margin:0 0 6px;font-size:22px">Order ${e(o.number)}</h1><p style="margin:0 0 18px;color:#555">${e(o.email)}</p>
<p style="font-size:28px;font-weight:700;margin:0 0 22px">${money(o.total_cents)} <small style="font-size:14px;color:#777">AUD</small></p>
<form method="post" action="/api/checkout?action=simulate&order=${o.id}&t=${o.public_token}" style="display:flex;gap:10px">
<button name="result" value="paid" style="flex:1;padding:12px;border:0;border-radius:999px;background:#C41E2A;color:#fff;font-weight:700;cursor:pointer">Pay (test)</button>
<button name="result" value="declined" style="flex:1;padding:12px;border:1px solid #ccc;border-radius:999px;background:#fff;cursor:pointer">Decline</button></form>
<p style="font-size:13px;color:#777;margin:18px 0 0">This page stands in for Stripe or PayPal on the staging site. Paying sends a signed payment webhook to the shop, exactly as Stripe would, and the order is marked paid only when that webhook is accepted.</p></div></body>`);
  }
  throw new HttpError(404, 'Unknown action');
});

export const POST = handle(async (req) => {
  const cfg = config(), u = new URL(req.url), action = u.searchParams.get('action');

  if (action === 'quote') {
    const body = await readJson(req);
    const q = await quote(db(cfg), body);
    return json({ lines: q.lines.map(l => ({ slug: l.product_slug, name: l.name, qty: l.qty, unit_cents: l.unit_cents, line_cents: l.line_cents })),
      delivery: q.delivery, delivery_cents: q.deliveryCents, subtotal_cents: q.subtotal, total_cents: q.total, gst_cents: q.gst, quote_required: q.quoteRequired });
  }

  if (action === 'create') {
    const body = await readJson(req);
    const available = providers(cfg).map(p => p.id);
    if (!available.includes(body.provider)) throw new HttpError(400, 'Please choose a payment method.');
    const d = db(cfg);
    const { order, quote: q } = await createPendingOrder(d, body);
    let session;
    if (body.provider === 'stripe') session = await stripeCheckout(cfg, order, q);
    else if (body.provider === 'paypal') session = await paypalCheckout(cfg, order, q);
    else session = { sessionId: `sim_${order.id}`, url: `${cfg.siteUrl}/api/checkout?action=simulate&order=${order.id}&t=${order.public_token}` };
    await d.update('orders', `id=eq.${order.id}`, { provider_session_id: session.sessionId });
    return json({ order_id: order.id, number: order.number, token: order.public_token, redirect_url: session.url }, 201);
  }

  if (action === 'simulate') {
    if (!cfg.simulator) throw new HttpError(404, 'Not found');
    const d = db(cfg), o = await loadOrder(d, u.searchParams.get('order') || '');
    if (!o || o.public_token !== u.searchParams.get('t')) throw new HttpError(404, 'Order not found.');
    const form = new URLSearchParams(await req.text());
    if (form.get('result') !== 'paid') return redirect(`${cfg.siteUrl}/#/checkout?cancelled=1`);
    // Build the same event Stripe would send, sign it, and hand it to the real webhook handler.
    const event = { id: `evt_sim_${o.id}`, type: 'checkout.session.completed', data: { object: {
      id: o.provider_session_id, object: 'checkout.session', client_reference_id: o.id, metadata: { order_id: o.id, order_number: o.number },
      payment_status: 'paid', payment_intent: `pi_sim_${o.id.slice(0, 8)}`, amount_total: o.total_cents, currency: 'aud' } } };
    const raw = JSON.stringify(event);
    await receive('simulator', new Request(`${cfg.siteUrl}/api/webhooks?provider=simulator`, { method: 'POST', body: raw,
      headers: { 'stripe-signature': stripeSign(raw, cfg.simulatorSecret), 'x-forwarded-for': clientIp(req) || '' } }));
    return redirect(`${cfg.siteUrl}/#/order/${o.id}?t=${o.public_token}&paid=1`);
  }
  throw new HttpError(404, 'Unknown action');
});
