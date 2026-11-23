// Stand-ins for the Stripe, PayPal and Resend APIs, so the real integration code can be tested
// end to end with no network access and no keys. Only the endpoints the shop uses are modelled.
import http from 'node:http';

export function startMocks(port = 0) {
  const state = { stripeSessions: [], paypalOrders: {}, emails: [], batches: 0, verify: 'SUCCESS', requests: [],
    stripeRefunds: [], paypalRefunds: [], stripeRefundFail: null, paypalRefundFail: null, stripeRefundStatus: 'succeeded',
    // 'before': the request never arrives (500). 'after': the refund is made but the reply is lost (500). Used once, then cleared.
    stripeRefundLost: null, paypalRefundLost: null, paypalCaptureStatus: {} };
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString(), url = new URL(req.url, 'http://x'), p = url.pathname;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    state.requests.push({ method: req.method, path: p, headers: req.headers });
    let m0;
    // ---- Stripe ----
    if (p === '/v1/checkout/sessions' && req.method === 'POST') {
      if (!/^Bearer (sk|rk)_(test|live)_/.test(req.headers.authorization || '')) return send(401, { error: { message: 'Invalid API key' } });
      const params = Object.fromEntries(new URLSearchParams(raw));
      const id = `cs_test_${++n}`;
      state.stripeSessions.push({ id, params, idempotency: req.headers['idempotency-key'] });
      return send(200, { id, url: `https://checkout.stripe.test/c/pay/${id}` });
    }
    // Stripe refunds: idempotent on the Idempotency-Key header, like the real API
    if (p === '/v1/refunds' && req.method === 'POST') {
      const params = Object.fromEntries(new URLSearchParams(raw)), key = req.headers['idempotency-key'];
      const prev = key && state.stripeRefunds.find(r => r.idem === key);
      if (prev) return send(200, prev);
      if (state.stripeRefundLost === 'before') { state.stripeRefundLost = null; return send(500, { error: { type: 'api_error', message: 'An unknown error occurred' } }); }
      if (state.stripeRefundFail) return send(400, { error: state.stripeRefundFail });
      const md = {}; for (const [k, v] of Object.entries(params)) { const mm = k.match(/^metadata\[(.+)\]$/); if (mm) md[mm[1]] = v; }
      const r = { id: `re_test_${++n}`, object: 'refund', payment_intent: params.payment_intent, amount: Number(params.amount), status: state.stripeRefundStatus,
        reason: params.reason, metadata: md, idem: key };
      state.stripeRefunds.push(r);
      if (state.stripeRefundLost === 'after') { state.stripeRefundLost = null; return send(500, { error: { type: 'api_error', message: 'An unknown error occurred' } }); }
      return send(200, r);
    }
    m0 = p.match(/^\/v1\/refunds\/([^/]+)$/);
    if (m0 && req.method === 'GET') { const r = state.stripeRefunds.find(x => x.id === m0[1]); return r ? send(200, r) : send(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }); }
    if (p === '/v1/refunds' && req.method === 'GET') {
      return send(200, { object: 'list', data: state.stripeRefunds.filter(r => r.payment_intent === url.searchParams.get('payment_intent')).slice().reverse() });
    }
    // ---- PayPal ----
    if (p === '/v1/oauth2/token') return send(200, { access_token: 'A21_test_token', expires_in: 32400 });
    if (p === '/v2/checkout/orders' && req.method === 'POST') {
      const body = JSON.parse(raw), id = `PP${++n}X`;
      state.paypalOrders[id] = { id, body, approved: false, captured: false, requestId: req.headers['paypal-request-id'] };
      return send(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.test/checkoutnow?token=${id}` }] });
    }
    let m = p.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (m) {
      const o = state.paypalOrders[m[1]]; if (!o) return send(404, { name: 'RESOURCE_NOT_FOUND' });
      const pu = o.body.purchase_units[0];
      const view = () => ({ id: o.id, status: o.captured ? 'COMPLETED' : 'APPROVED', purchase_units: [{ custom_id: pu.custom_id,
        payments: o.captured ? { captures: [{ id: `CAP-${o.id}`, status: 'COMPLETED', custom_id: pu.custom_id, amount: { currency_code: 'AUD', value: pu.amount.value } }] } : undefined }] });
      if (m[2]) {
        if (!o.approved) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
        if (o.captured) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
        o.captured = true; return send(201, view());
      }
      return send(200, view());
    }
    m = p.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/);
    if (m && req.method === 'POST') {
      const b = JSON.parse(raw || '{}'), rid = req.headers['paypal-request-id'];
      const prev = rid && state.paypalRefunds.find(r => r.requestId === rid);
      if (prev) return send(201, prev);
      if (state.paypalRefundLost === 'before') { state.paypalRefundLost = null; return send(503, { name: 'SERVICE_UNAVAILABLE' }); }
      if (state.paypalRefundFail) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [state.paypalRefundFail] });
      const r = { id: `PPREF${++n}`, status: 'COMPLETED', amount: b.amount, capture: m[1], requestId: rid, note_to_payer: b.note_to_payer, custom_id: b.custom_id,
        links: [{ rel: 'up', href: `https://api.paypal.test/v2/payments/captures/${m[1]}` }] };
      state.paypalRefunds.push(r);
      if (state.paypalRefundLost === 'after') { state.paypalRefundLost = null; return send(503, { name: 'SERVICE_UNAVAILABLE' }); }
      return send(201, r);
    }
    m = p.match(/^\/v2\/payments\/refunds\/([^/]+)$/);
    if (m && req.method === 'GET') { const r = state.paypalRefunds.find(x => x.id === m[1]); return r ? send(200, r) : send(404, { name: 'RESOURCE_NOT_FOUND' }); }
    m = p.match(/^\/v2\/payments\/captures\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const refunded = state.paypalRefunds.filter(x => x.capture === m[1]).length;
      return send(200, { id: m[1], status: state.paypalCaptureStatus[m[1]] || (refunded ? 'PARTIALLY_REFUNDED' : 'COMPLETED') });
    }
    if (p === '/v1/notifications/verify-webhook-signature') {
      const b = JSON.parse(raw);
      return send(200, { verification_status: b.transmission_sig === 'valid-signature' ? state.verify : 'FAILURE' });
    }
    // ---- SMTP2GO ----
    if (p === '/v3/email/send' && req.method === 'POST') { const b = JSON.parse(raw);
      if (req.headers['x-smtp2go-api-key'] !== 'api-test-key') return send(401, { data: { error_code: 'E_ApiResponseCodes.API_KEY_INVALID', error: 'Invalid API key' } });
      if (state.smtp2goFail) return send(200, { data: { succeeded: 0, failed: 1, failures: [state.smtp2goFail] } });   // 200 with a failure inside
      const id = `s2g_${++n}`; (state.smtp2go = state.smtp2go || []).push({ id, ...b }); return send(200, { request_id: 'r', data: { succeeded: 1, failed: 0, failures: [], email_id: id } }); }
    // ---- Resend ----
    if (p === '/emails' && req.method === 'POST') { const b = JSON.parse(raw), id = `re_${++n}`;
      if (state.failAttachments && b.attachments) return send(422, { message: 'Attachment too large' });   // to test the links-only fallback
      state.emails.push({ id, ...b, idempotency: req.headers['idempotency-key'] }); return send(200, { id }); }
    if (p === '/emails/batch' && req.method === 'POST') { const b = JSON.parse(raw); state.batches++;
      const data = b.map(x => { const id = `re_${++n}`; state.emails.push({ id, ...x }); return { id }; }); return send(200, { data }); }
    send(404, { message: `mock: no route ${req.method} ${p}` });
  });
  return new Promise(ok => server.listen(port, () => ok({ state, url: `http://localhost:${server.address().port}`, close: () => server.close(),
    approve: id => { state.paypalOrders[id].approved = true; } })));
}
