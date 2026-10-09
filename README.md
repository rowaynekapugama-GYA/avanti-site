# Avanti Print & Design, new storefront (v1)

## Changelog: checkout, orders and email marketing (October 2026)

- **Checkout:** cart now kept between visits; new checkout page with delivery choices, GST, a
  marketing opt-in, and payment by Stripe (card, Apple Pay, Google Pay) or PayPal. Artwork files
  upload to the private artwork store. Prices are always recalculated on the server.
- **Orders** in the dashboard: dashboard cards, order list with filters and search, order detail
  with items, artwork downloads, payment reference and a timeline of who changed what. Dispatch
  takes a carrier and tracking number. Customers are emailed on paid, in production, dispatched,
  cancelled and refunded.
- **Marketing:** customers with recorded consent, CSV import, segments, email campaigns with
  preview, test send, scheduling, results and duplicate, four automations (welcome, abandoned
  checkout, reorder reminder, win-back), and an email log. One-click unsubscribe and a preferences
  page (Spam Act).
- Until Supabase and the payment keys are set up, customers see "online payment isn't available
  yet, call us", and the dashboard demo shows sample orders and campaigns.
- Setup steps: `docs/GO-LIVE.md`.

## Changelog: photos compressed (this round)

- All photos re-encoded at quality 82 and capped at 1400px on the longest side (the product
  gallery shows them about 600px, so nothing visible is lost). The three homepage slides changed
  from PNG to JPEG. Photos: 149 MB to 64 MB. File names are unchanged apart from those three.
- Faster pages for customers, and small enough to upload to GitHub in a few commits.

## Changelog: last outside files brought in

- `download-extras.js` collected all 44 remaining files (44 of 44). The 40 mailer box artwork
  templates are now in `assets/templates/`, and the About page photo and the three homepage
  slides (previously on Imgur) are in `assets/products/`.
- The site no longer loads anything from the WordPress site or Imgur. Checked all 213 pages with
  both blocked: every image loads, and all 101 template links point at files in the site folder.

## Changelog: photos in place

- All 332 missing photos collected with `download-photos.js` (332 of 332, none missing) and added
  to `assets/products/`, which now holds 414 photos. Blog covers and the one photo inside a blog
  article now point at the local copies, as does the mailer box photo on the homepage banner.
- Checked every page (213) with the live site blocked, as if WordPress were already switched off:
  all product, category and blog photos load from the site folder.
- Still loading from outside: the About page photo, the three homepage slides (on Imgur), and the
  40 mailer box artwork templates (PDF). `scripts/download-extras.js` collects all 44 into
  `avanti-extras.zip`, using the same steps as the photo script.

## Changelog: one-zip photo download

- New `scripts/download-photos.js` replaces `download-images.js`. Run it in Chrome's console on
  avantiprint.com.au (steps at the top of the file). It collects the 332 photos the site still
  needs into a single `avanti-photos.zip`, already laid out as `assets/products/`, with
  `MISSING-PHOTOS.txt` listing anything it couldn't fetch. No cPanel access needed.

## Changelog: dashboard photos

- Fixed: product photos not yet in `assets/products/` showed as empty boxes in the dashboard. The
  saved fallback to the live site's copy was only the end of the address, so the browser looked
  for it on the staging site. Fallbacks are now saved in full, and older saved data (including
  demo copies already in people's browsers) is handled too.
- Any photo with no copy anywhere now shows a "Photo file missing" tile with its file name,
  instead of a broken-image icon. The same applies to category and blog images in the dashboard.
- 287 photo files are still to be downloaded into `assets/products/` before WordPress is switched
  off (see the photo download notes). Until then those photos load from the live site.
- Tests: 9 photo checks, plus the full suite. All pass.

## Changelog: banner templates and template dropdown

- All four pull up banner stands now list the live site's two artwork templates (1400 × 850 mm
  and 2200 × 850 mm) in the template box beside Add to cart. They used to appear only in the
  artwork preview panel further down the page; that duplicate has been removed.
- Every product's templates now sit in a "Download Artwork Template" dropdown, like the live
  site, instead of a block of links. It starts closed; choosing a size opens it on that size's
  PDFs, with "Show all sizes" to see the rest. Long lists (40 mailer box templates) scroll
  inside the dropdown.
