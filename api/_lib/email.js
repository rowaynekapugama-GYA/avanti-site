// Email: sending (Resend), the email log, and branded templates with plain-text versions.
import crypto from 'node:crypto';
import { config, escHtml as e, money, HttpError } from './core.js';

// ---------- sending ----------
// Every message is written to email_log first, then sent. Without RESEND_API_KEY the log row is
// marked 'logged' and nothing leaves the building (useful for staging and tests).
export async function sendEmail(d, msg, cfg = config()) {
  const [log] = await d.insert('email_log', {
    kind: msg.kind, template: msg.template || null, to_email: msg.to, subject: msg.subject,
    order_id: msg.order_id || null, campaign_id: msg.campaign_id || null, automation_key: msg.automation_key || null,
    customer_id: msg.customer_id || null, provider: cfg.email.mode, status: 'queued' });
  if (cfg.email.mode !== 'resend') { await d.update('email_log', `id=eq.${log.id}`, { status: 'logged' }); return { ...log, status: 'logged' }; }
  try {
    const r = await fetch(`${cfg.email.apiBase}/emails`, { method: 'POST',
      headers: { Authorization: `Bearer ${cfg.email.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': log.id },
      body: JSON.stringify(payload(msg, cfg)) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `Resend error ${r.status}`);
    await d.update('email_log', `id=eq.${log.id}`, { status: 'sent', provider_id: data.id });
    return { ...log, status: 'sent', provider_id: data.id };
  } catch (err) {
    await d.update('email_log', `id=eq.${log.id}`, { status: 'failed', error: String(err.message).slice(0, 500) });
    return { ...log, status: 'failed', error: err.message };
  }
}
function payload(msg, cfg) {
  return { from: msg.from || (msg.kind === 'transactional' ? cfg.email.from : cfg.email.marketingFrom), to: [msg.to],
    reply_to: cfg.email.replyTo, subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers || undefined,
    tags: msg.campaign_id ? [{ name: 'campaign', value: msg.campaign_id.replace(/[^\w-]/g, '') }] : undefined };
}

// Campaigns go out in batches of up to 100 (one API call each), all logged individually.
export async function sendBatch(d, msgs, cfg = config()) {
  const results = [];
  for (let i = 0; i < msgs.length; i += 100) {
    const chunk = msgs.slice(i, i + 100);
    const logs = await d.insert('email_log', chunk.map(m => ({ kind: m.kind, template: m.template || null, to_email: m.to, subject: m.subject,
      campaign_id: m.campaign_id || null, automation_key: m.automation_key || null, customer_id: m.customer_id || null,
      provider: cfg.email.mode, status: 'queued' })));
    if (cfg.email.mode !== 'resend') {
      await d.update('email_log', `id=in.(${logs.map(l => l.id).join(',')})`, { status: 'logged' });
      results.push(...logs.map(l => ({ ...l, status: 'logged' }))); continue;
    }
    try {
      const r = await fetch(`${cfg.email.apiBase}/emails/batch`, { method: 'POST',
        headers: { Authorization: `Bearer ${cfg.email.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `batch-${logs[0].id}` },
        body: JSON.stringify(chunk.map(m => payload(m, cfg))) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || `Resend error ${r.status}`);
      const ids = (data.data || []).map(x => x.id);
      await Promise.all(logs.map((l, j) => d.update('email_log', `id=eq.${l.id}`, { status: 'sent', provider_id: ids[j] || null })));
      results.push(...logs.map((l, j) => ({ ...l, status: 'sent', provider_id: ids[j] })));
    } catch (err) {
      await d.update('email_log', `id=in.(${logs.map(l => l.id).join(',')})`, { status: 'failed', error: String(err.message).slice(0, 500) });
      results.push(...logs.map(l => ({ ...l, status: 'failed' })));
    }
  }
  return results;
}

// Resend signs webhooks with Svix: svix-signature "v1,<base64 HMAC-SHA256(secret, `${id}.${ts}.${body}`)>"
export function svixVerify(raw, headers, secret, toleranceSec = 300, now = Date.now()) {
  if (!secret) throw new HttpError(500, 'Webhook secret is not configured');
  const id = headers.get('svix-id'), ts = headers.get('svix-timestamp'), sig = headers.get('svix-signature') || '';
  if (!id || !ts || !sig) throw new HttpError(400, 'Missing signature');
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSec) throw new HttpError(400, 'Signature timestamp outside tolerance');
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  const ok = sig.split(' ').some(p => { const v = p.split(',')[1] || ''; return v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); });
  if (!ok) throw new HttpError(400, 'Invalid signature');
  return JSON.parse(raw);
}
export function svixSign(raw, secret, id = 'msg_' + crypto.randomUUID(), ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64') };
}

