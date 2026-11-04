// /api/admin?action=...   Every call needs a signed-in admin (Supabase session token).
// Reads happen straight from the database with row-level security; anything that changes an
// order, sends email or touches consent comes through here so it is validated and audited.
import { config, db, handle, json, readJson, requireAdmin, HttpError, audit } from './_lib/core.js';
import { move, sendOrderEmail, sendStaffAlert, sendCustomerNote, sendArtworkRequest, orderEmailsOn, flag } from './_lib/effects.js';
import { loadOrder, loadCatalogue, shippingOptions } from './_lib/orders.js';
import { loadShippingConfig, saveShippingConfig, shippingFor } from './_lib/shipping/store.js';
import { quoteShipping, serialiseQuote, customerView, findZone } from './_lib/shipping/engine.js';
import { validateConfig } from './_lib/shipping/validate.js';
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
      if (to === 'dispatched') {   // carrier is required; tracking number and link are optional
        data.carrier = need(String(b.carrier || '').trim(), 'Choose a carrier.');
        if (!CARRIERS[data.carrier]) throw new HttpError(400, 'Unknown carrier.');
        data.tracking_number = String(b.tracking_number || '').trim().slice(0, 80);
        if (b.tracking_url && !/^https:\/\//.test(b.tracking_url)) throw new HttpError(400, 'Tracking link must start with https://');
        data.tracking_url = b.tracking_url || '';
      }
      // "Email the customer" tick box, on unless staff untick it
      const r = await move(d, need(b.order_id, 'Missing order.'), to, who, String(b.note || '').trim().slice(0, 1000) || null, data, cfg, { notify: b.notify !== false });
      return json(r);
    }
    case 'order-resend-email': {   // "Resend email" button: always sends, even if it went before
      const o = await loadOrder(d, need(b.order_id, 'Missing order.'));
      if (!o) throw new HttpError(404, 'Order not found.');
      if (!o.paid_at) throw new HttpError(409, 'This checkout was never paid, so there is no order email to send.');
      if (!(await orderEmailsOn(d, cfg))) throw new HttpError(409, 'Order emails are switched off. Switch them on in Email log first.');
      const which = ['staff', 'artwork'].includes(b.which) ? b.which : 'customer';
      const r = which === 'staff' ? await sendStaffAlert(d, o, { force: true, cfg }) : which === 'artwork' ? await sendArtworkRequest(d, o, { force: true, cfg }) : await sendOrderEmail(d, o, o.status, { force: true, cfg });
      if (r && r.skipped) throw new HttpError(409, r.skipped === 'no staff address' ? 'No staff email address is set (ADMIN_NOTIFICATION_EMAIL).' : r.skipped === 'no artwork needed' ? 'This order is not waiting on any artwork.' : 'There is no email for this status.');
      await d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: who,
        note: `${{ staff: 'New-order email to staff', artwork: 'Artwork upload link to the customer', customer: 'Status email to the customer' }[which]} resent (${r.status === 'failed' ? 'failed' : r.status}).` });
      await audit(d, who, 'order.email_resend', 'order', o.id, { which, status: r.status });
      return json({ status: r.status, to: r.to_email });
    }
    case 'email-settings': {   // what the dashboard shows on the Email log page
      if (typeof b.order_emails === 'boolean') {
        try { await d.insert('app_flags', [{ key: 'order_emails', value: b.order_emails, updated_at: new Date().toISOString() }], { onConflict: 'key' }); }
        catch (e) { throw new HttpError(409, 'The on/off switch needs the database update (migration 004). Run it in Supabase, then try again.'); }
        await audit(d, who, b.order_emails ? 'order_emails.on' : 'order_emails.off', 'app_flags', 'order_emails', {});
      }
      if (typeof b.order_email_copies === 'boolean') {
        try { await d.insert('app_flags', [{ key: 'order_email_copies', value: b.order_email_copies, updated_at: new Date().toISOString() }], { onConflict: 'key' }); }
        catch (e) { throw new HttpError(409, 'This switch needs the database update (migration 004). Run it in Supabase, then try again.'); }
        await audit(d, who, b.order_email_copies ? 'order_email_copies.on' : 'order_email_copies.off', 'app_flags', 'order_email_copies', {});
      }
      let sw = null; try { sw = await d.one('app_flags', 'select=value&key=eq.order_emails'); } catch (e) { /* not set up yet: on */ }
      const copies = await flag(d, 'order_email_copies');
      return json({ sending: cfg.email.mode === 'resend', order_emails_env: cfg.email.ordersEnabled, order_emails_switch: !(sw && sw.value === false), copies,
        test_recipient: cfg.email.testRecipient || null, staff_email: cfg.email.adminList.join(', ') || null, timezone: cfg.timezone });
    }
    // ---------------- shipping calculator ----------------
    case 'shipping-get': {   // settings in use, version history, validation
      const cur = await loadShippingConfig(d);
      let versions = [];
      try { versions = await d.select('shipping_config_versions', 'select=version,note,created_by,created_at&order=version.desc&limit=40'); } catch (e) { /* migration not run */ }
      return json({ version: cur.version, config: cur.config, unsaved: !!cur.unsaved, note: cur.meta && cur.meta.note, versions,
        validation: validateConfig(cur.config), require_approval: cfg.shipping.requireApproval });
    }
    case 'shipping-version': {   // an older version, to view or restore
      const v = await d.one('shipping_config_versions', `select=version,config,note,created_by,created_at&version=eq.${Number(b.version) || 0}`);
      if (!v) throw new HttpError(404, 'That version was not found.');
      return json(v);
    }
    case 'shipping-validate': return json(validateConfig(b.config));
    case 'shipping-save': {
      if (!b.config || typeof b.config !== 'object') throw new HttpError(400, 'Missing settings.');
      const r = await saveShippingConfig(d, b.config, { actor: who, note: b.note, expectVersion: b.expect_version });
      await audit(d, who, 'shipping.settings_saved', 'shipping_config', String(r.version), { note: b.note || null });
      return json({ version: r.version, config: r.config, validation: validateConfig(r.config) });
    }
    case 'shipping-simulate': {   // the same engine as checkout; can also try unsaved settings
      const cur = await loadShippingConfig(d);
      const draft = b.config && typeof b.config === 'object' ? b.config : null;
      if (draft) { const v = validateConfig(draft); if (v.errors.length) throw new HttpError(400, `These settings have problems: ${v.errors.slice(0, 2).join(' ')}`); }
      const use = draft ? { config: draft, version: `${cur.version} + unsaved changes` } : cur;
      const raw = Array.isArray(b.lines) ? b.lines.slice(0, 50) : [];
      const cat = await loadCatalogue(d, raw.filter(l => l.slug).map(l => l.slug));
      const lines = raw.map(l => {
        if (l.spec) return { spec: l.spec, qty: l.qty, name: l.name };
        const p = cat.products[l.slug];
        if (!p) throw new HttpError(400, `Unknown product: ${l.slug}`);
        return { slug: p.slug, category: p.category_slug, name: p.name, qty: l.qty, opts: shippingOptions(p, l.opts || {}) };   // same option rules as checkout
      });
      if (!lines.length) throw new HttpError(400, 'Add at least one item.');
      const live = quoteShipping({ lines, postcode: b.postcode, config: use.config, version: use.version, requireApproval: true });
      const preview = quoteShipping({ lines, postcode: b.postcode, config: use.config, version: use.version, requireApproval: false });
      const here = cfg.shipping.requireApproval ? live : preview;   // exactly what this site's checkout would do
      // the full working, shown even for a disabled zone so it can be checked before switching it on
      const working = preview.would_be ? { ...preview, ...preview.would_be } : preview;
      return json({ checkout_view: customerView(here), live_view: customerView(live), live_reason: live.ok ? null : live.reason,
        preview_view: customerView(preview), working: serialiseQuote(working), require_approval: cfg.shipping.requireApproval });
    }
    case 'shipping-lookup': {
      const cur = await loadShippingConfig(d), z = findZone(b.postcode, cur.config);
      return json({ postcode: b.postcode, zone: z.zone ? { id: z.zone.id, name: z.zone.name, state: z.zone.state, class: z.zone.class, enabled: z.zone.enabled, approval: z.zone.approval, via: z.via } : null, reason: z.reason || null });
    }
    case 'shipping-override': {   // change the delivery charge recorded for an order; the original calculation stays
      const o = await d.one('orders', `select=id,status,shipping_ex_gst_cents,shipping_override_ex_gst_cents&id=eq.${d.q(need(b.order_id, 'Missing order.'))}`);
      if (!o) throw new HttpError(404, 'Order not found.');
      const amount = Math.round(Number(b.new_ex_gst_cents));
      if (!(amount >= 0) || amount > 10000000) throw new HttpError(400, 'Enter the new delivery amount (ex GST).');
      const reason = need(String(b.reason || '').trim(), 'Give a reason for the change.').slice(0, 500);
      const original = o.shipping_override_ex_gst_cents != null ? o.shipping_override_ex_gst_cents : o.shipping_ex_gst_cents;
      await d.insert('shipping_overrides', { order_id: o.id, original_ex_gst_cents: original, new_ex_gst_cents: amount, reason, actor: who });
      await d.update('orders', `id=eq.${o.id}`, { shipping_override_ex_gst_cents: amount, updated_at: new Date().toISOString() });
      await d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: who,
        note: `Delivery charge overridden: $${((original || 0) / 100).toFixed(2)} to $${(amount / 100).toFixed(2)} ex GST. Reason: ${reason}`, data: { shipping_override: true } });
      await audit(d, who, 'shipping.override', 'order', o.id, { original, amount, reason });
      return json({ ok: true, original_ex_gst_cents: original, new_ex_gst_cents: amount });
    }
    case 'shipping-courier': {   // actual courier cost, or a later adjustment (ex GST)
      const o = await d.one('orders', `select=id,status&id=eq.${d.q(need(b.order_id, 'Missing order.'))}`);
      if (!o) throw new HttpError(404, 'Order not found.');
      const kind = b.kind === 'adjustment' ? 'adjustment' : 'cost';
      const amount = Math.round(Number(b.amount_cents));
      if (!Number.isFinite(amount) || (kind === 'cost' && amount < 0) || Math.abs(amount) > 10000000) throw new HttpError(400, 'Enter the amount (ex GST).');
      await d.insert('courier_costs', { order_id: o.id, kind, amount_cents: amount, carrier: String(b.carrier || '').slice(0, 80) || null, note: String(b.note || '').slice(0, 500) || null, actor: who });
      await d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: who,
        note: `${kind === 'cost' ? 'Courier cost recorded' : 'Courier adjustment'}: $${(amount / 100).toFixed(2)} ex GST${b.carrier ? ` (${String(b.carrier).slice(0, 80)})` : ''}${b.note ? `. ${String(b.note).slice(0, 200)}` : ''}` });
      return json({ ok: true });
    }
    case 'shipping-profit': {   // charged vs actual, for paid orders in a date range
      const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
      const from = need(day(b.from), 'Choose a start date.'), to = need(day(b.to), 'Choose an end date.');
      const end = new Date(new Date(to + 'T00:00:00Z').getTime() + 2 * 86400000).toISOString();   // generous; filtered below in Sydney time
      const rows = await d.select('orders', `select=id,number,name,status,paid_at,shipping_zone,shipping_postcode,shipping_ex_gst_cents,shipping_override_ex_gst_cents,shipping_config_version,delivery_cents&paid_at=gte.${d.q(new Date(new Date(from + 'T00:00:00Z').getTime() - 86400000).toISOString())}&paid_at=lt.${d.q(end)}&order=paid_at.desc&limit=1000`);
      const local = iso => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
      const inRange = rows.filter(r => { const dd = local(r.paid_at); return dd >= from && dd <= to; });
      const ids = inRange.map(r => r.id);
      const costs = ids.length ? await d.select('courier_costs', `select=order_id,kind,amount_cents,created_at&order_id=in.(${ids.join(',')})&order=created_at`) : [];
      const out = inRange.map(r => {
        const mine = costs.filter(c => c.order_id === r.id), last = mine.filter(c => c.kind === 'cost').pop();
        const adj = mine.filter(c => c.kind === 'adjustment').reduce((t, c) => t + c.amount_cents, 0);
        const charged = r.shipping_override_ex_gst_cents != null ? r.shipping_override_ex_gst_cents : r.shipping_ex_gst_cents;
        const actual = last ? last.amount_cents + adj : null;
        return { id: r.id, number: r.number, name: r.name, status: r.status, paid_at: r.paid_at, zone: r.shipping_zone, postcode: r.shipping_postcode,
          calculated_ex_gst_cents: r.shipping_ex_gst_cents, charged_ex_gst_cents: charged, overridden: r.shipping_override_ex_gst_cents != null,
          courier_cost_cents: last ? last.amount_cents : null, adjustments_cents: adj, actual_cents: actual, margin_cents: actual != null && charged != null ? charged - actual : null };
      });
      const withCost = out.filter(r => r.margin_cents != null);
      return json({ from, to, rows: out, totals: { orders: out.length, with_cost: withCost.length,
        charged_cents: withCost.reduce((t, r) => t + r.charged_ex_gst_cents, 0), actual_cents: withCost.reduce((t, r) => t + r.actual_cents, 0),
        margin_cents: withCost.reduce((t, r) => t + r.margin_cents, 0) } });
    }
    case 'analytics': {
      const day = v => { const s = String(v || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;   // and a real date: no 31 February
        const t = new Date(s + 'T00:00:00Z'); return !isNaN(t) && t.toISOString().slice(0, 10) === s ? s : null; };
      const from = need(day(b.from), 'Choose a start date.'), to = need(day(b.to), 'Choose an end date.');
      if (from > to) throw new HttpError(400, 'The start date is after the end date.');
      if ((new Date(to) - new Date(from)) / 864e5 > 3700) throw new HttpError(400, 'Choose a range of ten years or less.');
      return json(await d.rpc('admin_order_analytics', { p_from: from, p_to: to, p_tz: cfg.timezone, p_exclude_cancelled: b.exclude_cancelled !== false }));
    }
    case 'order-note': {   // internal note, or (to_customer) a note emailed to the customer
      const text = need(String(b.note || '').trim(), 'Write a note first.').slice(0, 2000);
      if (b.to_customer === true) {
        const o = await loadOrder(d, need(b.order_id, 'Missing order.'));
        if (!o) throw new HttpError(404, 'Order not found.');
        if (!(await orderEmailsOn(d, cfg))) throw new HttpError(409, 'Order emails are switched off. Switch them on in Email log first.');
        const r = await sendCustomerNote(d, o, text, cfg);
        const how = r.status === 'failed' ? `Note could not be emailed to the customer (${String(r.error || 'error').slice(0, 200)})` : r.status === 'logged' ? 'Note for the customer (recorded only: the email service is not connected)' : 'Note emailed to the customer';
        await d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: who, note: `${how}: ${text}`, data: { to_customer: true, email_status: r.status } });
        return json({ ok: true, status: r.status, to: r.to_email });
      }
      const o = await d.one('orders', `select=id,status&id=eq.${d.q(need(b.order_id, 'Missing order.'))}`);
      if (!o) throw new HttpError(404, 'Order not found.');
      await d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: who, note: text });
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
