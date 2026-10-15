#!/usr/bin/env node
// Builds paste-in SQL files for setting up a new Supabase project from the SQL Editor,
// so nobody needs Node or the secret key on their own computer.
//
//   node scripts/build-setup-sql.mjs [output-folder]     (default: supabase-setup/)
//
// Output:
//   1-tables.sql            supabase-schema.sql + every migration, in order
//   2-content-a.sql, b...   the same products, categories, shipping, blog, pages, FAQs,
//                           settings and SEO that scripts/seed.mjs loads, split into
//                           files small enough for the SQL Editor
// Every file is safe to run again. The content files act as the server (service role)
// for their own transaction only, which is what lets the save functions run from the
// SQL Editor, and switch back when the transaction ends.
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(here, '..', 'supabase-setup'));
const MAX = 350 * 1024;
const TAG = '$avanti$';

const seed = JSON.parse(await readFile(path.join(here, 'seed-data.json'), 'utf8'));
if (seed.format !== 'gya-cms-seed') throw new Error('seed-data.json is not a GYA CMS seed file');
const lit = v => { const s = JSON.stringify(v); if (s.includes(TAG)) throw new Error('content contains the quote tag'); return `${TAG}${s}${TAG}::jsonb`; };

function upsert(table, rows, key) {
  if (!rows || !rows.length) return null;
  const cols = Object.keys(rows[0]).filter(c => c !== 'shipping_class');
  const list = cols.map(c => `"${c}"`).join(', ');
  const set = cols.filter(c => c !== key).map(c => `"${c}" = excluded."${c}"`).join(', ');
  return `insert into public.${table} (${list})\nselect ${list} from jsonb_populate_recordset(null::public.${table}, ${lit(rows.map(r => { const o = {}; cols.forEach(c => { o[c] = r[c]; }); return o; }))})\non conflict ("${key}") do update set ${set};`;
}

const stmts = [
  upsert('categories', seed.categories, 'slug'),
  `select public.admin_save_shipping(${lit(seed.shipping)});`,
  ...seed.products.map(p => `select public.admin_save_product(${lit(p)});`),
  ...seed.blog_posts.map(b => upsert('blog_posts', [b], 'slug')),
  upsert('pages', seed.pages, 'slug'),
  ...Object.entries(seed.faqs).map(([k, items]) => `select public.admin_save_faqs(${TAG}${k}${TAG}, ${lit(items)});`),
  upsert('site_settings', seed.site_settings, 'key'),
  upsert('seo_entries', seed.seo_entries || [], 'route'),
].filter(Boolean);

const parts = [[]]; let size = 0;
for (const s of stmts) {
  if (size + s.length > MAX && parts[parts.length - 1].length) { parts.push([]); size = 0; }
  parts[parts.length - 1].push(s); size += s.length + 2;
}

await mkdir(out, { recursive: true });
for (const f of await readdir(out)) if (/^\d-.*\.sql$/.test(f)) await unlink(path.join(out, f));

const migDir = path.join(here, 'migrations');
const migs = (await readdir(migDir)).filter(f => f.endsWith('.sql')).sort();
let tables = `-- Avanti: step 1 of ${1 + parts.length}. Creates every table, security rule and function.\n-- Paste the whole file into Supabase > SQL Editor > New query, then Run. Safe to run again.\n\n`;
tables += await readFile(path.join(here, 'supabase-schema.sql'), 'utf8');
for (const m of migs) tables += `\n\n-- ===== ${m} =====\n\n` + await readFile(path.join(migDir, m), 'utf8');
tables += `\n\nselect 'Step 1 done: tables created' as result;\n`;
await writeFile(path.join(out, '1-tables.sql'), tables);

const letters = 'abcdefghij';
for (let i = 0; i < parts.length; i++) {
  const last = i === parts.length - 1;
  let sql = `-- Avanti: step ${i + 2} of ${1 + parts.length}. Loads the shop's products and content (part ${letters[i]}).\n`;
  sql += `-- Run 1-tables.sql first. Paste this whole file into a new SQL Editor query, then Run. Safe to run again.\n\n`;
  sql += `begin;\n-- act as the server for this transaction only\nselect set_config('request.jwt.claims', '{"role":"service_role"}', true);\n\n`;
  sql += parts[i].join('\n\n') + '\n\ncommit;\n\n';
  sql += last
    ? `select (select count(*) from public.categories) as categories, (select count(*) from public.products) as products,\n       (select count(*) from public.product_variations) as prices, (select count(*) from public.blog_posts) as blog_posts;\n`
    : `select 'Part ${letters[i]} loaded' as result;\n`;
  await writeFile(path.join(out, `${i + 2}-content-${letters[i]}.sql`), sql);
}
console.log(`Wrote ${1 + parts.length} files to ${out}`);
