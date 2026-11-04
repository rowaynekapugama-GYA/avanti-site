// Shipping settings in the database: load the version in use, save a new version.
import { SEED } from './seed.js';
import { validateConfig } from './validate.js';
import { quoteShipping } from './engine.js';
import { HttpError } from '../core.js';

// only "the table isn't there yet" counts as not set up; any other database error is reported, not hidden
const missingTable = e => ['PGRST205', '42P01'].includes(e && e.code) || /(could not find the table|relation "?[\w.]*shipping_config_versions"? does not exist)/i.test(String(e && e.message));

// The settings in use (highest version). The first time, the client spec's starting settings are
// saved as version 1. If the database update hasn't been run, the starting settings are used
// unsaved (version 0); on the live site zones still need approval, so nothing is priced then.
export async function loadShippingConfig(d) {
  try {
    const r = await d.one('shipping_config_versions', 'select=version,config,note,created_by,created_at&order=version.desc');
    if (r) return { version: r.version, config: r.config, meta: r };
    try {
      const [row] = await d.insert('shipping_config_versions', { version: 1, config: SEED, note: 'Starting settings from the client specification v1.0 (3 Nov 2026)', created_by: 'system (initial settings)' });
      return { version: 1, config: row.config, meta: row };
    } catch (e) {   // someone else saved version 1 at the same moment
      const again = await d.one('shipping_config_versions', 'select=version,config,note,created_by,created_at&order=version.desc');
      if (again) return { version: again.version, config: again.config, meta: again };
      throw e;
    }
  } catch (e) {
    if (missingTable(e)) return { version: 0, config: SEED, meta: { note: 'Database update 005 not run yet: using the starting settings unsaved.' }, unsaved: true };
    throw e;
  }
}

export async function saveShippingConfig(d, config, { actor, note, expectVersion }) {
  const { errors } = validateConfig(config);
  if (errors.length) throw new HttpError(400, `The settings weren't saved: ${errors.slice(0, 3).join(' ')}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''}`);
  const cur = await loadShippingConfig(d);
  if (cur.unsaved) throw new HttpError(409, 'Run the database update (migration 005) in Supabase before saving shipping settings.');
  if (expectVersion != null && Number(expectVersion) !== cur.version) throw new HttpError(409, `Someone saved shipping settings (version ${cur.version}) since you opened them. Reload and make your change again.`);
  // approvals are stamped by the server: who approved, and when
  const now = new Date().toISOString(), prev = Object.fromEntries((cur.config.zones || []).map(z => [z.id, z]));
  for (const z of config.zones || []) {
    const was = prev[z.id] && prev[z.id].approval || {}, st = z.approval && z.approval.status === 'approved' ? 'approved' : 'provisional';
    z.approval = st === 'approved' ? (was.status === 'approved' ? { ...was } : { status: 'approved', by: actor, at: now }) : { status: 'provisional', by: null, at: null };
  }
  try {
    const [row] = await d.insert('shipping_config_versions', { version: cur.version + 1, config, note: String(note || '').slice(0, 500) || null, created_by: actor });
    return { version: row.version, config: row.config };
  } catch (e) {
    if (/duplicate|23505|unique/i.test(String(e.message || e.code))) throw new HttpError(409, 'Someone saved shipping settings at the same moment. Reload and make your change again.');
    throw e;
  }
}

// The checkout and the simulator both call this, so they always agree.
export function shippingFor(lines, postcode, loaded, cfg) {
  return quoteShipping({ lines, postcode, config: loaded.config, version: loaded.version, requireApproval: cfg.shipping.requireApproval });
}
