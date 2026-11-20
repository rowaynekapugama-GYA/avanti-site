// Refunds: made from the dashboard (Stripe Refunds API / PayPal capture refund), or made directly in Stripe or
// PayPal and reported by their webhooks. Every refund is a row in "refunds"; the order's refunded total is the
// sum of the succeeded ones, so nothing is ever counted twice. A refund never gives a discount code's use back.
import crypto from 'node:crypto';
import { config, HttpError, dollars, money } from './core.js';
import { loadOrder } from './orders.js';
import { sendEmail, refundEmail } from './email.js';
import { ensureAdjustment, methodLabel } from './invoices.js';

export const REASONS = ['Order cancelled', 'Reprint or fault', 'Duplicate payment', 'Other'];
const missing = e => ['PGRST205', '42P01', '42703', 'PGRST204'].includes(e && e.code) || /(could not find the table|does not exist|schema cache)/i.test(String(e && e.message));

export async function refundsReady(d, cfg) {
  if (!cfg.refunds.enabled) return false;
  try { await d.select('refunds', 'select=id&limit=1'); return true; }
  catch (e) { if (missing(e)) return false; throw e; }
}

const note = (d, o, text, actor = 'system') => d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor, note: text }).catch(() => {});
export const left = o => o.total_cents - (o.refunded_cents || 0);
// Why an order can't be refunded from the dashboard (null = it can). ctx.recorded: refunds already counted here;
// ctx.providerRefunded: Stripe or PayPal says the payment already has a refund.
export const LEGACY = 'This order was refunded in Stripe or PayPal before refunds were recorded here, so the amounts aren\'t known. Please make any further refund in Stripe or PayPal directly.';
export function refundBlock(o, cfg, ctx = {}) {
  if (!o.paid_at) return 'This order hasn\'t been paid, so there\'s nothing to refund.';
  if (!o.provider_ref || !['stripe', 'paypal', 'simulator'].includes(o.provider))
    return 'This order has no saved payment reference, so it can\'t be refunded here. Please refund it in Stripe or PayPal directly.';
  if (o.provider === 'simulator' && !cfg.simulator) return 'This was a test payment, so there is nothing to refund.';
  if (o.provider === 'stripe' && !cfg.stripe.secret) return 'Stripe isn\'t connected on this site, so please refund it in the Stripe dashboard.';
  if (o.provider === 'paypal' && !(cfg.paypal.clientId && cfg.paypal.secret)) return 'PayPal isn\'t connected on this site, so please refund it in PayPal.';
  if (!ctx.recorded && (o.status === 'refunded' || o.refunded_at || ctx.providerRefunded)) return LEGACY;
  return null;
}
const NAME = p => p === 'paypal' ? 'PayPal' : p === 'stripe' ? 'Stripe' : 'the payment provider';
export const UNCONFIRMED = p => `The refund was sent to ${NAME(p)}, but no clear answer came back, so we can't tell yet whether it went through. Please don't refund again. Press Check refund on the order (it's safe to press more than once).`;
const STRIPE_KEY_HOURS = 23;   // Stripe keeps an idempotency key for at least 24 hours
const PAYPAL_KEY_HOURS = 6;    // kept short on purpose: well inside the time PayPal keeps a PayPal-Request-Id
const ageHours = r => (Date.now() - new Date(r.created_at).getTime()) / 3600000;

