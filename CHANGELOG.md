# Changelog

## 29 October 2026: WooCommerce-style notifications, artwork and delivery safeguards

**Before deploying:** Avanti must set delivery prices (Dashboard > Shipping) for every category
that doesn't have one, including Wallpaper (the $1 test product). After this update, items without
a delivery price can't be paid for online.

Notifications (Avanti hears about every order change, the way WooCommerce worked):
- **Copies to Avanti.** Every email sent to a customer also goes to `ADMIN_NOTIFICATION_EMAIL`
  as a separate email marked "[Copy]" (replying goes to the customer). On by default;
  Email log > "Turn copies off". Kept separate so a bounce on Avanti's copy never affects the customer.
- **Payment failed alert** to Avanti when Stripe or PayPal reports a failed payment (once).
- **Note to customer:** tick "Email this note to the customer" when adding a note.
- **Artwork in the new-order email:** attached when there are up to 6 files totalling 12 MB or less,
  and always with 30-day download links. Falls back to links if attaching fails.

Artwork and delivery (from order AVP-1002):
- Artwork uploads when the item is added to the cart, so a refresh before checkout can't lose it.
- If chosen artwork never arrived, checkout (browser and server) won't take payment and asks the
  customer to add it again, instead of quietly marking it "supply later".
- "Supply artwork later" stays, and is now followed up automatically (client revision, 29 Oct):
  - the customer gets an "Upload your artwork" email with a button to a secure upload page for
    their order (and the same button in their confirmation), plus Avanti's phone number;
  - one reminder goes out if nothing has arrived after 2 days (daily job);
  - Avanti's new-order email is marked "(artwork to follow)" with the customer's phone number;
  - when the customer uploads, Avanti gets an "Artwork received" email with the files attached
    (or download links), the files appear on the order, and the timeline records it;
  - the dashboard shows "Waiting for artwork" and has a "Resend artwork upload link" button;
  - uploads are accepted until the order is dispatched (up to 12 files per item).
- Items with no delivery price can't be paid with $0 delivery: the cart and checkout ask the
  customer to call or email for a quote.
