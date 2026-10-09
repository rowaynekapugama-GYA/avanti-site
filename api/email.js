// /api/email?action=subscribe|unsubscribe|preferences
// Unsubscribe links work without logging in, take effect immediately, and support one-click
// unsubscribe from the inbox (RFC 8058 List-Unsubscribe-Post), as the Spam Act and Gmail/Yahoo require.
import { config, db, handle, json, html, readJson, HttpError, escHtml as e, clientIp } from './_lib/core.js';
import { subscribe, unsubscribe } from './_lib/marketing.js';

const page = (cfg, title, body) => html(`<!doctype html><html lang="en-AU"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)}</title>
<body style="margin:0;background:#f4f2ee;font-family:system-ui,-apple-system,sans-serif;color:#17161a"><div style="max-width:480px;margin:48px auto;padding:0 16px">
<a href="${cfg.siteUrl}/"><img src="${cfg.siteUrl}/assets/logo-trim.png" alt="${e(cfg.brand)}" width="150" style="display:block;margin:0 0 22px"></a>
<div style="background:#fff;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.06)">${body}</div>
<p style="font-size:12px;color:#777;margin:16px 0 0">${e(cfg.business.name)}${cfg.business.abn ? ` · ABN ${e(cfg.business.abn)}` : ''} · ${e(cfg.business.phone)} · ${e(cfg.business.email)}</p></div></body></html>`);
const btn = (label, primary = true) => `<button style="padding:12px 22px;border-radius:999px;border:${primary ? '0' : '1px solid #ccc'};background:${primary ? '#C41E2A' : '#fff'};color:${primary ? '#fff' : '#17161a'};font-weight:700;cursor:pointer">${label}</button>`;

export const GET = handle(async (req) => {
  const cfg = config(), u = new URL(req.url), action = u.searchParams.get('action'), t = u.searchParams.get('t') || '';
  const d = db(cfg), c = /^[0-9a-f-]{36}$/.test(t) ? await d.one('customers', `select=email,marketing_status,pref_token&pref_token=eq.${d.q(t)}`) : null;
  if (!c) return page(cfg, 'Link expired', '<h1 style="margin:0 0 10px;font-size:22px">This link is no longer valid</h1><p>Reply to any of our emails and we will update your preferences for you.</p>');
  if (action === 'unsubscribe') {
    // A page with a button, rather than unsubscribing on GET: email security scanners open links automatically.
    if (c.marketing_status === 'unsubscribed') return page(cfg, 'Unsubscribed', `<h1 style="margin:0 0 10px;font-size:22px">You're unsubscribed</h1><p><b>${e(c.email)}</b> won't receive marketing emails from us. You'll still get emails about orders you place.</p>`);
    return page(cfg, 'Unsubscribe', `<h1 style="margin:0 0 10px;font-size:22px">Unsubscribe from marketing emails?</h1><p><b>${e(c.email)}</b> will stop receiving news and offers. Emails about your orders are not affected.</p>
<form method="post" action="/api/email?action=unsubscribe&t=${e(t)}">${btn('Unsubscribe')}</form><p style="font-size:14px;margin:18px 0 0"><a href="/api/email?action=preferences&t=${e(t)}" style="color:#C41E2A">Manage email preferences</a></p>`);
  }
  if (action === 'preferences') {
    const on = c.marketing_status === 'subscribed';
    return page(cfg, 'Email preferences', `<h1 style="margin:0 0 10px;font-size:22px">Email preferences</h1><p><b>${e(c.email)}</b> is currently <b>${on ? 'subscribed to' : 'not receiving'}</b> news and offers.</p>
<form method="post" action="/api/email?action=preferences&t=${e(t)}"><input type="hidden" name="subscribed" value="${on ? 'no' : 'yes'}">${on ? btn('Unsubscribe') : btn('Subscribe again')}</form>
<p style="font-size:13px;color:#777;margin:18px 0 0">Order confirmations and delivery updates are always sent, whatever you choose here.</p>`);
  }
  throw new HttpError(404, 'Unknown action');
});

export const POST = handle(async (req) => {
  const cfg = config(), u = new URL(req.url), action = u.searchParams.get('action'), t = u.searchParams.get('t') || '', d = db(cfg);
  const ip = clientIp(req), ua = req.headers.get('user-agent');
  if (action === 'subscribe') {   // footer / newsletter sign-up
    const b = await readJson(req);
    if (b.website) return json({ ok: true });   // honeypot field: bots fill it, people never see it
    if (!b.consent) throw new HttpError(400, 'Please tick the box to agree to receive emails.');
    await subscribe(d, { email: b.email, name: b.name, basis: 'footer_signup', source: String(b.source || 'Website sign-up form').slice(0, 120), ip, ua });
    return json({ ok: true });
  }
  if (action === 'unsubscribe') {   // the button on our page, or one-click from the inbox
    const body = await req.text();
    await unsubscribe(d, { token: t, source: body.includes('List-Unsubscribe=One-Click') ? 'One-click (inbox)' : 'Unsubscribe page', ip, ua });
    return page(cfg, 'Unsubscribed', '<h1 style="margin:0 0 10px;font-size:22px">You\'re unsubscribed</h1><p>You won\'t receive marketing emails from us any more. Emails about your orders are not affected.</p>');
  }
  if (action === 'preferences') {
    const form = new URLSearchParams(await req.text());
    const c = await d.one('customers', `select=email&pref_token=eq.${d.q(t)}`);
    if (!c) throw new HttpError(404, 'This link is no longer valid.');
    if (form.get('subscribed') === 'yes') await subscribe(d, { email: c.email, basis: 'footer_signup', source: 'Email preferences page', ip, ua });
    else await unsubscribe(d, { token: t, source: 'Email preferences page', ip, ua });
    return page(cfg, 'Saved', `<h1 style="margin:0 0 10px;font-size:22px">Preferences saved</h1><p>${form.get('subscribed') === 'yes' ? 'You\'re subscribed to news and offers again.' : 'You won\'t receive marketing emails any more.'}</p>`);
  }
  throw new HttpError(404, 'Unknown action');
});
