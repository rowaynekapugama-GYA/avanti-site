// API tests: checkout, webhooks, order states, emails, consent, campaigns, automations.
// Needs a Supabase database with the schema, migrations and seed loaded (a local copy is fine).
//   TEST_SUPABASE_URL=... TEST_SERVICE_KEY=... TEST_ANON_KEY=... TEST_ADMIN_EMAIL=... TEST_ADMIN_PASSWORD=...
//   TEST_EDITOR_EMAIL=... node --test tests/api.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startMocks } from './mock-providers.mjs';

const T = process.env;
const mocks = await startMocks();
Object.assign(process.env, {
  SITE_URL: 'https://shop.test', SUPABASE_URL: T.TEST_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: T.TEST_SERVICE_KEY, SUPABASE_ANON_KEY: T.TEST_ANON_KEY,
  STRIPE_SECRET_KEY: 'rk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test_stripe', STRIPE_API_BASE: mocks.url,
  PAYPAL_CLIENT_ID: 'pp-client', PAYPAL_CLIENT_SECRET: 'pp-secret', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_API_BASE: mocks.url,
  PAYMENTS_SIMULATOR: 'true', RESEND_API_KEY: 're_test_key', RESEND_API_BASE: mocks.url,
  RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.from('resend-test-secret-32-bytes-long!!').toString('base64'),
  CRON_SECRET: 'cron-test-secret', BUSINESS_ABN: '12 345 678 901', BUSINESS_ADDRESS: '1 Test St, Smithfield NSW 2164',
});
const checkout = await import('../api/checkout.js');
const webhooks = await import('../api/webhooks.js');
const admin = await import('../api/admin.js');
const emailApi = await import('../api/email.js');
const cron = await import('../api/cron.js');
const { stripeSign } = await import('../api/_lib/payments.js');
const { svixSign } = await import('../api/_lib/email.js');
const { db } = await import('../api/_lib/core.js');
const { loadCatalogue, unitCents } = await import('../api/_lib/orders.js');
const mk = await import('../api/_lib/marketing.js');
const d = db();

