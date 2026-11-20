// Tax invoice and refund maths, the ABN check and the PDFs. No database needed.   node --test tests/invoices.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gstOf, abnValid, abnFormat, abnDigits, invoiceModel, adjustmentModel, renderInvoicePdf, renderAdjustmentPdf, detailsComplete } from '../api/_lib/invoices.js';
import { plainProviderError, refundBlock, left } from '../api/_lib/refunds.js';
import { gstIn } from '../api/_lib/discounts.js';

const BIZ = { legal_name: 'Example Signs Pty Ltd', trading_name: 'Example Print', abn: '51824753556', address: '1 Test Street\nSmithfield NSW 2164',
  phone: '(02) 9000 0000', email: 'info@example.test', invoice_footer: 'Bank transfer details are on our website. Thank you for your business.' };
const ITEMS = [
  { name: 'Pull Up Banner', options: { Size: '850 × 2000 mm' }, qty: 5, unit_cents: 10800, line_cents: 54000 },
  { name: 'Foamboard - Custom Dimension', options: { Thickness: 'Foamboard 5mm', Printing: 'Single Side', 'Custom size': '600 × 900 mm' }, qty: 2, unit_cents: 1890, line_cents: 3780 },
];
const ORDER = { id: 'o1', number: 'AVP-1042', invoice_number: 'AV-000007', invoice_issued_at: '2026-11-20T01:15:00Z', paid_at: '2026-11-20T01:15:00Z',
  name: 'Jo Buyer', email: 'jo@example.com', provider: 'stripe', subtotal_cents: 57780, product_discount_cents: 5778, shipping_discount_cents: 0, discount_code: 'SAVE10',
  delivery_cents: 3850, delivery_method: 'Standard Delivery', total_cents: 57780 - 5778 + 3850, refunded_cents: 0 };

