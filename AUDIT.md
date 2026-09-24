# Avanti, Live vs Staging product audit
**Source of truth:** WooCommerce Store API, `avantiprint.com.au/wp-json/wc/store/v1/products`
**Date:** 2 September 2026

## How this audit was gathered
The Store API is publicly readable and returned full attribute sets, descriptions and FAQs.
Two limitations hit during this pass, both of which affect what can be completed:

1. **Per-variation prices are not in the payload.** *(RESOLVED 21 Sep, see Finding 8: the
   client's WooCommerce products export now supplies every variation price.)* The API returns each product's variation
   list as attribute combinations plus a variation ID, but no price per combination. Only the
   parent price range is exposed (e.g. Corflute Signs `$7.68 – $155.52`). Getting the price for
   each of the ~24 corflute / 12 ACM / 10 window-graphic / 4 A-frame combinations needs one
   fetch per variation ID.
2. **Paging is ignored.** `?page=2` and `?_fields=` are not honoured and the response truncates
   mid-catalogue. Confirmed this pass: A-Frames, Corflute (both), ACM (both), Window Graphics
   (both), Floor Decals (both), Foamboard custom, Posters custom. **Not yet pulled:** Foamboard
   standard, Foam PVC, EnviroBoard, Pull Up Banners, Cake Toppers, Mailer Boxes, Shipping Cartons.

## Finding 1, the staging URL is behind the current build
Two of the reported issues are already fixed in the latest zip from this chat, so
`avanti-ten.vercel.app` looks like an older deploy:

| Reported | Actual state of latest build |
|---|---|
| "Cake Toppers are missing" | **22 cake topper products** exist, in the `cake-toppers` category, with personalisation fields and self-hosted images |
| "All pull up banners are single-sided" | **All four** banner products exist, including both double-sided ones |

Banner tier bands in the build already match the table supplied:
Premium 240/216/192/168 · DS Standard 280/252/224/196 · DS Premium 320/288/256/224.
**One discrepancy to confirm:** Standard Pull Up is stored as 1–2 $120, 3–5 $108, 6–15 $96,
**16+ $84**. The brief says $84 at **30+**, which would leave 16–29 undefined. Our value came
from a live read in an earlier round. Needs a re-check against the live product page.

**Action:** redeploy from the current zip before assessing further.

## Finding 2, sizes (the client is correct)
Live uses **millimetre sizes** on every signage product. **Posters is the only product using
A-sizes** (A4–A0), exactly as the client said. Our build wrongly applies A-sizes to corflute,
foam PVC and foamboard, and wrong sizes to A-frames.

| Product | Live sizes | Staging sizes | Status |
|---|---|---|---|
| Corflute Signs | 600×400, 600×600, 600×800, 800×1200, 1200×1200, 1200×2400 mm | A4–A0 | **Wrong, fixed this pass** |
| ACM Panels | same six mm sizes | (none) | **Missing, fixed this pass** |
| Foamboard | same six mm sizes | A4–A0 | **Wrong, fixed this pass** |
| Floor Decals | 300×300, 400×400, 600×600, 800×800, 1000×1000 mm | (none) | **Missing, fixed this pass** |
| Window Graphics | 300×400, 600×400, 600×800, 800×1000, 1000×1200 mm | (none) | **Missing, fixed this pass** |
| A-Frames | 600×900 mm, 900×1200 mm | A1/A2 | **Wrong, fixed this pass** |
| Posters | A4, A3, A2, A1, A0 | A4–A0 | Correct, leave as is |
| Foam PVC | same six mm sizes (Thickness: PVC 2/3/5mm) | A4–A0 | **Wrong, fixed (page fetch)** |
| EnviroBoard | same six mm sizes (Material: Kraft/White 10/20mm) | A4–A0 | **Wrong, fixed (page fetch)** |

*Note:* the Floor Decals description text lists 450×450 mm but the actual variation set uses
400×400 mm. The variations are authoritative; flag for the client.

## Finding 3, option labels and missing selectors

| Product | Live options (exact labels) | Staging | Gap |
|---|---|---|---|
| Corflute Signs | **Material** (Corflute Signs 3mm / 5mm), **Size**, **Printing** (Single Side / Double Side) | Size, Thickness, Sides, Eyelets | Label mismatch: live calls it Material + Printing. Eyelets is **not** a live variation attribute, it's described in the FAQ only |
| ACM Panels | **Material** (Aluminium Composite Panel with polymeric print and gloss/matte laminate), **Size**, **Printing** | none | All three missing |
| Foamboard | **Thickness** (Foamboard 5mm / 10mm), **Size**, **Printing** | Size only | Thickness + Printing missing. Confirms the client's request to split them into two selectors |
| Floor Decals | **Material** (Floor decals with anti slip lam), **Size** | none | Both missing. Anti-slip laminate is **included**, not a chooser |
| Window Graphics | **Material** (Short Term / Permanent), **Size** | Type, Size | Rename Type → Material Type as requested |
| Posters | **Material** (Poster paper 220GSM matte or gloss / Satin synthetic paper), **Size** | Size, Stock | "Stock" should be "Material" with the two live values |
| A-Frames | **Material** (Metal Face / Corflute Insertable), **Size** | Style, Size | Split into two products as requested |

## Finding 4, lamination (RESOLVED 18 Sep, direct page fetches)
The earlier read was API-only; lamination is not a *variation* attribute, but the live **order
forms** carry required $0 finish fields the API never returns. Confirmed on-page:

- **ACM:** required "*Finish*: Gloss / Matte": in the build (Laminate selector, $0).
- **Posters:** required "*Finish*: Gloss / Matte": **added this pass** (Finish selector, $0).
- **Window Graphics:** required "*Laminate Type*: Gloss / Matte": **added this pass** ($0).
- **A-Frames:** required "*Finish*: Matte / Gloss Laminate" on the combined product. Applied to
  the Metal Face split only, since the FAQ says the Corflute Insertable has no laminate.
- **Floor Decals:** no finish field anywhere; anti-slip laminate included. No selector added  - 
  the only remaining lamination question for the client.

This closes the lamination half of client items 6/7/10 for ACM, Posters and Window Graphics.

## Finding 5, A-Frame split
Live is one variable product with two materials × two sizes, price range **$160 – $400**.
Split as requested, with the live naming:

| New product | Live material | Sizes | Laminate | Print |
|---|---|---|---|---|
| Corflute Insertable A-Frame | A - frame Corflute Insertable | 600×900, 900×1200 mm | None (per FAQ) | Double-sided always |
| Metal Face A-Frame | A - frame Metal Face | 600×900, 900×1200 mm | Gloss or matte | Double-sided always |

*Naming note:* the brief calls the second one "ACM Panel A-Frame". Live calls it **Metal Face**
and never says ACM. Using the live name; confirm if the client prefers ACM Panel A-Frame.
Per-variation prices are **TBC** pending variation fetches.

## Finding 6, artwork templates (COMPLETE 18 Sep, item 2 wired)
Every product page's "Download Artwork Template" widget has now been enumerated by direct page
fetch, 54 live PDFs plus the 2 banner ones, all catalogued in `assets/templates/manifest.csv`.
A per-size **Download Template** control is wired into every product page (filters to the
selected size, lists everything until a size is chosen). Links currently hotlink the live
`wp-content/uploads/` URLs, same as the banner templates always have.

Inventory quirks worth knowing:
- **Window Graphics:** only 4 templates: the 1000 × 1200 mm size has none on the live page.
  The control shows a graceful "no template published for this size" note there.
- **Window Graphics filenames** flip width/height vs the size labels (e.g. size 800 × 1000 mm
  → file `...1000x800mm.pdf`); matching is dimension-order-insensitive.
- **Posters:** two A1 files exist. `Poster-841x594mm-A1.pdf` is wired; `Posters-894x841mm-A1.pdf`
  (894 looks like a typo for 594) is manifest-only. Flag for the client to delete or fix.
- **Floor Decals:** each size ships square-cut *and* round-cut templates; both are offered.
- **A-Frames:** the 900 × 1200 insertable file is named `1200x900mm-Insertable`.

Self-hosting: DONE. The live site sits behind bot protection that returns 403/202 to any
scripted request, so neither the sandbox nor a local curl could fetch the PDFs. The client
downloaded all 56 manually and they are now committed to `assets/templates/`, with `tplUrl()`
and the banner `ART_TPLS` list both serving local paths. The storefront no longer depends on
avantiprint.com.au being reachable for templates.

## Finding 7, design packages
Every product description carries the same line: **"Design Service – $49 flat rate (includes 2
rounds of revisions)"**. The live site does not publish a two-tier "Design Pack 1 / Design Pack 2"
structure in any product description returned by the API, that structure appears only in the
banner page's artwork widget. The build's current wording (Pack 1 free basic / Pack 2 $49+GST)
matches the banner page. **Confirm with client** whether Pack 1/Pack 2 applies catalogue-wide or
whether other products are simply "$49 flat rate".