// ---------- helpers ----------
async function call(fn, path, { method = 'GET', body, headers = {}, form } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) { init.body = new URLSearchParams(form).toString(); init.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  else if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] = init.headers['content-type'] || 'application/json'; }
  const r = await fn(new Request('https://shop.test' + path, init));
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}
async function token(email, password) {
  const r = await fetch(`${T.TEST_SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST',
    headers: { apikey: T.TEST_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (await r.json()).access_token;
}
const auth = t => ({ authorization: `Bearer ${t}` });
async function reset() {
  for (const t of ['webhook_events', 'email_log', 'automation_sends', 'consent_log', 'order_events', 'order_items', 'orders', 'customers', 'campaigns', 'segments', 'audit_log'])
    await d.remove(t, ['webhook_events', 'order_events', 'order_items', 'consent_log', 'automation_sends', 'audit_log'].includes(t) ? 'id=gte.0' : 'id=not.is.null');
  await d.update('automation_flows', 'key=not.is.null', { enabled: false });
  for (const [key, delay_hours] of [['welcome', 0], ['abandoned_cart', 24], ['post_purchase', 1440], ['win_back', 4320]]) await d.update('automation_flows', `key=eq.${key}`, { delay_hours });
  await d.update('automation_flows', 'key=eq.post_purchase', { categories: ['mailer-boxes', 'shipping-cartons'] });
  mocks.state.emails.length = 0; mocks.state.stripeSessions.length = 0;
}
const CUSTOMER = { email: 'Jo.Buyer@Example.com', name: 'Jo Buyer', phone: '0400 000 000',
  address: { line1: '12 Print St', suburb: 'Smithfield', state: 'NSW', postcode: '2164' } };
const LINE_BANNER = { slug: 'pull-up-banner', qty: 5, opts: {}, price: 1 };           // tiered: 5+ at $108
const LINE_TOPPER = { slug: 'name-and-age-cake-topper', qty: 1, opts: { Name: 'Liam', Age: '21', Colour: 'Gold Mirror' } };
async function newOrder(provider = 'simulator', extra = {}) {
  const r = await call(checkout.POST, '/api/checkout?action=create', { method: 'POST', body: {
    provider, customer: CUSTOMER, lines: [LINE_BANNER], delivery: { 'pull-up-banners': 'Metro NSW delivery' }, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...r.data, row: await d.one('orders', `select=*&id=eq.${r.data.order_id}`) };
}
function stripeEvent(order, type = 'checkout.session.completed', obj = {}, id = `evt_${Math.random().toString(36).slice(2)}`) {
  const ev = { id, type, data: { object: { id: order.row.provider_session_id, client_reference_id: order.order_id, metadata: { order_id: order.order_id },
    payment_status: 'paid', payment_intent: `pi_${order.order_id.slice(0, 8)}`, amount_total: order.row.total_cents, ...obj } } };
  return JSON.stringify(ev);
}
const postStripe = (raw, sig) => call(webhooks.POST, '/api/webhooks?provider=stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': sig ?? stripeSign(raw, 'whsec_test_stripe') } });
const events = async id => d.select('order_events', `select=*&order_id=eq.${id}&order=id`);
const logs = async q => d.select('email_log', `select=*&${q}&order=created_at`);

let adminToken, editorToken;
before(async () => { await reset(); adminToken = await token(T.TEST_ADMIN_EMAIL, T.TEST_ADMIN_PASSWORD); editorToken = await token(T.TEST_EDITOR_EMAIL, T.TEST_ADMIN_PASSWORD); });
after(() => mocks.close());

// ======================= PR 1: pricing, checkout, payments =======================
test('server prices match the storefront for every product, option and quantity', async () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/storefront-prices.json', import.meta.url)));
  const cat = await loadCatalogue(d, cases.map(c => c.slug));
  const bad = cases.filter(c => unitCents(cat.products[c.slug], c.qty, c.opts) !== Math.round(c.price * 100));
  assert.equal(bad.length, 0, `mismatches: ${JSON.stringify(bad.slice(0, 3))}`);
  assert.ok(cases.length > 1000);
});

test('checkout config lists the enabled providers; restricted test keys count as test mode', async () => {
  const r = await call(checkout.GET, '/api/checkout?action=config');
  assert.deepEqual(r.data.providers.map(p => p.id), ['stripe', 'paypal', 'simulator']);
  assert.equal(r.data.providers[0].test, true);
});

test('checkout recalculates prices on the server and ignores prices sent by the browser', async () => {
  await reset();
  const o = await newOrder('simulator', { lines: [{ ...LINE_BANNER, unit_price: 0.01, price: 0.01 }] });
  assert.match(o.number, /^AVP-\d{4,}$/);
  assert.equal(o.row.status, 'pending_payment');
  assert.equal(o.row.subtotal_cents, 5 * 10800);             // 5+ tier
  assert.equal(o.row.delivery_cents, 3000);
  assert.equal(o.row.total_cents, 5 * 10800 + 3000);
  assert.equal(o.row.gst_cents, Math.round((5 * 10800 + 3000) / 11));
  assert.equal(o.row.email, 'jo.buyer@example.com');
  assert.match(o.redirect_url, /action=simulate/);
  const ev = await events(o.order_id);
  assert.equal(ev[0].to_status, 'pending_payment'); assert.equal(ev[0].actor, 'customer');
});

test('checkout rejects bad input with a plain message', async () => {
  const bad = async (body, re) => { const r = await call(checkout.POST, '/api/checkout?action=create', { method: 'POST', body: { provider: 'simulator', customer: CUSTOMER, lines: [LINE_BANNER], delivery: { 'pull-up-banners': 'Metro NSW delivery' }, ...body } });
    assert.equal(r.status, 400); assert.match(r.data.error, re); };
  await bad({ provider: 'bitcoin' }, /payment method/);
  await bad({ customer: { ...CUSTOMER, address: { ...CUSTOMER.address, postcode: '21' } } }, /postcode/);
  await bad({ customer: { ...CUSTOMER, email: 'nope' } }, /email/);
  await bad({ lines: [] }, /empty/);
  await bad({ lines: [{ slug: 'custom-branded-mailer-boxes', qty: 1, opts: { Material: 'Unobtainium' } }] }, /choose all options|not available/);
  await bad({ lines: [{ slug: 'no-such-product', qty: 1 }] }, /no longer available/);
  await bad({ delivery: {} }, /delivery option/);
});

test('items without a delivery rate are flagged for a quote', async () => {
  const q = await call(checkout.POST, '/api/checkout?action=quote', { method: 'POST', body: { lines: [{ slug: 'wallpaper-sample', qty: 1, opts: {} }, LINE_BANNER] } });
  assert.equal(q.status, 200, JSON.stringify(q.data)); assert.equal(q.data.quote_required, true); assert.equal(q.data.delivery.groups.length, 1);
});

test('Stripe: session created with the right amounts, then paid only by a signed webhook', async () => {
  await reset();
  const o = await newOrder('stripe', { lines: [LINE_BANNER, LINE_TOPPER], delivery: { 'pull-up-banners': 'Regional NSW delivery', 'cake-toppers': 'Express delivery' } });
  const s = mocks.state.stripeSessions.at(-1);
  assert.equal(s.params['metadata[order_id]'], o.order_id);
  assert.equal(s.params['line_items[0][price_data][unit_amount]'], '10800');
  assert.equal(s.params['line_items[0][quantity]'], '5');
  assert.equal(s.params['line_items[2][price_data][product_data][name]'], 'Delivery');
  assert.equal(s.params['line_items[2][price_data][unit_amount]'], String(5000 + 2000));
  assert.equal(s.params.currency, 'aud'); assert.equal(s.idempotency, `checkout-${o.order_id}`);
  assert.match(s.params.success_url, new RegExp(`#/order/${o.order_id}\\?t=`));
  assert.equal(o.redirect_url, `https://checkout.stripe.test/c/pay/${s.id}`);

  // landing on the success page does nothing by itself
  let st = await call(checkout.GET, `/api/checkout?action=status&id=${o.order_id}&t=${o.token}`);
  assert.equal(st.data.status, 'pending_payment');
  // forged or stale signatures are refused
  const raw = stripeEvent(o);
  assert.equal((await postStripe(raw, stripeSign(raw, 'whsec_wrong'))).status, 400);
  assert.equal((await postStripe(raw, stripeSign(raw, 'whsec_test_stripe', Math.floor(Date.now() / 1000) - 3600))).status, 400);
  assert.equal((await d.one('orders', `select=status&id=eq.${o.order_id}`)).status, 'pending_payment');
  // the real webhook marks it paid, records the customer and emails a confirmation
  const r = await postStripe(raw);
  assert.equal(r.status, 200); assert.equal(r.data.result, 'processed');
  st = await call(checkout.GET, `/api/checkout?action=status&id=${o.order_id}&t=${o.token}`);
  assert.equal(st.data.status, 'paid');
  const row = await d.one('orders', `select=*&id=eq.${o.order_id}`);
  assert.equal(row.provider_ref, `pi_${o.order_id.slice(0, 8)}`); assert.ok(row.customer_id);
  assert.deepEqual((await events(o.order_id)).map(e => `${e.to_status}:${e.actor}`), ['pending_payment:customer', 'paid:webhook:stripe']);
  const mail = mocks.state.emails.filter(m => m.to[0] === 'jo.buyer@example.com');
  assert.equal(mail.length, 1); assert.match(mail[0].subject, /Order confirmed: AVP-/);
  assert.equal(mail[0].reply_to, 'info@avantiprint.com.au'); assert.match(mail[0].from, /no-reply@avantiprint\.com\.au/);
  assert.match(mail[0].text, /Banner/); assert.match(mail[0].html, /Includes GST/);
  // the same webhook again (Stripe retries) is ignored: no second email
  const again = await postStripe(raw);
  assert.equal(again.data.duplicate, true);
  assert.equal(mocks.state.emails.filter(m => m.to[0] === 'jo.buyer@example.com').length, 1);
  // a different event id for the same payment is also harmless
  await postStripe(stripeEvent(o));
  assert.equal((await logs(`order_id=eq.${o.order_id}`)).length, 1);
});

