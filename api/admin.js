// /api/admin?action=...   Every call needs a signed-in admin (Supabase session token).
// Reads happen straight from the database with row-level security; anything that changes an
// order, sends email or touches consent comes through here so it is validated and audited.
import { config, db, handle, json, readJson, requireAdmin, HttpError, audit } from './_lib/core.js';
import { move } from './_lib/effects.js';
import { CARRIERS, marketingEmail } from './_lib/email.js';
import { sendCampaign, sendTest, campaignStats, audience, matches, marketable, subscribe, unsubscribe, runScheduled, runAutomations } from './_lib/marketing.js';

const STATUSES = ['paid', 'in_production', 'dispatched', 'delivered', 'cancelled', 'refunded'];

export const POST = handle(async (req) => {
  const cfg = config(), admin = await requireAdmin(req, cfg), d = db(cfg);
  const action = new URL(req.url).searchParams.get('action'), b = await readJson(req, 2_000_000), who = `admin:${admin.email}`;
  const need = (v, msg) => { if (!v) throw new HttpError(400, msg); return v; };

  switch (action) {
    case 'order-transition': {
      const to = need(STATUSES.includes(b.to) && b.to, 'Unknown status.');
      const data = {};
      if (to === 'dispatched') {
        data.carrier = need(String(b.carrier || '').trim(), 'Choose a carrier.');
        if (!CARRIERS[data.carrier]) throw new HttpError(400, 'Unknown carrier.');
        data.tracking_number = need(String(b.tracking_number || '').trim(), 'Enter the tracking number.').slice(0, 80);
        if (b.tracking_url && !/^https:\/\//.test(b.tracking_url)) throw new HttpError(400, 'Tracking link must start with https://');
        data.tracking_url = b.tracking_url || '';
      }
      const r = await move(d, need(b.order_id, 'Missing order.'), to, who, String(b.note || '').trim().slice(0, 1000) || null, data, cfg);
      return json(r);
    }
    case 'order-note': {
      const o = await d.one('orders', `select=id,status&id=eq.${d.q(need(b.order_id, 'Missing order.'))}`);
      if (!o) throw new HttpError(404, 'Order not found.');
      await d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: who, note: need(String(b.note || '').trim(), 'Write a note first.').slice(0, 2000) });
      return json({ ok: true });
    }
    case 'campaign-test': {
      const c = b.campaign || await d.one('campaigns', `select=*&id=eq.${d.q(need(b.campaign_id, 'Missing campaign.'))}`);
      const to = (b.to || admin.email).toLowerCase();
      const r = await sendTest(d, { campaign: c, to, name: admin.name }, cfg);
      await audit(d, who, 'campaign.test', 'campaign', c.id, { to });
      return json({ status: r.status, to });
    }
    case 'campaign-preview': {   // the real email template, with a sample recipient
      const c = b.campaign || {};
      const m = marketingEmail({ subject: c.subject || '', preview: c.preview_text, blocks: c.blocks || [], campaignId: c.id || null,
        customer: { email: admin.email, name: admin.name, pref_token: '00000000-0000-0000-0000-000000000000', consent_at: new Date().toISOString() } }, cfg);
      return json({ html: m.html, text: m.text });
    }
    case 'campaign-send': return json(await sendCampaign(d, need(b.campaign_id, 'Missing campaign.'), who, cfg));
    case 'campaign-schedule': {
      const at = new Date(need(b.at, 'Choose a date and time.'));
      if (isNaN(at) || at.getTime() < Date.now() + 60000) throw new HttpError(400, 'Choose a time at least a minute from now.');
      const rows = await d.update('campaigns', `id=eq.${d.q(b.campaign_id)}&status=in.(draft,scheduled)`, { status: 'scheduled', scheduled_at: at.toISOString(), updated_at: new Date().toISOString() });
      if (!rows.length) throw new HttpError(409, 'Only draft campaigns can be scheduled.');
      await audit(d, who, 'campaign.schedule', 'campaign', b.campaign_id, { at: at.toISOString() });
      return json(rows[0]);
    }
    case 'campaign-unschedule': {
      const rows = await d.update('campaigns', `id=eq.${d.q(b.campaign_id)}&status=eq.scheduled`, { status: 'draft', scheduled_at: null, updated_at: new Date().toISOString() });
      if (!rows.length) throw new HttpError(409, 'That campaign is not scheduled.');
      await audit(d, who, 'campaign.unschedule', 'campaign', b.campaign_id);
      return json(rows[0]);
    }
    case 'campaign-duplicate': {
      const c = await d.one('campaigns', `select=*&id=eq.${d.q(need(b.campaign_id, 'Missing campaign.'))}`);
      if (!c) throw new HttpError(404, 'Campaign not found.');
      const [n] = await d.insert('campaigns', { name: `${c.name} (copy)`, subject: c.subject, preview_text: c.preview_text, blocks: c.blocks,
        segment_id: c.segment_id, series: c.series, duplicated_from: c.id, created_by: admin.email });
      await audit(d, who, 'campaign.duplicate', 'campaign', n.id, { from: c.id });
      return json(n);
    }
    case 'campaign-stats': return json(await campaignStats(d, (b.ids || []).filter(x => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200)));
    case 'segment-preview': {
      const all = await marketable(d);
      const rules = b.rules || (b.segment_id ? (await d.one('segments', `select=rules&id=eq.${d.q(b.segment_id)}`) || {}).rules : null);
      const hit = rules ? all.filter(c => matches(rules, c)) : all;
      return json({ count: hit.length, sample: hit.slice(0, 8).map(c => c.email), eligible: all.length });
    }
    case 'audience-count': return json({ count: (await audience(d, b.segment_id || null)).length });
    case 'customers-import': {
      // Imports must say where consent came from; people who unsubscribed are never re-added.
      const source = need(String(b.source || '').trim(), 'Say where these people gave consent (e.g. "2025 trade show sign-up sheet").');
      if (!b.confirm) throw new HttpError(400, 'Confirm that everyone on this list agreed to receive marketing email.');
      const rows = (b.rows || []).slice(0, 10000); let added = 0, already = 0, skipped = 0, invalid = 0;
      for (const r of rows) {
        try {
          const res = await subscribe(d, { email: r.email, name: r.name, state: r.state, tags: r.tags, basis: 'imported_list', source, actor: who });
          if (res.changed) added++; else if (res.skipped) skipped++; else already++;
        } catch { invalid++; }
      }
      await audit(d, who, 'customers.import', 'customers', null, { source, added, already, skipped, invalid });
      return json({ added, already, skipped_unsubscribed: skipped, invalid });
    }
    case 'customer-subscribe': {
      const c = await d.one('customers', `select=email&id=eq.${d.q(need(b.customer_id, 'Missing customer.'))}`);
      if (!c) throw new HttpError(404, 'Customer not found.');
      const r = await subscribe(d, { email: c.email, basis: 'admin_added', source: need(String(b.source || '').trim(), 'Record how this person gave consent.'), actor: who });
      if (r.skipped) throw new HttpError(409, 'This person unsubscribed. Only they can subscribe again, using the sign-up form.');
      await audit(d, who, 'customer.subscribe', 'customer', b.customer_id, { source: b.source });
      return json(r.customer);
    }
    case 'customer-unsubscribe': {
      const r = await unsubscribe(d, { customerId: need(b.customer_id, 'Missing customer.'), source: 'Unsubscribed by staff', actor: who });
      await audit(d, who, 'customer.unsubscribe', 'customer', b.customer_id);
      return json(r);
    }
    case 'run-automations': {   // "Run now" button; the scheduler also runs this once a day
      const r = { campaigns: await runScheduled(d, new Date(), cfg), automations: await runAutomations(d, new Date(), cfg) };
      await audit(d, who, 'automations.run', null, null, r);
      return json(r);
    }
    default: throw new HttpError(404, 'Unknown action');
  }
});