// ---------- providers ----------
async function stripeApi(cfg, method, path, params, idem, timeout = 15000) {
  const body = params ? new URLSearchParams(Object.entries(params).flatMap(([k, v]) => v && typeof v === 'object'
    ? Object.entries(v).map(([k2, v2]) => [`${k}[${k2}]`, String(v2)]) : v == null ? [] : [[k, String(v)]])).toString() : undefined;
  const r = await fetch(`${cfg.stripe.apiBase}${path}`, { method, body, signal: AbortSignal.timeout(timeout),
    headers: { Authorization: `Bearer ${cfg.stripe.secret}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) } });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
let ppTok = null;
// notSent: the request never left (no PayPal sign-in), so nothing can have been refunded.
async function paypalApi(cfg, method, path, body, requestId, timeout = 15000) {
  if (!ppTok || ppTok.exp < Date.now()) {
    let t, j = {};
    try {
      t = await fetch(`${cfg.paypal.apiBase}/v1/oauth2/token`, { method: 'POST', body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.paypal.clientId}:${cfg.paypal.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' } });
      j = await t.json().catch(() => ({}));
    } catch { return { ok: false, status: 0, notSent: true, data: { message: 'Could not connect to PayPal.' } }; }
    if (!t.ok || !j.access_token) return { ok: false, status: t.status, notSent: true, data: { message: 'Could not connect to PayPal.' } };
    ppTok = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 300) - 60) * 1000 };
  }
  const r = await fetch(`${cfg.paypal.apiBase}${path}`, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
    headers: { Authorization: `Bearer ${ppTok.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) } });
  if (r.status === 401) ppTok = null;
  const text = await r.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch {}
  return { ok: r.ok, status: r.status, data };
}
// The provider's reason for refusing, in plain words.
export function plainProviderError(provider, data = {}) {
  if (provider === 'stripe') {
    const e = data.error || {}, code = e.code || '';
    if (code === 'charge_already_refunded') return 'Stripe says this payment has already been refunded in full.';
    if (code === 'amount_too_large') return 'Stripe says that is more than is left to refund on this payment.';
    if (/insufficient|balance/i.test(code + e.message)) return 'Stripe couldn\'t make the refund because there isn\'t enough balance in the Stripe account. Add funds in Stripe or try again later.';
    if (code === 'charge_disputed') return 'This payment is disputed (a chargeback), so Stripe won\'t refund it. Check the dispute in Stripe.';
    if (/permission/i.test(String(e.message))) return 'The Stripe key on this site isn\'t allowed to make refunds (a restricted key needs Refunds: Write). Nothing was refunded.';
    return `Stripe couldn't make the refund: ${String(e.message || 'no reason given').slice(0, 300)}`;
  }
  const issue = (data.details && data.details[0] && (data.details[0].issue || data.details[0].description)) || data.name || '';
  if (/REFUND_TIME_LIMIT_EXCEEDED|TIME_LIMIT/i.test(issue)) return 'PayPal won\'t refund this payment any more because more than 180 days have passed. Arrange the refund another way.';
  if (/INSUFFICIENT_FUNDS|INSUFFICIENT/i.test(issue)) return 'PayPal couldn\'t make the refund because there isn\'t enough money in the PayPal balance or linked account.';
  if (/CAPTURE_FULLY_REFUNDED|ALREADY_REFUNDED/i.test(issue)) return 'PayPal says this payment has already been refunded in full.';
  if (/REFUND_AMOUNT_EXCEEDED|AMOUNT_EXCEEDED/i.test(issue)) return 'PayPal says that is more than is left to refund on this payment.';
  if (/TRANSACTION_REFUSED|REFUND_NOT_ALLOWED|PERMISSION_DENIED|NOT_AUTHORIZED/i.test(issue)) return 'PayPal refused the refund. Check the payment in PayPal; it may be on hold or disputed.';
  return `PayPal couldn't make the refund: ${String((data.details && data.details[0] && data.details[0].description) || data.message || issue || 'no reason given').slice(0, 300)}`;
}
const stripeStatus = s => s === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(s) ? 'failed' : 'pending';
const paypalStatus = s => s === 'COMPLETED' ? 'succeeded' : ['FAILED', 'CANCELLED'].includes(s) ? 'failed' : 'pending';
// Only a clear refusal counts as failed (nothing was refunded). A timeout, no connection, a server error, "too many
// requests" or "already in progress" is unknown: the refund may have gone through, so it is checked, never retried blind.
const refused = st => st >= 400 && st < 500 && ![408, 409, 425, 429].includes(st);

