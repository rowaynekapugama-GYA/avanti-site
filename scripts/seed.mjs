#!/usr/bin/env node
// GYA CMS seed: loads scripts/seed-data.json into a Supabase project.
// Reusable: works for any site whose adapter exports the same seed format.
//
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed.mjs
//   add --dry-run to check the file without writing anything
//   add --file other-seed.json to load a different export
//
// Safe to re-run: rows are matched on their slug or key and replaced, so running it
// twice gives the same result. It never deletes rows that aren't in the file.
// The service role key bypasses all security: keep it on your own computer, never
// in index.html, never in git. Needs Node 18 or newer (built-in fetch).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const fileArg = args.indexOf('--file');
const here = path.dirname(fileURLToPath(import.meta.url));
const file = fileArg >= 0 ? args[fileArg + 1] : path.join(here, 'seed-data.json');
const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const fail = msg => { console.error(`\n  Stopped: ${msg}\n`); process.exit(1); };
const seed = JSON.parse(await readFile(file, 'utf8'));
if (seed.format !== 'gya-cms-seed') fail(`${file} isn't a GYA CMS seed file.`);

const counts = {
  categories: seed.categories.length, 'shipping groups': seed.shipping.classes.length, products: seed.products.length,
  variations: seed.products.reduce((n, p) => n + p.variations.length, 0), images: seed.products.reduce((n, p) => n + p.images.length, 0),
  templates: seed.products.reduce((n, p) => n + p.templates.length, 0), 'blog posts': seed.blog_posts.length, pages: seed.pages.length,
  faqs: Object.values(seed.faqs).reduce((n, l) => n + l.length, 0), settings: seed.site_settings.length,
};
console.log(`\nSeed file: ${file} (site "${seed.site}", exported ${seed.generated})`);
Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));

// checks that catch a broken export before anything is written
const catSlugs = new Set(seed.categories.map(c => c.slug));
const problems = [];
seed.products.forEach(p => {
  if (!catSlugs.has(p.category_slug)) problems.push(`${p.slug}: unknown category "${p.category_slug}"`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug)) problems.push(`${p.slug}: invalid slug`);
  if (p.variation_keys && p.variations.some(v => p.variation_keys.some(k => !(k in v.option_values)))) problems.push(`${p.slug}: a variation is missing a price option`);
});
const dup = seed.products.map(p => p.slug).filter((s, i, a) => a.indexOf(s) !== i);
if (dup.length) problems.push(`duplicate product slugs: ${dup.join(', ')}`);
if (problems.length) fail(`the seed file has problems:\n    ${problems.join('\n    ')}`);
console.log('  checks           passed');
if (dry) { console.log('\nDry run: nothing was written.\n'); process.exit(0); }

if (!url || !key) fail('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) {
  const role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role;
  if (role !== 'service_role') fail(`that key is the "${role}" key. The seed needs the service role key.`);
} else if (/^sb_publishable_/.test(key)) fail('that is the publishable key. The seed needs the secret (service role) key.');

const headers = { apikey: key, 'Content-Type': 'application/json' };
if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) headers.Authorization = `Bearer ${key}`;
async function call(p, body, prefer) {
  const r = await fetch(`${url}/rest/v1/${p}`, { method: 'POST', headers: prefer ? { ...headers, Prefer: prefer } : headers, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(`${p}: ${r.status} ${t.slice(0, 300)}`); }
  return r.status === 204 ? null : r.text();
}
const upsert = (table, rows, onConflict) => call(`${table}?on_conflict=${onConflict}`, rows, 'resolution=merge-duplicates,return=minimal');
const step = async (label, fn) => { process.stdout.write(`  ${label.padEnd(34, '.')} `); const t = Date.now(); await fn(); console.log(`done (${Date.now() - t} ms)`); };

console.log(`\nWriting to ${url}`);
try {
  // categories first (without shipping links, which the shipping step sets)
  await step('categories', () => upsert('categories', seed.categories.map(c => ({ ...c, shipping_class: undefined })), 'slug'));
  await step('shipping', () => call('rpc/admin_save_shipping', { payload: seed.shipping }));
  await step(`products (${seed.products.length})`, async () => {
    const queue = seed.products.slice(); let done = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) { const p = queue.shift(); await call('rpc/admin_save_product', { p }); done++; }
    }));
    if (done !== seed.products.length) throw new Error('not every product was saved');
  });
  await step('blog posts', () => seed.blog_posts.length ? upsert('blog_posts', seed.blog_posts, 'slug') : null);
  await step('pages', () => seed.pages.length ? upsert('pages', seed.pages, 'slug') : null);
  await step('faqs', async () => { for (const [set_key, items] of Object.entries(seed.faqs)) await call('rpc/admin_save_faqs', { set_key, items }); });
  await step('settings', () => upsert('site_settings', seed.site_settings, 'key'));
  await step('seo', () => (seed.seo_entries || []).length ? upsert('seo_entries', seed.seo_entries, 'route') : null);
} catch (e) { fail(e.message); }

// read back what the public site will see
const get = async q => { const r = await fetch(`${url}/rest/v1/${q}`, { headers: { ...headers, Prefer: 'count=exact', Range: '0-0' } });
  return +(r.headers.get('content-range') || '/0').split('/')[1]; };
const live = { categories: await get('categories?select=slug'), products: await get('products?select=slug'),
  variations: await get('product_variations?select=id'), images: await get('product_images?select=id') };
console.log('\nNow in the database:');
Object.entries(live).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}${v < counts[k] ? '  (fewer than the file: check for errors above)' : ''}`));
console.log('\nSeed complete. Reload the site: it now reads from the database.\n');
