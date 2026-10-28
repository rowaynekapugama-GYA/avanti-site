// What happens after an order changes status. Called only when the status really changed,
// so a webhook delivered twice never sends two emails.
//
// Email here must never block or undo an order: everything after the status change is wrapped
// in try/catch, problems are written to the order's timeline, and the change itself stands.
import { config, storageSign } from './core.js';
import { transition, loadOrder, recordCustomer } from './orders.js';
import { sendEmail, orderEmail, staffOrderEmail, customerNoteEmail } from './email.js';

// Staff can switch order emails off instantly in the dashboard (server-only flag "order_emails" = false).
// ORDER_EMAILS_ENABLED=false in Vercel switches them off too. If the flag can't be read, behave as before.
export async function orderEmailsOn(d, cfg = config()) {
  if (!cfg.email.ordersEnabled) return false;
  try { const r = await d.one('app_flags', 'select=value&key=eq.order_emails'); return !(r && r.value === false); }
  catch (e) { return true; }
}

// "Send Avanti a copy of every customer email" (on unless switched off in the dashboard), like
// WooCommerce, where the shop hears about every order change. The copy is its own email, so a bounce
// or spam report on Avanti's copy is never recorded against the customer.
export async function flag(d, key, fallback = true) {
  try { const r = await d.one('app_flags', `select=value&key=eq.${d.q(key)}`); return r ? r.value !== false : fallback; }
  catch (e) { return fallback; }
}
async function copyTo(d, o, cfg) {
  const to = cfg.email.adminNotify;
  if (!to || to === 'off' || to === String(o.email || '').toLowerCase()) return undefined;
  return (await flag(d, 'order_email_copies')) ? to : undefined;
}

// An email counts as already sent unless every earlier attempt failed.
async function alreadySent(d, orderId, template) {
  const rows = await d.select('email_log', `select=id&order_id=eq.${d.q(orderId)}&template=eq.${d.q(template)}&status=neq.failed&limit=1`);
  return rows.length > 0;
}
const timelineNote = (d, o, note) => d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: 'system', note });

// The customer's email for a status (paid = order confirmation). force = the "Resend email" button.
export async function sendOrderEmail(d, o, status, { force = false, cfg = config() } = {}) {
  const m = orderEmail(status, o, cfg);
  if (!m) return { skipped: 'no email for this status' };
  const template = `order-${status}`;
  if (!force && await alreadySent(d, o.id, template)) return { skipped: 'already sent' };
  const r = await sendEmail(d, { kind: 'transactional', template, to: o.email, order_id: o.id, customer_id: o.customer_id, ...m }, cfg);
  if (r.status !== 'failed') await sendCopy(d, o, template, m, cfg);
  return r;
}
async function sendCopy(d, o, template, m, cfg) {
  try {
    const to = await copyTo(d, o, cfg);
    if (!to) return;
    await sendEmail(d, { kind: 'transactional', template: `copy-${template}`, to, order_id: o.id, replyTo: o.email,
      subject: `[Copy] ${m.subject}`, html: m.html, text: `Copy of the email sent to ${o.email}. Replying goes to the customer.\n\n${m.text}` }, cfg);
  } catch (err) { console.error('copy to Avanti failed', o.id, err); }
}

// A note typed by staff and sent to the customer. Every note is its own email (never deduplicated).
export async function sendCustomerNote(d, o, note, cfg = config()) {
  const m = customerNoteEmail(o, note, cfg);
  const r = await sendEmail(d, { kind: 'transactional', template: 'order-note', to: o.email, order_id: o.id, customer_id: o.customer_id, ...m }, cfg);
  if (r.status !== 'failed') await sendCopy(d, o, 'order-note', m, cfg);
  return r;
}

// The customer's uploaded artwork, with a 30-day download link for each file.
const ATTACH_LIMIT = 12 * 1024 * 1024, ATTACH_MAX = 6;   // attach up to 6 files totalling 12 MB (inbox limits are ~25 MB)
async function artworkFiles(o, cfg) {
  const list = [];
  for (const i of o.items || []) for (const f of (i.artwork && i.artwork.files) || []) if (f.path) list.push({ i, f });
  // links are made in parallel so a big order never holds up the payment
  return Promise.all(list.slice(0, 40).map(async ({ i, f }) => {
    let url = null;
    try { url = await storageSign(cfg, 'artwork', f.path, 30 * 86400); } catch (err) { console.error('artwork link failed', o.id, f.path, err.message); }
    return { item: i.name, side: f.side || 'Artwork', name: f.name || f.path.split('/').pop(), size: f.size || null, url };
  }));
}