test('GST is one eleventh of the GST-inclusive total, to the cent, on the discounted total including shipping', () => {
  assert.equal(gstOf(55852), 5077);   // 5077.45
  assert.equal(gstOf(1100), 100);
  assert.equal(gstOf(1155), 105);     // 105.0
  assert.equal(gstOf(1), 0);
  assert.equal(gstOf(6), 1);          // 0.545 rounds up
  assert.equal(gstOf(0), 0);
  const m = invoiceModel(ORDER, ITEMS);
  assert.equal(m.total, 55852); assert.equal(m.gst, 5077);
  assert.equal(m.subtotal - m.productDiscount + m.delivery - m.shippingDiscount, m.total);
  // with a shipping discount as well
  const o2 = { ...ORDER, product_discount_cents: 0, shipping_discount_cents: 3850, discount_code: 'FREESHIP', total_cents: 57780 };
  assert.equal(invoiceModel(o2, ITEMS).gst, 5253);   // 57780 / 11 = 5252.7
  // no discount: the same as the order record's per-part figure when shipping is a round dollar amount
  const o3 = { ...ORDER, product_discount_cents: 0, discount_code: null, total_cents: 57780 + 3850 };
  assert.equal(invoiceModel(o3, ITEMS).gst, gstIn(57780) + 350);
});
test('GST in a partial refund', () => {
  assert.equal(gstOf(1000), 91);      // $10.00 refunded includes $0.91 GST
  assert.equal(gstOf(2550), 232);     // 231.8
  const a = adjustmentModel({ ...ORDER, refunded_cents: 1000 }, { adjustment_number: 'AN-000001', amount_cents: 1000, reason: 'Reprint or fault', created_at: '2026-11-21T00:00:00Z' });
  assert.equal(a.amount, 1000); assert.equal(a.gst, 91); assert.equal(a.invoice, 'AV-000007'); assert.equal(a.refundedToDate, 1000);
});
test('ABN check digits', () => {
  assert.ok(abnValid('51 824 753 556'));      // the ATO's published example ABN
  assert.ok(abnValid('51824753556'));
  assert.ok(!abnValid('51 824 753 557'));
  assert.ok(!abnValid('5182475355'));
  assert.ok(!abnValid('ABN 51824753556'));
  assert.ok(!abnValid(''));
  assert.equal(abnFormat('51824753556'), '51 824 753 556');
  assert.equal(abnDigits(' 51 824 753 556 '), '51824753556');
});
test('sales of $1,000 or more show the buyer: business name if given, otherwise the customer', () => {
  const big = { ...ORDER, total_cents: 100000 }, small = { ...ORDER, total_cents: 99999 };
  assert.equal(invoiceModel(big, ITEMS).large, true); assert.equal(invoiceModel(small, ITEMS).large, false);
  assert.equal(invoiceModel(big, ITEMS).buyer.name, 'Jo Buyer');
  const biz = invoiceModel({ ...big, buyer_business_name: 'Buyer Co Pty Ltd', buyer_abn: '51824753556' }, ITEMS);
  assert.equal(biz.buyer.name, 'Buyer Co Pty Ltd'); assert.equal(biz.buyer.contact, 'Jo Buyer'); assert.equal(biz.buyer.abn, '51 824 753 556');
  assert.equal(invoiceModel({ ...big, company: 'Old Company Field' }, ITEMS).buyer.name, 'Old Company Field');   // the existing Company box counts too
  assert.equal(invoiceModel({ ...big, name: '' }, ITEMS).buyer.name, 'jo@example.com');   // never blank
});
test('no invoice without a legal name and ABN', () => {
  assert.equal(detailsComplete({}), false); assert.equal(detailsComplete({ legal_name: 'X' }), false); assert.equal(detailsComplete({ abn: '51824753556' }), false);
  assert.equal(detailsComplete(BIZ), true);
});
test('refund limits and blocked refunds', () => {
  assert.equal(left({ total_cents: 5000, refunded_cents: 1200 }), 3800);
  const cfg = { simulator: false, stripe: { secret: 'sk_test_x' }, paypal: { clientId: 'a', secret: 'b' } };
  assert.match(refundBlock({ paid_at: null }, cfg), /hasn't been paid/);
  assert.match(refundBlock({ paid_at: 'x', provider: 'stripe', provider_ref: '' }, cfg), /refund it in Stripe or PayPal/);
  assert.equal(refundBlock({ paid_at: 'x', provider: 'stripe', provider_ref: 'pi_1' }, cfg), null);
  // refunded before refunds were recorded here: the amounts aren't known, so it's blocked
  assert.match(refundBlock({ paid_at: 'x', provider: 'stripe', provider_ref: 'pi_1', status: 'refunded', refunded_at: 'x' }, cfg), /before refunds were recorded/);
  assert.match(refundBlock({ paid_at: 'x', provider: 'paypal', provider_ref: 'CAP1' }, cfg, { providerRefunded: true }), /before refunds were recorded/);
  assert.equal(refundBlock({ paid_at: 'x', provider: 'stripe', provider_ref: 'pi_1', status: 'refunded', refunded_at: 'x' }, cfg, { recorded: true }), null);
  assert.match(plainProviderError('stripe', { error: { code: 'balance_insufficient', message: 'Insufficient funds' } }), /enough balance/);
  assert.match(plainProviderError('paypal', { details: [{ issue: 'REFUND_TIME_LIMIT_EXCEEDED' }] }), /180 days/);
});

function pdfText(buf) {
  const f = path.join(os.tmpdir(), `inv-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`); fs.writeFileSync(f, buf);
  try { return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); } catch { return null; } finally { fs.unlinkSync(f); }
}
test('the tax invoice PDF carries everything the ATO asks for', () => {
  const pdf = renderInvoicePdf(invoiceModel({ ...ORDER, buyer_business_name: 'Buyer Co Pty Ltd', buyer_abn: '51824753556' }, ITEMS), BIZ);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.match(pdf.subarray(-6).toString(), /%%EOF/);
  const t = pdfText(pdf); if (t == null) return;   // pdftotext not installed: structure checked above
  for (const want of ['Tax invoice', 'Example Signs Pty Ltd', 'ABN 51 824 753 556', 'AV-000007', '20 November 2026', 'AVP-1042', 'Buyer Co Pty Ltd',
    'Pull Up Banner', '850 × 2000 mm', '$108.00', '$540.00', 'Product discount (SAVE10)', '-$57.78', 'Standard Delivery', '$38.50', '$558.52',
    'GST included in total', '$50.77', 'All items include GST', 'Card (Stripe)', 'Paid']) assert.ok(t.includes(want), `missing "${want}"`);
  assert.ok(!t.includes('\u2014'), 'no em dashes');
});
test('the adjustment note PDF', () => {
  const pdf = renderAdjustmentPdf(adjustmentModel({ ...ORDER, refunded_cents: 1000 }, { adjustment_number: 'AN-000001', amount_cents: 1000, reason: 'Reprint or fault', note: 'Colour was off on one banner', created_at: '2026-11-21T00:00:00Z' }), BIZ);
  const t = pdfText(pdf); if (t == null) return;
  for (const want of ['Adjustment note', 'AN-000001', 'AV-000007', 'ABN 51 824 753 556', 'Reprint or fault', '$10.00', '$0.91', 'Total refunded on this order']) assert.ok(t.includes(want), `missing "${want}"`);
});
test('the PNG reader refuses huge or broken images instead of using lots of memory', async () => {
  const { loadImage } = await import('../api/_lib/pdf.js');
  const zlib = await import('node:zlib');
  const chunk = (t, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(t, 4, 'latin1'); data.copy(b, 8); return b; };
  const png = (w, h, idat) => { const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]); };
  const ok = png(2, 2, zlib.deflateSync(Buffer.alloc(2 * (1 + 6))));
  assert.equal(loadImage(ok).kind, 'png');
  assert.equal(loadImage(png(20000, 20000, zlib.deflateSync(Buffer.alloc(10)))), null, 'too big');
  assert.equal(loadImage(png(2, 2, zlib.deflateSync(Buffer.alloc(5000)))), null, 'more data than the size says');
  assert.equal(loadImage(png(2, 2, zlib.deflateSync(Buffer.alloc(3)))), null, 'less data than the size says');
});
test('a long order runs onto a second page', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `Item ${i + 1} with a fairly long product name to wrap`, options: { Size: '600 × 900 mm', Printing: 'Double Side' }, qty: 1, unit_cents: 100, line_cents: 100 }));
  const pdf = renderInvoicePdf(invoiceModel({ ...ORDER, subtotal_cents: 4000, product_discount_cents: 0, total_cents: 7850 }, many), BIZ);
  assert.ok(/\/Count 2/.test(pdf.toString('latin1')) || /\/Count 3/.test(pdf.toString('latin1')));
  const t = pdfText(pdf); if (t == null) return;
  assert.ok(t.includes('Tax invoice AV-000007 (continued)'), 'continuation pages say what they are');
  assert.ok(/Page 1 of [23]/.test(t) && /Page 2 of [23]/.test(t), 'every page is numbered');
  assert.equal((t.match(/Thank you for your business/g) || []).length, 1, 'the footer line is on the last page only');
});