- WebP images are no longer offered for artwork (the artwork store doesn't accept them).
- Avanti's alerts and copies go to info@avantiprint.com.au and rowayne@gyaclients.com by default,
  each as its own email. Change the list with `ADMIN_NOTIFICATION_EMAIL` (comma separated, up to 5).

No database change. Files: `api/_lib/effects.js`, `api/_lib/email.js`, `api/_lib/orders.js`,
`api/_lib/core.js`, `api/admin.js`, `api/checkout.js`, `index.html`, `tests/`. Tests: 44 API tests,
plus checkout, artwork, dashboard and demo browser tests and the 214-page storefront sweep.
An independent review of the checkout changes found no way to take a wrong payment; its other
findings are fixed.

## 28 October 2026: order emails, order status management and analytics

Client request: email the customer the order details, mark orders as Processing or Dispatched
in the dashboard, email the customer at each step, and an Analytics section with date ranges.
Full notes, settings, testing checklist and rollback: `docs/ORDER-SYSTEM-RELEASE.md`.

- New-order email to the Avanti team (`ADMIN_NOTIFICATION_EMAIL`, default info@avantiprint.com.au).
- Order confirmation now shows unit prices, subtotal, delivery method and support contact.
- New Delivered email. "In production" renamed "Processing" (same status underneath).
- Dashboard: confirmation box for every status change, "Email the customer" tick box, courier
  required but tracking optional on Dispatched, Resend buttons, emails on the order timeline,
  search orders by customer name, order email on/off switch in Email log.
- New Analytics section: presets and custom range, KPIs with % change, charts, top products,
  monthly table, CSV export, Sydney time.
- Emails never block an order, never send twice automatically, time out after 10 seconds, and
  can be switched off.
- Fix: refunding a cancelled order in Stripe or PayPal now marks it Refunded instead of making
  the webhook fail.
- New settings (all optional): `ORDER_EMAILS_ENABLED`, `ADMIN_NOTIFICATION_EMAIL`,
  `EMAIL_TEST_RECIPIENT`, `BUSINESS_TIMEZONE`. See `.env.example`.
- Database: run `scripts/migrations/004-order-emails-analytics.sql` in Supabase. Additive only
  (indexes, a server-only `app_flags` table, the analytics function, updated status rules).

| File | Change |
| --- | --- |
| `index.html` | Dashboard orders, order page, Email log switch, new Analytics section, demo mode support, "Processing" label on the customer order page |
| `api/admin.js` | Notify flag, optional tracking, new actions: resend email, email settings, analytics |
| `api/_lib/effects.js` | Emails after a status change: non-blocking, once only, staff alert, off switch |
| `api/_lib/email.js` | Email content (summaries, Delivered, staff alert), test recipient redirect |
| `api/_lib/core.js` | New settings |
| `api/_lib/orders.js` | Dispatch error message |
| `tests/api.test.mjs` | Updated for the new behaviour, 9 new tests |
| New | `scripts/migrations/004-order-emails-analytics.sql`, `.env.example`, `docs/ORDER-SYSTEM-AUDIT.md`, `docs/ORDER-SYSTEM-RELEASE.md` |

## 21 October 2026: new main photo for the Corflute Insertable A-Frame

- New main photo supplied by Avanti (single "Pedestrians" A-frame, square). Saved as
  `assets/products/corflute-insertable-a-frame-main.jpg`, 1400 x 1400, 230 KB, metadata removed.
  Because it's square it now shows in full on the product cards, with no trimming.
- Gallery is now: the new main photo, then the group of three A-frames. Alt text unchanged.
- `corflute-insertable-a-frame-1.jpg` is no longer shown but is kept in the repo, so the
  19 October database patch can still be re-run safely.
- Database: run `scripts/patches/2026-10-21-a-frame-main-photo.sql` in Supabase after deploying.
  It only changes the A-frame's first photo and should return one row saying OK.
- Files changed: `index.html`, `scripts/seed-data.json`, `CHANGELOG.md`, plus the new photo and patch.

## 19 October 2026: client revisions (Joey, "Website Updates")

Five changes requested by Joey at Avanti, plus the dashboard auto sign-out from 15 October
(not yet pushed at the time, so it ships in this update too).

**Important:** products and FAQs are now served from the Supabase database. The website files
alone don't change what customers see for the photos and FAQs. After this update is deployed,
run `scripts/patches/2026-10-19-client-revisions.sql` in Supabase (SQL Editor, New query, paste, Run).
Every row of its final check should say OK. Deploy first, then run the patch, so the new photo files
exist before the database points to them.

### Files changed

| File | What changed |
| --- | --- |
| `index.html` | All five tasks (built-in copy of the catalogue, FAQs and page wording), photo alt text support, dashboard auto sign-out after 60 minutes of no activity |
| `assets/products/corflute-insertable-a-frame-1.jpg` | New. Supplied photo, single A-frame ("Pedestrians"), 1050 x 1400, 155 KB |
| `assets/products/corflute-insertable-a-frame-2.jpg` | New. Supplied photo, three A-frames, 1400 x 1050, 134 KB |
| `scripts/seed-data.json` | Same image, FAQ and blog changes, so a fresh database setup matches the live site |
| `scripts/patches/2026-10-19-client-revisions.sql` | New. Applies the same changes to the live database (safe to run again) |
| `CHANGELOG.md` | New. This file |

No files were removed. The old A-frame photos are still used by the Metal Face A-Frame.

### Task 1: Corflute Insertable A-Frame photos

- Gallery replaced with the two supplied photos (black-framed A-frames with printed corflute inserts).
  The single sign is the main photo, the group of three is the second.
- Optimised the same way as the rest of the site's product photos (JPEG, about 1400 px on the long
  side, quality 82, progressive). Original aspect ratios kept, nothing cropped. Location and camera
  data removed from the files.
- Alt text: "Corflute insertable A-frame sign with a black frame and printed corflute insert" and
  "Three corflute insertable A-frame signs with black frames and printed corflute inserts".
  Product cards, the product page and the thumbnails now use a photo's alt text when it has one
  (otherwise the product name, as before). Staff can edit it in the dashboard under Products.
- Updated everywhere the product appears: product page, thumbnails, A-Frames category, search,
  related products and the share (og:image) picture, which all read the same gallery.
- Metal Face A-Frame keeps its current photos.

### Task 2: Different main photo for custom-size listings

Six products have a separate custom-size listing. Each custom-size listing now leads with a
different real photo from the same product's own gallery. The rest of the gallery keeps its order.
Standard-size listings are unchanged. No placeholder or designed images were needed.

| Product | Standard listing main photo (unchanged) | Custom-size listing main photo (new) | Type |
| --- | --- | --- | --- |
| ACM Panels | `Acm-02.jpg` (Gaming sign) | `Acm-7.jpg` (Yoga & Beyond freestanding sign) | Real photo |
| Corflute Signs | `corflute-1.jpg` (Halloween display) | `corflute-4.jpg` (wide shopping-centre panel) | Real photo |
| Floor Decals | `floor-decols2.jpg` (rectangular decal) | `floor-decols-4.jpg` (shaped "Hop on over" decals) | Real photo |
| Foamboard | `foam-board-1.jpg` (school holidays board) | `foam-board-6.jpg` (cut-out flower and egg shapes) | Real photo |
| Posters | `posters-1-480x600.jpg` (Easter poster) | `posters-4.jpg` (large Cilantro poster) | Real photo |
| Window Graphics | `window-graphics-2-480x600.jpg` ("Let's Connect") | `window-graphics-3.jpg` (full-height window panels) | Real photo |

