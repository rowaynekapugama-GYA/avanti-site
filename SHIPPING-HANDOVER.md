# Shipping calculator: handover

Built from the client's *Shipping Calculator Specification v1.0* (3 November 2026).
Branch `feature/shipping-calculator`. It sits on top of `feature/woo-style-notifications`
(order emails, artwork follow-up), which is also not live yet, so releasing this branch
releases both.

## What it does

- At checkout the customer enters a postcode and sees one option: **Standard Delivery**, a
  single price including GST (with "$X + GST $Y" underneath). No breakdown, no pickup.
- If the postcode isn't in an enabled, approved zone with a rate for every package, or a package
  is too big for ordinary courier rates, the customer sees exactly:
  "Delivery pricing is currently unavailable for your postcode. Please contact us for a shipping
  quote." (plus Avanti's phone and email) and can't pay online. It never falls back to a cheaper zone.
- The server works out the price. Nothing the browser sends can change it. The same figure goes
  to Stripe or PayPal and is saved on the order.
- Each order stores a copy of the whole calculation and the settings version used. That copy
  can't be changed afterwards (database trigger).

## How the price is worked out

One engine (`api/_lib/shipping/engine.js`) is used by checkout, order creation and the
dashboard simulator. All money is whole numbers (fractions of a cent kept exactly, never floats).

1. Each cart line is packed using its packing profile (rigid, flat, rolled, poster, wallpaper,
   fixed-size parcel, flat-pack). Packages over 20 kg, or over the profile's height/diameter
   limit, are split.
2. Each package gets a freight band from its longest packed side: Small ≤600 mm, Medium ≤1000,
   Large ≤1500, Oversized 1 ≤2000, Oversized 2 over 2000.
3. The dearest package pays 100% of its zone base rate, the others 75% (editable; oversized
   packages can be excluded from the 75%).
4. Freight × 1.15.
5. Plus each package's width surcharge (second-longest side: 0 / 15 / 30 / 50% of its full base
   rate, not marked up) and weight surcharge ($0 / $10 / $20 / $35 up to 20 kg).
6. Plus packaging (cardboard $6/m², bubble wrap $0.65/m², labour $8 and tape $1.50 per
   package) × 1.2.
7. $15 ex GST minimum, rounded up to the next whole dollar, then GST at 10%.

The spec's reference example (Sydney Metro, two packages) comes to $107.00 ex GST and
$117.70 inc GST, and is an automated test.

## Files

New:
- `api/_lib/shipping/engine.js`: the calculation (zones, packing, pricing).
- `api/_lib/shipping/seed.js`: the starting settings (zones, rates, materials, packing).
- `api/_lib/shipping/validate.js`: checks settings before they can be saved.
- `api/_lib/shipping/store.js`: loads and saves settings versions.
- `scripts/migrations/005-shipping-calculator.sql`: database changes (additive only).
- `tests/shipping.test.mjs`: 17 engine tests (no database needed).

Changed:
- `api/_lib/orders.js`: quote and order creation use the engine; orders store the calculation.
- `api/checkout.js`: quote returns the customer's delivery price for their postcode.
- `api/admin.js`: dashboard actions `shipping-get`, `-save`, `-validate`, `-version`,
  `-simulate`, `-lookup`, `-override`, `-courier`, `-profit`.
- `api/_lib/core.js`: `SHIPPING_REQUIRE_APPROVAL` setting.
- `index.html`: checkout postcode pricing; cart and product pages say "calculated at checkout";
  new dashboard **Shipping** page (replaces the old per-category delivery options); Shipping card
  on each order.
- `tests/api.test.mjs`: shipping tests (48 API tests in total).

The old per-category delivery tables (`shipping_classes`, `shipping_rates`) are left in the
database untouched but no longer used for pricing.

## Settings (environment variables)

| Name | Value | Notes |
|---|---|---|
| `SHIPPING_REQUIRE_APPROVAL` | leave unset | Default: on in production (zones must be approved to price), off on preview links so rates can be tested. Never set it to `false` on production. |

No other new variables. `PAYMENTS_SIMULATOR` stays off on production.

## Database

In Supabase, SQL Editor > New query, run in order (both are safe to run again):
1. `scripts/migrations/004-order-emails-analytics.sql` if it hasn't been run yet (from the order emails release).
2. `scripts/migrations/005-shipping-calculator.sql`. It adds the settings versions table, six
   nullable columns on `orders`, the overrides and courier costs tables, and admin-read-only
   access. Nothing existing is changed, and the current live site ignores it, so it can be run
   before going live.

The first time the dashboard Shipping page (or a checkout) loads, the starting settings are saved
as version 1.

## Using it (dashboard > Shipping)

