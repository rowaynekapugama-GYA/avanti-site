#!/usr/bin/env node
// Local stand-in for Vercel: serves the static site and runs /api/*.js handlers the same way
// (Web-standard Request/Response, the rewrites in vercel.json).
//
//   PORT=3000 SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... PAYMENTS_SIMULATOR=true node scripts/dev-server.mjs
//
// Environment variables are read from .env.local if present (KEY=value lines).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env.local')))
  readFileSync(path.join(root, '.env.local'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); });
const port = +(process.env.PORT || 3000);
const vercel = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.md': 'text/plain' };

function rewrite(url) {
  for (const r of vercel.rewrites || []) {
    const names = []; const re = new RegExp('^' + r.source.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = url.pathname.match(re);
    if (m) { let dest = r.destination; names.forEach((n, i) => { dest = dest.replace(':' + n, m[i + 1]); });
      const u = new URL(dest, url); url.searchParams.forEach((v, k) => u.searchParams.set(k, v)); return u; }
  }
  return url;
}

http.createServer(async (req, res) => {
  let url = rewrite(new URL(req.url, `http://localhost:${port}`));
  try {
    if (url.pathname.startsWith('/api/')) {
      const file = path.join(root, url.pathname.replace(/\/$/, '') + '.js');
      if (!file.startsWith(path.join(root, 'api')) || url.pathname.includes('/_lib/') || !existsSync(file)) { res.writeHead(404).end('Not found'); return; }
      const mod = await import(pathToFileURL(file).href);
      const fn = mod[req.method] || (mod.default && mod.default[req.method]);
      if (!fn) { res.writeHead(405).end('Method not allowed'); return; }
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      if (!headers.get('x-forwarded-for')) headers.set('x-forwarded-for', req.socket.remoteAddress || '');
      const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const out = await fn(request);
      const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
      res.writeHead(out.status, h); res.end(Buffer.from(await out.arrayBuffer())); return;
    }
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && (await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) { const nf = path.join(root, '404.html'); res.writeHead(404, { 'Content-Type': TYPES['.html'] }); res.end(existsSync(nf) ? await readFile(nf) : 'Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }); res.end(await readFile(file));
  } catch (e) { console.error(e); res.writeHead(500).end('Server error'); }
}).listen(port, () => console.log(`Avanti dev server on http://localhost:${port}`));
