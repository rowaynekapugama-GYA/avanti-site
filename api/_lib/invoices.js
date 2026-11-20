// Tax invoices (emailed once an order is paid) and adjustment notes (one per refund).
//
// Rules relied on (ATO, "Tax invoices", last updated 18 September 2026): the words "Tax invoice", the seller's
// identity and ABN, the date of issue, a description, quantity and price of each item, the GST (or, when GST is
// exactly one eleventh of the total, a statement that the total includes GST), the extent each sale is taxable,
// and for sales of $1,000 or more the buyer's identity or ABN.
//
// All prices include GST and every item is taxable, so GST = the GST-inclusive total / 11, to the cent,
// worked out on the discounted total including shipping.
import { config, money, storageUpload, storageDownload, storageSign } from './core.js';
import { createPdf, loadImage, wrap, A4 } from './pdf.js';

export const BUCKET = 'invoices';
export const gstOf = cents => Math.round(cents / 11);
const missing = e => ['PGRST205', '42P01', '42703', 'PGRST204'].includes(e && e.code) || /(could not find the table|does not exist|schema cache|column)/i.test(String(e && e.message));

// ---------- ABN ----------
// The ABN check digit test (ABR): take 1 from the first digit, weight the 11 digits, the total must divide by 89.
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
export const abnDigits = s => String(s ?? '').replace(/\s+/g, '');
export function abnValid(s) {
  const d = abnDigits(s);
  if (!/^\d{11}$/.test(d)) return false;
  const n = d.split('').map(Number); n[0] -= 1;
  return n.reduce((t, v, i) => t + v * ABN_WEIGHTS[i], 0) % 89 === 0;
}
export const abnFormat = s => { const d = abnDigits(s); return /^\d{11}$/.test(d) ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : String(s ?? '').trim(); };

// A payment that didn't move real money gets a TEST- number, never a real one: a Vercel preview, Stripe test
// keys, the PayPal sandbox, or the built-in test gateway.
export function isTestPayment(o, cfg) {
  if (['preview', 'development'].includes(cfg.vercelEnv)) return true;
  if (o.provider === 'simulator') return true;
  if (o.provider === 'stripe') return !!cfg.stripe.testMode;
  if (o.provider === 'paypal') return cfg.paypal.env !== 'live';
  return false;
}
const isTestNumber = n => /^TEST-/.test(String(n || ''));

// ---------- readiness ----------
export async function invoicesReady(d, cfg) {
  if (!cfg.invoices.enabled) return false;
  try { await d.select('business_details', 'select=id&limit=1'); return true; }
  catch (e) { if (missing(e)) return false; throw e; }
}
export async function businessDetails(d) {
  try { return (await d.one('business_details', 'select=*&id=eq.1')) || {}; }
  catch (e) { if (missing(e)) return {}; throw e; }
}
// No invoice without a legal name and an ABN.
export const detailsComplete = b => !!(b && String(b.legal_name || '').trim() && String(b.abn || '').trim());