- Fixed: in demo or database mode, blog posts lost their Google title and description on the
  post list, so a seed export ("Download seed data") left out all 87 post SEO entries, and
  SEO edited for products and pages. Posts now keep their SEO in every mode, and the export
  includes every SEO entry. `scripts/seed-data.json` regenerated.
- Tests: 23 template checks, 29 demo, 36 dashboard, 48 blog, and all seven storefront suites. All pass.

## Changelog: demo sign-in

- The dashboard can now be tried before Supabase is set up. Go to `/#/login` and sign in with
  username `teamGYA`, password `avantisite2026`.
- In demo mode the dashboard works fully (prices, products, blog, SEO, wording, shipping, image
  uploads) but saves only in that person's own browser. Nobody else sees the changes and nothing
  goes live. The shop in that same browser shows the edits, so you can check them. **Reset demo**
  in the dashboard sidebar puts everything back.
- The demo password is visible to anyone who reads the page code. That's fine for a demo, as it only
  unlocks a private copy in their own browser, but set `demo: false` in the config block before
  go-live. Filling in the Supabase URL and key also switches the demo off automatically.
- Tests: 27 demo checks, plus the blog (48), dashboard (36) and all seven storefront suites. All pass.

## Changelog: blog moved across with its SEO

- All 87 of Avanti's blog posts (July 2019 to August 2026) now live on this site in full, imported
  from the WordPress export of 22 Sep 2026. Blog page: newest first, 12 per page with page numbers;
  the homepage shows the latest four; each article ends with three more to read.
- Post SEO carried over from Yoast: all 87 Google descriptions and the 22 custom page titles, plus
  photo alt text. They work without the database and are loaded into Supabase by the seed, where
  staff can edit them in the dashboard (Blog, or the SEO table).
- 17 theme sample posts (fashion and model articles from April 2022) were left out. See AUDIT.md Finding 15.
- Links inside articles now point at the new site. 10 old product links were matched to the current
  cake topper pages; 126 links to products no longer sold (sneeze screens, neon signs and so on) are
  now plain text, so no article sends a reader to an error page.
- New `404.html`: once WordPress is switched off, the old addresses Google has indexed (posts,
  dated post addresses, categories, blog pages, About, Contact, policies) land on the matching page.
- New `scripts/import-wordpress.mjs`: reusable for any GYA site moving off WordPress. Re-run it with
  a fresh export at any time: `node scripts/import-wordpress.mjs export.xml` (add `--dry-run` first).
- Blog cover photos still load from the live site. Download them before WordPress is switched off:
  `bash scripts/download-images.sh blog` (92 files, list in `scripts/images-blog.txt`).
- Tests: 48 blog checks (including the old-address redirects and the database copy), 36 dashboard
  checks, and all seven storefront suites on built-in and database data. All pass.

## Changelog: staff login and dashboard

- New staff login at `#/login` and dashboard at `#/admin`, backed by Supabase. Staff can edit
  prices (every variation), descriptions, photos, shipping, site wording, SEO, FAQs, pages
  and blog posts, live on the next page load. Setup steps are in DASHBOARD-SETUP.md.
- With the config block left blank (as shipped), the site runs exactly as before on its
  built-in data. If the database is unreachable, it falls back to that data automatically.
- Blog posts can now live on this site (`#/blog/<slug>`) instead of only linking to the old one.
- New files: `scripts/supabase-schema.sql`, `scripts/seed.mjs`, `scripts/seed-data.json`,
  `DASHBOARD-SETUP.md`.
- Tested against a local copy of Supabase: 36 dashboard checks (login, access control,
  price edits, spreadsheet paste, image upload, blog, wording, SEO, sign out, database down),
  and all seven storefront suites pass on both built-in and database data.
- The dashboard block is written to be reused on other GYA single-file sites: copy the
  `GYA CMS` block, run the same schema, and write a small adapter and seed for that site.

## Changelog: custom-dimension options and signage photos

- Posters, Window Graphics, ACM, Foamboard, Corflute and Floor Decals custom-dimension products
  now show their live options. See AUDIT.md Finding 13.
- scripts/download-signage-images.js grabs the 52 missing signage and A-frame photos.
- Fixed "weather-resistant, The go-to" style punctuation left by the em dash cleanup.

## Changelog: product names matched to live, em dashes removed

