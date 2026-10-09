// Stand-ins for the Stripe, PayPal and Resend APIs, so the real integration code can be tested
// end to end with no network access and no keys. Only the endpoints the shop uses are modelled.
import http from 'node:http';

export function startMocks(port = 0) {
  const state = { stripeSessions: [], paypalOrders: {}, emails: [], batches: 0, verify: 'SUCCESS', requests: [] };
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString(), url = new URL(req.url, 'http://x'), p = url.pathname;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    state.requests.push({ method: req.method, path: p, headers: req.headers });
    // ---- Stripe ----
    if (p === '/v1/checkout/sessions' && req.method === 'POST') {
      if (!/^Bearer (sk|rk)_(test|live)_/.test(req.headers.authorization || '')) return send(401, { error: { message: 'Invalid API key' } });
      const params = Object.fromEntries(new URLSearchParams(raw));
      const id = `cs_test_${++n}`;
      state.stripeSessions.push({ id, params, idempotency: req.headers['idempotency-key'] });
      return send(200, { id, url: `https://checkout.stripe.test/c/pay/${id}` });
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
    if (p === '/v1/notifications/verify-webhook-signature') {
      const b = JSON.parse(raw);
      return send(200, { verification_status: b.transmission_sig === 'valid-signature' ? state.verify : 'FAILURE' });
    }
    // ---- Resend ----
    if (p === '/emails' && req.method === 'POST') { const b = JSON.parse(raw), id = `re_${++n}`; state.emails.push({ id, ...b, idempotency: req.headers['idempotency-key'] }); return send(200, { id }); }
    if (p === '/emails/batch' && req.method === 'POST') { const b = JSON.parse(raw); state.batches++;
      const data = b.map(x => { const id = `re_${++n}`; state.emails.push({ id, ...x }); return { id }; }); return send(200, { data }); }
    send(404, { message: `mock: no route ${req.method} ${p}` });
  });
  return new Promise(ok => server.listen(port, () => ok({ state, url: `http://localhost:${server.address().port}`, close: () => server.close(),
    approve: id => { state.paypalOrders[id].approved = true; } })));
}