## Finding 8: per-variation prices (RESOLVED 21 Sep, WooCommerce export)
The client's products CSV (746 rows: 95 simple, 19 variable, 632 variations) now drives pricing.
`VPRICE` in index.html (exported as `variationPrices` in products.json) holds the exact price of
448 of 449 option combinations across 14 products, keyed on the build's own option labels.

**Before this pass the cart charged every variable product at its lowest "from" price**
regardless of options (a 1200 × 2400 double-sided ACM panel checked out at $25.20, not $453.60).
Now the product page shows the exact price once every price-bearing option is chosen, keeps the
range while a selection is partial, and the cart and totals price each line on its own options.
Same pass fixed wallpaper cart lines, which charged the per-m² rate flat instead of wall m² × rate.

Catalogue parity confirmed: all 94 published simple products match on price (22 cake toppers,
59 wallpapers, banners, custom-dimension items). Build corrections made from the export:
- **A-Frame ranges**: the split products kept the combined $160–$400. Real ranges are Metal
  Face $200–$400 and Corflute Insertable $160–$280.
- **Plain Shipping Cartons**: the two largest sizes are 335 mm on the live site, not 340 mm
  (the build had borrowed the printed-carton size list).
- **Standard Pull Up Banner tiers**: build had breaks at 3/6/16; WooCommerce's rule is 5/15/30.
- Names: four office wallpapers were titled "… Office Office Wallpaper"; the Vella family
  topper now uses its live name.