async function sendToProvider(cfg, o, row) {
  try {
    if (o.provider === 'stripe') {
      const { ok, status, data } = await stripeApi(cfg, 'POST', '/v1/refunds', {
        payment_intent: o.provider_ref, amount: row.amount_cents, reason: row.reason === 'Duplicate payment' ? 'duplicate' : 'requested_by_customer',
        metadata: { refund_id: row.id, order_id: o.id, order_number: o.number } }, `refund-${row.id}`);
      if (!ok) return refused(status) && data.error ? { status: 'failed', failure: plainProviderError('stripe', data) } : { status: 'unknown', failure: `Stripe replied ${status}` };
      if (!data.id) return { status: 'unknown', failure: 'Stripe sent an empty reply' };
      return { status: stripeStatus(data.status), id: data.id, failure: data.status === 'failed' ? plainProviderError('stripe', { error: { message: data.failure_reason } }) : null };
    }
    if (o.provider === 'paypal') {
      const { ok, status, data, notSent } = await paypalApi(cfg, 'POST', `/v2/payments/captures/${encodeURIComponent(o.provider_ref)}/refund`, {
        amount: { currency_code: 'AUD', value: dollars(row.amount_cents) }, custom_id: row.id,
        note_to_payer: `Refund for order ${o.number}`.slice(0, 255) }, `refund-${row.id}`);
      if (notSent) return { status: 'failed', failure: 'Couldn\'t connect to PayPal, so nothing was sent and nothing was refunded. Please try again in a few minutes.' };
      if (!ok) return refused(status) ? { status: 'failed', failure: plainProviderError('paypal', data) } : { status: 'unknown', failure: `PayPal replied ${status}` };
      if (!data.id) return { status: 'unknown', failure: 'PayPal sent an empty reply' };
      return { status: paypalStatus(data.status), id: data.id };
    }
    if (o.provider === 'simulator' && cfg.simulator) return { status: 'succeeded', id: `sim_re_${crypto.randomUUID().slice(0, 12)}` };
    return { status: 'failed', failure: 'This payment method can\'t be refunded from the dashboard.' };
  } catch (e) {
    return { status: 'unknown', failure: `no reply (${String(e && e.message || e).slice(0, 120)})` };
  }
}

// Brings in refunds made directly in Stripe that haven't reached us (or were made before refunds were tracked),
// and for PayPal asks whether the payment already has a refund. Never throws; a provider that can't be reached
// just leaves things as they are.
export async function syncFromProvider(d, o, cfg = config(), { timeout = 5000 } = {}) {
  const out = { providerRefunded: false };
  try {
    if (o.provider === 'stripe' && cfg.stripe.secret && o.provider_ref) await stripeRefundEvent(d, o, o.provider_ref, cfg, timeout);
    else if (o.provider === 'paypal' && cfg.paypal.clientId && cfg.paypal.secret && o.provider_ref) {
      const { ok, data } = await paypalApi(cfg, 'GET', `/v2/payments/captures/${encodeURIComponent(o.provider_ref)}`, null, null, timeout);
      if (ok && ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(data.status)) out.providerRefunded = true;
    }
  } catch (e) { console.error('refund sync', o.id, e && e.message); }
  return out;
}
export async function refundContext(d, o, cfg = config(), opts) {
  const s = await syncFromProvider(d, o, cfg, opts);
  const rows = await d.select('refunds', `select=id,status,source,provider_refund_id&order_id=eq.${d.q(o.id)}`);
  return { providerRefunded: s.providerRefunded, recorded: rows.some(r => r.status === 'succeeded'),
    unconfirmed: rows.find(r => r.source === 'dashboard' && r.status === 'pending' && !r.provider_refund_id) || null };
}

