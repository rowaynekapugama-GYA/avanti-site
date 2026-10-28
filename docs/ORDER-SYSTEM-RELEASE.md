# Order emails, order status and analytics: release notes

Built 28 October 2026 on branch `feature/order-emails-admin-analytics`.
Safety copy of the live site before this work: branch `safety/pre-order-system-2026-10-28` (commit 41e1051).

## What it does

1. **New order emails.** When Stripe or PayPal confirms a payment, the customer gets an order
   confirmation (order number, date, items with unit price and line total, subtotal, delivery
   method and cost, GST, total, delivery address, support contact). The Avanti team gets a
   "New order" email at `ADMIN_NOTIFICATION_EMAIL` with everything needed to start the job and a
   button that opens the order in the dashboard. Replying to it goes straight to the customer.
2. **Order status in the dashboard.** Each order has buttons: Mark as Processing, Mark as
   Dispatched, Mark as Delivered, Cancel order, Mark refunded. Nothing is saved until you confirm
   in the box that opens. Dispatched asks for the courier; tracking number and link are optional.
   Every change asks "Email the customer" (ticked by default).
3. **Status emails.** Processing, Dispatched (with courier and tracking if given), Delivered,
   Cancelled and Refunded each send a branded email with an order summary and contact details.
   Each email goes once. "Resend" on the order page sends it again on purpose.
4. **Timeline.** Status changes, who made them, notes, and every email (with its delivery status)
   show on the order's timeline.
5. **Analytics** (new menu item under Dashboard). Presets: Today, Last 7 days, Last 30 days, This
   month, Last month, This year, Custom range. Orders, revenue, average order value, items sold,
   new and returning customers, each with % change against the previous period of the same
   length. Orders and revenue by day (ranges up to 62 days) or by month, orders by status, top 10
   products, monthly table, and CSV export. Cancelled and refunded orders are left out unless you
   untick the box. Days and months follow Sydney time.
6. **Off switch.** Email log > Order emails > Switch off stops all order emails at once, with no
   redeploy. `ORDER_EMAILS_ENABLED=false` in Vercel does the same.

"In production" is now called "Processing" everywhere, including the customer's order page.
It is the same status underneath, so existing orders are unaffected.

## Safety

- Checkout, cart, prices, Stripe and PayPal code are unchanged. Emails run after the payment is
  recorded. If an email fails (or Resend is down) the order still completes, the failure is
  written to the timeline, and the email can be resent.
- An email only counts as sent if it didn't fail, and is never sent twice for the same order and
  status automatically, so webhook retries and double clicks can't send duplicates.
- All new admin actions check on the server that the person is a signed-in admin.
- The database change is additive: two indexes, one new server-only table for the on/off
  switch (not readable by the public), one new read-only function, and the existing status
  function re-created with two small changes: tracking number optional on Dispatched, and a paid
  order that was cancelled can become Refunded. No table, column or row is dropped, renamed or
  rewritten.
- Fixed along the way: previously, refunding a cancelled order in Stripe or PayPal made their
  webhook fail and retry for days. Now the order simply moves to Refunded and the customer gets
  the refund email.
- Emails time out after 10 seconds, so a slow email service never holds up a payment.
- Resend is only offered on orders that were actually paid.

## Settings (Vercel > Settings > Environment Variables)

All new settings have safe defaults, so nothing **has** to be added for this release to work.

| Variable | What it does | Example | Where |
| --- | --- | --- | --- |
| `ORDER_EMAILS_ENABLED` | `false` stops every order email (customer and staff). Orders still work. | `true` | Production and Preview |
| `ADMIN_NOTIFICATION_EMAIL` | Who gets the "New order" email. `off` turns it off. Defaults to `info@avantiprint.com.au`. | `info@avantiprint.com.au` | Production and Preview |
| `EMAIL_TEST_RECIPIENT` | Testing only: every email goes to this address instead, with `[TEST for ...]` in the subject. | `you@example.com` | **Preview only. Never Production.** |
| `BUSINESS_TIMEZONE` | Timezone for analytics and email dates. Defaults to Sydney. | `Australia/Sydney` | Production and Preview |
| `RESEND_API_KEY` | Already supported. Until it's set, emails are logged in the dashboard but not delivered. | `re_...` | Production |
| `RESEND_WEBHOOK_SECRET` | Already supported. Lets the Email log show delivered, bounced, opened. | `whsec_...` | Production |

Add or change these **before** the production deploy (or redeploy after changing them).

## Database step (Supabase > SQL Editor > New query)

Paste and run `scripts/migrations/004-order-emails-analytics.sql`. It's safe to run more than
once and should end with "Migration 004 done". Run it just before or just after the production
deploy. Until it's run, everything works except: Analytics shows an error, the on/off switch
asks you to run it, and Dispatched still needs a tracking number.