**Live-site data bugs found (the new build handles each; the client should fix WooCommerce):**
- **Custom Branded Shipping Cartons**: the Material attribute is blank on all 64 variations, so
  WooCommerce matches the first (White) price whichever material is picked. Kraft buyers are
  overcharged (e.g. $7.73 instead of $7.15). Verified 32/32 against the old per-material
  products; the build prices White and Kraft separately.
- **Foamboard**: variation 21112 ($14.26) is labelled 10mm / 600 × 800 / Double, duplicating
  21108 ($28.51). By the ×1.35 double-side ratio that holds on every other row it is really
  10mm / 600 × 400 / Double, which is currently **unbuyable** on the live site. Build fixed.
- **Blank Mailer Boxes**: no variation exists for White B Flute 3mm / 225 × 160 × 80. The build
  shows "Unavailable" for that combination and blocks add to cart until the client prices it.
- **Premium and both Double Sided banner tiers** are entered as `4:…,14:…,29:…,30:…`. The plugin
  reads those as minimum quantities, so live discounts start at 14, not 5 (a customer buying 5
  to 13 pays full price). The Standard stand is entered correctly (`5,15,30`). Build uses 5/15/30.
- **Gold Lines in Granite Wallpaper** is a variable product with zero variations, so it cannot
  be purchased on the live site. The build sells it at the standard $65/m².

Not changed: the Design Pack 2 fee ($49 + GST) is displayed but not added to cart totals.
Needs the client to say whether it is charged once per order or per item.

## Finding 9: artwork upload on every print product (DONE 21 Sep)
Client note: "most don't have anywhere to upload their artwork", plus item 3's "design assistance"
on ACM. The studio existed only on banners, corflute and A-frames, and even there it sat below
Add to cart. Now, on all 20 print products (adds ACM, Foamboard, Foam PVC, EnviroBoard, Posters,
Window Graphics, Floor Decals and their custom-size versions):
- The artwork step sits in the buy column between the options and Add to cart, matching the live
  order form: "How will your print-ready artwork be supplied?", print-ready files or design
  assistance (Design Pack 1 / 2), Upload file with the 32 MB limit, and "supply artwork later".