test('Stripe: payments from the old website are ignored', async () => {
  const raw = JSON.stringify({ id: 'evt_woo_1', type: 'checkout.session.completed', data: { object: { id: 'cs_woo', payment_status: 'paid', amount_total: 5000, metadata: { order_id: '4521' } } } });
  const r = await postStripe(raw);
  assert.equal(r.status, 200); assert.equal(r.data.result, 'ignored');
});

test('Stripe: wrong amount, unpaid sessions and refunds', async () => {
  await reset();
  const a = await newOrder('stripe');
  await postStripe(stripeEvent(a, 'checkout.session.completed', { amount_total: 100 }));
  assert.equal((await d.one('orders', `select=status&id=eq.${a.order_id}`)).status, 'pending_payment');
  assert.match((await events(a.order_id)).at(-1).note, /does not match/);
  const b = await newOrder('stripe');
  await postStripe(stripeEvent(b, 'checkout.session.completed', { payment_status: 'unpaid' }));
  assert.equal((await d.one('orders', `select=status&id=eq.${b.order_id}`)).status, 'pending_payment');
  await postStripe(stripeEvent(b, 'checkout.session.async_payment_succeeded'));
  assert.equal((await d.one('orders', `select=status&id=eq.${b.order_id}`)).status, 'paid');
  await postStripe(JSON.stringify({ id: 'evt_ref_part', type: 'charge.refunded', data: { object: { payment_intent: `pi_${b.order_id.slice(0, 8)}`, amount: b.row.total_cents, amount_refunded: 1000, refunded: false } } }));
  assert.equal((await d.one('orders', `select=status&id=eq.${b.order_id}`)).status, 'paid');
  await postStripe(JSON.stringify({ id: 'evt_ref_full', type: 'charge.refunded', data: { object: { payment_intent: `pi_${b.order_id.slice(0, 8)}`, amount: b.row.total_cents, amount_refunded: b.row.total_cents, refunded: true } } }));
  assert.equal((await d.one('orders', `select=status&id=eq.${b.order_id}`)).status, 'refunded');
  assert.ok(mocks.state.emails.some(m => /Refund for order/.test(m.subject)));
});

