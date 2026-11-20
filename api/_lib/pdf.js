// A small PDF writer for tax invoices and adjustment notes. No npm packages: plain PDF 1.4 with the
// built-in Helvetica fonts (WinAnsi encoding), lines, boxes, and an optional JPEG or PNG logo.
// Positions are in points from the top left of an A4 page (595 x 842).
import zlib from 'node:zlib';

export const A4 = { w: 595.28, h: 841.89 };

// Helvetica and Helvetica-Bold character widths (1/1000 em) for codes 32 to 126, from the standard font metrics.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,
  556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
// Characters outside plain ASCII that WinAnsi can print, with their widths [regular, bold].
const EXTRA = { '×': [0xd7, 584, 584], '·': [0xb7, 278, 278], '²': [0xb2, 333, 333], '’': [0x92, 222, 278], '‘': [0x91, 222, 278],
  '“': [0x93, 333, 500], '”': [0x94, 333, 500], '–': [0x96, 556, 556], '•': [0x95, 350, 350], '…': [0x85, 1000, 1000],
  '°': [0xb0, 400, 400], '©': [0xa9, 737, 737], '®': [0xae, 737, 737], 'é': [0xe9, 556, 556], 'è': [0xe8, 556, 556],
  'ê': [0xea, 556, 556], 'á': [0xe1, 556, 556], 'à': [0xe0, 556, 556], 'ó': [0xf3, 556, 611], 'ü': [0xfc, 556, 611],
  'ö': [0xf6, 556, 611], 'ä': [0xe4, 556, 556], ' ': [0x20, 278, 278], '½': [0xbd, 834, 834], '¼': [0xbc, 834, 834] };
// Long dashes typed by customers print as a plain hyphen.
const SUBST = { '\u2014': '-', '\u2012': '-', '\u2212': '-', '\u2032': "'", '\u2033': '"' };

function codes(str) {   // a JS string as WinAnsi byte codes, with the width table key for each
  const out = [];
  for (let ch of String(str ?? '')) {
    ch = SUBST[ch] || ch;
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out.push([c, c]);
    else if (EXTRA[ch]) out.push([EXTRA[ch][0], ch]);
    else if (c === 9 || c === 10 || c === 13) out.push([32, 32]);
    else out.push([63, 63]);   // '?'
  }
  return out;
}
export function textWidth(str, size, bold = false) {
  let w = 0;
  for (const [, k] of codes(str)) w += typeof k === 'number' ? (bold ? W_BOLD : W_REG)[k - 32] : EXTRA[k][bold ? 2 : 1];
  return w * size / 1000;
}
// Break text into lines no wider than maxW (words longer than a line are cut).
export function wrap(str, size, maxW, bold = false) {
  const lines = [];
  for (const para of String(str ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= maxW) { line = next; continue; }
      if (line) lines.push(line);
      let w = word;
      while (textWidth(w, size, bold) > maxW && w.length > 1) {
        let n = w.length - 1; while (n > 1 && textWidth(w.slice(0, n), size, bold) > maxW) n--;
        lines.push(w.slice(0, n)); w = w.slice(n);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}
const hex = str => '<' + codes(str).map(([c]) => c.toString(16).padStart(2, '0')).join('') + '>';
const num = n => (Math.round(n * 100) / 100).toString();
const rgb = c => { const h = String(c || '#000000').replace('#', ''); return [0, 2, 4].map(i => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(' '); };

// ---------- images ----------
function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    i += 2 + len;
  }
  return null;
}
function pngDecode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let i = 8, w, h, depth, type, interlace; const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), t = buf.toString('latin1', i + 4, i + 8), d = buf.subarray(i + 8, i + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
    i += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!w || !h || depth !== 8 || !ch || interlace) return null;   // 8-bit grey, RGB, grey+alpha or RGBA, not interlaced
  if (w > 4000 || h > 4000 || w * h > 4_000_000) return null;      // a logo, not a poster: caps the memory used
  const stride = w * ch, want = h * (stride + 1);
  const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: want });   // throws (no logo) if it would be bigger
  if (raw.length < want) return null;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0, b = up ? up[x] : 0, c = up && x >= ch ? up[x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[x] = v & 255;
    }
  }
  const colours = ch >= 3 ? 3 : 1, hasAlpha = ch === 2 || ch === 4;
  const col = Buffer.alloc(w * h * colours), alpha = hasAlpha ? Buffer.alloc(w * h) : null;
  for (let p = 0; p < w * h; p++) {
    for (let k = 0; k < colours; k++) col[p * colours + k] = px[p * ch + k];
    if (alpha) alpha[p] = px[p * ch + ch - 1];
  }
  return { w, h, colours, col, alpha };
}
// Read a logo file. Returns null (no logo) for anything it can't read, so a bad file never stops an invoice.
export function loadImage(buf) {
  try {
    if (!buf || buf.length < 16) return null;
    const j = jpegInfo(buf);
    if (j) return { kind: 'jpeg', w: j.w, h: j.h, comps: j.comps, data: buf };
    const p = pngDecode(buf);
    return p ? { kind: 'png', ...p } : null;
  } catch { return null; }
}