- Add to cart stays locked ("Upload artwork to continue") until artwork, a design pack or the
  supply-later option is chosen. Unsold combinations also lock it.
- The full preview / quality check stays below and is one click away.
- The Back artwork tab follows the Printing option: hidden for Single Side, shown for Double Side,
  and a single-sided order never carries a back file. One-sided products have no Back tab.
Fixed along the way: corflute's preview drew every size at A2 proportions; the template links
overflowed the screen on phones; the price update from Finding 8 re-enabled Add to cart before
artwork was supplied.

Still open: files are held in the browser only. The site is static, so uploaded artwork does not
reach Avanti until an upload endpoint is chosen (see open items).

## Finding 10: photos and cake topper options (21 Sep)
**Photos.** The build referenced live photo URLs, but avantiprint.com.au refuses image requests
from other sites (the same protection that blocked the template downloads), so on staging every
hotlinked photo fell back to "Product photo coming". Now:
- Every product's gallery comes from the WooCommerce export `Images` column: same photos, same
  order as live (47 products previously had fewer photos than live).
- All images point at `assets/products/`. 141 are already there; 248 are listed in
  `scripts/images-to-download.txt` and `scripts/download-images.js`. Drop the files into
  `assets/products/` and they appear with no code change. Until then each image tries the live
  URL once, then shows the placeholder.

**Cake toppers.** The build's 20 colours did not match live. Now the 17 live colours (Plywood to
Rose Gold Mirror) as swatches, and the Vella topper has no colour choice (fixed design on live).
Age Cake Topper matches the live form field for field: Age (14 characters, counter), Style
(5 lettering fonts, live preview), Size 4.5cm x 14cm, optional Event Date, live description.
Only Lobster previews exactly; the other four fonts are licensed and preview approximately, with
a note on screen, until the font files are supplied.

The personalisation fields come from the ThemeComplete Extra Product Options plugin, built inside
each product (not shared forms), so neither the WooCommerce export nor Tools > Export includes them.
All 22 toppers were therefore read field by field from the live pages (21 Sep) and now match:
each topper's own text fields (Age, Name, Name + Age, Years, or none), its own font list (4, 5 or
6 fonts; Happy Birthday with Name adds The Richland Bold), its fixed size, and whether Event Date
is required (19 toppers) or optional (Age, Cross and Dove, Last Fling). Fixed-wording toppers
(Congrats, Engaged, Oh Baby, Last Fling, Bride To Be, Twinkle Twinkle) preview that wording in the
chosen font. Descriptions follow each live page.

Live-site slips for the client: Engaged, Love With Arrow and Oh Baby Wreath list Silver Glitter
twice and no Silver Mirror; several colour names are misspelt on the live forms (the build uses the
correct 17). Only the Age topper's character limit (14) is known; other text fields are left
uncapped rather than guessed.

## Finding 11: full sweep of the remaining live categories (21 Sep 2026)

Every category not already verified against the WooCommerce export was checked on the live site:
pull up banners, wallpaper, mailer boxes and shipping cartons. Variable products' dropdowns were
already confirmed from the export; this sweep targeted the plugin-added order form parts the
export cannot show.

What was found and applied to the build:
- Custom Branded Mailer Boxes (and by the identical Design Pack copy, Custom Branded Shipping
  Cartons) carry the same live artwork block as the banners: supply choice, 32 MB upload and both
  Design Packs. The build now shows that block on both branded box products, with Outside and
  Inside artwork slots that follow the Printing choice, and Add to cart gated until artwork is
  handled. Blank Mailer Boxes and Plain Shipping Cartons carry no print and correctly get no
  artwork step.
- The live mailer page publishes 40 artwork template PDFs (20 sizes in 1.5mm and 3mm bleed
  menus). All 40 are now linked on the build's branded mailer page, filtered by the chosen size.
  They point at the live PDFs for now; download them into assets/templates/ when convenient and
  the links will keep working unchanged.
- Wallpaper finishes are named Textured Canvas Wallpaper and Smooth Matte Wallpaper on live, in
  that order; the build previously used shorter invented labels. Labels, ordering and the finish
  descriptions now follow the live page, and each wallpaper shows the live page's Order a sample
  ($10, posted in both finishes) and Installation enquiry actions, wired to email on the static
  build.