test('PayPal: captured on return, webhook repeats are harmless, refunds tracked', async () => {
  await reset();
  const o = await newOrder('paypal');
  const ppId = o.row.provider_session_id, pp = mocks.state.paypalOrders[ppId];
  assert.equal(pp.body.purchase_units[0].custom_id, o.order_id);
  assert.equal(pp.body.purchase_units[0].amount.value, (o.row.total_cents / 100).toFixed(2));
  assert.equal(pp.body.purchase_units[0].amount.currency_code, 'AUD');
  assert.match(o.redirect_url, /paypal\.test\/checkoutnow/);
  // returning without approving does not mark it paid
  let r = await call(checkout.GET, `/api/checkout?action=paypal-return&order=${o.order_id}&token=${ppId}`);
  assert.equal(r.status, 303); assert.equal((await d.one('orders', `select=status&id=eq.${o.order_id}`)).status, 'pending_payment');
  mocks.approve(ppId);
  r = await call(checkout.GET, `/api/checkout?action=paypal-return&order=${o.order_id}&token=${ppId}`);
  assert.equal(r.status, 303); assert.match(r.headers.get('location'), /#\/order\/.+paid=1/);
  const row = await d.one('orders', `select=*&id=eq.${o.order_id}`);
  assert.equal(row.status, 'paid'); assert.equal(row.provider_ref, `CAP-${ppId}`);
  // PayPal's own webhook for the same capture: verified, then a no-op
  const ev = { id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: `CAP-${ppId}`, status: 'COMPLETED', custom_id: o.order_id, amount: { value: (row.total_cents / 100).toFixed(2) } } };
  const hdr = sig => ({ 'paypal-transmission-sig': sig, 'paypal-transmission-id': 't', 'paypal-transmission-time': 'now', 'paypal-cert-url': 'https://x', 'paypal-auth-algo': 'SHA256withRSA' });
  assert.equal((await call(webhooks.POST, '/api/webhooks?provider=paypal', { method: 'POST', body: ev, headers: hdr('forged') })).status, 400);
  r = await call(webhooks.POST, '/api/webhooks?provider=paypal', { method: 'POST', body: ev, headers: hdr('valid-signature') });
  assert.equal(r.status, 200);
  assert.equal((await events(o.order_id)).filter(e => e.to_status === 'paid' && e.from_status !== 'paid').length, 1);
  assert.equal(mocks.state.emails.filter(m => /Order confirmed/.test(m.subject)).length, 1);
  // refund
  const ref = { id: 'WH-EVT-2', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF-1', amount: { value: (row.total_cents / 100).toFixed(2) }, links: [{ rel: 'up', href: `https://api/v2/payments/captures/CAP-${ppId}` }] } };
  await call(webhooks.POST, '/api/webhooks?provider=paypal', { method: 'POST', body: ref, headers: hdr('valid-signature') });
  assert.equal((await d.one('orders', `select=status&id=eq.${o.order_id}`)).status, 'refunded');
});

test('PayPal: approval webhook captures when the customer never came back', async () => {
  await reset();
  const o = await newOrder('paypal'); const ppId = o.row.provider_session_id; mocks.approve(ppId);
  const ev = { id: 'WH-EVT-APP', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: ppId, purchase_units: [{ custom_id: o.order_id }] } };
  await call(webhooks.POST, '/api/webhooks?provider=paypal', { method: 'POST', body: ev, headers: { 'paypal-transmission-sig': 'valid-signature' } });
  assert.equal((await d.one('orders', `select=status&id=eq.${o.order_id}`)).status, 'paid');
});

test('test gateway: pays through a signed webhook, same path as Stripe', async () => {
  await reset();
  const o = await newOrder('simulator');
  const page = await call(checkout.GET, `/api/checkout?action=simulate&order=${o.order_id}&t=${o.token}`);
  assert.match(page.data, /TEST PAYMENT/);
  const r = await call(checkout.POST, `/api/checkout?action=simulate&order=${o.order_id}&t=${o.token}`, { method: 'POST', form: { result: 'paid' } });
  assert.equal(r.status, 303);
  assert.equal((await d.one('orders', `select=status&id=eq.${o.order_id}`)).status, 'paid');
  assert.equal((await events(o.order_id)).at(-1).actor, 'webhook:simulator');
  process.env.PAYMENTS_SIMULATOR = 'false';
  assert.equal((await call(checkout.GET, `/api/checkout?action=simulate&order=${o.order_id}&t=${o.token}`)).status, 404);
  assert.equal((await call(checkout.GET, '/api/checkout?action=config')).data.providers.some(p => p.id === 'simulator'), false);
  process.env.PAYMENTS_SIMULATOR = 'true';
});

