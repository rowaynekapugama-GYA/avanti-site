# Payments, orders and email: going live

This build adds online checkout (Stripe and PayPal), an Orders area, customer emails, and
email marketing to the Avanti site. Until the steps below are done, the site behaves exactly
as before for customers: the checkout page says online payment isn't available yet and gives
the phone number, and the dashboard demo shows sample orders and campaigns.

The client-facing setup guide (Stripe, PayPal and Vercel, click by click) is a separate document.
This file is the technical checklist.

## 1. Database (Supabase)

1. Create the Supabase project (see DASHBOARD-SETUP.md if not done yet).
2. SQL Editor: run, in order, `scripts/supabase-schema.sql`, then
   `scripts/migrations/002-orders.sql`, then `scripts/migrations/003-marketing.sql`.
   All three are safe to run again.
3. Create staff logins and make them admins (DASHBOARD-SETUP.md, "Staff accounts").
4. Load the products: `node scripts/seed.mjs` (needs the service role key on your own computer).
5. In `index.html`, fill in `supabaseUrl` and `anonKey`, and set `demo: false`.

## 2. Vercel settings (Settings > Environment Variables, then redeploy)

| Variable | Value |
| --- | --- |
| `SITE_URL` | `https://avanti-site-lovat.vercel.app` (staging), `https://avantiprint.com.au` at launch |
| `SUPABASE_URL` | the project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (server only, never in index.html) |
| `SUPABASE_ANON_KEY` | anon public key |
| `STRIPE_SECRET_KEY` | restricted key `rk_test_...` / `rk_live_...` with **Checkout Sessions: Write** |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from the Stripe webhook below |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | from the PayPal app |
| `PAYPAL_WEBHOOK_ID` | from the PayPal webhook below |
| `PAYPAL_ENV` | `sandbox` while testing, `live` at launch |
| `RESEND_API_KEY` | from Resend (without it, emails are logged in the dashboard but not sent) |
| `RESEND_WEBHOOK_SECRET` | `whsec_...` from the Resend webhook |
| `EMAIL_FROM` | `Avanti Print & Design <no-reply@avantiprint.com.au>` (default) |
| `EMAIL_REPLY_TO` | `info@avantiprint.com.au` (default) |
| `BUSINESS_ABN`, `BUSINESS_ADDRESS` | shown in every marketing email (Spam Act) |
| `CRON_SECRET` | any long random string; Vercel sends it to the scheduled job |
| `PAYMENTS_SIMULATOR` | `true` on staging only, for test orders with no keys. Never on live. |

## 3. Webhooks to register

| Provider | URL | Events |
| --- | --- | --- |
| Stripe | `<SITE_URL>/api/webhooks/stripe` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` (payload style: Snapshot) |
| PayPal | `<SITE_URL>/api/webhooks/paypal` | Checkout order approved; Payment capture completed, denied, declined, refunded, reversed |
| Resend | `<SITE_URL>/api/webhooks/resend` | email delivered, delivery delayed, bounced, complained, opened, clicked |

Stripe success and cancel pages, and the PayPal return address, are set automatically from
`SITE_URL` (`/#/order/...`, `/#/checkout?cancelled=1`, `/api/checkout?action=paypal-return`).

Payments made on the old WooCommerce site share the same Stripe and PayPal accounts. The new
webhook ignores them (they don't carry one of our order ids), so both sites can run side by side.

## 4. How an order becomes "paid"

Only a verified webhook from Stripe or PayPal (or the server-side PayPal capture) marks an order
paid, never the customer landing on the thank-you page. Every webhook is stored once by its id, so
repeats are ignored and no customer gets two confirmation emails. The amount paid must match the
order total. Status changes go through one database function that only allows:
awaiting payment → paid → in production → dispatched → delivered, plus cancelled and refunded.

## 5. Scheduled job

`vercel.json` runs `/api/cron` once a day, early morning Sydney time (20:00 UTC): scheduled campaigns, automations, and
cancelling checkouts left unpaid for 14 days. Vercel's free plan allows daily only. On Pro, change
the schedule to `*/15 * * * *` so scheduled campaigns and abandoned-cart emails go out within 15
minutes. The "Run now" button in Automations does the same on demand.

## 6. Email (Resend)

Create a Resend account, add the domain `avantiprint.com.au`, and add the DNS records it shows
(SPF, DKIM, and a DMARC record if there isn't one). Until the domain is verified, keep
`RESEND_API_KEY` empty: emails are then recorded in the Email log but not sent.

## 7. Testing before launch

1. With test keys and `PAYMENTS_SIMULATOR=true`, place an order with card `4242 4242 4242 4242`,
   one with a PayPal sandbox buyer, and one with the test gateway. Each should show as Paid in
   Orders with a confirmation in the Email log.
2. Move one through In production, Dispatched (with tracking) and Delivered.
3. Refund one in the Stripe dashboard and check it changes to Refunded.

## 8. Launch day

1. Switch to live keys, `PAYPAL_ENV=live`, `PAYMENTS_SIMULATOR` removed, `SITE_URL=https://avantiprint.com.au`.
2. Add live webhooks pointing at `https://avantiprint.com.au/api/webhooks/...`, update the secrets, redeploy.
3. One small real order, then refund it.
4. Two weeks later, once old WooCommerce orders are finished, disable the old site's webhooks.

## Decisions still needed from Avanti

- Delivery rates for the 11 categories without one (currently "quoted separately").
- Prices are treated as GST-inclusive (GST shown as total ÷ 11).
- Surcharging (none), PayPal Pay in 4 (left on), refunds done in the Stripe/PayPal dashboard.
- Single opt-in for the newsletter (consent date, source and IP recorded).

## Developer notes

- `api/` holds the serverless functions (Node 20, no npm packages). `scripts/dev-server.mjs` runs
  the site and API locally the same way Vercel does.
- Tests: `npm test` runs `tests/api.test.mjs` against a Supabase database with the schema, both
  migrations and the seed loaded (see the header of that file for the variables it needs).
  `tests/fixtures/storefront-prices.json` holds 1,429 prices taken from the shop; the test checks
  the server charges exactly the same for every one.
