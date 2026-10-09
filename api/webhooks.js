// /api/webhooks?provider=stripe|paypal|resend   (vercel.json also maps /api/webhooks/<provider>)
// Order state is driven only from here (and the server-side PayPal capture), never from the
// browser landing on a "thank you" page.
import { config, db, json, HttpError } from './_lib/core.js';
import { stripeVerify, paypalVerify, paypalCapture } from './_lib/payments.js';
import { svixVerify } from './_lib/email.js';
import { markPaid, move } from './_lib/effects.js';
import { suppress, unsubscribe } from './_lib/marketing.js';

async function claim(d, provider, id, type, payload) {
  const rows = await d.insert('webhook_events', { provider, event_id: id, type, payload }, { onConflict: 'provider,event_id', ignore: true });
  if (rows.length) return rows[0];
  const prev = await d.one('webhook_events', `select=*&provider=eq.${provider}&event_id=eq.${d.q(id)}`);
  return prev && (prev.status === 'processed' || prev.status === 'ignored') ? null : prev;   // null = already handled
}
const note = (d, o, actor, text) => d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor, note: text });
// Only our own order ids (UUIDs) are looked up: the old WooCommerce site uses numbers, and
// those payments must be ignored rather than erroring (Stripe and PayPal retry errors for days).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orderBy = (d, col, val) => !val || (col === 'id' && !UUID_RE.test(String(val))) ? null : d.one('orders', `select=*&${col}=eq.${d.q(val)}`);

async function stripeEvent(d, ev, actor, cfg) {
  const obj = ev.data && ev.data.object || {};
  if (ev.type.startsWith('checkout.session.')) {
    // payments made on the old website (or anything else in the Stripe account) carry no order id of ours: ignored
    const o = await orderBy(d, 'id', (obj.metadata && obj.metadata.order_id) || obj.client_reference_id);
    if (!o) return 'ignored';
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      if (obj.payment_status !== 'paid') { await note(d, o, actor, 'Checkout completed; waiting for the payment to clear.'); return 'processed'; }
      await markPaid(d, o, { actor, providerRef: obj.payment_intent, providerStatus: 'paid', amountCents: obj.amount_total }, cfg);
      return 'processed';
    }
    if (ev.type === 'checkout.session.async_payment_failed') { if (o.status === 'pending_payment') await move(d, o.id, 'cancelled', actor, 'Payment failed', {}, cfg); return 'processed'; }
    if (ev.type === 'checkout.session.expired') { await note(d, o, actor, 'Checkout expired without payment.'); return 'processed'; }
  }
  if (ev.type === 'charge.refunded') {
    const o = await orderBy(d, 'provider_ref', obj.payment_intent);
    if (!o) return 'ignored';
    if (obj.refunded || obj.amount_refunded >= obj.amount) { if (o.status !== 'refunded') await move(d, o.id, 'refunded', actor, 'Refunded in Stripe', {}, cfg); }
    else await note(d, o, actor, `Partial refund of $${(obj.amount_refunded / 100).toFixed(2)} made in Stripe.`);
    return 'processed';
  }
  return 'ignored';
}

async function paypalEvent(d, ev, cfg) {
  const r = ev.resource || {}, actor = 'webhook:paypal';
  if (ev.event_type === 'CHECKOUT.ORDER.APPROVED') {   // customer approved but may have closed the tab before returning
    const o = await orderBy(d, 'id', r.purchase_units && r.purchase_units[0].custom_id);
    if (!o || o.status !== 'pending_payment') return 'ignored';
    const cap = await paypalCapture(cfg, r.id, o.id);
    if (cap.completed) await markPaid(d, o, { actor, providerRef: cap.captureId, providerStatus: cap.status, amountCents: Math.round(Number(cap.amount) * 100) }, cfg);
    return 'processed';
  }
  if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const o = await orderBy(d, 'id', r.custom_id);
    if (!o) return 'ignored';
    await markPaid(d, o, { actor, providerRef: r.id, providerStatus: r.status, amountCents: Math.round(Number(r.amount && r.amount.value) * 100) }, cfg);
    return 'processed';
  }
  if (ev.event_type === 'PAYMENT.CAPTURE.DENIED' || ev.event_type === 'PAYMENT.CAPTURE.DECLINED') {
    const o = await orderBy(d, 'id', r.custom_id);
    if (o && o.status === 'pending_payment') await move(d, o.id, 'cancelled', actor, 'PayPal payment declined', {}, cfg);
    return o ? 'processed' : 'ignored';
  }
  if (ev.event_type === 'PAYMENT.CAPTURE.REFUNDED' || ev.event_type === 'PAYMENT.CAPTURE.REVERSED') {
    const up = (r.links || []).find(l => l.rel === 'up'), capId = r.custom_id ? null : up && up.href.split('/').pop();
    const o = r.custom_id ? await orderBy(d, 'id', r.custom_id) : await orderBy(d, 'provider_ref', capId);
    if (!o) return 'ignored';
    const amt = Math.round(Number(r.amount && r.amount.value) * 100);
    if (ev.event_type === 'PAYMENT.CAPTURE.REFUNDED' && amt >= o.total_cents) { if (o.status !== 'refunded') await move(d, o.id, 'refunded', actor, 'Refunded in PayPal', {}, cfg); }
    else await note(d, o, actor, ev.event_type === 'PAYMENT.CAPTURE.REVERSED' ? 'PayPal payment reversed (chargeback). Check the PayPal dashboard.' : `Partial refund of $${(amt / 100).toFixed(2)} made in PayPal.`);
    return 'processed';
  }
  return 'ignored';
}