// ---------- the figures on an invoice (pure, tested) ----------
const sydneyDate = (iso, tz) => new Intl.DateTimeFormat('en-AU', { timeZone: tz || 'Australia/Sydney', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso || Date.now()));
export const methodLabel = o => o.provider === 'stripe' ? 'Card (Stripe)' : o.provider === 'paypal' ? 'PayPal' : o.provider === 'simulator' ? 'Test payment' : 'Online payment';
export function invoiceModel(o, items, tz) {
  const lines = (items || []).map(i => ({ name: i.name, options: Object.values(i.options || {}).filter(v => v != null && String(v).trim()).map(String).join(' · '),
    qty: i.qty, unit: i.unit_cents, total: i.line_cents }));
  const subtotal = o.subtotal_cents != null ? o.subtotal_cents : lines.reduce((t, l) => t + l.total, 0);
  const total = o.total_cents;
  const large = total >= 100000;   // $1,000 or more: the buyer's identity or ABN must be shown
  const contact = String(o.name || '').trim();
  const business = String(o.buyer_business_name || o.company || '').trim();
  return {
    test: isTestNumber(o.invoice_number), number: o.invoice_number, date: sydneyDate(o.invoice_issued_at || o.paid_at, tz), order: o.number,
    buyer: { name: business || contact || o.email, contact: business ? contact : '', email: o.email, abn: o.buyer_abn ? abnFormat(o.buyer_abn) : '' },
    large, lines, subtotal,
    productDiscount: o.product_discount_cents || 0, shippingDiscount: o.shipping_discount_cents || 0, code: o.discount_code || '',
    delivery: o.delivery_cents || 0, deliveryMethod: o.delivery_method || 'Delivery',
    total, gst: gstOf(total), method: methodLabel(o),
  };
}
export function adjustmentModel(o, refund, tz) {
  return { test: isTestNumber(refund.adjustment_number), number: refund.adjustment_number, date: sydneyDate(refund.adjustment_issued_at || refund.created_at, tz), invoice: o.invoice_number,
    invoiceDate: sydneyDate(o.invoice_issued_at || o.paid_at, tz), order: o.number,
    buyer: { name: String(o.buyer_business_name || o.company || '').trim() || o.name || o.email, contact: String(o.buyer_business_name || o.company || '').trim() ? o.name : '', email: o.email, abn: o.buyer_abn ? abnFormat(o.buyer_abn) : '' },
    amount: refund.amount_cents, gst: gstOf(refund.amount_cents), reason: refund.reason || 'Refund', note: refund.note || '', method: methodLabel(o),
    originalTotal: o.total_cents, refundedToDate: o.refunded_cents || 0 };
}

// ---------- PDF ----------
const INK = '#17161a', MUTED = '#6b6870', RED = '#C41E2A', LINE = '#dcd8d0', SHADE = '#f6f4f0';
const L = 48, R = A4.w - 48;
function header(doc, biz, logo, title, rightRows) {
  let y = 50;
  if (logo) { const h = 46, w = Math.min(170, h * logo.w / logo.h); doc.image(logo, L, y - 8, w, h); y += 50; }
  else { doc.text(L, y + 6, biz.trading_name || biz.legal_name, { size: 16, bold: true, color: INK }); y += 24; }
  doc.text(R, 58, title, { size: 22, bold: true, color: RED, align: 'right' });
  let ry = 78;
  for (const [k, v] of rightRows) { doc.text(R - 120, ry, k, { size: 9, color: MUTED, align: 'right' }); doc.text(R, ry, v, { size: 9, bold: true, align: 'right' }); ry += 14; }
  // seller
  const seller = [biz.legal_name, biz.trading_name && biz.trading_name !== biz.legal_name ? `Trading as ${biz.trading_name}` : '', `ABN ${abnFormat(biz.abn)}`,
    ...String(biz.address || '').split(/\r?\n/), [biz.phone, biz.email].filter(Boolean).join(' · ')].filter(s => String(s || '').trim());
  seller.forEach((s, i) => { doc.text(L, y + i * 12.5, s, { size: 9, bold: i === 0, color: i === 0 ? INK : MUTED }); });
  return Math.max(y + seller.length * 12.5, ry) + 14;
}
function buyerBlock(doc, y, b, label = 'Bill to') {
  doc.text(L, y, label.toUpperCase(), { size: 8, bold: true, color: MUTED });
  const rows = [b.name, b.contact, b.abn ? `ABN ${b.abn}` : '', b.email].filter(Boolean);
  rows.forEach((s, i) => doc.text(L, y + 14 + i * 12.5, s, { size: 10, bold: i === 0 }));
  return y + 14 + rows.length * 12.5 + 12;
}
// The footer line on the last page, and "Page n of N" on every page.
function footerText(doc, biz) {
  const f = String(biz.invoice_footer || '').trim(), pages = doc.pageCount;
  if (f) wrap(f, 8, R - L).slice(0, 3).forEach((l, i) => doc.text(L, A4.h - 64 + i * 10, l, { size: 8, color: MUTED }));
  for (let n = 1; n <= pages; n++) doc.onPage(n).text(R, A4.h - 28, `Page ${n} of ${pages}`, { size: 8, color: MUTED, align: 'right' });
  doc.onPage(pages);
}
// Pages after the first: what the document is, whose, and its number, so a loose page still makes sense.
function continued(doc, biz, title, number, test) {
  doc.page(); if (test) testBanner(doc);
  doc.text(L, 50, `${title} ${number} (continued)`, { size: 12, bold: true, color: RED });
  doc.text(R, 50, `${biz.legal_name} · ABN ${abnFormat(biz.abn)}`, { size: 8.5, color: MUTED, align: 'right' });
  doc.line(L, 60, R, 60, { color: LINE });
  return 86;
}