// ---------- dashboard refund ----------
// amountCents is checked here and again inside the database (with the order locked), never trusted from the browser.
export async function refundFromDashboard(d, { orderId, amountCents, full, reason, note: staffNote, notify, requestKey, admin }, cfg = config()) {
  let o = await loadOrder(d, orderId);
  if (!o) throw new HttpError(404, 'Order not found.');
  if (!REASONS.includes(reason)) throw new HttpError(400, 'Please choose a reason for the refund.');
  if (reason === 'Other' && !String(staffNote || '').trim()) throw new HttpError(400, 'Please add a note explaining the refund.');
  const key = requestKey ? String(requestKey).slice(0, 80) : null;
  const same = key ? await d.one('refunds', `select=*&request_key=eq.${d.q(key)}&order_id=eq.${d.q(o.id)}`) : null;
  if (!same) {
    const waiting = await d.select('refunds', `select=id,amount_cents&order_id=eq.${d.q(o.id)}&source=eq.dashboard&status=eq.pending&provider_refund_id=is.null`);
    const ctx = await refundContext(d, o, cfg);
    o = await loadOrder(d, orderId);   // the sync may have added refunds
    if (ctx.unconfirmed) throw new HttpError(409, UNCONFIRMED(o.provider), { refund_unconfirmed: true });
    // an earlier refund that hadn't been confirmed has just been settled by the sync: show staff before going on
    if (waiting.length) throw new HttpError(409, `An earlier refund of ${money(waiting[0].amount_cents)} that hadn't been confirmed has now been checked with ${NAME(o.provider)}. Please reload the order and look at the Refunds box before refunding again.`, { refund_unconfirmed: true });
    const block = refundBlock(o, cfg, ctx); if (block) throw new HttpError(409, block, { refund_blocked: true });
  }
  const available = left(o);
  if (!same && available <= 0) throw new HttpError(409, 'This order has already been refunded in full.');
  const amount = same ? same.amount_cents : full ? available : Number(amountCents);
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Please enter an amount to refund.');
  if (!same && amount > available) throw new HttpError(400, `You can refund at most ${money(available)} on this order.`);
  let row;
  try {
    row = await d.rpc('refund_reserve', { p_order: o.id, p_amount: amount, p_reason: reason, p_note: String(staffNote || '').trim().slice(0, 500) || null,
      p_notify: !!notify, p_admin: admin.id || null, p_admin_email: admin.email || null, p_key: key });
  } catch (e) {
    const m = /over_refund:(-?\d+)/.exec(e.message);
    if (m) throw new HttpError(409, `Someone else has just refunded part of this order. You can refund at most ${money(Math.max(0, +m[1]))} now. Please reload the order.`);
    if (/refund_unconfirmed/.test(e.message)) throw new HttpError(409, UNCONFIRMED(o.provider), { refund_unconfirmed: true });
    if (/legacy_refund/.test(e.message)) throw new HttpError(409, LEGACY, { refund_blocked: true });
    if (/no_payment_reference/.test(e.message)) throw new HttpError(409, refundBlock({ ...o, provider_ref: '' }, cfg), { refund_blocked: true });
    if (/not_paid/.test(e.message)) throw new HttpError(409, 'This order hasn\'t been paid, so there\'s nothing to refund.');
    if (e.code === '23505' || /duplicate key/i.test(e.message)) throw new HttpError(409, 'This refund was already sent. Please reload the order.');
    throw e;
  }
  if (Array.isArray(row)) row = row[0];
  // The same request sent twice: the first one stands. A first attempt still waiting for an answer is sent again
  // with the same key, which Stripe and PayPal treat as the same refund, so it can never be paid twice.
  if (row.status === 'failed') throw new HttpError(502, row.failure || 'That refund didn\'t go through, so nothing was refunded.', { refund_failed: true });
  if (row.status !== 'pending' || row.provider_refund_id) return { refund: row, repeated: true, order: await loadOrder(d, o.id) };
  return applyResult(d, o, row, await sendToProvider(cfg, o, row), cfg, admin.email || 'admin');
}

// What happens once Stripe or PayPal has answered (or not). Nothing after the provider call may throw a plain
// error: the refund may have gone through, so any trouble leaves it waiting for Check refund instead.
async function applyResult(d, o, row, res, cfg, actor) {
  const amount = row.amount_cents, unconfirmed = async why => {
    console.error('refund unconfirmed', row.id, why);
    await note(d, o, `Refund of ${money(amount)} sent to ${NAME(o.provider)} but not confirmed (${String(why).slice(0, 160)}). It isn't counted yet. Use Check refund before doing anything else.`, actor);
    return { refund: row, unconfirmed: true, message: UNCONFIRMED(o.provider), order: await loadOrder(d, o.id).catch(() => o) };
  };
  if (res.status === 'unknown') return unconfirmed(res.failure);
  let settled;
  try {
    settled = await d.rpc('refund_settle', { p_id: row.id, p_status: res.status, p_provider_refund_id: res.id || null, p_failure: res.failure || null });
    if (Array.isArray(settled)) settled = settled[0];
  } catch (e) { return unconfirmed(`${NAME(o.provider)} answered "${res.status}" but it couldn't be saved: ${e.message}`); }
  try {
    const why = `${row.reason}${row.note ? `: ${String(row.note).slice(0, 200)}` : ''}`;
    await note(d, o, res.status === 'failed' ? `Refund of ${money(amount)} failed: ${res.failure}`
      : `${res.status === 'succeeded' ? 'Refunded' : `Refund accepted by ${NAME(o.provider)}, still processing:`} ${money(amount)} (${why}).`, actor);
  } catch {}
  if (res.status === 'failed') throw new HttpError(502, res.failure, { refund_failed: true });
  if (settled.status === 'succeeded') await afterRefund(d, o.id, settled, cfg);
  return { refund: settled, order: await loadOrder(d, o.id).catch(() => o) };
}

