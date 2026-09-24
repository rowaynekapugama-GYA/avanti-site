/* Avanti: collect the last few files the new site needs into ONE zip, using your own browser.
 * Same steps as download-photos.js:
 *   1. Open https://avantiprint.com.au and let it load.
 *   2. Open the console: Option + Command + J (Mac) or Ctrl + Shift + J (Windows).
 *   3. If Chrome says pasting is blocked, type:  allow pasting   and press Enter.
 *   4. Paste this whole file and press Enter. Chrome downloads avanti-extras.zip.
 * Contents: the 40 mailer box artwork templates (PDF), the About page photo, and the three
 * homepage slide images currently hosted on Imgur. Anything that can't be fetched is listed in
 * MISSING-FILES.txt inside the zip. Nothing on the live site is changed. */
(async () => {
  const FILES = [
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-5mm-95x90x40mm.pdf", "assets/templates/5mm-Mailer-Box-5mm-95x90x40mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-95x90x40mm.pdf", "assets/templates/Mailer-Box-95x90x40mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-135x95x25mm.pdf", "assets/templates/5mm-Mailer-Box-135x95x25mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-135x95x25mm.pdf", "assets/templates/Mailer-Box-135x95x25mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-150x100x50mm.pdf", "assets/templates/5mm-Mailer-Box-150x100x50mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-150-x-100-x-50mm.pdf", "assets/templates/Mailer-Box-150-x-100-x-50mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-155x155x102mm.pdf", "assets/templates/5mm-Mailer-Box-155x155x102mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-155x155x102mm.pdf", "assets/templates/Mailer-Box-155x155x102mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-180x140x25mm.pdf", "assets/templates/5mm-Mailer-Box-180x140x25mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-180-x-140-x-25mm.pdf", "assets/templates/Mailer-Box-180-x-140-x-25mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-203x203x155mm.pdf", "assets/templates/5mm-Mailer-Box-203x203x155mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-203-x-203-x-155mm.pdf", "assets/templates/Mailer-Box-203-x-203-x-155mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-225x160x80.pdf", "assets/templates/5mm-Mailer-Box-225x160x80.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-225-x160-x-80mm-.pdf", "assets/templates/Mailer-Box-225-x160-x-80mm-.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-230x180x70mm.pdf", "assets/templates/5mm-230x180x70mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-230-x-180-x-70mm.pdf", "assets/templates/Mailer-Box-230-x-180-x-70mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-230x160x40mm.pdf", "assets/templates/5mm-230x160x40mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-230x160x40mm.pdf", "assets/templates/Mailer-Box-230x160x40mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-250x180x100.pdf", "assets/templates/5mm-250x180x100.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-250-x-180-x-100mm.pdf", "assets/templates/Mailer-Box-250-x-180-x-100mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-260x205x105mm.pdf", "assets/templates/5mm-260x205x105mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-260-x-205-x-105mm.pdf", "assets/templates/Mailer-Box-260-x-205-x-105mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-280x150x40mm.pdf", "assets/templates/5mm-280x150x40mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-280-x-150-x-40mm.pdf", "assets/templates/Mailer-Box-280-x-150-x-40mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-290x175x60mm.pdf", "assets/templates/5mm-290x175x60mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-290-x-175-x-60mm.pdf", "assets/templates/Mailer-Box-290-x-175-x-60mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-300x210x740mm.pdf", "assets/templates/5mm-300x210x740mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-300-x-210-x-70mm.pdf", "assets/templates/Mailer-Box-300-x-210-x-70mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-305x305x130mm.pdf", "assets/templates/5mm-305x305x130mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-305-x-305-x-130mm.pdf", "assets/templates/Mailer-Box-305-x-305-x-130mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-315x220x50mm.pdf", "assets/templates/5mm-Mailer-Box-315x220x50mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-315x220x50mm.pdf", "assets/templates/Mailer-Box-315x220x50mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-315x230x100mm.pdf", "assets/templates/5mm-Mailer-Box-315x230x100mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-315x230x100.pdf", "assets/templates/Mailer-Box-315x230x100.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-355x255x150mm.pdf", "assets/templates/5mm-Mailer-Box-355x255x150mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-355-x-255-x-150mm.pdf", "assets/templates/Mailer-Box-355-x-255-x-150mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-410-x-330-x-70mm.pdf", "assets/templates/5mm-Mailer-Box-410-x-330-x-70mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-410-x-330-x-70mm.pdf", "assets/templates/Mailer-Box-410-x-330-x-70mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/5mm-Mailer-Box-440x310x60mm.pdf", "assets/templates/5mm-Mailer-Box-440x310x60mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/07/Mailer-Box-440x310x60mm.pdf", "assets/templates/Mailer-Box-440x310x60mm.pdf"],
    ["https://avantiprint.com.au/wp-content/uploads/2025/04/unsplash_-uHVRvDr7pg-copy.jpg", "assets/products/unsplash_-uHVRvDr7pg-copy.jpg"],
    ["https://i.imgur.com/trAbhwz.png", "assets/products/hero-corflute.png"],
    ["https://i.imgur.com/F9NtHsP.png", "assets/products/hero-pull-up-banners.png"],
    ["https://i.imgur.com/0RzN1XC.png", "assets/products/hero-a-frames.png"]
  ];
  const OK_HOST = /(^|\.)avantiprint\.com\.au$/.test(location.hostname) || window.__AVANTI_PHOTO_TEST__;
  if (!OK_HOST) { alert('Open https://avantiprint.com.au first, then run this in that tab.'); return; }
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#17161a;color:#fff;font:14px/1.45 system-ui,sans-serif;padding:14px 16px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);width:300px';
  box.innerHTML = '<b>Collecting Avanti files</b><div id="avp-t" style="margin:6px 0 8px">Starting...</div><div style="height:6px;background:#333;border-radius:3px"><div id="avp-b" style="height:6px;width:0;background:#c41e2a;border-radius:3px"></div></div>';
  document.body.appendChild(box);
  const show = (t, pct) => { box.querySelector('#avp-t').textContent = t; if (pct != null) box.querySelector('#avp-b').style.width = pct + '%'; };
  const TEST = window.__AVANTI_PHOTO_TEST__ ? (u => u.replace(/^https:\/\/[^/]+/, location.origin)) : (u => u);
  const got = new Array(FILES.length), missing = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function grab(i) {
    const [url, dest] = FILES[i], sameSite = /avantiprint\.com\.au/.test(url);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(TEST(url), sameSite ? { credentials: 'include', cache: 'no-store' } : { mode: 'cors', referrerPolicy: 'no-referrer', cache: 'no-store' });
        const type = r.headers.get('content-type') || '';
        if (r.ok && /^(image\/|application\/pdf)/.test(type)) { got[i] = new Uint8Array(await r.arrayBuffer()); return; }
        if (r.status === 404) { missing.push(url + '  (not found)'); return; }
        if (attempt === 3) missing.push(url + '  (HTTP ' + r.status + (type ? ', ' + type.split(';')[0] : '') + ')');
      } catch (e) { if (attempt === 3) missing.push(url + '  (' + e.message + (sameSite ? '' : '. Save it from the browser instead: open the link, right-click, Save image as ' + dest.split('/').pop()) + ')'); }
      await wait(800 * attempt);
    }
  }
  let next = 0, done = 0;
  async function worker() { while (next < FILES.length) { const i = next++; await grab(i); done++; show(`${done} of ${FILES.length} files checked`, Math.round(done / FILES.length * 100)); } }
  await Promise.all([worker(), worker(), worker(), worker()]);
  // build a zip (stored, not compressed: photos are already compressed)
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
        dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  function add(name, data) {
    const n = enc.encode(name), crc = crc32(data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), n, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  let count = 0;
  
  FILES.forEach(([url, dest], i) => { if (got[i]) { add(dest, got[i]); count++; } });
  const note = `Avanti extra files collected ${now.toISOString()}\n${count} of ${FILES.length} files included.\n` +
    (missing.length ? `\nCould not be fetched (${missing.length}):\n` + missing.map(m => '  ' + m).join('\n') + '\n' : '\nNothing missing.\n');
  add('MISSING-FILES.txt', enc.encode(note));
  const cdSize = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count + 1, true); end.setUint16(10, count + 1, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const blob = new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'avanti-extras.zip';
  document.body.appendChild(a); a.click(); a.remove();
  show(`Done: ${count} of ${FILES.length} files in avanti-extras.zip.` + (missing.length ? ` ${missing.length} couldn't be fetched, listed inside.` : ''), 100);
  console.log(note);
  window.__AVANTI_EXTRAS_RESULT__ = { count, missing };
})();
