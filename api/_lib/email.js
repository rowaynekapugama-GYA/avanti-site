// Email: sending (Resend), the email log, and branded templates with plain-text versions.
import crypto from 'node:crypto';
import { config, escHtml as e, money, HttpError } from './core.js';

// ---------- sending ----------
// Every message is written to email_log first, then sent. Without RESEND_API_KEY the log row is
// marked 'logged' and nothing leaves the building (useful for staging and tests).
// EMAIL_TEST_RECIPIENT: send everything to one test address instead, and say who it was really for.
const redirect = (msg, cfg) => cfg.email.testRecipient
  ? { ...msg, to: cfg.email.testRecipient, bcc: undefined, subject: `[TEST for ${msg.to}] ${msg.subject}` } : msg;

export async function sendEmail(d, msg, cfg = config()) {
  msg = redirect(msg, cfg);
  const [log] = await d.insert('email_log', {
    kind: msg.kind, template: msg.template || null, to_email: msg.to, subject: msg.subject,
    order_id: msg.order_id || null, campaign_id: msg.campaign_id || null, automation_key: msg.automation_key || null,
    customer_id: msg.customer_id || null, provider: cfg.email.mode, status: 'queued' });
  if (cfg.email.mode !== 'resend') { await d.update('email_log', `id=eq.${log.id}`, { status: 'logged' }); return { ...log, status: 'logged' }; }
  try {
    const r = await fetch(`${cfg.email.apiBase}/emails`, { method: 'POST',
      headers: { Authorization: `Bearer ${cfg.email.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': log.id },
      body: JSON.stringify(payload(msg, cfg)), signal: AbortSignal.timeout(10000) });   // a hung email service never holds up an order
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
  return { from: msg.from || (msg.kind === 'transactional' ? cfg.email.from : cfg.email.marketingFrom), to: [msg.to], bcc: msg.bcc ? [msg.bcc] : undefined,
    reply_to: msg.replyTo || cfg.email.replyTo, subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers || undefined,
    tags: msg.campaign_id ? [{ name: 'campaign', value: msg.campaign_id.replace(/[^\w-]/g, '') }] : undefined };
}

// Campaigns go out in batches of up to 100 (one API call each), all logged individually.
export async function sendBatch(d, msgs, cfg = config()) {
  msgs = msgs.map(m => redirect(m, cfg));
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
  const rows = (o.items || []).map(i => `<tr><td style="padding:8px 0;border-bottom:1px solid ${LINE}"><b>${e(i.name)}</b> × ${i.qty}${i.qty > 1 ? ` <span style="color:${MUTED};font-size:13px">at ${money(i.unit_cents)} each</span>` : ''}${Object.keys(i.options || {}).length ? `<br><span style="color:${MUTED};font-size:13px">${e(Object.values(i.options).join(' · '))}</span>` : ''}${i.artwork && i.artwork.later ? `<br><span style="color:${MUTED};font-size:13px">Artwork to follow</span>` : ''}</td><td align="right" style="padding:8px 0;border-bottom:1px solid ${LINE};white-space:nowrap">${money(i.line_cents)}</td></tr>`).join('');
  const sub = o.subtotal_cents != null ? o.subtotal_cents : (o.items || []).reduce((t, i) => t + i.line_cents, 0);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;font-size:14px">${rows}
<tr><td style="padding:8px 0">Subtotal</td><td align="right">${money(sub)}</td></tr>
<tr><td style="padding:8px 0">Delivery${o.delivery_method ? `<br><span style="color:${MUTED};font-size:13px">${e(o.delivery_method)}</span>` : ''}</td><td align="right">${money(o.delivery_cents)}</td></tr>
<tr><td style="padding:8px 0;font-weight:bold">Total (AUD)</td><td align="right" style="font-weight:bold">${money(o.total_cents)}</td></tr>
<tr><td colspan="2" style="color:${MUTED};font-size:12px">Includes GST of ${money(o.gst_cents)}</td></tr></table>`;
}
const itemsText = o => (o.items || []).map(i => `- ${i.name} x ${i.qty}${i.qty > 1 ? ` at ${money(i.unit_cents)} each` : ''}${Object.keys(i.options || {}).length ? ` (${Object.values(i.options).join(', ')})` : ''}: ${money(i.line_cents)}`).join('\n')
  + `\nSubtotal: ${money(o.subtotal_cents != null ? o.subtotal_cents : (o.items || []).reduce((t, i) => t + i.line_cents, 0))}\nDelivery: ${money(o.delivery_cents)}${o.delivery_method ? ` (${o.delivery_method})` : ''}\nTotal (AUD): ${money(o.total_cents)} (includes GST of ${money(o.gst_cents)})`;
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
export const trackingUrl = (o) => o.tracking_url || (o.tracking_number && CARRIERS[o.carrier] ? CARRIERS[o.carrier](o.tracking_number) : '') || '';

// One template per status change the customer hears about.
const placed = (o, cfg = config()) => o.paid_at || o.created_at ? new Date(o.paid_at || o.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: cfg.timezone }) : '';
const help = cfg => p(`Questions? Reply to this email, or call us on ${e(cfg.business.phone)}.`);
const helpText = cfg => `Questions? Reply to this email or call ${cfg.business.phone}.`;
const summary = o => p('<b>Your order</b>') + itemsTable(o);

export function orderEmail(kind, o, cfg = config()) {
  const link = `${cfg.siteUrl}/#/order/${o.id}?t=${o.public_token}`;
  const T = {
    paid: {
      subject: `Order confirmed: ${o.number}`, pre: `Thanks ${first(o.name)}, we've received your order.`,
      body: h1(`Thanks, ${first(o.name)}. Your order is confirmed.`) + p(`We've received your payment for order <b>${e(o.number)}</b>${placed(o, cfg) ? `, placed on ${e(placed(o, cfg))}` : ''}. We'll let you know when we start working on it${(o.items || []).some(i => i.artwork && i.artwork.later) ? ', and we will be in touch about the artwork you are supplying' : ''}.`)
        + itemsTable(o) + p(`<b>Delivering to</b><br>${e(o.name)}<br>${e(addressText(o.shipping_address || {}))}`)
        + (o.delivery_quote_required ? p('Some items in this order need a delivery quote. We will contact you to confirm delivery before dispatch.') : '') + btn('View your order', link) + help(cfg),
      text: `Thanks ${first(o.name)}, your order ${o.number} is confirmed.${placed(o, cfg) ? ` Placed ${placed(o, cfg)}.` : ''}\n\n${itemsText(o)}\n\nDelivering to: ${o.name}, ${addressText(o.shipping_address || {})}\n\nView your order: ${link}\n\n${helpText(cfg)}`,
    },
    in_production: {
      subject: `Your order ${o.number} is being processed`, pre: "We're working on your order now.",
      body: h1("We're working on your order") + p(`Good news: order <b>${e(o.number)}</b> is now being processed and made in our Western Sydney factory. We'll email you as soon as it's dispatched.`) + summary(o) + btn('View your order', link) + help(cfg),
      text: `Order ${o.number} is being processed. We'll email you when it's dispatched.\n\n${itemsText(o)}\n\nView your order: ${link}\n\n${helpText(cfg)}`,
    },
    dispatched: {
      subject: `Your order ${o.number} is on its way`, pre: o.carrier === 'Own delivery' ? 'Our team is delivering it.' : o.carrier && o.carrier !== 'Other' ? `Sent with ${o.carrier}.` : 'Your order has been dispatched.',
      body: h1('Your order is on its way') + p(`Order <b>${e(o.number)}</b> has been dispatched${o.carrier === 'Own delivery' ? ' and our team will deliver it' : o.carrier && o.carrier !== 'Other' ? ` with <b>${e(o.carrier)}</b>` : ''}.`)
        + (o.tracking_number ? p(`Tracking number: <b>${e(o.tracking_number)}</b>`) : '') + (trackingUrl(o) ? btn('Track your delivery', trackingUrl(o)) : btn('View your order', link)) + summary(o) + help(cfg),
      text: `Order ${o.number} has been dispatched${o.carrier === 'Own delivery' ? ' and our team will deliver it' : o.carrier && o.carrier !== 'Other' ? ` with ${o.carrier}` : ''}.${o.tracking_number ? `\nTracking number: ${o.tracking_number}` : ''}${trackingUrl(o) ? `\nTrack it: ${trackingUrl(o)}` : ''}\n\n${itemsText(o)}\n\nView your order: ${link}\n\n${helpText(cfg)}`,
    },
    delivered: {
      subject: `Your order ${o.number} has been delivered`, pre: 'We hope you love it.',
      body: h1('Your order has been delivered') + p(`Order <b>${e(o.number)}</b> has been delivered. We hope you love it. If anything isn't right, let us know and we'll sort it out.`) + summary(o) + btn('View your order', link) + help(cfg),
      text: `Order ${o.number} has been delivered. We hope you love it. If anything isn't right, let us know.\n\n${itemsText(o)}\n\nView your order: ${link}\n\n${helpText(cfg)}`,
    },
    cancelled: {
      subject: `Order ${o.number} has been cancelled`, pre: 'Your order has been cancelled.',
      body: h1('Your order has been cancelled') + p(`Order <b>${e(o.number)}</b> has been cancelled.`) + p(o.paid_at ? 'Any payment you made will be refunded to your original payment method. Refunds usually appear within 5 to 10 business days.' : 'You have not been charged.') + summary(o) + p(`If this is unexpected, reply to this email or call us on ${e(cfg.business.phone)}.`),
      text: `Order ${o.number} has been cancelled. ${o.paid_at ? 'Any payment will be refunded to your original payment method within 5 to 10 business days.' : 'You have not been charged.'}\n\n${itemsText(o)}\n\nQuestions? Reply to this email or call ${cfg.business.phone}.`,
    },
    refunded: {
      subject: `Refund for order ${o.number}`, pre: `We've refunded ${money(o.total_cents)}.`,
      body: h1('Your refund is on its way') + p(`We've refunded order <b>${e(o.number)}</b> to your original payment method. It usually appears within 5 to 10 business days.`) + summary(o) + help(cfg),
      text: `We've refunded order ${o.number} to your original payment method. It usually appears within 5 to 10 business days.\n\n${itemsText(o)}\n\n${helpText(cfg)}`,
    },
  }[kind];
  if (!T) return null;
  return { subject: T.subject, html: layout({ preheader: T.pre, body: T.body, cfg }), text: T.text + `\n\n${cfg.business.name}\n${cfg.business.phone} · ${cfg.business.email}` };
}

// Emails for the Avanti team: "New order" (kind 'new', with everything needed to start the job)
// and "Payment failed" (kind 'failed': the customer's payment didn't go through).
export function staffOrderEmail(o, cfg = config(), kind = 'new') {
  const failed = kind === 'failed';
  const a = o.shipping_address || {};
  const admin = `${cfg.siteUrl}/#/admin/orders/${o.id}`;
  const provider = { stripe: 'Card (Stripe)', paypal: 'PayPal', simulator: 'Test gateway' }[o.provider] || o.provider || '';
  const art = i => !i.artwork ? '' : i.artwork.later ? 'Artwork: customer will supply later'
    : (i.artwork.files || []).length ? `Artwork: ${(i.artwork.files || []).map(f => `${f.side} (${f.name})`).join(', ')}` : i.artwork.design ? `Design: ${i.artwork.design}` : '';
  const rows = (o.items || []).map(i => `<tr><td style="padding:8px 0;border-bottom:1px solid ${LINE}"><b>${e(i.name)}</b> × ${i.qty}${i.qty > 1 ? ` <span style="color:${MUTED};font-size:13px">at ${money(i.unit_cents)} each</span>` : ''}
${Object.keys(i.options || {}).length ? `<br><span style="color:${MUTED};font-size:13px">${Object.entries(i.options).map(([k, v]) => `${e(k)}: ${e(v)}`).join(' · ')}</span>` : ''}${art(i) ? `<br><span style="color:${MUTED};font-size:13px">${e(art(i))}</span>` : ''}</td>
<td align="right" style="padding:8px 0;border-bottom:1px solid ${LINE};white-space:nowrap">${money(i.line_cents)}</td></tr>`).join('');
  const body = (failed ? h1(`Payment failed: order ${o.number}`) + p(`<b>${e(o.name || o.email)}</b> tried to pay <b>${money(o.total_cents)}</b>${provider ? ` by ${e(provider)}` : ''}, but the payment didn't go through, so the checkout was cancelled automatically. They have not been charged. You may want to get in touch and help them finish the order.`)
      : h1(`New order ${o.number}`) + p(`<b>${money(o.total_cents)}</b> paid${provider ? ` by ${e(provider)}` : ''}${placed(o, cfg) ? ` on ${e(placed(o, cfg))}` : ''}.`))
    + btn('Open the order in the dashboard', admin)
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;font-size:14px">${rows}
<tr><td style="padding:8px 0">Delivery${o.delivery_method ? `<br><span style="color:${MUTED};font-size:13px">${e(o.delivery_method)}</span>` : ''}${o.delivery_quote_required ? `<br><span style="color:${RED};font-size:13px">Needs a courier quote before dispatch</span>` : ''}</td><td align="right">${money(o.delivery_cents)}</td></tr>
<tr><td style="padding:8px 0;font-weight:bold">Total (AUD)</td><td align="right" style="font-weight:bold">${money(o.total_cents)}</td></tr></table>`
    + p(`<b>Customer</b><br>${e(o.name || '')}${o.company ? `<br>${e(o.company)}` : ''}<br>${e(o.email)}${o.phone ? `<br>${e(o.phone)}` : ''}`)
    + p(`<b>Deliver to</b><br>${e(addressText(a))}`) + (o.customer_note ? p(`<b>Customer note</b><br>${e(o.customer_note)}`) : '');
  const text = (failed ? `Payment failed for order ${o.number}: ${money(o.total_cents)}${provider ? ` by ${provider}` : ''}. The checkout was cancelled automatically and the customer has not been charged. You may want to get in touch and help them finish the order.\n\n`
      : `New order ${o.number}: ${money(o.total_cents)} paid${provider ? ` by ${provider}` : ''}.\n\n`)
    + (o.items || []).map(i => `- ${i.name} x ${i.qty}: ${money(i.line_cents)}${Object.keys(i.options || {}).length ? `\n  ${Object.entries(i.options).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}${art(i) ? `\n  ${art(i)}` : ''}`).join('\n')
    + `\nDelivery: ${money(o.delivery_cents)}${o.delivery_method ? ` (${o.delivery_method})` : ''}${o.delivery_quote_required ? ' - needs a courier quote' : ''}\nTotal: ${money(o.total_cents)}\n\n`
    + `Customer: ${o.name || ''}${o.company ? `, ${o.company}` : ''}, ${o.email}${o.phone ? `, ${o.phone}` : ''}\nDeliver to: ${addressText(a)}${o.customer_note ? `\nNote: ${o.customer_note}` : ''}\n\nOpen in the dashboard: ${admin}`;
  return { subject: failed ? `Payment failed for order ${o.number} (${money(o.total_cents)}, ${o.name || o.email})` : `New order ${o.number}: ${money(o.total_cents)} from ${o.name || o.email}`, html: layout({ preheader: `${(o.items || []).length} item(s), ${money(o.total_cents)}`, body, cfg }), text };
}

// A note from the Avanti team to the customer about their order (like WooCommerce's "customer note").
export function customerNoteEmail(o, note, cfg = config()) {
  const link = `${cfg.siteUrl}/#/order/${o.id}?t=${o.public_token}`;
  const body = h1('A note about your order') + p(`Hi ${e(first(o.name))}, here's an update about order <b>${e(o.number)}</b>:`)
    + `<blockquote style="margin:0 0 16px;padding:12px 16px;background:#faf8f5;border-left:3px solid ${RED};border-radius:0 8px 8px 0">${e(note).replace(/\n/g, '<br>')}</blockquote>`
    + summary(o) + btn('View your order', link) + help(cfg);
  const text = `Hi ${first(o.name)}, here's an update about order ${o.number}:\n\n${note}\n\n${itemsText(o)}\n\nView your order: ${link}\n\n${helpText(cfg)}\n\n${cfg.business.name}\n${cfg.business.phone} · ${cfg.business.email}`;
  return { subject: `A note about your order ${o.number}`, html: layout({ preheader: note.slice(0, 90), body, cfg }), text };
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
