# Order system audit (28 October 2026)

Written before changing anything, for the client request: order emails, order status management,
status emails and an analytics section. The site is live, so the rule for this work is: add,
don't rewrite.

## What the site is

- **Front end:** one static page (`index.html`, hash routes such as `#/product/...`, `#/admin/orders`).
  No framework, no build step, no package dependencies. The staff dashboard is part of the same page.
- **Server:** Vercel serverless functions in `api/` (Node 20, plain `fetch`, no npm packages).
- **Database:** Supabase (Postgres + PostgREST + Auth + Storage), project in ap-southeast-2.
- **Deploys:** Vercel Git integration on `rowaynekapugama-GYA/avanti-site`. A push to `main` deploys
  production; a push to any other branch makes a Preview deployment. `vercel.json` holds rewrites,
  the daily cron and headers. No `.vercel` folder in the repo.
- **Business timezone and currency:** Australia/Sydney, AUD. Prices include GST (GST = total / 11).
- **Lint, type-check, build:** there is no build, linter or TypeScript in this project. The checks
  are `node --check` on every API file, the API test suite (`npm test`, against a copy of the
  database) and browser tests.

## Orders today

- Stored in Supabase: `orders`, `order_items`, `order_events` (timeline), `email_log`, `webhook_events`.
- Created by `api/checkout.js` (`action=create`) as `pending_payment`, priced on the server.
- Become paid only from a verified Stripe webhook, a verified PayPal webhook or the server-side
  PayPal capture (`api/webhooks.js`, `api/checkout.js` → `markPaid` in `api/_lib/effects.js`).
  Webhooks are stored once by event id, so retries are ignored.
- Status changes go through one SQL function, `order_transition`, which allows only:
  pending_payment → paid | cancelled; paid → in_production | cancelled | refunded;
  in_production → dispatched | cancelled | refunded; dispatched → delivered | refunded;
  delivered → refunded. Nothing can go backwards. Dispatch currently requires carrier **and** tracking.
- After a real change, `afterTransition` records the customer (on paid) and sends the status email.

## Admin area today

- `#/admin` dashboard, signed in with Supabase Auth; only `profiles.role = 'admin'` gets in.
  The server checks the token and the admin role on every `/api/admin` call (`requireAdmin`), and
  row-level security limits database reads to admins. Auto sign-out after 60 minutes idle.
- Orders list: search (order number, email), status filter, date range, "Load more" paging.
- Order detail: items, artwork downloads, customer, payment, timeline with who changed what,
  internal notes, buttons for the next allowed statuses, dispatch form with carrier and tracking.

## Email today

- Provider: Resend over its REST API (`api/_lib/email.js`). Every message is written to `email_log`
  first. Without `RESEND_API_KEY` nothing is sent; messages are only logged. **Resend is not set up
  on the live site yet**, so no email currently reaches anyone.
- Customer emails exist for paid (confirmation), in production, dispatched, cancelled and refunded.
  No email on delivered. No email to Avanti when an order comes in.
- One email per real status change (the SQL function only reports a change once), but there is no
  explicit "already sent" check and no way to skip or resend an email.

## Gaps against the request

1. No "new order" email to Avanti.
2. No Delivered email; status emails don't include an order summary.
3. No "notify customer" choice, no resend button, no confirmation step on most status buttons.
4. "Processing" is called "In production" in the dashboard and emails.
5. Dispatch can't be saved without a tracking number.
6. No kill switch or test-recipient setting for email.
7. No analytics section.
8. An error while building or sending a status email could surface as an error to the webhook
   (the order itself is already saved as paid at that point, but the webhook call would report failure).

## Plan (files)

Modify:
- `api/_lib/core.js`: read the new settings (`ORDER_EMAILS_ENABLED`, `EMAIL_TEST_RECIPIENT`,
  `ADMIN_NOTIFICATION_EMAIL`, `BUSINESS_TIMEZONE`).
- `api/_lib/email.js`: Delivered and staff new-order templates, order summary in every status email,
  test-recipient redirect, tracking link only when there's a tracking number.
- `api/_lib/effects.js`: email after a status change becomes non-blocking (try/catch), skips
  duplicates, honours the on/off switches and the "notify customer" choice, and sends the staff alert.
- `api/admin.js`: notify flag, resend email, email on/off switch, analytics.
- `index.html`: dashboard only (orders screens, Analytics section, email switch). No change to the
  shop, cart, checkout or payment code.
- `tests/api.test.mjs`: tests for everything above.

Create:
- `scripts/migrations/004-order-emails-analytics.sql`: analytics function (read-only, server only),
  an index on `orders(paid_at)`, and the same `order_transition` with tracking made optional on dispatch.
  Nothing is dropped, renamed or rewritten; existing orders keep their status and data.
- `docs/ORDER-SYSTEM-AUDIT.md` (this file), `.env.example`, release notes in `CHANGELOG.md`.

Not touched: checkout pricing, cart, Stripe/PayPal calls, webhook verification, product data.