export async function sendStaffAlert(d, o, { force = false, cfg = config() } = {}) {
  const to = cfg.email.adminNotify;
  if (!to || to === 'off') return { skipped: 'no staff address' };
  if (!force && await alreadySent(d, o.id, 'order-new-staff')) return { skipped: 'already sent' };
  let files = [];
  try { files = await artworkFiles(o, cfg); } catch (err) { console.error('artwork files', o.id, err); }
  const total = files.reduce((t, f) => t + (f.size || 0), 0);
  const canAttach = files.length > 0 && files.length <= ATTACH_MAX && files.every(f => f.url && f.size) && total <= ATTACH_LIMIT;
  const base = { kind: 'transactional', template: 'order-new-staff', to, order_id: o.id, replyTo: o.email };
  if (canAttach) {
    const r = await sendEmail(d, { ...base, ...staffOrderEmail(o, cfg, 'new', { files, attached: true }),
      attachments: files.map(f => ({ filename: f.name, path: f.url })) }, cfg);
    if (r.status !== 'failed') return r;
    console.error('staff alert with attachments failed, sending links only', o.id, r.error);   // fall back to links
    return sendEmail(d, { ...base, ...staffOrderEmail(o, cfg, 'new', { files, notAttached: 'failed' }) }, cfg);
  }
  return sendEmail(d, { ...base, ...staffOrderEmail(o, cfg, 'new', { files, notAttached: files.length ? 'size' : '' }) }, cfg);
}
async function sendFailedAlert(d, o, cfg) {
  const to = cfg.email.adminNotify;
  if (!to || to === 'off' || await alreadySent(d, o.id, 'order-failed-staff')) return null;
  return sendEmail(d, { kind: 'transactional', template: 'order-failed-staff', to, order_id: o.id, replyTo: o.email, ...staffOrderEmail(o, cfg, 'failed') }, cfg);
}

// opts.notify = false: staff unticked "Email the customer" for this change.
export async function afterTransition(d, orderId, from, to, cfg = config(), opts = {}, meta = {}) {
  let o = null;
  try {
    o = await loadOrder(d, orderId);
    if (!o) return;
    if (to === 'paid') await recordCustomer(d, o);
  } catch (err) {
    console.error('afterTransition: could not record the customer', orderId, err);
    if (o) await timelineNote(d, o, `Could not update the customer record: ${String(err.message).slice(0, 300)}`).catch(() => {});
  }
  if (!o) return;
  // an unpaid checkout that is cancelled: the customer isn't emailed. If Stripe or PayPal said the
  // payment failed, the Avanti team is told (WooCommerce's "Failed order" email); tidy-ups are silent.
  if (to === 'cancelled' && from === 'pending_payment') {
    if (!String(meta.actor || '').startsWith('webhook:')) return;
    try {
      if (!(await orderEmailsOn(d, cfg))) return;
      const r = await sendFailedAlert(d, o, cfg);
      if (r && r.status === 'failed') await timelineNote(d, o, `Payment-failed email to the Avanti team failed: ${String(r.error || '').slice(0, 300)}`);
    } catch (err) { console.error('afterTransition: failed-payment alert', orderId, err); }
    return;
  }
  try {
    if (!(await orderEmailsOn(d, cfg))) { await timelineNote(d, o, 'Order emails are switched off, so no email was sent.'); return; }
    if (opts.notify === false) await timelineNote(d, o, 'Customer was not emailed about this change.');
    else {
      const r = await sendOrderEmail(d, o, to, { cfg });
      if (r && r.status === 'failed') await timelineNote(d, o, `Email to the customer failed: ${String(r.error || '').slice(0, 300)}`);
    }
  } catch (err) {
    console.error('afterTransition: email failed', orderId, err);
    await timelineNote(d, o, `Email to the customer could not be sent: ${String(err.message).slice(0, 300)}`).catch(() => {});
  }
  // new paid order: let the Avanti team know (separately, so one failing never stops the other)
  if (to !== 'paid') return;
  try {
    if (!(await orderEmailsOn(d, cfg))) return;
    const r = await sendStaffAlert(d, o, { cfg });
    if (r && r.status === 'failed') await timelineNote(d, o, `New-order email to the Avanti team failed: ${String(r.error || '').slice(0, 300)}`);
  } catch (err) {
    console.error('afterTransition: staff alert failed', orderId, err);
    await timelineNote(d, o, `New-order email to the Avanti team could not be sent: ${String(err.message).slice(0, 300)}`).catch(() => {});
  }
}

// The status change is already saved by the time this runs, so nothing here may turn it into an error.
export const move = (d, orderId, to, actor, note, data, cfg = config(), opts = {}) =>
  transition(d, orderId, to, actor, note, data, { after: async (id, from, status, meta) => {
    try { await afterTransition(d, id, from, status, cfg, opts, meta || { actor }); }
    catch (err) { console.error('afterTransition failed', id, err); }
  } });

// Payment confirmed by the provider (webhook or server-side capture). Checks the amount matches.
export async function markPaid(d, order, { actor, providerRef, providerStatus, amountCents }, cfg = config()) {
  if (amountCents != null && amountCents !== order.total_cents) {
    await d.insert('order_events', { order_id: order.id, from_status: order.status, to_status: order.status, actor,
      note: `Payment amount ${amountCents} does not match order total ${order.total_cents}; not marked paid. Please check with the payment provider.` });
    return { changed: false, mismatch: true };
  }
  return move(d, order.id, 'paid', actor, null, { provider_ref: providerRef || '', provider_status: providerStatus || 'paid' }, cfg);
}
