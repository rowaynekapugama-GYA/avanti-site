// Marketing: consent, segments, campaigns, automations.
// Rule enforced everywhere: marketing email only goes to customers who are subscribed, have a
// recorded consent basis and date, and are not suppressed (hard bounce / complaint).
import { config, HttpError, audit } from './core.js';
import { sendEmail, sendBatch, marketingEmail } from './email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const BASES = ['checkout_opt_in', 'footer_signup', 'imported_list', 'admin_added'];
export const canMarket = c => !!c && c.marketing_status === 'subscribed' && !!c.consent_basis && !!c.consent_at && !c.suppressed;

async function logConsent(d, customer_id, action, x = {}) {
  await d.insert('consent_log', { customer_id, action, basis: x.basis || null, source: x.source || null, ip: x.ip || null,
    user_agent: x.ua ? String(x.ua).slice(0, 300) : null, actor: x.actor || 'customer' });
}

// Subscribe with a recorded basis. An import can never re-subscribe someone who unsubscribed:
// only the person themselves (signup form, checkout box) can undo their own unsubscribe.
export async function subscribe(d, { email, name, basis, source, ip, ua, actor = 'customer', state, tags }) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!BASES.includes(basis)) throw new HttpError(400, 'Unknown consent basis.');
  let c = await d.one('customers', `select=*&email=eq.${d.q(email)}`);
  if (!c) [c] = await d.insert('customers', { email, name: name || null, state: state || null, tags: tags || [] });
  if (c.marketing_status === 'subscribed') return { customer: c, changed: false };
  const selfService = basis === 'checkout_opt_in' || basis === 'footer_signup';
  if (c.marketing_status === 'unsubscribed' && !selfService) return { customer: c, changed: false, skipped: 'previously unsubscribed' };
  const [u] = await d.update('customers', `id=eq.${c.id}`, { marketing_status: 'subscribed', consent_basis: basis, consent_at: new Date().toISOString(),
    consent_source: source ? String(source).slice(0, 300) : null, consent_ip: ip || null, unsubscribed_at: null,
    name: c.name || name || null, updated_at: new Date().toISOString() });
  await logConsent(d, c.id, c.marketing_status === 'unsubscribed' ? 'resubscribe' : 'subscribe', { basis, source, ip, ua, actor });
  return { customer: u, changed: true };
}