- All product and category names now match the live site (see AUDIT.md Finding 12), including
  Standard and Premium Pull Up Banner Stands and the Wallpaper category.
- Added the live Wallpaper Sample product ($10), linked from every wallpaper with its design
  pre-selected.
- Removed every em dash from the site copy, page titles, docs and scripts.

## Changelog: live-site sweep of banners, wallpaper, mailers and cartons

- Branded mailer boxes and branded shipping cartons now carry the live artwork block (supply
  choice, upload, Design Packs) with Outside and Inside slots; blank and plain boxes stay clean.
- All 40 live mailer artwork templates linked and filtered by size (1.5mm and 3mm bleeds).
- Wallpaper finishes renamed to the live labels (Textured Canvas Wallpaper, Smooth Matte
  Wallpaper), with the live sample and installation actions added. See AUDIT.md Finding 11.

## Changelog: all 22 cake toppers match the live order forms

- Every topper now has its live fields: text inputs, font list, fixed size, required or optional
  Event Date, fixed-wording previews and live descriptions. See AUDIT.md Finding 10.

## Changelog: photos + cake topper options

- Galleries from the WooCommerce export for all 105 products, served from `assets/products/`
  (248 photos still to supply: see `scripts/images-to-download.txt`).
- Cake toppers: live 17 colours as swatches; Age Cake Topper matches the live form in full.
- See AUDIT.md Finding 10.

## Changelog: artwork step on every print product

- Artwork supply (print-ready upload or design assistance, Design Pack 1/2, supply later) now on
  all 20 print products, placed between the options and Add to cart as on the live site.
- Add to cart locked until artwork is dealt with; Back tab follows Single/Double printing.
- Fixes: corflute preview size, template links overflowing on mobile, Add to cart gate clash.
- See AUDIT.md Finding 9.

## Changelog: real per-variation pricing from the WooCommerce export

- **Exact prices per option combination** for all 14 variable products (448 of 449 combinations),
  from the client's products CSV. Data lives in `VPRICE` (products.json: `variationPrices`).
- **Cart bug fixed**: variable products previously went into the cart at their lowest price
  whatever options were chosen. Cart lines, totals and the product page now use the selection.
- **Wallpaper cart lines** now charge wall m² × rate (min 0.5 m²), matching the product page.
- Unsold combinations show "Unavailable" and cannot be added.
- Corrections from the export: A-frame ranges, plain carton 335 mm sizes, Standard banner tier
  breaks (5/15/30), duplicated "Office" in wallpaper names, Vella topper name.
- Live WooCommerce data bugs are listed in AUDIT.md Finding 8 for the client to fix.
- To refresh prices later: re-export the CSV and rebuild `VPRICE` (see AUDIT.md Finding 8).

## Changelog, item 2: per-size artwork templates

- **Every product page now has a Download Template control** (dashed box under the option
  selectors). Until a size is chosen it lists all of that product's templates; once a Size is
  selected it filters to the matching PDF(s). Floor decals offer square-cut and round-cut per
  size; Window Graphics 1000 × 1200 mm shows a "no template published" note (none exists live).
- **54 template PDFs enumerated** from the live pages into `assets/templates/manifest.csv`.
  Data lives in `TPLS` in index.html (and exports to `products.json` under `templates`).
- **All 56 template PDFs are self-hosted** in `assets/templates/` (about 12 MB). The live site
  is behind bot protection that 403s scripted downloads, so the files were collected manually
  and committed. Both the per-size control (`tplUrl()`) and the older banner template list
  (`ART_TPLS`) now serve local paths, so nothing about templates depends on the live site.
  To add a template later: drop the PDF in `assets/templates/` and add an entry to `TPLS`.
- **Finish selectors added to Posters ("Finish") and Window Graphics ("Laminate Type")**, the
  live order forms carry these as required $0 fields (confirmed by page fetch); ACM and the
  Metal Face A-Frame already had theirs. See AUDIT.md Finding 4 (now resolved).

## Changelog, live-site audit, real sizes, A-Frame split
Audited against the **WooCommerce Store API** (`/wp-json/wc/store/v1/products`), which is
publicly readable and gave exact attribute sets. Full findings in **AUDIT.md**.

**Fixed this round**
- **Sizes now match Avanti's real sizes.** Corflute, ACM, Foamboard, Floor Decals and Window
  Graphics use the live millimetre sizes. Posters keeps A4–A0 (the only product that uses them).