// ---------- document ----------
export function createPdf() {
  const pages = [], images = [];
  let ops = null;
  const doc = {
    page() { ops = []; pages.push(ops); return doc; },
    onPage(n) { ops = pages[n - 1]; return doc; },   // go back to page n (1 based), for headers and page numbers
    text(x, y, str, { size = 10, bold = false, color = '#1a1a1a', align = 'left' } = {}) {
      const w = textWidth(str, size, bold), tx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(tx)} ${num(A4.h - y)} Td ${hex(str)} Tj ET`);
      return w;
    },
    line(x1, y1, x2, y2, { width = 0.6, color = '#cccccc' } = {}) {
      ops.push(`${num(width)} w ${rgb(color)} RG ${num(x1)} ${num(A4.h - y1)} m ${num(x2)} ${num(A4.h - y2)} l S`);
    },
    rect(x, y, w, h, { fill = null, stroke = null, width = 0.6 } = {}) {
      const r = `${num(x)} ${num(A4.h - y - h)} ${num(w)} ${num(h)} re`;
      if (fill && stroke) ops.push(`${rgb(fill)} rg ${rgb(stroke)} RG ${num(width)} w ${r} B`);
      else if (fill) ops.push(`${rgb(fill)} rg ${r} f`);
      else ops.push(`${rgb(stroke || '#000000')} RG ${num(width)} w ${r} S`);
    },
    image(img, x, y, w, h) {
      if (!img) return;
      let i = images.indexOf(img); if (i < 0) { images.push(img); i = images.length - 1; }
      ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(A4.h - y - h)} cm /Im${i + 1} Do Q`);
    },
    get pageCount() { return pages.length; },
    toBuffer(info = {}) {
      const objs = [];   // [n] = Buffer for object n+1
      const add = b => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')); return objs.length; };
      const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
      const catalog = add(''), pagesObj = add('');
      const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const imgRefs = images.map(img => {
        if (img.kind === 'jpeg') {
          const cs = img.comps === 1 ? '/DeviceGray' : img.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
          return add(stream(`/Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${img.comps === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''}`, img.data));
        }
        const smask = img.alpha ? add(stream(`/Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(img.alpha))) : null;
        return add(stream(`/Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace ${img.colours === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode${smask ? ` /SMask ${smask} 0 R` : ''}`, zlib.deflateSync(img.col)));
      });
      const xo = imgRefs.length ? ` /XObject << ${imgRefs.map((r, i) => `/Im${i + 1} ${r} 0 R`).join(' ')} >>` : '';
      const kids = pages.map(p => {
        const content = add(stream('/Filter /FlateDecode', zlib.deflateSync(Buffer.from(p.join('\n'), 'latin1'))));
        return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xo} >> /Contents ${content} 0 R >>`);
      });
      objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`, 'latin1');
      objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
      const meta = add(`<< /Title ${hex(info.title || '')} /Author ${hex(info.author || '')} /Producer (GYA) /CreationDate (D:${(info.date || new Date()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
      const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offsets = [];
      let pos = parts[0].length;
      objs.forEach((b, i) => { offsets.push(pos); const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), tail = Buffer.from('\nendobj\n', 'latin1'); parts.push(head, b, tail); pos += head.length + b.length + tail.length; });
      const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
      parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${meta} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
      return Buffer.concat(parts);
    },
  };
  return doc;
}