// ---------- Check refund: settles a refund whose answer never came back, or one still processing ----------
// Stripe: looked up by our refund id (sent as metadata); if Stripe has no record it is sent again with the same
// key, which makes it once at most. PayPal: sent again with the same PayPal-Request-Id, which returns the first
// answer if PayPal got it. Past those windows staff confirm in PayPal and press "It wasn't refunded".
export async function checkRefund(d, { refundId, admin, notRefunded }, cfg = config()) {
  const row = await d.one('refunds', `select=*&id=eq.${d.q(refundId)}`);
  if (!row) throw new HttpError(404, 'Refund not found.');
  const o = await loadOrder(d, row.order_id), actor = (admin && admin.email) || 'admin';
  if (row.status !== 'pending') return { refund: row, order: o };
  if (row.provider_refund_id) {   // accepted, still processing: ask for its current status
    try {
      const r = o.provider === 'stripe' ? await stripeApi(cfg, 'GET', `/v1/refunds/${encodeURIComponent(row.provider_refund_id)}`)
        : await paypalApi(cfg, 'GET', `/v2/payments/refunds/${encodeURIComponent(row.provider_refund_id)}`);
      if (!r.ok) return { refund: row, order: o, message: `${NAME(o.provider)} didn't answer. Please try again in a few minutes.` };
      const st = o.provider === 'stripe' ? stripeStatus(r.data.status) : paypalStatus(r.data.status);
      if (st === 'pending') return { refund: row, order: o, message: `${NAME(o.provider)} is still processing this refund. It will update on its own when it's done.` };
      const res = await recordExternal(d, o, row.provider, row.provider_refund_id, row.amount_cents, st, row.id, cfg);
      return { refund: res.refund, order: await loadOrder(d, o.id) };
    } catch (e) { return { refund: row, order: o, message: `Couldn't reach ${NAME(o.provider)}. Please try again in a few minutes.` }; }
  }
  if (row.source !== 'dashboard') return { refund: row, order: o };
  if (o.provider === 'stripe') {
    let found;
    try {
      const { ok, data } = await stripeApi(cfg, 'GET', `/v1/refunds?payment_intent=${encodeURIComponent(o.provider_ref)}&limit=100`);
      if (!ok) throw new Error('list failed');
      found = (data.data || []).find(r => r.metadata && r.metadata.refund_id === row.id);
    } catch { return { refund: row, order: o, message: 'Couldn\'t reach Stripe. Please try again in a few minutes.' }; }
    if (found) return applyResult(d, o, row, { status: stripeStatus(found.status), id: found.id }, cfg, actor);
    if (ageHours(row) < STRIPE_KEY_HOURS) return applyResult(d, o, row, await sendToProvider(cfg, o, row), cfg, actor);
    return applyResult(d, o, row, { status: 'failed', failure: 'Stripe has no record of this refund, so nothing was refunded.' }, cfg, actor).catch(e => {
      if (e instanceof HttpError) return { refund: { ...row, status: 'failed' }, order: o, message: e.message }; throw e; });
  }
  if (o.provider === 'paypal') {
    if (ageHours(row) < PAYPAL_KEY_HOURS) return applyResult(d, o, row, await sendToProvider(cfg, o, row), cfg, actor);
    if (!notRefunded) return { refund: row, order: o, manual: true,
      message: 'This is too old to check automatically. In PayPal, open Activity and find this payment. If the refund is there, it will be matched when PayPal tells the site. If it isn\'t there, press "It wasn\'t refunded".' };
    return applyResult(d, o, row, { status: 'failed', failure: `Marked as not refunded by ${actor} after checking PayPal.` }, cfg, actor).catch(e => {
      if (e instanceof HttpError) return { refund: { ...row, status: 'failed' }, order: o, message: 'Marked as not refunded. You can refund it again now.' }; throw e; });
  }
  if (o.provider === 'simulator') return applyResult(d, o, row, await sendToProvider(cfg, o, row), cfg, actor);
  return { refund: row, order: o };
}