const testBanner = doc => { doc.rect(0, 0, A4.w, 22, { fill: '#fff4d6' });
  doc.text(A4.w / 2, 15, 'TEST ONLY: made from a test payment. Not a tax invoice and no money changed hands.', { size: 8.5, bold: true, color: '#8a5a00', align: 'center' }); };
export function renderInvoicePdf(m, biz, logo = null) {
  const doc = createPdf().page();
  if (m.test) testBanner(doc);
  let y = header(doc, biz, logo, 'Tax invoice', [['Invoice number', m.number], ['Date of issue', m.date], ['Order', m.order], ['Status', 'Paid']]);
  y = buyerBlock(doc, y, m.buyer);
  // items
  const cQty = 360, cUnit = 445, cTot = R;
  const head = () => { doc.rect(L, y - 11, R - L, 20, { fill: SHADE }); doc.text(L + 6, y + 2, 'Item', { size: 9, bold: true });
    doc.text(cQty, y + 2, 'Qty', { size: 9, bold: true, align: 'right' }); doc.text(cUnit, y + 2, 'Unit price', { size: 9, bold: true, align: 'right' });
    doc.text(cTot - 6, y + 2, 'Amount', { size: 9, bold: true, align: 'right' }); y += 24; };
  head();
  for (const l of m.lines) {
    const name = wrap(l.name, 10, cQty - L - 50, true), opts = l.options ? wrap(l.options, 8.5, cQty - L - 50) : [];
    const last = (name.length - 1) * 13 + (opts.length ? 11 + (opts.length - 1) * 11 : 0);   // baseline of the item's last line
    if (y + last + 30 > A4.h - 90) { y = continued(doc, biz, 'Tax invoice', m.number, m.test); head(); }
    name.forEach((s, i) => doc.text(L + 6, y + i * 13, s, { size: 10, bold: true }));
    opts.forEach((s, i) => doc.text(L + 6, y + (name.length - 1) * 13 + 11 + i * 11, s, { size: 8.5, color: MUTED }));
    doc.text(cQty, y, String(l.qty), { size: 10, align: 'right' }); doc.text(cUnit, y, money(l.unit), { size: 10, align: 'right' });
    doc.text(cTot - 6, y, money(l.total), { size: 10, align: 'right' });
    doc.line(L, y + last + 8, R, y + last + 8, { color: LINE }); y += last + 24;
  }
  if (y > A4.h - 260) y = continued(doc, biz, 'Tax invoice', m.number, m.test) + 10;   // the totals stay together
  y -= 10;
  // totals
  const row = (label, value, opt = {}) => { doc.text(cUnit - 10, y, label, { size: opt.size || 10, bold: opt.bold, color: opt.color || INK, align: 'right' });
    doc.text(cTot - 6, y, value, { size: opt.size || 10, bold: opt.bold, color: opt.color || INK, align: 'right' }); y += opt.gap || 16; };
  y += 8;
  row('Subtotal', money(m.subtotal));
  if (m.productDiscount) row(`Product discount (${m.code})`, `-${money(m.productDiscount)}`);
  row(m.deliveryMethod, money(m.delivery));
  if (m.shippingDiscount) row(`Shipping discount (${m.code})`, `-${money(m.shippingDiscount)}`);
  doc.line(cUnit - 150, y - 8, R, y - 8, { color: INK, width: 0.8 }); y += 6;
  row('Total (AUD)', money(m.total), { bold: true, size: 12, gap: 18 });
  row('GST included in total', money(m.gst), { color: MUTED });
  row('Paid by', m.method, { color: MUTED, gap: 22 });
  // statement of the extent taxable
  doc.rect(L, y - 4, R - L, 30, { fill: SHADE });
  doc.text(L + 10, y + 8, 'All items include GST. The total price includes GST of ' + money(m.gst) + '.', { size: 9, bold: true });
  doc.text(L + 10, y + 20, `Paid in full on ${m.date}. Thank you for your order.`, { size: 8.5, color: MUTED });
  footerText(doc, biz);
  return doc.toBuffer({ title: `Tax invoice ${m.number}`, author: biz.legal_name });
}