## Email delivery (Resend) and DNS

Emails are not delivered yet: Resend is not connected on the live site. Until it is, every email
is recorded in the Email log as "Logged only".

1. Create a Resend account and add the domain `avantiprint.com.au` (choose the sending region
   closest to Australia that it offers).
2. In whoever manages the avantiprint.com.au DNS, add the records Resend shows. They look like:

   | Type | Name | Value | Priority |
   | --- | --- | --- | --- |
   | MX | `send` | `feedback-smtp.<region>.amazonses.com` (copy from Resend) | 10 |
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` (copy from Resend) | |
   | TXT | `resend._domainkey` | `p=...` (long DKIM key, copy from Resend) | |
   | TXT | `_dmarc` (only if there isn't one) | `v=DMARC1; p=none;` | |

   These sit on the `send` and `resend._domainkey` names, so they don't touch the existing
   mailbox records (info@ keeps working as it does now).
3. When Resend says Verified, create an API key (Sending access, this domain only) and put it in
   Vercel as `RESEND_API_KEY`. Add a Resend webhook to
   `https://avantiprint.com.au/api/webhooks/resend` (delivered, delivery delayed, bounced,
   complained, opened, clicked) and put its signing secret in `RESEND_WEBHOOK_SECRET`. Redeploy.

## Testing checklist

On the Preview (with `EMAIL_TEST_RECIPIENT` set) or on live with the $1 hidden test product:

1. Place a test order. In Orders it shows as Paid, with "Order confirmation" and "New-order alert"
   in the timeline and Email log. With Resend connected, both emails arrive.
2. Open the order, click Mark as Processing. Check nothing changes until you click Confirm.
   Confirm with "Email the customer" ticked: status is Processing, email logged.
3. Mark as Dispatched: pick a courier, leave tracking empty, confirm. Email says it's on its way.
   Try another order with a tracking number: the email has a tracking link.
4. Mark as Delivered: delivered email logged.
5. On another order, untick "Email the customer": the timeline says the customer was not emailed.
   Click "Resend" and the email goes.
6. Click a status button twice quickly: only one email.
7. Email log > Switch off. Change an order's status: no email, the timeline says emails are off.
   Switch back on.
8. Analytics: Today and This month include the test orders, with the right totals. Untick
   "Exclude cancelled": cancelled test orders are counted. Export CSV opens in Excel.
9. Checkout still works exactly as before: add to cart, delivery choice, Stripe and PayPal pages.
10. Sign out and open `/#/admin/analytics`: you are sent to the sign-in page, and the server
    refuses analytics without sign-in.
11. Cancel and refund the test orders in Stripe/PayPal as usual, then unpublish the test product.

Automated: `tests/api.test.mjs` (37 tests, 10 of them new for this release) all pass against a
local copy of the database built from all migrations, plus browser tests of the new dashboard
screens, the demo, sign-out, password reset and a 214-page storefront sweep. An independent
code review found no problems with checkout or duplicate emails; its smaller findings are fixed.

## Rollback

If anything goes wrong after going live:

1. **Emails only:** Email log > Switch off (instant), or set `ORDER_EMAILS_ENABLED=false` and
   redeploy. Orders and payments keep working.
2. **Website:** Vercel > Deployments > the deployment before this one > "..." > Instant Rollback.
   Takes seconds.
3. **Code:** `git revert -m 1 <merge commit>` on main and push, or reset main to the branch
   `safety/pre-order-system-2026-10-28` (commit 41e1051).
4. **Database:** nothing needs undoing. The old site works with migration 004 in place (the new
   function and index are simply unused). If you want the old "tracking number required" rule
   back, re-run the `order_transition` part of `scripts/migrations/002-orders.sql` (this also
   removes the cancelled to refunded step).

## Update 29 October 2026: WooCommerce-style notifications

| Email | Goes to | When |
| --- | --- | --- |
| Order confirmation | Customer, copy to Avanti | Payment confirmed |
| New order | Avanti | Payment confirmed |
| Payment failed | Avanti | Stripe or PayPal reports a failed payment |
| Processing, Dispatched, Delivered | Customer, copy to Avanti | Staff change the status (tick box on) |
| Cancelled, Refunded | Customer, copy to Avanti | Staff cancel, or a full refund in Stripe or PayPal |
| Note to customer | Customer, copy to Avanti | Staff add a note with "Email this note to the customer" ticked |

Copies are separate emails marked "[Copy]" (replying goes to the customer) and can be turned off
in Email log. The new-order email also carries the customer's artwork: attached when up to 6 files
total 12 MB or less, and always as 30-day download links.

Before deploying this update, every category needs a delivery price (Dashboard > Shipping):
items without one can no longer be paid for online with $0 delivery.