- **Option labels match live**: Material / Size / Printing. Window Graphics "Type" renamed to
  "Material Type". Posters "Stock" renamed to "Material" with the two live values.
- **Foamboard Thickness and Printing are now separate selectors** (5mm/10mm × Single/Double).
- **ACM** gained Material, Size, Printing and a $0 Laminate (Matte/Gloss) chooser.
- **A-Frames split** into **Corflute Insertable A-Frame** and **Metal Face A-Frame**, with the
  live 600×900 / 900×1200 mm sizes, double-sided print noted as standard, and laminate on the
  metal-face model only. Both prices flagged `priceTBC`.

**Not done, see AUDIT.md "Open items"**
Per-variation prices, artwork templates for non-banner products, Cake Topper re-verification,
and the artwork-upload backend. The Store API does not expose per-variation prices, so no
option-level pricing has been invented.

## Changelog, studio rollout to corflute & A-frames + modern restyle
- **Artwork studio now on corflute and A-frame product pages** using the flat-panel
  mockup: tilted board with a fluted edge for corflute, a framed insert with legs for
  A-frames. The print size is live, corflute follows the selected A-size or the custom
  width/height inputs (aspect ratio and DPI recalculate on change), A-frames parse the
  size option's mm. Corflute gets Front/Back tabs (back = double-sided orders, no
  auto-copy); A-frames get Side A/Side B with one-file-both-sides auto-copy.
- **Modern UI pass**: card elevation with gradient hairline, 1-2-3 step chips that light
  as you progress, icon dropzone with hover/drag micro-interactions, pill segmented
  controls, spotlight stage backdrop, pulsing low-DPI warning.
- Hero "Upload your design" CTAs for corflute and A-frames now land on fully working
  upload studios.

## Changelog, hero slider promotes signage trio
Hero now promotes **Corflute Signs, Pull Up Banners and A-Frame Signs** with supplied
mockup images (hot-linked from imgur for now) and per-product copy, replacing the old
generic tagline. Each slide has two CTAs: **Shop now** (category page) and **Upload your
design** (product page; on the banner it deep-links via `?studio` and auto-scrolls to the
artwork studio). Note: the studio currently exists only on banner pages, so the corflute
and A-frame upload buttons land on their product pages, they'll light up fully when the
studio rolls out to flat signage next round. Consider replacing the imgur hot-links with
files in `assets/` so the hero doesn't depend on a third-party image host.

## Changelog, real delivery pricing + angled banner mockup
- **Delivery pricing wired in from the live WooCommerce table rates** (per client screenshots):
  Cake Toppers standard $13 / express $20; Banner Stands Metro NSW $30 / Regional NSW $50;
  Corflute Metro NSW $40 / Regional NSW $100. Costs are summed per option when multiple
  classes are in the cart (matching the Woo "Sum" rate calculation), the cart shows a
  per-class delivery estimate, product pages show category-accurate delivery lines, and
  NSW courier items carry the "our team will contact to confirm delivery details" note.
  Shipping classes are exported in `products.json` under `shipping`. Other categories
  still show "quoted at checkout", send their rates through and they slot straight in.
- **Banner mockup restyled to a 3D angled view** (like a product mockup photo): perspective
  tilt, artwork running edge-to-edge under a clamping top rail, lighting sheen across the
  face, roller base with feet (black on premium), soft floor shadow. Drag/zoom unchanged.

## Changelog, artwork audit + banner artwork studio (this round)
**Task 1, live-site cross-reference audit.** Every artwork-supply category was checked
against avantiprint.com.au (banners and corflute re-fetched live; the rest against the
original scrape). Findings and fixes are in **AUDIT.md**. Fixed in this round: corflute
thickness + eyelet options on both corflute products, live-parity material combos on the
custom product, and width/height (mm) capture on **all six custom-dimension products**
(corflute and ACM/foamboard enforce the live 1200 × 2400 mm maximum at add-to-cart).

**Task 2, artwork upload + live preview on the four pull-up banner pages.**
- Drag-and-drop / click upload (JPG, PNG, WebP preview instantly; PDF accepted with a
  "print-ready PDF received" state; 32 MB cap as on the live store)