export function renderAdjustmentPdf(m, biz, logo = null) {
  const doc = createPdf().page();
  if (m.test) testBanner(doc);
  let y = header(doc, biz, logo, 'Adjustment note', [['Note number', m.number], ['Date of issue', m.date], ['Original tax invoice', m.invoice], ['Invoice date', m.invoiceDate], ['Order', m.order]]);
  y = buyerBlock(doc, y, m.buyer, 'Customer');
  doc.rect(L, y - 11, R - L, 20, { fill: SHADE }); doc.text(L + 6, y + 2, 'Adjustment', { size: 9, bold: true }); doc.text(R - 6, y + 2, 'Amount', { size: 9, bold: true, align: 'right' }); y += 24;
  const desc = `Refund against tax invoice ${m.invoice} (order ${m.order}): ${m.reason}`;
  const dl = wrap(desc, 10, R - L - 140);
  dl.forEach((s, i) => doc.text(L + 6, y + i * 13, s, { size: 10, bold: i === 0 }));
  doc.text(R - 6, y, `-${money(m.amount)}`, { size: 10, align: 'right' });
  y += dl.length * 13;
  if (m.note) { wrap(m.note, 8.5, R - L - 140).slice(0, 4).forEach((s, i) => doc.text(L + 6, y + i * 11, s, { size: 8.5, color: MUTED })); y += Math.min(4, wrap(m.note, 8.5, R - L - 140).length) * 11; }
  y += 6; doc.line(L, y, R, y, { color: LINE }); y += 20;
  const row = (label, value, opt = {}) => { doc.text(445 - 10, y, label, { size: opt.size || 10, bold: opt.bold, color: opt.color || INK, align: 'right' });
    doc.text(R - 6, y, value, { size: opt.size || 10, bold: opt.bold, color: opt.color || INK, align: 'right' }); y += opt.gap || 16; };
  row('Amount refunded (AUD)', money(m.amount), { bold: true, size: 12, gap: 18 });
  row('GST included in refund', money(m.gst), { color: MUTED });
  row('Refunded to', m.method, { color: MUTED });
  row('Original invoice total', money(m.originalTotal), { color: MUTED });
  row('Total refunded on this order', money(m.refundedToDate), { color: MUTED, gap: 22 });
  doc.rect(L, y - 4, R - L, 30, { fill: SHADE });
  doc.text(L + 10, y + 8, `This note reduces the GST on tax invoice ${m.invoice} by ${money(m.gst)}.`, { size: 9, bold: true });
  doc.text(L + 10, y + 20, 'Refunds usually take 5 to 10 business days to appear, depending on your bank.', { size: 8.5, color: MUTED });
  footerText(doc, biz);
  return doc.toBuffer({ title: `Adjustment note ${m.number}`, author: biz.legal_name });
}

async function logoFor(cfg, biz) {
  if (!biz.logo_path) return null;
  try { return loadImage(await storageDownload(cfg, BUCKET, biz.logo_path)); } catch (e) { console.error('invoice logo', e.message); return null; }
}

// ---------- issuing ----------
const note = (d, o, text) => d.insert('order_events', { order_id: o.id, from_status: o.status, to_status: o.status, actor: 'system', note: text }).catch(() => {});

// Give a paid order its invoice number and PDF (stored privately). Safe to call again: an order keeps its
// number, and its PDF is only made once. Returns { ok, order, reason }.
export async function ensureInvoice(d, o, cfg = config(), biz = null) {
  biz = biz || await businessDetails(d);
  if (!detailsComplete(biz)) return { ok: false, reason: 'details' };
  if (!o.paid_at) return { ok: false, reason: 'not_paid' };
  if (!o.invoice_number) {
    const num = await d.rpc('invoice_assign', { p_order: o.id, p_test: isTestPayment(o, cfg) });
    o = { ...o, invoice_number: num };
    const fresh = await d.one('orders', `select=invoice_number,invoice_issued_at,invoice_pdf_path,invoice_sent_at&id=eq.${d.q(o.id)}`);
    Object.assign(o, fresh || {});
  }
  if (!o.invoice_pdf_path) {
    const items = o.items || await d.select('order_items', `select=*&order_id=eq.${d.q(o.id)}&order=position`);
    const pdf = renderInvoicePdf(invoiceModel(o, items, cfg.timezone), biz, await logoFor(cfg, biz));
    const path = `invoices/${o.invoice_number}.pdf`;
    await storageUpload(cfg, BUCKET, path, pdf, 'application/pdf');
    await d.update('orders', `id=eq.${d.q(o.id)}`, { invoice_pdf_path: path });
    o = { ...o, invoice_pdf_path: path, _pdf: pdf };
  }
  return { ok: true, order: o };
}
export async function invoicePdf(d, o, cfg = config()) { return o._pdf || storageDownload(cfg, BUCKET, o.invoice_pdf_path); }
export const invoiceLink = (o, cfg = config()) => `${cfg.siteUrl}/api/checkout?action=invoice&order=${o.id}&t=${o.public_token}`;
export const signedFile = (cfg, path, seconds = 600) => storageSign(cfg, BUCKET, path, seconds);

