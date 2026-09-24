#!/usr/bin/env node
// GYA blog importer: turns a WordPress export (WXR .xml) into this site's blog.
//
//   node scripts/import-wordpress.mjs path/to/export.xml
//   add --dry-run to see what it would import without changing anything
//   add --local-images once the blog photos are in assets/products/ (bash scripts/download-images.sh blog)
//
// In WordPress: Tools > Export > Posts > All authors, all categories > Download Export File.
// (An export of "All content" works too; pages, products and media are ignored.)
//
// What it does
//   - keeps published posts only, and skips theme demo posts (see DEMO_CATEGORIES)
//   - cleans page-builder shortcodes ([vc_row] and friends) and block editor comments
//   - points links to the old site at the new routes (#/shop/..., #/blog/..., #/contact)
//   - replaces em dashes, per the house style
//   - finds each post's featured image and SEO description (Yoast or Rank Math)
//   - rewrites the BLOG DATA block in index.html and the blog in scripts/seed-data.json
//   - lists every image the posts use in scripts/images-blog.txt, for downloading
// Safe to re-run: it rebuilds the blog from the export each time. Posts added in the
// dashboard live in the database, so run the seed again afterwards only if you want the
// database to match the export.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run'), localImages = args.includes('--local-images');
const file = args.find(a => !a.startsWith('--'));
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const fail = msg => { console.error(`\n  Stopped: ${msg}\n`); process.exit(1); };
if (!file) fail('give the export file, e.g. node scripts/import-wordpress.mjs export.xml');

// Categories the site's WordPress theme installed as sample content. Override with
// --exclude-categories a,b,c (nicenames as they appear in the export).
const DEMO_CATEGORIES = (opt('--exclude-categories') || 'trends,models,street-style,celebrity-style').split(',').map(s => s.trim()).filter(Boolean);
// Old site paths that map to routes on the new site. Anything else on the old
// domain that looks like a post slug goes to #/blog/<slug>.
const PATH_MAP = { '': '#/', 'shop': '#/shop', 'blog': '#/blog', 'about-us': '#/about', 'contact-us': '#/contact',
  'terms-and-conditions': '#/page/terms', 'privacy-policy': '#/page/privacy', 'returns-policy': '#/page/returns' };
const CATEGORY_ALIASES = { banners: 'pull-up-banners', 'cupcake-toppers': 'cake-toppers' };
Object.assign(PATH_MAP, { contact: '#/contact', about: '#/about', 'custom-design-products': '#/shop' });

const xml = await readFile(file, 'utf8');
const site = (opt('--site-url') || (xml.match(/<wp:base_site_url>(.*?)<\/wp:base_site_url>/) || [])[1] || '').replace(/\/+$/, '');
if (!site) fail('couldn\'t find the site address in the export. Add --site-url https://example.com.au');
const host = new URL(site).host.replace(/^www\./, '');

// ---- tiny WXR reader (the format is regular enough that no XML library is needed)
const cdata = s => (s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>');
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? cdata(m[1]) : ''; };
const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
if (!items.length) fail(`${path.basename(file)} has no posts in it. In WordPress choose Tools > Export > Posts (not just the default), then Download Export File.`);
const meta = block => Object.fromEntries([...block.matchAll(/<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g)].map(m => [tag(m[1], 'wp:meta_key'), tag(m[1], 'wp:meta_value')]));
const attachments = new Map();   // id -> { url, alt }
items.filter(b => tag(b, 'wp:post_type') === 'attachment').forEach(b => attachments.set(tag(b, 'wp:post_id'),
  { url: tag(b, 'wp:attachment_url'), alt: decode(meta(b)._wp_attachment_image_alt || '').trim() }));
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Yoast titles can use template variables. Titles that are just the template
// (%%title%% ...) fall back to the site's own default, so only real custom titles are kept.
const BRAND = opt('--brand') || 'Avanti Print & Design';
function seoTitle(raw, title) {
  const t = decode(raw || '').trim();
  if (!t || /%%title%%/.test(t)) return undefined;
  const out = t.replace(/%%sep%%/g, '|').replace(/%%sitename%%/g, BRAND).replace(/%%(page|pagenumber|pagetotal)%%/g, '')
    .replace(/%%[a-z_]+%%/g, '').replace(/\s+/g, ' ').replace(/\s*\|\s*$/, '').trim();
  return out && out !== `${title} | ${BRAND}` ? out : undefined;
}