async function resendEvent(d, ev) {
  const x = ev.data || {}, log = x.email_id && await d.one('email_log', `select=*&provider_id=eq.${d.q(x.email_id)}`);
  if (!log) return 'ignored';
  const now = ev.created_at || new Date().toISOString(), patch = {};
  const rank = { queued: 0, sent: 1, delivery_delayed: 2, delivered: 3, bounced: 4, complained: 5, failed: 4, logged: 0 };
  const up = s => { if ((rank[s] || 0) >= (rank[log.status] || 0)) patch.status = s; };
  switch (ev.type) {
    case 'email.delivered': up('delivered'); patch.delivered_at = log.delivered_at || now; break;
    case 'email.delivery_delayed': up('delivery_delayed'); break;
    case 'email.bounced': {
      patch.status = 'bounced'; const b = x.bounce || {};
      patch.bounce_reason = [b.type, b.subType, b.message].filter(Boolean).join(': ').slice(0, 500) || 'Bounced';
      if (!b.type || /permanent|hard/i.test(b.type)) await suppress(d, log.to_email, `Hard bounce ${now.slice(0, 10)}`);
      break; }
    case 'email.complained': patch.status = 'complained';
      await suppress(d, log.to_email, `Spam complaint ${now.slice(0, 10)}`);
      try { const c = await d.one('customers', `select=id&email=eq.${d.q(log.to_email)}`); if (c) await unsubscribe(d, { customerId: c.id, source: 'Spam complaint', actor: 'system' }); } catch {}
      break;
    case 'email.opened': patch.opened_at = log.opened_at || now; break;
    case 'email.clicked': patch.clicked_at = log.clicked_at || now; patch.opened_at = log.opened_at || now; break;
    default: return 'ignored';
  }
  await d.update('email_log', `id=eq.${log.id}`, patch);
  return 'processed';
}

export async function receive(provider, req, cfg = config()) {
  const raw = await req.text(), d = db(cfg);
  let ev, id, type;
  if (provider === 'stripe' || provider === 'simulator') {
    if (provider === 'simulator' && !cfg.simulator) throw new HttpError(404, 'Not found');
    ev = stripeVerify(raw, req.headers.get('stripe-signature'), provider === 'stripe' ? cfg.stripe.webhookSecret : cfg.simulatorSecret);
    id = ev.id; type = ev.type;
  } else if (provider === 'paypal') {
    try { ev = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
    await paypalVerify(cfg, req, ev); id = ev.id; type = ev.event_type;
  } else if (provider === 'resend') {
    ev = svixVerify(raw, req.headers, cfg.email.webhookSecret); id = req.headers.get('svix-id'); type = ev.type;
  } else throw new HttpError(404, 'Unknown provider');

  const row = await claim(d, provider, id, type, ev);
  if (!row) return json({ received: true, duplicate: true });
  try {
    const result = provider === 'paypal' ? await paypalEvent(d, ev, cfg) : provider === 'resend' ? await resendEvent(d, ev)
      : await stripeEvent(d, ev, provider === 'simulator' ? 'webhook:simulator' : 'webhook:stripe', cfg);
    await d.update('webhook_events', `id=eq.${row.id}`, { status: result, processed_at: new Date().toISOString(), error: null });
    return json({ received: true, result });
  } catch (err) {
    await d.update('webhook_events', `id=eq.${row.id}`, { status: 'failed', error: String(err.message).slice(0, 500) });
    throw err;   // 500 makes the provider retry later
  }
}

export async function POST(req) {
  try { return await receive(new URL(req.url).searchParams.get('provider'), req); }
  catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e); return json({ error: 'Webhook processing failed' }, 500);
  }
}