// After payment: number, PDF, then the email, sent once only. The "sent" marker is claimed before sending,
// so two payment notices arriving together can't both send it; if sending fails the claim is released.
export async function issueAndSendInvoice(d, o, { cfg = config(), sendEmail, invoiceEmail }) {
  try {
    if (!(await invoicesReady(d, cfg))) return { skipped: 'off' };
    const biz = await businessDetails(d);
    if (!detailsComplete(biz)) { await note(d, o, 'No tax invoice was created: the business legal name or ABN is missing in Business details.'); return { skipped: 'details' }; }
    const r = await ensureInvoice(d, o, cfg, biz);
    if (!r.ok) return { skipped: r.reason };
    const inv = r.order;
    if (inv.invoice_sent_at) return { skipped: 'already sent' };
    const claimed = await d.update('orders', `id=eq.${d.q(o.id)}&invoice_sent_at=is.null`, { invoice_sent_at: new Date().toISOString() });
    if (!claimed.length) return { skipped: 'already sent' };
    const pdf = await invoicePdf(d, inv, cfg);
    const msg = invoiceEmail(inv, biz, invoiceLink(inv, cfg), cfg);
    const res = await sendEmail(d, { kind: 'transactional', template: 'tax_invoice', to: o.email, order_id: o.id, ...msg,
      attachments: [{ filename: `Tax invoice ${inv.invoice_number}.pdf`, content: pdf.toString('base64') }] }, cfg);
    if (res && res.status === 'failed') {
      await d.update('orders', `id=eq.${d.q(o.id)}`, { invoice_sent_at: null });
      await note(d, o, `Tax invoice ${inv.invoice_number} was created but the email failed: ${String(res.error || '').slice(0, 200)}. Use Resend invoice on the order.`);
      return { failed: true };
    }
    await note(d, o, `Tax invoice ${inv.invoice_number} emailed to ${o.email}.`);
    return { sent: true, number: inv.invoice_number };
  } catch (e) {
    console.error('invoice', o.id, e);
    await note(d, o, `Tax invoice could not be created: ${String(e.message).slice(0, 200)}. Use Generate invoice on the order.`);
    return { failed: true, error: e.message };
  }
}

// An adjustment note for a succeeded refund, when the order has a tax invoice. Safe to call again.
export async function ensureAdjustment(d, o, refund, cfg = config()) {
  if (!o.invoice_number) return { ok: false, reason: 'no invoice' };
  const biz = await businessDetails(d);
  if (!detailsComplete(biz)) return { ok: false, reason: 'details' };
  let r = refund;
  if (!r.adjustment_number) {
    await d.rpc('adjustment_assign', { p_refund: r.id, p_test: isTestNumber(o.invoice_number) || isTestPayment(o, cfg) });
    r = await d.one('refunds', `select=*&id=eq.${d.q(r.id)}`);
  }
  if (r.adjustment_pdf_path) return { ok: true, refund: r };
  const pdf = renderAdjustmentPdf(adjustmentModel(o, r, cfg.timezone), biz, await logoFor(cfg, biz));
  const path = `adjustments/${r.adjustment_number}.pdf`;
  await storageUpload(cfg, BUCKET, path, pdf, 'application/pdf');
  await d.update('refunds', `id=eq.${d.q(r.id)}`, { adjustment_pdf_path: path });
  return { ok: true, refund: { ...r, adjustment_pdf_path: path, _pdf: pdf } };
}