- Live banner mockup: rail, 850 × 2000 mm print face, pole and roller base (black base
  on premium models), with drag-to-reposition, zoom slider, fill/fit toggle and a
  dashed "keep text inside" safe-area overlay
- Print-quality check: effective DPI at print size with a badge (140+ excellent · 95+
  good · 70+ acceptable · below 70 too low) and plain-language guidance
- Double-sided models take front/back uploads with a side switcher; one file = printed
  both sides (matches the live FAQ)
- Live-parity supply choice: print-ready files **or** design assistance (Pack 1 free /
  Pack 2 $49 + GST) plus the two artwork-template PDF downloads
- Artwork attaches to the cart line (filename, pixels, DPI verdict, layout) and shows in
  the cart drawer; "order now, supply artwork later" unlocks add-to-cart without a file
- Everything stays client-side (object URLs): no backend

**Rolling out to other products:** the studio is a reusable component (`artStudioHTML` /
`artStudio` + `BANNER_CFG`); next round points it at A-frames and corflute with a flat
panel mockup (portrait/landscape) instead of the banner rig.

Open `index.html` in any browser. Everything runs client-side, no build step.

## What's in here
- `index.html`: the whole site: home, shop (all products + 14 category pages, search, sort, wallpaper sub-filters), product pages, cart drawer with quantity-tier pricing, about, contact + FAQ, blog, policy page stubs.
- `products.json`: the full catalogue (104 products, 14 categories) pulled from avantiprint.com.au, ready to load into whatever backend comes next.
- `assets/logo-trim.png`: the logo, trimmed for the header.
- `assets/favicon.ico`, `icon-192.png`, `apple-touch-icon.png`, `avanti-favicon-512.png`, the browser/tab and home-screen icons, all generated from the supplied 512px mark.
- `assets/products/`: product photos supplied directly (rather than pulled from the live site).

## Product photos, current coverage
**All 104 products and all 14 category tiles now have real photography.**

Images come from two places:
- **Local files in `assets/products/`**: photos supplied directly. These are bundled in the repo, so they keep working regardless of the old WooCommerce site.
- **Hot-linked from `avantiprint.com.au/wp-content/uploads/...`**: mostly the extra gallery shots (close-ups and artboards) that sit behind the main image.

Any image URL that fails falls back automatically to the branded placeholder tile (see `imgFail` in `index.html`), so a broken image never appears.

### How wallpaper images work
Each wallpaper design on the live site has up to three shots: `Complete-Wall-Design-N`, `Close-Up-Design-N` and `Original-Artboard-Design-N`. Two things to know:
- The trailing `-1` / `-2` is **part of the design identity, not a duplicate marker**, `Design-4`, `Design-4-1` and `Design-4-2` are three completely different artworks. Some numbers carry three separate designs.
- To wire a wallpaper up, add to its row in the `WP` array: the design number as the sixth field, then an array of image paths as the seventh. `WP_TRIO(n, suffix)` builds the three live-site URLs (pass `0` for no suffix).

### Replacing an image later
- **Wallpaper**: edit the seventh field of its `WP` row.
- **Cake topper**: add an entry to the `CT_LOCAL` map; otherwise the filename is derived as `{Name}-Topper.jpg`.
- **Signage / packaging**: edit the relevant `IMGS_*` / `POSTER_IMGS` / `WG_IMGS` constant near the top of the data block.

Then regenerate `products.json` (it's built from the same data) if you're using it.

### A note on image quality
Many of the supplied wallpaper files are the WordPress `480x600` thumbnail rather than the full-size original. They look fine on the shop cards but are a little soft on the large product-page image. Where a thumbnail was supplied, the full-size URL is already included as the next gallery image, so swapping in the originals later is straightforward.

## Deliberately left for the next round
- Real variation pricing (sizes/materials currently show a base price and a "final price by size" note)
- Delivery options and checkout/payment
- Artwork upload on the product page
- Terms, privacy and returns copy (stubs are in place)


## Left for next round
- Roll the artwork studio out to A-frames, corflute and other flat signage (panel mockup)
- Real per-variant pricing for corflute thickness/eyelet combos and other size-priced options
- Delivery options and a checkout/payment flow
- Real policy-page copy; upgrade 480×600 wallpaper thumbnails to full-size originals
- Minor copy fixes (Garden Greens, Grey Artistic Strokes descriptions)
