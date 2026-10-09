// GYA server core: settings, database access, HTTP helpers, admin check.
// Runs on Vercel (Node 20, Web-standard Request/Response handlers). No npm packages.

const E = (k, d = '') => (process.env[k] ?? d);
const isJwt = k => /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(k || '');

// Read settings at call time so tests (and Vercel previews) can change them.
export function config() {
  const ppEnv = E('PAYPAL_ENV', 'sandbox') === 'live' ? 'live' : 'sandbox';
  return {
    siteUrl: E('SITE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    brand: E('BRAND_NAME', 'Avanti Print & Design'),
    supabaseUrl: E('SUPABASE_URL').replace(/\/+$/, ''),
    serviceKey: E('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: E('SUPABASE_ANON_KEY'),
    stripe: {
      secret: E('STRIPE_SECRET_KEY'), webhookSecret: E('STRIPE_WEBHOOK_SECRET'),
      apiBase: E('STRIPE_API_BASE', 'https://api.stripe.com'),
      get enabled() { return !!this.secret && E('STRIPE_ENABLED', 'true') !== 'false'; },
      get testMode() { return /^(sk|rk)_test_/.test(this.secret); },   // standard or restricted test key
    },
    paypal: {
      clientId: E('PAYPAL_CLIENT_ID'), secret: E('PAYPAL_CLIENT_SECRET'), webhookId: E('PAYPAL_WEBHOOK_ID'), env: ppEnv,
      apiBase: E('PAYPAL_API_BASE', ppEnv === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'),
      get enabled() { return !!(this.clientId && this.secret) && E('PAYPAL_ENABLED', 'true') !== 'false'; },
    },
    // Built-in test gateway: lets staging take a full order end to end with no provider keys.
    // Never switch this on for the live site.
    simulator: E('PAYMENTS_SIMULATOR') === 'true',
    simulatorSecret: E('SIMULATOR_WEBHOOK_SECRET', 'whsec_simulator_only_not_for_production'),
    email: {
      resendKey: E('RESEND_API_KEY'), apiBase: E('RESEND_API_BASE', 'https://api.resend.com'),
      webhookSecret: E('RESEND_WEBHOOK_SECRET'),
      from: E('EMAIL_FROM', 'Avanti Print & Design <no-reply@avantiprint.com.au>'),
      marketingFrom: E('EMAIL_MARKETING_FROM', E('EMAIL_FROM', 'Avanti Print & Design <no-reply@avantiprint.com.au>')),
      replyTo: E('EMAIL_REPLY_TO', 'info@avantiprint.com.au'),
      get mode() { return this.resendKey ? 'resend' : 'log'; },   // without a key, emails are logged, not sent
    },
    business: {   // shown in every email footer (the Spam Act requires sender identification)
      name: E('BUSINESS_NAME', 'Avanti Print & Design'),
      abn: E('BUSINESS_ABN', ''),
      address: E('BUSINESS_ADDRESS', ''),
      phone: E('BUSINESS_PHONE', '(02) 9729 0139'),
      email: E('EMAIL_REPLY_TO', 'info@avantiprint.com.au'),
    },
    cronSecret: E('CRON_SECRET'),
  };
}

// ---------- HTTP ----------
export class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
export const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
export const redirect = (url, status = 303) => new Response(null, { status, headers: { Location: url } });
export async function readJson(req, max = 200_000) {
  const t = await req.text();
  if (t.length > max) throw new HttpError(413, 'Request too large');
  try { return t ? JSON.parse(t) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
}
// Wrap a handler: errors become JSON with a safe message; unexpected ones are logged.
export function handle(fn) {
  return async (req) => {
    try { return await fn(req); }
    catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  };
}
export const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cents = n => Math.round(Number(n) * 100);
export const dollars = c => (c / 100).toFixed(2);
export const money = c => '$' + (c / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const clientIp = req => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;

// ---------- database (Supabase REST with the service role key) ----------
export function db(cfg = config()) {
  if (!cfg.supabaseUrl || !cfg.serviceKey) throw new HttpError(503, 'The shop database is not connected yet.');
  const headers = { apikey: cfg.serviceKey, 'Content-Type': 'application/json' };
  if (isJwt(cfg.serviceKey)) headers.Authorization = `Bearer ${cfg.serviceKey}`;
  async function call(method, path, body, prefer) {
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
      method, headers: prefer ? { ...headers, Prefer: prefer } : headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) { const e = new Error((data && (data.message || data.hint)) || `Database error ${r.status}`); e.status = r.status; e.code = data && data.code; throw e; }
    return data;
  }
  const q = v => encodeURIComponent(v);
  return {
    q,
    select: (table, query = 'select=*') => call('GET', `${table}?${query}`),
    one: async (table, query) => (await call('GET', `${table}?${query}&limit=1`))[0] || null,
    insert: (table, rows, { onConflict, ignore } = {}) =>
      call('POST', `${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`, rows,
        `return=representation${onConflict ? (ignore ? ',resolution=ignore-duplicates' : ',resolution=merge-duplicates') : ''}`),
    update: (table, filter, patch) => call('PATCH', `${table}?${filter}`, patch, 'return=representation'),
    remove: (table, filter) => call('DELETE', `${table}?${filter}`, undefined, 'return=representation'),
    rpc: (fn, args = {}) => call('POST', `rpc/${fn}`, args),
  };
}

// ---------- admin check: a signed-in Supabase user whose profile role is 'admin' ----------
export async function requireAdmin(req, cfg = config()) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new HttpError(401, 'Please sign in again.');
  const r = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: cfg.anonKey || cfg.serviceKey, Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  const user = await r.json();
  const p = await db(cfg).one('profiles', `select=role,display_name&user_id=eq.${encodeURIComponent(user.id)}`);
  if (!p || p.role !== 'admin') throw new HttpError(403, 'This account does not have dashboard access.');
  return { id: user.id, email: (user.email || '').toLowerCase(), name: p.display_name || user.email };
}

export async function audit(d, actor, action, target_type, target_id, data) {
  try { await d.insert('audit_log', { actor, action, target_type, target_id: target_id == null ? null : String(target_id), data: data || null }); }
  catch (e) { console.error('audit log failed', e.message); }
}