test('order status page needs the private token', async () => {
  const o = await newOrder('simulator');
  assert.equal((await call(checkout.GET, `/api/checkout?action=status&id=${o.order_id}&t=00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await call(checkout.GET, `/api/checkout?action=status&id=${o.order_id}&t=${o.token}`)).status, 200);  assert.equal((await call(checkout.GET, `/api/checkout?action=status&id=1234&t=${o.token}`)).status, 404);
});

test('without a database connection, checkout offers no payment methods', async () => {
  const keep = process.env.SUPABASE_URL; process.env.SUPABASE_URL = '';
  const r = await call(checkout.GET, '/api/checkout?action=config');
  process.env.SUPABASE_URL = keep;
  assert.deepEqual(r.data.providers, []);
});

// ======================= PR 2: orders admin and transactional email =======================
async function paidOrder() { const o = await newOrder('stripe'); await postStripe(stripeEvent(o)); return o; }
const act = (t, action, body) => call(admin.POST, `/api/admin?action=${action}`, { method: 'POST', body, headers: t ? auth(t) : {} });

test('admin actions need a signed-in admin', async () => {
  const o = await paidOrder();
  assert.equal((await act(null, 'order-transition', { order_id: o.order_id, to: 'in_production' })).status, 401);
  assert.equal((await act(editorToken, 'order-transition', { order_id: o.order_id, to: 'in_production' })).status, 403);
  assert.equal((await act('not-a-token', 'order-transition', { order_id: o.order_id, to: 'in_production' })).status, 401);
});

test('full order lifecycle with emails, tracking and an audit trail', async () => {
  await reset();
  const o = await paidOrder();
  let r = await act(adminToken, 'order-transition', { order_id: o.order_id, to: 'in_production', note: 'Artwork approved' });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'in_production');
  r = await act(adminToken, 'order-transition', { order_id: o.order_id, to: 'dispatched', carrier: 'Australia Post' });
  assert.equal(r.status, 400); assert.match(r.data.error, /tracking/);
  r = await act(adminToken, 'order-transition', { order_id: o.order_id, to: 'dispatched', carrier: 'Australia Post', tracking_number: 'AP1234567' });
  assert.equal(r.status, 200);
  r = await act(adminToken, 'order-transition', { order_id: o.order_id, to: 'in_production' });
  assert.equal(r.status, 409); assert.match(r.data.error, /not allowed/);
  r = await act(adminToken, 'order-transition', { order_id: o.order_id, to: 'delivered' });
  assert.equal(r.status, 200);
  const ev = await events(o.order_id);
  assert.deepEqual(ev.map(e => e.to_status), ['pending_payment', 'paid', 'in_production', 'dispatched', 'delivered']);
  assert.equal(ev[2].actor, 'admin:admin@avanti.test'); assert.equal(ev[2].note, 'Artwork approved');
  assert.ok(ev.every(e => e.created_at));
  const subjects = mocks.state.emails.map(m => m.subject);
  assert.ok(subjects.some(s => /Order confirmed/.test(s)) && subjects.some(s => /in production/.test(s)) && subjects.some(s => /on its way/.test(s)));
  assert.ok(!subjects.some(s => /delivered/i.test(s)));
  const disp = mocks.state.emails.find(m => /on its way/.test(m.subject));
  assert.match(disp.html, /auspost\.com\.au\/mypost\/track\/details\/AP1234567/); assert.match(disp.text, /AP1234567/);
  const log = await logs(`order_id=eq.${o.order_id}`);
  assert.deepEqual(log.map(l => l.template), ['order-paid', 'order-in_production', 'order-dispatched']);
  assert.ok(log.every(l => l.status === 'sent' && l.provider_id));
});

test('cancelling: unpaid checkouts are silent, paid orders get an email', async () => {
  await reset();
  const a = await newOrder('stripe');
  await act(adminToken, 'order-transition', { order_id: a.order_id, to: 'cancelled' });
  assert.equal(mocks.state.emails.length, 0);
  const b = await paidOrder();
  const r = await act(adminToken, 'order-transition', { order_id: b.order_id, to: 'cancelled', note: 'Customer changed their mind' });
  assert.equal(r.status, 200);
  assert.ok(mocks.state.emails.some(m => /cancelled/.test(m.subject) && /refunded/.test(m.text)));
});

test('Resend webhooks update the log; hard bounces and complaints stop marketing', async () => {
  await reset();
  const o = await paidOrder();
  const log = (await logs(`order_id=eq.${o.order_id}`))[0];
  const hook = async (type, data, sig) => { const raw = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: log.provider_id, ...data } });
    return call(webhooks.POST, '/api/webhooks?provider=resend', { method: 'POST', body: raw, headers: sig || svixSign(raw, process.env.RESEND_WEBHOOK_SECRET) }); };
  assert.equal((await hook('email.delivered', {}, { 'svix-id': 'x', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,forged' })).status, 400);
  await hook('email.delivered'); await hook('email.opened'); await hook('email.clicked');
  let l = await d.one('email_log', `select=*&id=eq.${log.id}`);
  assert.equal(l.status, 'delivered'); assert.ok(l.delivered_at && l.opened_at && l.clicked_at);
  await mk.subscribe(d, { email: o.row.email, basis: 'footer_signup', source: 'test' });
  await hook('email.bounced', { bounce: { type: 'Permanent', subType: 'General', message: 'Mailbox does not exist' } });
  l = await d.one('email_log', `select=*&id=eq.${log.id}`);
  assert.equal(l.status, 'bounced'); assert.match(l.bounce_reason, /Mailbox does not exist/);
  const c = await d.one('customers', `select=*&email=eq.${o.row.email}`);
  assert.equal(c.suppressed, true); assert.equal(mk.canMarket(c), false);
});

// ======================= PR 3: consent, campaigns, automations =======================
test('sign-up needs ticked consent, records it, and ignores bots', async () => {
  await reset();
  assert.equal((await call(emailApi.POST, '/api/email?action=subscribe', { method: 'POST', body: { email: 'a@test.com' } })).status, 400);
  assert.equal((await call(emailApi.POST, '/api/email?action=subscribe', { method: 'POST', body: { email: 'bot@test.com', consent: true, website: 'x' } })).status, 200);
  assert.equal(await d.one('customers', 'select=id&email=eq.bot@test.com'), null);
  const r = await call(emailApi.POST, '/api/email?action=subscribe', { method: 'POST', body: { email: 'A@Test.com', consent: true }, headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(r.status, 200);
  const c = await d.one('customers', 'select=*&email=eq.a@test.com');
  assert.equal(c.marketing_status, 'subscribed'); assert.equal(c.consent_basis, 'footer_signup'); assert.ok(c.consent_at); assert.equal(c.consent_ip, '203.0.113.9');
  const cl = await d.select('consent_log', `select=*&customer_id=eq.${c.id}`);
  assert.equal(cl.length, 1); assert.equal(cl[0].action, 'subscribe');
});

test('checkout opt-in subscribes only when ticked', async () => {
  await reset();
  const a = await newOrder('stripe', { marketing_opt_in: true }); await postStripe(stripeEvent(a));
  const b = await newOrder('stripe', { customer: { ...CUSTOMER, email: 'no-optin@test.com' } }); await postStripe(stripeEvent(b));
  const ca = await d.one('customers', `select=*&email=eq.jo.buyer@example.com`), cb = await d.one('customers', 'select=*&email=eq.no-optin@test.com');
  assert.equal(ca.marketing_status, 'subscribed'); assert.equal(ca.consent_basis, 'checkout_opt_in'); assert.match(ca.consent_source, /AVP-/);
  assert.equal(cb.marketing_status, 'not_subscribed');
});

test('imports need a stated source and never re-add people who unsubscribed', async () => {
  await reset();
  await mk.subscribe(d, { email: 'gone@test.com', basis: 'footer_signup' });
  const g = await d.one('customers', 'select=*&email=eq.gone@test.com');
  await call(emailApi.POST, `/api/email?action=unsubscribe&t=${g.pref_token}`, { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } });
  assert.equal((await act(adminToken, 'customers-import', { rows: [{ email: 'x@test.com' }], confirm: true })).status, 400);
  assert.equal((await act(adminToken, 'customers-import', { rows: [{ email: 'x@test.com' }], source: 'Trade show' })).status, 400);
  const r = await act(adminToken, 'customers-import', { rows: [{ email: 'new1@test.com', state: 'VIC' }, { email: 'gone@test.com' }, { email: 'bad' }], source: 'Trade show sheet 2025', confirm: true });
  assert.deepEqual(r.data, { added: 1, already: 0, skipped_unsubscribed: 1, invalid: 1 });
  assert.equal((await d.one('customers', 'select=marketing_status&email=eq.gone@test.com')).marketing_status, 'unsubscribed');
  assert.equal((await act(adminToken, 'customer-subscribe', { customer_id: g.id, source: 'asked on the phone' })).status, 409);
  assert.ok((await d.select('audit_log', 'select=*&action=eq.customers.import')).length);
});

test('segment rules', () => {
  const now = Date.now(), day = 86400000;
  const c = { categories: ['mailer-boxes'], last_order_at: new Date(now - 30 * day).toISOString(), total_spent_cents: 250000, paid_orders: 3, state: 'NSW', tags: ['wholesale'], consent_at: new Date(now - 2 * day).toISOString() };
  const m = (rules, match = 'all') => mk.matches({ match, rules }, c, now);
  assert.ok(m([{ field: 'category', op: 'includes', value: 'mailer-boxes' }]));
  assert.ok(!m([{ field: 'category', op: 'includes', value: 'wallpaper' }]));
  assert.ok(m([{ field: 'last_order', op: 'within', value: 60 }]) && !m([{ field: 'last_order', op: 'more_than', value: 60 }]));
  assert.ok(m([{ field: 'total_spent', op: 'gte', value: 2000 }]) && !m([{ field: 'total_spent', op: 'gte', value: 3000 }]));
  assert.ok(m([{ field: 'state', op: 'in', value: ['NSW', 'ACT'] }]) && !m([{ field: 'state', op: 'in', value: ['VIC'] }]));
  assert.ok(m([{ field: 'tag', op: 'has', value: 'wholesale' }]) && m([{ field: 'orders', op: 'gte', value: 3 }]));
  assert.ok(m([{ field: 'state', op: 'in', value: ['VIC'] }, { field: 'tag', op: 'has', value: 'wholesale' }], 'any'));
  assert.ok(!m([{ field: 'state', op: 'in', value: ['VIC'] }, { field: 'tag', op: 'has', value: 'wholesale' }], 'all'));
  assert.ok(mk.matches({ match: 'all', rules: [{ field: 'last_order', op: 'never' }] }, { }, now));
});

test('customer totals count each order once, even with several items', async () => {
  await reset();
  const o = await newOrder('stripe', { lines: [LINE_BANNER, LINE_TOPPER], delivery: { 'pull-up-banners': 'Metro NSW delivery', 'cake-toppers': 'Standard delivery' } });
  await postStripe(stripeEvent(o));
  const c = await d.one('customers', 'select=id&email=eq.jo.buyer@example.com');
  const s = await d.one('customer_stats', `select=*&customer_id=eq.${c.id}`);
  assert.equal(s.paid_orders, 1); assert.equal(Number(s.total_spent_cents), o.row.total_cents);
});

test('campaigns reach only consenting subscribers, with working one-click unsubscribe and stats', async () => {
  await reset();
  // a paying, opted-in NSW customer; a subscriber in VIC; someone never subscribed; an unsubscriber; a suppressed address
  const o = await newOrder('stripe', { marketing_opt_in: true }); await postStripe(stripeEvent(o));
  await mk.subscribe(d, { email: 'vic@test.com', basis: 'footer_signup', state: 'VIC' });
  await d.insert('customers', { email: 'never@test.com' });
  await mk.subscribe(d, { email: 'left@test.com', basis: 'footer_signup' }); await mk.unsubscribe(d, { customerId: (await d.one('customers', 'select=id&email=eq.left@test.com')).id });
  await mk.subscribe(d, { email: 'bounced@test.com', basis: 'footer_signup' }); await mk.suppress(d, 'bounced@test.com', 'Hard bounce');
  const [seg] = await d.insert('segments', { name: 'Banner buyers', rules: { match: 'all', rules: [{ field: 'category', op: 'includes', value: 'pull-up-banners' }] } });
  const prev = await act(adminToken, 'segment-preview', { segment_id: seg.id });
  assert.equal(prev.data.count, 1); assert.equal(prev.data.eligible, 2);
  const [c] = await d.insert('campaigns', { name: 'Spring', subject: 'Spring sale', preview_text: '10% off', blocks: [{ type: 'heading', text: 'Hi {{first_name}}' }, { type: 'text', html: '<p>Big <b>news</b><script>alert(1)</script></p>' }, { type: 'button', label: 'Shop', url: '/#/shop' }] });
  // preview and test send go to the admin only
  const pv = await act(adminToken, 'campaign-preview', { campaign: c });
  assert.match(pv.data.html, /Big <b>news<\/b>/); assert.doesNotMatch(pv.data.html, /<script/);
  let r = await act(adminToken, 'campaign-test', { campaign_id: c.id });
  assert.equal(r.data.to, 'admin@avanti.test');
  assert.equal(mocks.state.emails.filter(m => m.subject === '[Test] Spring sale').length, 1);
  mocks.state.emails.length = 0;
  r = await act(adminToken, 'campaign-send', { campaign_id: c.id });
  assert.equal(r.status, 200); assert.equal(r.data.recipients, 2);
  const to = mocks.state.emails.map(m => m.to[0]).sort();
  assert.deepEqual(to, ['jo.buyer@example.com', 'vic@test.com']);
  const m1 = mocks.state.emails.find(m => m.to[0] === 'jo.buyer@example.com');
  assert.match(m1.headers['List-Unsubscribe'], /api\/email\?action=unsubscribe&t=/); assert.equal(m1.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(m1.html, /Hi Jo/); assert.doesNotMatch(m1.html, /<script/); assert.match(m1.html, /ABN 12 345 678 901/);
  assert.match(m1.html, /shop\.test\/\?c=[0-9a-f-]{36}#\/shop/); assert.match(m1.text, /Unsubscribe: https/);
  assert.equal((await act(adminToken, 'campaign-send', { campaign_id: c.id })).status, 409);   // can't send twice
  // one-click unsubscribe from the inbox
  const token = m1.headers['List-Unsubscribe'].match(/t=([0-9a-f-]{36})/)[1];
  const get = await call(emailApi.GET, `/api/email?action=unsubscribe&t=${token}`);
  assert.match(get.data, /Unsubscribe from marketing emails\?/);
  assert.equal((await d.one('customers', 'select=marketing_status&email=eq.jo.buyer@example.com')).marketing_status, 'subscribed');   // viewing the page doesn't unsubscribe
  await call(emailApi.POST, `/api/email?action=unsubscribe&t=${token}`, { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } });
  assert.equal((await d.one('customers', 'select=marketing_status&email=eq.jo.buyer@example.com')).marketing_status, 'unsubscribed');
  // a duplicate of the campaign now reaches only the VIC subscriber
  const dup = await act(adminToken, 'campaign-duplicate', { campaign_id: c.id });
  assert.equal(dup.data.name, 'Spring (copy)'); mocks.state.emails.length = 0;
  await act(adminToken, 'campaign-send', { campaign_id: dup.data.id });
  assert.deepEqual(mocks.state.emails.map(m => m.to[0]), ['vic@test.com']);
  // stats: delivered/opened via webhooks, revenue from an attributed order
  const vicLog = (await logs(`campaign_id=eq.${c.id}&to_email=eq.vic@test.com`))[0];
  for (const type of ['email.delivered', 'email.opened', 'email.clicked']) { const raw = JSON.stringify({ type, data: { email_id: vicLog.provider_id } });
    await call(webhooks.POST, '/api/webhooks?provider=resend', { method: 'POST', body: raw, headers: svixSign(raw, process.env.RESEND_WEBHOOK_SECRET) }); }
  const att = await newOrder('stripe', { customer: { ...CUSTOMER, email: 'vic@test.com' }, campaign_id: c.id }); await postStripe(stripeEvent(att));
  const st = (await act(adminToken, 'campaign-stats', { ids: [c.id] })).data[c.id];
  assert.equal(st.sent, 2); assert.equal(st.delivered, 1); assert.equal(st.opened, 1); assert.equal(st.clicked, 1);
  assert.equal(st.revenue_cents, att.row.total_cents); assert.equal(st.orders, 1);
});

test('an empty campaign is refused and stays a draft', async () => {
  await reset();
  const [c] = await d.insert('campaigns', { name: 'Empty', subject: '', blocks: [] });
  assert.equal((await act(adminToken, 'campaign-send', { campaign_id: c.id })).status, 400);
  assert.equal((await d.one('campaigns', `select=status&id=eq.${c.id}`)).status, 'draft');
});

test('scheduled campaigns go out when due, via the protected cron', async () => {
  await reset();
  await mk.subscribe(d, { email: 's1@test.com', basis: 'footer_signup' });
  const [c] = await d.insert('campaigns', { name: 'Later', subject: 'Later', blocks: [{ type: 'text', html: '<p>x</p>' }] });
  assert.equal((await act(adminToken, 'campaign-schedule', { campaign_id: c.id, at: new Date(Date.now() - 1000).toISOString() })).status, 400);
  assert.equal((await act(adminToken, 'campaign-schedule', { campaign_id: c.id, at: new Date(Date.now() + 3600000).toISOString() })).status, 200);
  assert.equal((await call(cron.GET, '/api/cron')).status, 401);
  const r = await call(cron.GET, '/api/cron', { headers: auth('cron-test-secret') });
  assert.equal(r.status, 200); assert.equal(r.data.campaigns.length, 0);
  assert.equal((await mk.runScheduled(d, new Date(Date.now() + 2 * 3600000))).length, 1);
  assert.equal((await d.one('campaigns', `select=status,recipients&id=eq.${c.id}`)).status, 'sent');
});

test('automations: each flow sends once, only when enabled, only to consenting customers', async () => {
  await reset();
  const H = 3600000, now = Date.now();
  await d.update('automation_flows', 'key=not.is.null', { enabled: true });
  // welcome
  await mk.subscribe(d, { email: 'w@test.com', basis: 'footer_signup' });
  let r = await mk.runAutomations(d, new Date(now + 60000));
  assert.equal(r.welcome, 1);
  assert.equal((await mk.runAutomations(d, new Date(now + 120000))).welcome, 0);
  // abandoned checkout: pending order older than 24h, no later paid order; not sent to non-subscribers
  await newOrder('stripe', { customer: { ...CUSTOMER, email: 'w@test.com' } });
  await newOrder('stripe', { customer: { ...CUSTOMER, email: 'nosub@test.com' } });
  assert.equal((await mk.runAutomations(d, new Date(now + 2 * H))).abandoned_cart, 0);
  r = await mk.runAutomations(d, new Date(now + 25 * H));
  assert.equal(r.abandoned_cart, 1);
  const abMail = mocks.state.emails.find(m => /Still thinking/.test(m.subject));
  assert.equal(abMail.to[0], 'w@test.com'); assert.match(abMail.html, /Banner/);
  // post-purchase packaging reminder after 60 days
  await mk.subscribe(d, { email: 'box@test.com', basis: 'footer_signup' });
  const box = await newOrder('stripe', { customer: { ...CUSTOMER, email: 'box@test.com' }, lines: [{ slug: 'custom-branded-mailer-boxes', qty: 100,
    opts: { Material: 'White E Flute 1.5mm', 'Size (mm)': '225 × 160 × 80', Printing: 'Single side (outside only)' } }], delivery: {} });
  await postStripe(stripeEvent(box));
  assert.equal((await mk.runAutomations(d, new Date(now + 10 * 24 * H))).post_purchase, 0);
  assert.equal((await mk.runAutomations(d, new Date(now + 61 * 24 * H))).post_purchase, 1);
  // win-back after 180 days without an order
  assert.ok((await mk.runAutomations(d, new Date(now + 181 * 24 * H))).win_back >= 1);
  // disabled flows send nothing
  await d.update('automation_flows', 'key=not.is.null', { enabled: false });
  await mk.subscribe(d, { email: 'late@test.com', basis: 'footer_signup' });
  assert.deepEqual(await mk.runAutomations(d, new Date(now + 200 * 24 * H)), {});
  const sends = await d.select('automation_sends', 'select=flow_key,email');
  assert.ok(!sends.some(s => s.email === 'nosub@test.com'));
});

test('every email is logged, and without a Resend key nothing leaves the building', async () => {
  await reset();
  process.env.RESEND_API_KEY = '';
  const o = await paidOrder();
  const l = await logs(`order_id=eq.${o.order_id}`);
  assert.equal(l.length, 1); assert.equal(l[0].status, 'logged'); assert.equal(l[0].provider, 'log');
  assert.equal(mocks.state.emails.length, 0);
  process.env.RESEND_API_KEY = 're_test_key';
});