// ---------- after a refund has gone through (dashboard or webhook) ----------
// Fully refunded orders move to Refunded (a cancelled order stays Cancelled). For a dashboard refund that's quiet:
// the refund email below is the customer's message. A refund made directly in Stripe or PayPal sends the usual
// "refunded" status email, as before. Then the adjustment note, then the refund email if staff ticked it. Never throws.
export async function afterRefund(d, orderId, refund, cfg = config(), { move } = {}) {
  try {
    let o = await loadOrder(d, orderId);
    if (!o) return;
    if ((o.refunded_cents || 0) >= o.total_cents && ['paid', 'in_production', 'dispatched', 'delivered'].includes(o.status)) {
      const mv = move || (await import('./effects.js')).move;
      const direct = refund.source && refund.source !== 'dashboard';
      await mv(d, o.id, 'refunded', direct ? `webhook:${refund.source}` : 'system', direct ? `Refunded in ${NAME(refund.source)}` : 'Refunded in full', {}, cfg, { quiet: !direct });
      o = await loadOrder(d, orderId);
    }
    let adj = { ok: false };
    try { adj = await ensureAdjustment(d, o, refund, cfg); }
    catch (e) { console.error('adjustment note', refund.id, e); await note(d, o, `Adjustment note could not be created: ${String(e.message).slice(0, 200)}`); }
    const r = adj.ok ? adj.refund : refund;
    if (!r.notify_customer || r.email_sent_at) return;
    const claimed = await d.update('refunds', `id=eq.${d.q(r.id)}&email_sent_at=is.null`, { email_sent_at: new Date().toISOString() });
    if (!claimed.length) return;
    let pdf = r._pdf;
    if (!pdf && r.adjustment_pdf_path) { try { pdf = await (await import('./core.js')).storageDownload(cfg, 'invoices', r.adjustment_pdf_path); } catch {} }
    const msg = refundEmail(o, r, cfg, { method: methodLabel(o) === 'PayPal' ? 'PayPal account' : 'card', attached: !!pdf });
    const sent = await sendEmail(d, { kind: 'transactional', template: 'refund', to: o.email, order_id: o.id, ...msg,
      attachments: pdf ? [{ filename: `Adjustment note ${r.adjustment_number}.pdf`, content: pdf.toString('base64') }] : undefined }, cfg);
    if (sent && sent.status === 'failed') { await d.update('refunds', `id=eq.${d.q(r.id)}`, { email_sent_at: null }); await note(d, o, `Refund email to the customer failed: ${String(sent.error || '').slice(0, 200)}`); }
    else await note(d, o, `Refund confirmation emailed to ${o.email}.`);
  } catch (e) { console.error('afterRefund', orderId, e); }
}

// ---------- refunds reported by webhooks ----------
async function recordExternal(d, o, provider, providerRefundId, amount, status, ourId, cfg) {
  let res = await d.rpc('refund_external', { p_order: o.id, p_provider: provider, p_provider_refund_id: providerRefundId, p_amount: amount, p_status: status,
    p_our_id: ourId && /^[0-9a-f-]{36}$/i.test(ourId) ? ourId : null });
  if (Array.isArray(res)) res = res[0];
  const r = res.refund;
  if (res.added) await note(d, o, `${status === 'succeeded' ? 'Refund' : status === 'failed' ? 'Failed refund' : 'Pending refund'} of ${money(amount)} made directly in ${NAME(provider)}.`, `webhook:${provider}`);
  if (res.was === 'succeeded' && r.status === 'failed')
    await note(d, o, `${NAME(provider)} now says the refund of ${money(r.amount_cents)} failed, so it is no longer counted.${r.adjustment_number ? ` Adjustment note ${r.adjustment_number} was already issued; let the customer know if needed.` : ''}`, `webhook:${provider}`);
  if (r.status === 'succeeded' && res.was !== 'succeeded') await afterRefund(d, o.id, r, cfg);
  return res;
}
// Stripe: charge.refunded / refund.created / refund.updated. The refunds are read back from Stripe for the
// payment (the event alone may not list them), and each is recorded once.
export async function stripeRefundEvent(d, o, paymentIntent, cfg = config(), timeout) {
  const { ok, data } = await stripeApi(cfg, 'GET', `/v1/refunds?payment_intent=${encodeURIComponent(paymentIntent)}&limit=100`, null, null, timeout);
  if (!ok) throw new Error(`Stripe refunds list failed: ${(data.error && data.error.message) || 'error'}`);
  for (const r of data.data || []) await recordExternal(d, o, 'stripe', r.id, r.amount, stripeStatus(r.status), r.metadata && r.metadata.refund_id, cfg);
}
// PayPal: PAYMENT.CAPTURE.REFUNDED (the event resource is the refund itself; custom_id is our refund id when
// the refund was made from the dashboard).
export async function paypalRefundEvent(d, o, refund, cfg = config()) {
  const amount = Math.round(Number(refund.amount && refund.amount.value) * 100);
  if (!refund.id || !(amount > 0)) return;
  await recordExternal(d, o, 'paypal', refund.id, amount, paypalStatus(refund.status || 'COMPLETED'), refund.custom_id, cfg);
}