Wallpapers are made to each customer's wall size, but there's no separate standard-size listing to
tell them apart from, so they were left as they are.

### Task 3: Showroom, walk-in and pickup references

Removed or reworded:

- Footer: "Showroom open Mon–Fri 9am–3pm" removed.
- Contact page: the "Showroom" box (Western Sydney, NSW, Open Mon – Fri 9am – 3pm) is now
  "Location: Western Sydney, NSW. Online, phone and email orders only. No walk-ins or pickups."
  "Opening hours" relabelled "Business hours" (Mon – Fri 9am – 4pm, Sat & Sun closed).
- About page: "or drop into the showroom in Western Sydney" now reads "or get in touch with our
  team by phone or email".
- Home page ("Printed & dispatched" step): "or pick up in-store" now reads "then delivered to your door".
- Product pages: "in-store pickup available" removed from the delivery line.
- Blog post "Where to find a personalised cake topper in Australia": the sentence offering pickup
  from the Smithfield factory removed.
- Site wording saved in the dashboard: the database patch drops any saved override that still
  mentions the showroom, walk-ins or pickup.

Checked and nothing to change: there is no LocalBusiness or FAQ structured data, no opening-hours
schema, no Google Maps embed and no "Get directions" button on the site. Checkout has no pickup
option. Remaining matches for the search terms are general blog wording (for example "in-store
promotions" or "someone walking past"), not about visiting Avanti.

### Task 4: Shipping FAQ

"How do you ship my orders?" now reads: "We deliver Australia-wide. The carrier we use depends on
the size of your order. Smaller items are generally sent with Australia Post, while larger and
bulkier products such as A-frames, large signage and corflute boards are sent with trusted external
courier and freight companies. If you have a question about delivery for a specific order, please
call us on 02 9729 0139 or email info@avantiprint.com.au."

The old line "Choose standard or express at checkout, or pick up from us in-store" was dropped.
Standard and express rates are still covered by the separate "What are your shipping rates?" FAQ.

### Task 5: Showroom FAQ

"Do you have a showroom?" now reads: "No, we don't have a showroom, and we're unable to accept
walk-ins or in-person pickups. All orders are handled online, by phone and by email, and delivered
to you. Our team is happy to help with any questions on 02 9729 0139 or info@avantiprint.com.au."

### Checks run

- Product pages, A-Frames category, contact page, footer, About, home page and the blog post
  checked at desktop (1280 px), tablet (820 px) and mobile (390 px): 70 of 70 checks passed,
  no sideways scrolling, no page errors.
- All 6 custom-size listings lead with the new photo; all 6 standard listings and the Metal Face
  A-Frame keep their original main photo.
- Full sweep of 214 pages: 1,924 images, 0 broken, 0 outside requests.
- Dashboard regression (20 of 20) and auto sign-out (15 of 15) checks passed.
- The database patch was run twice on a copy of the database. The result matches a fresh
  database built from the updated seed data exactly.
- This site has no build step (it's a single page plus serverless functions), so there is no
  `npm run build`. The API files were syntax-checked instead.

### Needs client confirmation

1. **Joey's ZIP wasn't received.** Only two photos came through, and both are used. If the ZIP
   had more, send them and they can be added to the gallery.
2. **Client branding in the A-frame photos.** Both photos show Westfield signage that Avanti
   printed. Please confirm Avanti is happy to show it on the website.
3. **Custom-size photos.** All six custom-size listings use another real photo of the same product
   from the existing galleries. If Joey would prefer dedicated custom-size shots, send them through.
4. **Location wording.** The site still shows "Western Sydney, NSW" (footer and contact page) with
   no street address. Confirm this is still right for the new location, or send the suburb to show.
5. **Business hours.** The footer and contact page still show "Mon–Fri 9am–4pm" as business
   hours (phone and email). Confirm these hours are still correct.
6. **Product card crop.** Product cards are square across the whole site, so the top and bottom
   edges of the tall A-frame photo are trimmed slightly in listings. The full photo shows on the
   product page.

## 15 October 2026: dashboard auto sign-out

Staff are signed out of the dashboard after 60 minutes with no activity. A "Still there?" warning
with a countdown and a "Stay signed in" button appears two minutes before. Tabs share activity, so
working in one keeps the others signed in, and a time-out in one signs them all out. A laptop left
closed for over an hour asks for sign-in again. Set by `idleMinutes` in the config block at the top
of `index.html`. Everyone is signed out once when this first goes live.