- **Zones:** find which zone a postcode falls in; edit names, postcode ranges, base rates, width
  and weight surcharges and optional package limits per zone; enable/disable; tick "Approved for
  the live site" (records who approved and when); postcode overrides. Where two zones cover a
  postcode, the narrower range wins (Sydney Metro beats NSW Regional); an exact tie is treated as
  unavailable.
- **Freight pricing:** markups, additional-package %, oversized discount, minimum, rounding,
  GST, band limits, package limits, and a rates table for all zones.
- **Products and packaging:** packaging costs and weights, materials (thickness, weight),
  rules that pick a material from the customer's options, packing profile settings, fixed-size
  parcels (A-frames, banners, cake toppers, samples), flat-pack board, and which packing each
  category or product uses.
- **Simulator:** postcode plus real products (with options) or custom items. Shows what the
  customer would see here and on the live site, each package (packed size, weight, band,
  surcharges, packaging) and every step of the total. Can use unsaved changes.
- **Profitability:** delivery charged vs courier cost per order, by date (Sydney time).
- **History:** every saved version; load an old one into the editor and save to restore it.

Changes are a draft until "Save as version N". Settings are checked as you type and can't be
saved with errors. If someone else saved in the meantime, saving is refused rather than
overwriting their change.

On each order: the Shipping card shows the zone, settings version and calculation, and lets
staff **override** the delivery charge (records original amount, new amount, reason, who and
when; it doesn't charge or refund the customer, that's done in Stripe or PayPal) and **record
the courier cost** or later adjustments.

## Release steps (suggested)

1. Run migration 005 in Supabase (harmless to the live site).
2. On the preview link, Avanti checks zones and rates in the simulator, corrects anything, and
   ticks "Approved" on each zone they want to sell to. The preview uses the same database, so
   approvals saved there carry over.
3. Go live (merge to `main`).
4. Place one small real order to a Sydney postcode and check the delivery on the order and in
   Stripe.

Important: on production a zone only prices once approved. If go-live happens before any zone is
approved, every customer sees the "unavailable" message and nobody can pay online.

## Needs Avanti's confirmation (all marked provisional in the settings)

- **Base rates** are the spec's Section 13 test rates, not real courier rates.
- **Metro postcode ranges** come from Shippit's published metro lists
  (support.shippit.com/en/articles/8942194). Brisbane is the core metro only; Gold Coast,
  Sunshine Coast and Tweed are a separate disabled zone.
- Regional, remote, WA, TAS and NT zones are disabled with no rates.
- Package limits: 2500 × 1300 × 600 mm and 20 kg.
- Packaging weights (cardboard 550 g/m², bubble wrap 40 g/m²) and a 10% waste allowance on
  measured areas.
- Print media thickness and weight (posters, synthetic paper, window graphics, floor decals,
  wallpaper).
- Fixed-size parcels: A-frame, pull up banner, cake topper and wallpaper sample sizes and weights.
- Wallpaper: 10 m² per roll, 4 rolls per 1100 × 250 × 250 mm carton.
- Flat-pack flat sizes: shipping cartons (L+W+35) × (H+W) in 2 layers; mailers
  (2W+3H+40) × (L+2H+20) in 1 layer.

## Assumptions made where the spec was silent

- Width surcharge uses the package's full base rate (before the 75% discount).
- Ties for "dearest package": the first one in the cart pays 100%.
- Rigid boards stack with others of the same size only (setting can allow smaller on larger).
- Packaging area: boxes use 2(LW + LH + WH) of the packed size; tubes use π × diameter ×
  length plus end caps.
- Oversized packages are eligible for the 75% rate (setting).
- A manual override records the corrected charge for reporting; it doesn't change the payment.
- Cake toppers and pull up banners are fixed-size parcels (5 toppers per mailer, 1 banner
  per package).

## Things that change for customers

- Cake toppers no longer have an Express option (Standard Delivery only, as the spec says).
- Small items now pay at least the $15 ex GST minimum ($16.50 inc GST), including the $1
  wallpaper sample.
- The top bar still says "Australia-wide shipping from $13.20" (Site wording > top bar). That's
  no longer accurate: update it, or remove it until regional zones are on.
- The FAQ "What are your shipping rates?" (Pages & FAQs) still quotes $12 standard and $20
  express. It needs rewording, e.g. "Delivery is priced from your postcode at checkout."
  Avanti should confirm the wording.

## Tests

- `node --test tests/shipping.test.mjs`: 17 engine tests (reference example, every band, width
  and weight boundary, splitting, packing profiles, postcodes, availability, rounding, GST).
- `tests/api.test.mjs`: 48 API tests against a local database (simulator equals checkout,
  versioning, approvals, immutability, overrides, profitability, permissions).
- Browser checks on a local copy: checkout by postcode, approving a zone, simulator, validation,
  history, order card, profitability, phone layout; plus the existing order, artwork, demo and
  site-wide checks.

No courier API is used. Real courier costs are entered per order for the profitability report.