export async function unsubscribe(d, { token, customerId, source, ip, ua, actor = 'customer' }) {
  const c = customerId ? await d.one('customers', `select=*&id=eq.${d.q(customerId)}`)
    : /^[0-9a-f-]{36}$/.test(token || '') ? await d.one('customers', `select=*&pref_token=eq.${d.q(token)}`) : null;
  if (!c) throw new HttpError(404, 'This link is no longer valid.');
  if (c.marketing_status !== 'unsubscribed') {
    await d.update('customers', `id=eq.${c.id}`, { marketing_status: 'unsubscribed', unsubscribed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    await logConsent(d, c.id, 'unsubscribe', { source, ip, ua, actor });
  }
  return { ...c, marketing_status: 'unsubscribed' };
}

export async function suppress(d, email, reason) {
  const c = await d.one('customers', `select=id,suppressed&email=eq.${d.q(String(email).toLowerCase())}`);
  if (!c || c.suppressed) return;
  await d.update('customers', `id=eq.${c.id}`, { suppressed: true, suppressed_reason: String(reason).slice(0, 200), updated_at: new Date().toISOString() });
  await logConsent(d, c.id, 'suppress', { source: reason, actor: 'system' });
}

// ---------- segments ----------
// rules: {match:'all'|'any', rules:[{field, op, value}]}
//   category   includes | excludes   <category slug>
//   last_order within | more_than    <days>        ('never' op: no paid order yet)
//   total_spent gte | lte            <dollars>
//   orders     gte | lte             <count>
//   state      in | not_in           [NSW, VIC, ...]
//   tag        has | lacks           <tag>
//   subscribed within                <days>
const DAY = 86400000;
export function matches(rules, c, now = Date.now()) {
  const list = (rules && rules.rules) || [];
  if (!list.length) return true;
  const test = r => {
    const v = r.value, days = n => c[n] ? (now - new Date(c[n]).getTime()) / DAY : Infinity;
    switch (r.field) {
      case 'category': return r.op === 'excludes' ? !(c.categories || []).includes(v) : (c.categories || []).includes(v);
      case 'last_order': return r.op === 'never' ? !c.last_order_at : r.op === 'within' ? days('last_order_at') <= +v : c.last_order_at ? days('last_order_at') > +v : false;
      case 'total_spent': return r.op === 'lte' ? (c.total_spent_cents || 0) <= +v * 100 : (c.total_spent_cents || 0) >= +v * 100;
      case 'orders': return r.op === 'lte' ? (c.paid_orders || 0) <= +v : (c.paid_orders || 0) >= +v;
      case 'state': { const s = [].concat(v || []); return r.op === 'not_in' ? !s.includes(c.state) : s.includes(c.state); }
      case 'tag': return r.op === 'lacks' ? !(c.tags || []).includes(v) : (c.tags || []).includes(v);
      case 'subscribed': return days('consent_at') <= +v;
      default: return false;
    }
  };
  return rules.match === 'any' ? list.some(test) : list.every(test);
}

// Everyone who may legally receive marketing, with their order history attached.
export async function marketable(d) {
  const [cs, stats] = await Promise.all([
    d.select('customers', 'select=*&marketing_status=eq.subscribed&suppressed=eq.false&consent_basis=not.is.null&consent_at=not.is.null'),
    d.select('customer_stats', 'select=*'),
  ]);
  const byId = Object.fromEntries(stats.map(s => [s.customer_id, s]));
  return cs.filter(canMarket).map(c => ({ ...c, ...(byId[c.id] || {}), id: c.id }));
}
export async function audience(d, segmentId) {
  const all = await marketable(d);
  if (!segmentId) return all;
  const seg = await d.one('segments', `select=*&id=eq.${d.q(segmentId)}`);
  if (!seg) throw new HttpError(404, 'Segment not found.');
  return all.filter(c => matches(seg.rules, c));
}

// ---------- campaigns ----------
export async function sendCampaign(d, id, actor, cfg = config()) {
  // claim it: only one sender can move a campaign into 'sending'
  const claimed = await d.update('campaigns', `id=eq.${d.q(id)}&status=in.(draft,scheduled)`, { status: 'sending', updated_at: new Date().toISOString() });
  if (!claimed.length) throw new HttpError(409, 'This campaign has already been sent or is sending.');
  const camp = claimed[0];
  try {
    if (!camp.subject || !(camp.blocks || []).length) throw new HttpError(400, 'Add a subject and some content before sending.');
    const people = await audience(d, camp.segment_id);
    const msgs = people.filter(canMarket).map(c => ({ kind: 'campaign', template: 'campaign', to: c.email, campaign_id: camp.id, customer_id: c.id,
      ...marketingEmail({ subject: camp.subject, preview: camp.preview_text, blocks: camp.blocks, customer: c, campaignId: camp.id }, cfg) }));
    await sendBatch(d, msgs, cfg);
    await d.update('campaigns', `id=eq.${camp.id}`, { status: 'sent', sent_at: new Date().toISOString(), recipients: msgs.length, updated_at: new Date().toISOString() });
    await audit(d, actor, 'campaign.send', 'campaign', camp.id, { recipients: msgs.length });
    return { recipients: msgs.length };
  } catch (err) {
    // a campaign that never went out goes back to draft so it can be fixed and sent; one that fails mid-send is marked failed
    const back = err instanceof HttpError && err.status === 400 ? 'draft' : 'failed';
    await d.update('campaigns', `id=eq.${camp.id}`, { status: back, updated_at: new Date().toISOString() });
    throw err;
  }
}

export async function sendTest(d, { campaign, to, name }, cfg = config()) {
  const fake = { email: to, name: name || 'there', pref_token: '00000000-0000-0000-0000-000000000000', consent_at: new Date().toISOString() };
  const m = marketingEmail({ subject: `[Test] ${campaign.subject || '(no subject)'}`, preview: campaign.preview_text, blocks: campaign.blocks || [], customer: fake, campaignId: campaign.id }, cfg);
  return sendEmail(d, { kind: 'test', template: 'campaign-test', to, campaign_id: campaign.id || null, ...m }, cfg);
}

export async function campaignStats(d, ids) {
  if (!ids.length) return {};
  const list = ids.map(d.q).join(',');
  const [logs, orders] = await Promise.all([
    d.select('email_log', `select=campaign_id,status,opened_at,clicked_at&campaign_id=in.(${list})&kind=eq.campaign`),
    d.select('orders', `select=campaign_id,total_cents&campaign_id=in.(${list})&status=in.(paid,in_production,dispatched,delivered)`),
  ]);
  const out = Object.fromEntries(ids.map(id => [id, { sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, opened: 0, clicked: 0, revenue_cents: 0, orders: 0 }]));
  logs.forEach(l => { const s = out[l.campaign_id]; if (!s) return; s.sent++;
    if (['delivered', 'complained'].includes(l.status) || l.opened_at || l.clicked_at) s.delivered++;
    if (l.status === 'bounced') s.bounced++; if (l.status === 'complained') s.complained++; if (l.status === 'failed') s.failed++;
    if (l.opened_at) s.opened++; if (l.clicked_at) s.clicked++; });
  orders.forEach(o => { const s = out[o.campaign_id]; if (s) { s.revenue_cents += o.total_cents; s.orders++; } });
  return out;
}

// ---------- scheduled work (called by the cron endpoint) ----------
export async function runScheduled(d, now = new Date(), cfg = config()) {
  const due = await d.select('campaigns', `select=id&status=eq.scheduled&scheduled_at=lte.${d.q(now.toISOString())}`);
  const done = [];
  for (const c of due) { try { done.push({ id: c.id, ...(await sendCampaign(d, c.id, 'system:schedule', cfg)) }); } catch (e) { done.push({ id: c.id, error: e.message }); } }
  return done;
}

async function flowSend(d, flow, c, ref, extra, cfg) {
  const claim = await d.insert('automation_sends', { flow_key: flow.key, email: c.email, ref }, { onConflict: 'flow_key,email,ref', ignore: true });
  if (!claim.length) return false;   // already sent this one
  const m = marketingEmail({ subject: flow.subject, preview: flow.preview_text, blocks: flow.blocks, customer: c, ...extra }, cfg);
  const log = await sendEmail(d, { kind: 'automation', template: flow.key, automation_key: flow.key, to: c.email, customer_id: c.id, ...m }, cfg);
  await d.update('automation_sends', `id=eq.${claim[0].id}`, { email_id: log.id });
  return true;
}

export async function runAutomations(d, now = new Date(), cfg = config()) {
  const flows = await d.select('automation_flows', 'select=*&enabled=eq.true');
  if (!flows.length) return {};
  const people = await marketable(d), byEmail = Object.fromEntries(people.map(c => [c.email, c]));
  const t = now.getTime(), iso = ms => new Date(ms).toISOString(), sent = {};
  for (const f of flows) {
    let n = 0; const cutoff = t - f.delay_hours * 3600000;
    if (f.key === 'welcome') {
      for (const c of people) if (new Date(c.consent_at).getTime() <= cutoff && new Date(c.consent_at).getTime() > t - 30 * 86400000)
        n += await flowSend(d, f, c, 'signup', {}, cfg) ? 1 : 0;
    }
    if (f.key === 'abandoned_cart') {
      // checkout started (an unpaid order exists) and nothing paid by that email since; within 7 days of the cutoff
      const pend = await d.select('orders', `select=*&status=eq.pending_payment&created_at=lte.${d.q(iso(cutoff))}&created_at=gte.${d.q(iso(cutoff - 7 * 86400000))}`);
      for (const o of pend) {
        const c = byEmail[o.email]; if (!c) continue;
        const later = await d.select('orders', `select=id&email=eq.${d.q(o.email)}&status=in.(paid,in_production,dispatched,delivered)&created_at=gte.${d.q(o.created_at)}&limit=1`);
        if (later.length) continue;
        o.items = await d.select('order_items', `select=*&order_id=eq.${o.id}&order=position`);
        n += await flowSend(d, f, c, o.id, { order: o, resumeUrl: `${cfg.siteUrl}/#/checkout` }, cfg) ? 1 : 0;
      }
    }
    if (f.key === 'post_purchase') {
      const cats = f.categories && f.categories.length ? f.categories : null;
      const paid = await d.select('orders', `select=id,email,paid_at&status=in.(paid,in_production,dispatched,delivered)&paid_at=lte.${d.q(iso(cutoff))}&paid_at=gte.${d.q(iso(cutoff - 14 * 86400000))}`);
      for (const o of paid) {
        const c = byEmail[o.email]; if (!c) continue;
        if (cats) { const items = await d.select('order_items', `select=category_slug&order_id=eq.${o.id}`); if (!items.some(i => cats.includes(i.category_slug))) continue; }
        n += await flowSend(d, f, c, o.id, {}, cfg) ? 1 : 0;
      }
    }
    if (f.key === 'win_back') {
      for (const c of people) if (c.last_order_at && new Date(c.last_order_at).getTime() <= cutoff)
        n += await flowSend(d, f, c, `winback:${c.last_order_at}`, {}, cfg) ? 1 : 0;
    }
    sent[f.key] = n;
  }
  return sent;
}