- Standard Pull Up Banner matched the build exactly (artwork block, both templates, tiers
  1-4 $120 / 5-14 $108 / 15-29 $96 / 30+ $84), and the live page reconfirms the band-limit slip
  on the other three banners already logged in Finding 6.

Live-site slips for the client from this sweep:
- The wallpaper order form says minimum 0.5 m2 (707mm x 707mm) while the FAQ on the same page
  says the minimum is 1 sqm. The build follows the order form (0.5 m2).
- The wallpaper installation guide PDF on live product pages links to the old staging domain
  (avantiprintt.gya.net.au), not the live site.
- The Contact page FAQ quotes standard shipping at $12 while the site header says from $13.20
  and checkout charges $13. One number should win.
- No artwork template list could be found on the live branded shipping cartons page from here;
  worth confirming whether carton dielines should be published like the mailer ones.

## Finding 12: product names matched to the live site (21 Sep 2026)

Every build product name was compared against the Name column of the client's WooCommerce export
(the live names), and every category name against the live shop menu.

Changed to match live:
- Standard Pull Up Banner Stand is now Standard Pull Up Banner Stands, and Premium Pull Up Banner
  Stand is now Premium Pull Up Banner Stands. Live writes the second as "stands" in lower case;
  the build keeps the capital S so it sits consistently beside the others. The two Double Sided
  banners are singular "Stand" on live and already matched.
- The eight names with a dash (the Custom Dimensions products and the two Bridal Shower toppers)
  now use the plain hyphen live uses.
- Sydney Harbour Elegance Wallpaper and World Map Wallpaper no longer carry an "Office" the build
  had added.
- The wallpaper category is now "Wallpaper", as in the live menu (was Peel & Stick Wallpaper).

Added: Wallpaper Sample ($10), a live product the build was missing. Live has no options on it;
the build adds a required Design choice so the order says which print to post, which is what the
live FAQ promises. Every wallpaper's Order a sample link opens it with that design already chosen.

Deliberately not matched: live sells one A-Frames product; the build splits it into Corflute
Insertable A-Frame and Metal Face A-Frame at the client's request (punch list item 3).

91 of the 105 existing names already matched exactly. The remaining live-only items are not
storefront products (Express Shipping, Standard Delivery, a Repeat Order stub, and unpublished
legacy box products).

## Finding 13: signage photos and custom-dimension options (21 Sep 2026)

Client report: no images on the corflute, ACM, foam PVC, foamboard, EnviroBoard, posters, window
graphics and floor decal products, and no options on Posters - Custom Dimensions and Window
Graphics - Custom Dimensions.

Photos: none of the signage product photos are in the build yet. They are on the list of photos
still to be downloaded from avantiprint.com.au, which blocks other sites from loading its images,
so staging shows a "Product photo coming" panel instead (never a broken image). Posters, Posters -
Custom Dimensions, Window Graphics and Window Graphics - Custom Dimensions already show the two
photos Avanti supplied for each, once staging is redeployed. scripts/download-signage-images.js
fetches the 52 signage and A-frame photos in one go; they then drop into assets/products/ with no
code changes.

Options: the live custom-dimension products are simple products whose choices come from a
product options plugin rather than variations, so the earlier export check missed them. All six
now carry the live choices: Posters (paper stock and finish), Window Graphics (short term or
permanent, laminate), ACM (single or double side, laminate), Foamboard (5mm or 10mm, single or
double side), Corflute (3mm or 5mm and single or double side as separate choices, plus eyelets)
and Floor Decals (anti-slip laminate). Pricing on these stays at the live base price until the
per-square-metre rates are confirmed (open item). Double-sided choices now drive the back
artwork slot like the standard products.

Also fixed: the em dash cleanup had left a comma before a capital on signage descriptions
("weather-resistant, The go-to solution") and in the homepage title; both now read correctly.

## Open items for client confirmation
1. ~~Standard Pull Up Banner top band~~ RESOLVED by the export: 30+ (rule 5/15/30).
2. ~~All per-variation prices~~ DONE 21 Sep (Finding 8). New asks from the export: price for
   Blank Mailer White B Flute 225 × 160 × 80; fix the five live data bugs in Finding 8; and is
   Design Pack 2 ($49 + GST) charged per order or per item?