// ---- cleaning
const UPLOADS = `https?://(?:www\\.)?${host.replace(/\./g, '\\.')}/wp-content/uploads/`;
const uploadsRel = u => { const m = String(u).match(new RegExp('^' + UPLOADS + '(.+)$')); return m ? m[1] : null; };
const images = new Set();
function mapLink(href) {
  let u; try { u = new URL(href, site + '/'); } catch { return href; }
  if (u.host.replace(/^www\./, '') !== host || /\/wp-content\//.test(u.pathname)) return href;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg[0] === 'product-category' && seg[1]) return '#/shop/' + (CATEGORY_ALIASES[seg[1]] || seg[1]);
  if (seg[0] === 'product' && seg[1]) return '#/product/' + seg[1];
  if (seg[0] === 'category') return '#/blog';
  if (seg.length === 4 && /^\d{4}$/.test(seg[0]) && /^\d{2}$/.test(seg[1])) return '#/blog/' + seg[3];   // old dated post address
  const key = seg.join('/');
  if (key in PATH_MAP) return PATH_MAP[key];
  if (seg.length === 1) return '#/blog/' + seg[0];
  return href;
}
function autop(html) {   // WordPress stores classic-editor posts without <p> tags
  if (/<p[\s>]/i.test(html)) return html;
  const block = /^<(h[1-6]|ul|ol|li|blockquote|table|figure|div|hr|pre|img)/i;
  html = html.replace(/^[ \t]*(&nbsp;|\u00a0)[ \t]*$/gm, '')                       // spacer lines
    .replace(/(&nbsp;|\u00a0)\s*(?=<(h[1-6]|ul|ol|blockquote|table|figure|div|hr|pre)[\s>])/gi, '')
    .replace(/<(h[1-6]|ul|ol|blockquote|table|figure|div|hr|pre)(?=[\s>])/gi, '\n\n<$1')   // block tags start their own chunk
    .replace(/<\/(h[1-6]|ul|ol|blockquote|table|figure|div|pre)>/gi, '</$1>\n\n');
  return html.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => block.test(p) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}
function clean(html) {
  let h = html.replace(/\r/g, '')
    .replace(/<!--\s*\/?wp:[\s\S]*?-->/g, '')                        // block editor markers
    .replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/g, '$1')        // keep captioned images
    .replace(/\[vc_single_image[^\]]*\bimage="(\d+)"[^\]]*\]/g, (_, id) => { const a = attachments.get(id);   // page-builder images
      return a ? `\n\n<img src="${escAttr(a.url)}" alt="${escAttr(a.alt)}">\n\n` : ''; })
    .replace(/\[\/?(vc_|et_pb_|fusion_|av_|cs_|x_)[^\]]*\]/g, '')     // page-builder shortcodes
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s(style|data-[\w-]+|id)="[^"]*"/gi, '')
    .replace(/<\/?(span|font)\b[^>]*>/gi, '')                                 // Word and editor wrappers
    .replace(/\s(lang|dir|align|class)="[^"]*"/gi, '').replace(/\s[\w-]+=""/g, '');
  h = autop(h).replace(/<(\/?)h1(\s|>)/gi, '<$1h2$2');   // the page already has the post title as its h1
  h = h.replace(/href="([^"]+)"/g, (_, u) => `href="${mapLink(decode(u)).replace(/"/g, '&quot;')}"`);
  h = h.replace(/src="([^"]+)"/g, (_, u) => { const rel = uploadsRel(u); if (!rel) return `src="${u}"`;
    images.add(rel); return `src="${localImages ? 'assets/products/' + rel.split('/').pop() : u}"`; });
  h = h.replace(/\ssrcset="[^"]*"|\ssizes="[^"]*"/g, '').replace(/<img(?![^>]*loading=)/g, '<img loading="lazy"');
  h = noEmDash(h).replace(/<p>(\s|&nbsp;|\u00a0|<br\s*\/?>)*<\/p>/g, '').replace(/<br>\s*(?=<\/p>)/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return h;
}
const noEmDash = s => s.replace(/\s*(?:\u2014|&mdash;|&#8212;)\s*/g, ', ').replace(/,\s*,/g, ',').replace(/,\s*([.!?:;])/g, '$1');
const text = html => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const excerptOf = (given, body) => { const t = noEmDash(text(given || '')); if (t) return t;
  const words = noEmDash(text(body)).split(' '); return words.length > 30 ? words.slice(0, 30).join(' ') + '...' : words.join(' '); };

// ---- build the posts
const skipped = { demo: [], draft: 0, other: 0 };
const posts = [];
for (const b of items) {
  const type = tag(b, 'wp:post_type'), status = tag(b, 'wp:status');
  if (type !== 'post') { skipped.other++; continue; }
  if (status !== 'publish') { skipped.draft++; continue; }
  const cats = [...b.matchAll(/<category domain="category" nicename="([^"]+)">/g)].map(m => m[1]);
  const slug = tag(b, 'wp:post_name');
  if (cats.length && cats.every(c => DEMO_CATEGORIES.includes(c))) { skipped.demo.push(slug); continue; }
  const m = meta(b), body = clean(tag(b, 'content:encoded'));
  const att = attachments.get(m._thumbnail_id || ''), thumb = att ? att.url : '';
  const img = thumb ? (uploadsRel(thumb) || thumb) : '';
  // older posts repeat the featured image at the top of the text: drop that copy
  const coverKey = img && img.split('/').pop().replace(/-\d+x\d+(?=\.\w+$)/, '');
  let text0 = body;
  if (coverKey) { const m = text0.match(/^(?:<p>)?\s*<img\b[^>]*src="([^"]+)"[^>]*>\s*(?:<\/p>)?\s*/);
    if (m && m[1].split('/').pop().replace(/-\d+x\d+(?=\.\w+$)/, '') === coverKey) text0 = text0.slice(m[0].length); }
  if (img) images.add(img);
  const seo = noEmDash(decode(m._yoast_wpseo_metadesc || m.rank_math_description || '')).trim();
  const title = noEmDash(decode(tag(b, 'title'))).trim();
  posts.push({ slug, t: title, date: tag(b, 'wp:post_date').slice(0, 10), alt: att && att.alt ? noEmDash(att.alt) : undefined,
    img: img && !/^https?:/.test(img) && localImages ? 'assets/products/' + img.split('/').pop() : img,
    excerpt: excerptOf(tag(b, 'excerpt:encoded'), text0), body: text0 || undefined,
    legacy: tag(b, 'link') || `${site}/${slug}/`, seo: seo || undefined, seoTitle: seoTitle(noEmDash(m._yoast_wpseo_title || m.rank_math_title || ''), title) });
}
posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

// ---- check every internal link against what the new site actually has. Old products are
// matched to a current one only when the names agree exactly (ignoring words like "cake
// topper" and "personalised"); links to things no longer sold become plain text.
let catalogue = null;
try { const pj = JSON.parse(await readFile(path.join(root, 'products.json'), 'utf8'));
  catalogue = { cats: new Set(pj.categories.map(c => c.s)), prods: pj.products.map(p => p.s) }; } catch { console.warn('  (products.json not found: internal links not checked)'); }
const STOP = new Set('cake topper toppers custom personalised personalise personalized your own the with and of a printed print'.split(' '));
const words = s => s.split('-').filter(t => t && !STOP.has(t) && !/^\d+$/.test(t)).sort().join(' ');
const linkStats = { remapped: 0, unlinked: 0 };
function checkLink(h) {
  if (!catalogue || !h.startsWith('#/')) return h;
  const [kind, slug] = h.slice(2).split(/[?#]/)[0].split('/');
  if (!kind || (!slug && ['shop', 'blog', 'about', 'contact'].includes(kind))) return h;
  if (kind === 'shop') return catalogue.cats.has(slug) ? h : null;
  if (kind === 'blog') return posts.some(p => p.slug === slug) ? h : null;
  if (kind === 'page') return ['terms', 'privacy', 'returns'].includes(slug) ? h : null;
  if (kind === 'product') { if (catalogue.prods.includes(slug)) return h;
    const w = words(slug), hit = w && catalogue.prods.filter(p => words(p) === w);
    return hit && hit.length === 1 ? (linkStats.remapped++, '#/product/' + hit[0]) : null; }
  return h;
}
posts.forEach(p => { if (p.body) p.body = p.body.replace(/<a\b([^>]*?)href="(#\/[^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (all, pre, h, post, inner) => {
  const to = checkLink(h); if (to === h) return all; if (to) return `<a${pre}href="${to}"${post}>${inner}</a>`; linkStats.unlinked++; return inner; }); });
const dup = posts.map(p => p.slug).filter((s, i, a) => a.indexOf(s) !== i);
if (dup.length) fail(`two posts share a web address: ${[...new Set(dup)].join(', ')}`);

console.log(`\nExport: ${path.basename(file)} (${site})`);
console.log(`  posts imported     ${posts.length} (${posts.filter(p => p.body).length} with full text)`);
console.log(`  theme demo skipped ${skipped.demo.length}${skipped.demo.length ? ': ' + skipped.demo.slice(0, 3).join(', ') + (skipped.demo.length > 3 ? ', ...' : '') : ''}`);
console.log(`  drafts skipped     ${skipped.draft}`);
console.log(`  links remapped     ${linkStats.remapped} (old product address to its current one)`);
console.log(`  links removed      ${linkStats.unlinked} (products or pages no longer on the site; text kept)`);
console.log(`  SEO descriptions   ${posts.filter(p => p.seo).length}`);
console.log(`  custom SEO titles  ${posts.filter(p => p.seoTitle).length}`);
console.log(`  images referenced  ${images.size}`);
if (dry) { console.log('\nDry run: nothing was changed.\n'); process.exit(0); }

// ---- write index.html
const START = '/* ==== BLOG DATA', END = '/* ==== END BLOG DATA ==== */';
const htmlPath = path.join(root, 'index.html');
let page = await readFile(htmlPath, 'utf8');
const a = page.indexOf(START), z = page.indexOf(END);
if (a < 0 || z < a) fail('index.html has no BLOG DATA block to replace.');
const json = JSON.stringify(posts, null, 0).replace(/<\/script/gi, '<\\/script').replace(/},{/g, '},\n{');
page = page.slice(0, a) + `/* ==== BLOG DATA: written by scripts/import-wordpress.mjs from ${path.basename(file)}. Posts are edited in the dashboard; this copy is the fallback. ==== */\nconst BLOG_DATA = ${json};\n` + page.slice(z);
await writeFile(htmlPath, page);

// ---- write the seed
const seedPath = path.join(here, 'seed-data.json');
try {
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  seed.blog_posts = posts.map(p => ({ slug: p.slug, title: p.t, excerpt: p.excerpt || null, body_html: p.body || null, cover_url: p.img ? (/^https?:|^assets\//.test(p.img) ? p.img : 'assets/products/' + p.img.split('/').pop()) : null,
    legacy_url: p.body ? null : p.legacy, published_at: p.date, published: true }));
  const keep = (seed.seo_entries || []).filter(e => !e.route.startsWith('/blog/'));
  seed.seo_entries = keep.concat(posts.filter(p => p.seo || p.seoTitle).map(p => ({ route: '/blog/' + p.slug, title: p.seoTitle || null, description: p.seo || null, og_image: null })));
  seed.generated = new Date().toISOString();
  await writeFile(seedPath, JSON.stringify(seed, null, 1));
} catch (e) { console.warn(`  (seed-data.json not updated: ${e.message})`); }

await writeFile(path.join(here, 'images-blog.txt'), [...images].sort().map(r => `${site}/wp-content/uploads/${r}`).join('\n') + '\n');
console.log(`\nDone. index.html, scripts/seed-data.json and scripts/images-blog.txt updated.`);
console.log('If the site is connected to Supabase, run the seed again to load the posts.\n');