// ---------- templates ----------
const RED = '#C41E2A', INK = '#17161a', MUTED = '#6b6870', LINE = '#ebe8e2';
function footer(cfg, marketing) {
  const b = cfg.business;
  const id = [b.name, b.abn && `ABN ${b.abn}`, b.address].filter(Boolean).map(e).join(' · ');
  const contact = [b.phone, b.email].filter(Boolean).map(e).join(' · ');
  return `<p style="margin:0 0 6px">${id}</p><p style="margin:0 0 6px">${contact}</p>${marketing || ''}`;
}
export function layout({ preheader = '', body, cfg = config(), marketingFooter = '' }) {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title></title></head>
<body style="margin:0;padding:0;background:#f4f2ee;font-family:Helvetica,Arial,sans-serif;color:${INK}">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden">${e(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="padding:22px 28px;border-bottom:3px solid ${RED}"><a href="${cfg.siteUrl}/"><img src="${cfg.siteUrl}/assets/logo-trim.png" width="150" alt="${e(cfg.brand)}" style="display:block;border:0;height:auto"></a></td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">${body}</td></tr>
<tr><td style="padding:18px 28px;background:#faf8f5;border-top:1px solid ${LINE};font-size:12px;line-height:1.5;color:${MUTED}">${footer(cfg, marketingFooter)}</td></tr>
</table></td></tr></table></body></html>`;
}
const h1 = t => `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${INK}">${e(t)}</h1>`;
const p = t => `<p style="margin:0 0 14px">${t}</p>`;
const btn = (label, url) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td style="background:${RED};border-radius:999px"><a href="${e(url)}" style="display:inline-block;padding:12px 26px;color:#fff;font-weight:bold;text-decoration:none">${e(label)}</a></td></tr></table>`;
function itemsTable(o) {
  const rows = (o.items || []).map(i => `<tr><td style="padding:8px 0;border-bottom:1px solid ${LINE}"><b>${e(i.name)}</b> × ${i.qty}${Object.keys(i.options || {}).length ? `<br><span style="color:${MUTED};font-size:13px">${e(Object.values(i.options).join(' · '))}</span>` : ''}${i.artwork && i.artwork.later ? `<br><span style="color:${MUTED};font-size:13px">Artwork to follow</span>` : ''}</td><td align="right" style="padding:8px 0;border-bottom:1px solid ${LINE};white-space:nowrap">${money(i.line_cents)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;font-size:14px">${rows}
<tr><td style="padding:8px 0">Delivery${o.delivery_method ? `<br><span style="color:${MUTED};font-size:13px">${e(o.delivery_method)}</span>` : ''}</td><td align="right">${money(o.delivery_cents)}</td></tr>
<tr><td style="padding:8px 0;font-weight:bold">Total (AUD)</td><td align="right" style="font-weight:bold">${money(o.total_cents)}</td></tr>
<tr><td colspan="2" style="color:${MUTED};font-size:12px">Includes GST of ${money(o.gst_cents)}</td></tr></table>`;
}
const itemsText = o => (o.items || []).map(i => `- ${i.name} x ${i.qty}${Object.keys(i.options || {}).length ? ` (${Object.values(i.options).join(', ')})` : ''}: ${money(i.line_cents)}`).join('\n')
  + `\nDelivery: ${money(o.delivery_cents)}\nTotal (AUD): ${money(o.total_cents)} (includes GST of ${money(o.gst_cents)})`;
const addressText = a => [a.line1, a.line2, `${a.suburb} ${a.state} ${a.postcode}`].filter(Boolean).join(', ');
const first = n => String(n || '').trim().split(/\s+/)[0] || 'there';

export const CARRIERS = {
  'Australia Post': n => `https://auspost.com.au/mypost/track/details/${encodeURIComponent(n)}`,
  StarTrack: n => `https://startrack.com.au/track/details/${encodeURIComponent(n)}`,
  Sendle: n => `https://track.sendle.com/tracking?ref=${encodeURIComponent(n)}`,
  Aramex: n => `https://www.aramex.com.au/tools/track?l=${encodeURIComponent(n)}`,
  'Couriers Please': n => `https://www.couriersplease.com.au/tools-track/no/${encodeURIComponent(n)}`,
  TNT: n => `https://www.tnt.com/express/en_au/site/shipping-tools/tracking.html?searchType=con&cons=${encodeURIComponent(n)}`,
  'Own delivery': () => '',
  Other: () => '',
};
export const trackingUrl = (o) => o.tracking_url || (CARRIERS[o.carrier] ? CARRIERS[o.carrier](o.tracking_number || '') : '') || '';

// One template per status change the customer hears about.
export function orderEmail(kind, o, cfg = config()) {
  const link = `${cfg.siteUrl}/#/order/${o.id}?t=${o.public_token}`;
  const T = {
    paid: {
      subject: `Order confirmed: ${o.number}`, pre: `Thanks ${first(o.name)}, we've received your order.`,
      body: h1(`Thanks, ${first(o.name)}. Your order is confirmed.`) + p(`We've received your payment for order <b>${e(o.number)}</b>. We'll let you know when it goes into production${(o.items || []).some(i => i.artwork && i.artwork.later) ? ', and we will be in touch about the artwork you are supplying' : ''}.`)
        + itemsTable(o) + p(`<b>Delivering to</b><br>${e(o.name)}<br>${e(addressText(o.shipping_address || {}))}`)
        + (o.delivery_quote_required ? p('Some items in this order need a delivery quote. We will contact you to confirm delivery before dispatch.') : '') + btn('View your order', link),
      text: `Thanks ${first(o.name)}, your order ${o.number} is confirmed.\n\n${itemsText(o)}\n\nDelivering to: ${o.name}, ${addressText(o.shipping_address || {})}\n\nView your order: ${link}`,
    },
    in_production: {
      subject: `Your order ${o.number} is in production`, pre: 'Your order is being made now.',
      body: h1('Your order is in production') + p(`Good news: order <b>${e(o.number)}</b> is being made in our Western Sydney factory. We'll email you tracking details as soon as it's dispatched.`) + btn('View your order', link),
      text: `Order ${o.number} is in production. We'll email tracking details when it's dispatched.\n\n${link}`,
    },
    dispatched: {
      subject: `Your order ${o.number} is on its way`, pre: `Sent with ${o.carrier || 'our courier'}.`,
      body: h1('Your order is on its way') + p(`Order <b>${e(o.number)}</b> has been dispatched with <b>${e(o.carrier || '')}</b>.`)
        + (o.tracking_number ? p(`Tracking number: <b>${e(o.tracking_number)}</b>`) : '') + (trackingUrl(o) ? btn('Track your delivery', trackingUrl(o)) : btn('View your order', link)),
      text: `Order ${o.number} has been dispatched with ${o.carrier || ''}.${o.tracking_number ? `\nTracking number: ${o.tracking_number}` : ''}${trackingUrl(o) ? `\nTrack it: ${trackingUrl(o)}` : ''}\n\n${link}`,
    },
    cancelled: {
      subject: `Order ${o.number} has been cancelled`, pre: 'Your order has been cancelled.',
      body: h1('Your order has been cancelled') + p(`Order <b>${e(o.number)}</b> has been cancelled.`) + p(o.paid_at ? 'Any payment you made will be refunded to your original payment method. Refunds usually appear within 5 to 10 business days.' : 'You have not been charged.') + p(`If this is unexpected, reply to this email or call us on ${e(cfg.business.phone)}.`),
      text: `Order ${o.number} has been cancelled. ${o.paid_at ? 'Any payment will be refunded to your original payment method within 5 to 10 business days.' : 'You have not been charged.'}\nQuestions? Reply to this email or call ${cfg.business.phone}.`,
    },
    refunded: {
      subject: `Refund for order ${o.number}`, pre: `We've refunded ${money(o.total_cents)}.`,
      body: h1('Your refund is on its way') + p(`We've refunded order <b>${e(o.number)}</b> to your original payment method. It usually appears within 5 to 10 business days.`) + p(`Questions? Reply to this email or call us on ${e(cfg.business.phone)}.`),
      text: `We've refunded order ${o.number} to your original payment method. It usually appears within 5 to 10 business days.`,
    },
  }[kind];
  if (!T) return null;
  return { subject: T.subject, html: layout({ preheader: T.pre, body: T.body, cfg }), text: T.text + `\n\n${cfg.business.name}\n${cfg.business.phone} · ${cfg.business.email}` };
}

// ---------- campaign blocks ----------
// Blocks: heading{text} text{html} image{url,alt,link} button{label,url} divider products{items:[{name,price,url,image}]} cart spacer
const SAFE_TAGS = /^(p|br|b|strong|i|em|u|a|ul|ol|li|h2|h3|h4|span)$/i;
export function cleanHtml(s) {   // small allow-list sanitiser for staff-written text blocks
  return String(s || '').replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (m, tag, attrs) => {
      if (!SAFE_TAGS.test(tag)) return '';
      if (m.startsWith('</')) return `</${tag.toLowerCase()}>`;
      if (tag.toLowerCase() === 'a') { const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || [])[1] || '';
        return /^(https?:|mailto:|tel:|\/|#|\{\{)/i.test(href) ? `<a href="${e(href)}" style="color:${RED}">` : '<a>'; }
      return `<${tag.toLowerCase()}>`;
    });
}
export function renderBlocks(blocks, ctx = {}, cfg = config()) {
  const abs = u => { u = String(u || ''); if (u.startsWith('{{')) return u; return /^https?:/i.test(u) ? u : `${cfg.siteUrl}${u.startsWith('/') ? '' : '/'}${u}`; };
  // tag links back to the shop with ?c=<campaign> (before the #) so resulting orders are attributed
  const track = u => { if (!ctx.campaignId || !u.startsWith(cfg.siteUrl)) return u;
    const i = u.indexOf('#'), base = i < 0 ? u : u.slice(0, i), hash = i < 0 ? '' : u.slice(i);
    return `${base}${base.includes('?') ? '&' : '?'}c=${ctx.campaignId}${hash}`; };
  const html = [], text = [];
  for (const b of blocks || []) {
    if (b.type === 'heading') { html.push(h1(b.text || '')); text.push(String(b.text || '').toUpperCase()); }
    else if (b.type === 'text') { const c = cleanHtml(b.html).replace(/<p>/g, '<p style="margin:0 0 14px">'); html.push(c); text.push(c.replace(/<br>/g, '\n').replace(/<\/p>/g, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()); }
    else if (b.type === 'image' && b.url) { const img = `<img src="${e(abs(b.url))}" alt="${e(b.alt || '')}" width="544" style="display:block;width:100%;height:auto;border:0;border-radius:8px;margin:0 0 16px">`; html.push(b.link ? `<a href="${e(track(abs(b.link)))}">${img}</a>` : img); }
    else if (b.type === 'button' && b.label) { const u = track(abs(b.url || '/')); html.push(btn(b.label, u)); text.push(`${b.label}: ${u}`); }
    else if (b.type === 'divider') { html.push(`<hr style="border:0;border-top:1px solid ${LINE};margin:20px 0">`); }
    else if (b.type === 'products' && Array.isArray(b.items)) {
      html.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr>${b.items.slice(0, 3).map(i => `<td width="33%" valign="top" style="padding:0 6px;text-align:center;font-size:13px"><a href="${e(track(abs(i.url)))}" style="color:${INK};text-decoration:none">${i.image ? `<img src="${e(abs(i.image))}" alt="" width="170" style="width:100%;height:auto;border-radius:6px;display:block;margin:0 0 8px">` : ''}<b>${e(i.name)}</b>${i.price ? `<br>${e(i.price)}` : ''}</a></td>`).join('')}</tr></table>`);
      b.items.slice(0, 3).forEach(i => text.push(`${i.name}${i.price ? ` (${i.price})` : ''}: ${track(abs(i.url))}`));
    }
    else if (b.type === 'cart' && ctx.order) { html.push(itemsTable(ctx.order)); text.push(itemsText(ctx.order)); }
  }
  const fill = s => s.replace(/\{\{\s*first_name\s*\}\}/g, e(first(ctx.name))).replace(/\{\{\s*resume_url\s*\}\}/g, ctx.resumeUrl || `${cfg.siteUrl}/#/checkout`)
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, ctx.unsubscribeUrl || '#');
  return { html: fill(html.join('\n')), text: fill(text.join('\n\n')) };
}

// Wrap marketing content with the legally required bits: who we are, why they're getting it, one-click unsubscribe.
export function marketingEmail({ subject, preview, blocks, customer, campaignId, order, resumeUrl }, cfg = config()) {
  const unsub = `${cfg.siteUrl}/api/email?action=unsubscribe&t=${customer.pref_token}`;
  const prefs = `${cfg.siteUrl}/api/email?action=preferences&t=${customer.pref_token}`;
  const body = renderBlocks(blocks, { name: customer.name, campaignId, order, resumeUrl, unsubscribeUrl: unsub }, cfg);
  const why = `You're receiving this because you subscribed to ${e(cfg.business.name)} emails${customer.consent_at ? ` on ${new Date(customer.consent_at).toLocaleDateString('en-AU')}` : ''}.`;
  const mf = `<p style="margin:10px 0 0">${why} <a href="${e(unsub)}" style="color:${MUTED}">Unsubscribe</a> · <a href="${e(prefs)}" style="color:${MUTED}">Email preferences</a></p>`;
  return {
    subject, html: layout({ preheader: preview || '', body: body.html, cfg, marketingFooter: mf }),
    text: `${body.text}\n\n--\n${cfg.business.name}${cfg.business.abn ? ` · ABN ${cfg.business.abn}` : ''}${cfg.business.address ? `\n${cfg.business.address}` : ''}\n${why.replace(/&amp;/g, '&')}\nUnsubscribe: ${unsub}\nPreferences: ${prefs}`,
    headers: { 'List-Unsubscribe': `<${unsub}>, <mailto:${cfg.email.replyTo}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}
