// /api/cron  Vercel calls this on the schedule in vercel.json, with "Authorization: Bearer <CRON_SECRET>".
// Sends due scheduled campaigns, runs the automations, and tidies up checkouts abandoned for 14+ days.
// On Vercel's free plan it runs once a day; on Pro, change the schedule in vercel.json to "*/15 * * * *".
import { config, db, json, HttpError, handle } from './_lib/core.js';
import { runScheduled, runAutomations } from './_lib/marketing.js';
import { move } from './_lib/effects.js';

export const GET = handle(async (req) => {
  const cfg = config();
  if (!cfg.cronSecret || req.headers.get('authorization') !== `Bearer ${cfg.cronSecret}`) throw new HttpError(401, 'Unauthorised');
  const d = db(cfg), now = new Date();
  const campaigns = await runScheduled(d, now, cfg);
  const automations = await runAutomations(d, now, cfg);
  const stale = await d.select('orders', `select=id&status=eq.pending_payment&created_at=lt.${d.q(new Date(now - 14 * 86400000).toISOString())}&limit=200`);
  for (const o of stale) await move(d, o.id, 'cancelled', 'system', 'Checkout abandoned: no payment after 14 days', {}, cfg);
  return json({ ran_at: now.toISOString(), campaigns, automations, expired_checkouts: stale.length });
});