11. Artwork upload destination: the site is static, so uploaded files need somewhere to go
    (a form or storage service, or a small serverless function). Until decided, orders carry the
    file name and Avanti collects artwork by email.
12. Photos: supply the 248 images in scripts/images-to-download.txt (browser script, or zip them
    from wp-content/uploads via cPanel/FTP). Font files for the four licensed topper fonts too.
13. ~~Extra Product Options export~~ Not possible (fields are per product); all 22 toppers were
    read from the live pages instead. Remaining: character limits for topper text fields other
    than Age, and fix the duplicated Silver Glitter on three live topper forms.
14. Live copy says "twenty colours" but the topper pages offer 17. Which is right?
3. ~~Artwork templates~~ DONE 18 Sep: all products enumerated and wired (Finding 6). Remaining:
   a template for Window Graphics 1000 × 1200 mm does not exist on the live site, supply one?
4. ~~Poster / ACM / Window Graphics lamination~~ RESOLVED (Finding 4). Remaining: is Floor
   Decal laminate ever optional? (Live shows no chooser; none added.)
5. "ACM Panel A-Frame" vs live name "Metal Face A-Frame"
6. Floor Decals 450×450 (description) vs 400×400 (actual variation)
7. Design Pack 1/2 catalogue-wide, or $49 flat rate only?
8. Custom-dimension pricing: no per-m² rate is published for any custom product
9. Foam PVC custom sizing (client item 4): the live site has no Foam PVC custom-dimensions
   product, description says "custom sizes available on request". Adding a W×H field on the
   new site therefore has no published price: it will be built with price TBC unless the
   client supplies a rate
10. Posters: duplicate/typo A1 template `ARTWORK-SPEC-FORM-Posters-894x841mm-A1.pdf` on the
    live page, delete or correct to 594 × 841?

## Finding 14: staff dashboard added (22 Sep 2026)

Not a live-site bug; recorded here because it changes how prices and content are maintained.

- Prices, descriptions, photos, shipping, wording, SEO, FAQs, pages and blog posts now come
  from Supabase when the site is connected, edited through `#/admin`. The data inside
  `index.html` becomes the fallback copy.
- Any product change made in code must also be made in the dashboard (or re-seeded),
  otherwise the live data and the fallback drift apart.
- Customer artwork uploads now have a private `artwork` storage bucket: visitors can upload
  only into `incoming/`, cannot read or overwrite anything, and only staff can see the files.
  This settles the open artwork-upload item on the punch list once it's wired to checkout.
- Security: public sign-up must be switched off, only `admin` profiles can write, and the
  service role key is used only by the seed script. Verified with `rls-test.sql` style checks.
- Still open: moving to real page addresses so social sites read per-page SEO, and
  server-side order totals once online payment is added.

## Finding 15: live blog (22 Sep 2026)

- **17 theme sample posts are live on the blog.** Fashion and model articles ("Joining Skims'
  Supermodel Reunion", "Jennifer Lopez Makes Dungarees a Sexy Wardrobe Staple" and 15 more), dated
  26 April 2022 and filed under Trends, Models, Street Style and Celebrity Style. They sit on blog
  pages 6 and 7 among Avanti's own posts and are indexed by Google. Recommend deleting them from
  WordPress now; they are not in the new site.
- **126 links in older posts point at products no longer sold** (sneeze screens and guards, social
  distancing decals, neon signs, name hoops, serving boards, puzzles, aprons and others). On the new
  site these are plain text. Ten links to cake toppers whose addresses changed were remapped.
- **Yoast titles worth a look:** 68 of the 87 post titles run past 60 characters and will be cut off
  in Google, and 20 descriptions run past 160. Two titles carry typos from the live site:
  "How Custom Designs Evoke Emotional Resonance with Consumer" and "Where to find a personalised
  cake toppers in Australia". Six titles were Yoast templates and now use the site's default. All of
  these can be edited in the dashboard's SEO table, which flags long entries.
- **Blog photos are hosted by WordPress.** They must be downloaded (`bash scripts/download-images.sh
  blog`, or taken from the cPanel uploads zip) before WordPress is switched off.
- The first three WordPress exports supplied (21 Sep) held only the site's 87 user accounts,
  including staff email addresses, and no posts. Worth deleting those files from shared folders.

