// Sending through SMTP2GO (and Resend), with a stand-in database. No real database needed.   node --test tests/email.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMocks } from './mock-providers.mjs';
import { sendEmail, sendBatch, smtp2goPayload } from '../api/_lib/email.js';
import { config } from '../api/_lib/core.js';

let mocks;
const ENV = ['SMTP2GO_API_KEY', 'SMTP2GO_API_BASE', 'RESEND_API_KEY', 'RESEND_API_BASE', 'EMAIL_TEST_RECIPIENT'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
before(async () => { mocks = await startMocks(0); });
after(() => { mocks.close(); for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
function use({ smtp2go = true, resend = false } = {}) {
  for (const k of ENV) delete process.env[k];
  if (smtp2go) { process.env.SMTP2GO_API_KEY = 'api-test-key'; process.env.SMTP2GO_API_BASE = mocks.url + '/v3'; }
  if (resend) { process.env.RESEND_API_KEY = 're_test_key'; process.env.RESEND_API_BASE = mocks.url; }
  mocks.state.smtp2go = []; mocks.state.smtp2goFail = null; mocks.state.emails = [];
  return config();
}
// the email log, kept in memory
function fakeDb() {
  const rows = []; let n = 0;
  return { rows,
    async insert(_t, v) { const list = (Array.isArray(v) ? v : [v]).map(r => ({ id: `log-${++n}`, ...r })); rows.push(...list); return list; },
    async update(_t, filter, patch) {
      const ids = /id=eq\.(.+)$/.test(filter) ? [filter.split('id=eq.')[1]] : filter.replace(/^id=in\.\(|\)$/g, '').split(',');
      rows.filter(r => ids.includes(r.id)).forEach(r => Object.assign(r, patch)); return [];
    } };
}
const MSG = { kind: 'transactional', to: 'jo@example.com', subject: 'Your tax invoice from Avanti Print & Design (order AVP-1)', html: '<p>Hi</p>', text: 'Hi',
  attachments: [{ filename: 'Tax invoice AV-000001.pdf', content: Buffer.from('%PDF-1.4 test').toString('base64') }] };

test('with SMTP2GO_API_KEY set, emails go through SMTP2GO with the PDF attached and replies to info@', async () => {
  const cfg = use(), d = fakeDb();
  assert.equal(cfg.email.mode, 'smtp2go'); assert.equal(cfg.email.sending, true);
  const r = await sendEmail(d, MSG, cfg);
  assert.equal(r.status, 'sent'); assert.match(r.provider_id, /^s2g_/);
  assert.equal(d.rows[0].provider, 'smtp2go'); assert.equal(d.rows[0].status, 'sent'); assert.equal(d.rows[0].provider_id, r.provider_id);
  const sent = mocks.state.smtp2go[0];
  assert.equal(sent.sender, 'Avanti Print & Design <no-reply@avantiprint.com.au>');
  assert.deepEqual(sent.to, ['jo@example.com']); assert.equal(sent.subject, MSG.subject);
  assert.equal(sent.html_body, '<p>Hi</p>'); assert.equal(sent.text_body, 'Hi');
  assert.deepEqual(sent.custom_headers, [{ header: 'Reply-To', value: 'info@avantiprint.com.au' }]);
  assert.deepEqual(sent.attachments, [{ filename: 'Tax invoice AV-000001.pdf', fileblob: MSG.attachments[0].content, mimetype: 'application/pdf' }]);
});
test('artwork sent as a link is fetched by SMTP2GO (url), with the right file type', () => {
  const p = smtp2goPayload({ ...MSG, attachments: [{ filename: 'artwork.jpg', path: 'https://x.supabase.co/storage/v1/object/sign/a.jpg?token=t' }], headers: { 'List-Unsubscribe': '<https://a/u>' } }, use());
  assert.deepEqual(p.attachments, [{ filename: 'artwork.jpg', url: 'https://x.supabase.co/storage/v1/object/sign/a.jpg?token=t', mimetype: 'image/jpeg' }]);
  assert.deepEqual(p.custom_headers, [{ header: 'Reply-To', value: 'info@avantiprint.com.au' }, { header: 'List-Unsubscribe', value: '<https://a/u>' }]);
});
test('a failure SMTP2GO reports inside a 200 reply, or a bad key, is logged as failed with the reason', async () => {
  let cfg = use(), d = fakeDb();
  mocks.state.smtp2goFail = 'jo@example.com: sender domain not verified';
  let r = await sendEmail(d, MSG, cfg);
  assert.equal(r.status, 'failed'); assert.match(d.rows[0].error, /sender domain not verified/);
  mocks.state.smtp2goFail = null;
  process.env.SMTP2GO_API_KEY = 'api-wrong'; cfg = config(); d = fakeDb();
  r = await sendEmail(d, MSG, cfg);
  assert.equal(r.status, 'failed'); assert.match(d.rows[0].error, /Invalid API key/);
});
test('SMTP2GO is used when both keys are set; with neither, emails are only logged', async () => {
  let cfg = use({ smtp2go: true, resend: true }), d = fakeDb();
  await sendEmail(d, MSG, cfg);
  assert.equal(mocks.state.smtp2go.length, 1); assert.equal(mocks.state.emails.length, 0);
  cfg = use({ smtp2go: false, resend: false }); d = fakeDb();
  assert.equal(cfg.email.sending, false);
  const r = await sendEmail(d, MSG, cfg);
  assert.equal(r.status, 'logged'); assert.equal(mocks.state.smtp2go.length, 0);
  cfg = use({ smtp2go: false, resend: true }); d = fakeDb();   // Resend still works as before
  assert.equal((await sendEmail(d, MSG, cfg)).status, 'sent'); assert.equal(mocks.state.emails.length, 1);
});
test('campaigns through SMTP2GO: one email each, every one logged', async () => {
  const cfg = use(), d = fakeDb();
  const msgs = Array.from({ length: 12 }, (_, i) => ({ kind: 'campaign', to: `c${i}@example.com`, subject: 'Spring sale', html: '<p>x</p>', text: 'x', campaign_id: 'camp-1' }));
  const res = await sendBatch(d, msgs, cfg);
  assert.equal(res.length, 12); assert.ok(res.every(r => r.status === 'sent'));
  assert.equal(mocks.state.smtp2go.length, 12);
  assert.deepEqual(new Set(mocks.state.smtp2go.map(m => m.to[0])).size, 12);
  assert.ok(d.rows.every(r => r.status === 'sent' && r.provider === 'smtp2go' && r.provider_id));
});
test('test mode still sends everything to the one test address', async () => {
  use(); process.env.EMAIL_TEST_RECIPIENT = 'qa@gya.test';
  const cfg = config(), d = fakeDb();
  await sendEmail(d, MSG, cfg);
  assert.deepEqual(mocks.state.smtp2go[0].to, ['qa@gya.test']); assert.match(mocks.state.smtp2go[0].subject, /^\[TEST for jo@example.com\]/);
});
