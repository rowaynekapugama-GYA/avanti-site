/* Avanti: collect every photo the new site still needs into ONE zip, using your own browser.
 *
 * Why this works: the live site's bot protection blocks download tools, but not a normal
 * browser that's already on the site. Run from the site's own tab, the requests count as the
 * site loading its own photos.
 *
 * STEPS (Chrome, about 5 minutes):
 *   1. Open https://avantiprint.com.au and wait for the page to finish loading.
 *   2. Open the console: Option + Command + J (Mac) or Ctrl + Shift + J (Windows).
 *   3. Chrome may say pasting is blocked. If so, type:  allow pasting   and press Enter.
 *   4. Paste this whole file into the console and press Enter.
 *   5. Leave the tab open. A progress box appears top right. When it finishes, Chrome
 *      downloads avanti-photos.zip.
 *   6. Send avanti-photos.zip back. Unzipped, the photos sit in assets/products/, ready to
 *      drop into the site folder. Anything that couldn't be fetched is listed in
 *      MISSING-PHOTOS.txt inside the zip.
 *
 * Nothing is changed on the live site; the script only reads photos it already shows. */
(async () => {
  const FILES = [
    "2019/07/blog-1.jpg",
    "2019/07/blog-2.jpg",
    "2019/07/blog-3.jpg",
    "2019/07/blog-4.jpg",
    "2019/08/wedding-decoration-ideas.jpg",
    "2019/09/cake-toppers-australia.jpg",
    "2019/10/Avanti.jpg",
    "2019/11/avanti.jpg",
    "2019/12/Where-can-you-buy-personalised-neon-signs.jpg",
    "2020/01/best-wholesale-event-decorations.jpg",
    "2020/02/wedding-decorations.jpg",
    "2020/03/personalise-homme.jpg",
    "2020/04/sneeze-screens.jpg",
    "2020/05/sneeze-guards.jpg",
    "2020/06/buy-get-install-sneeze-guards-australia.jpg",
    "2020/07/Protecting-your-business-against-COVID-19.jpg",
    "2020/07/colors1.jpg",
    "2020/08/covid-prevention-signage.jpg",
    "2020/09/decoration-ideas-1.jpg",
    "2020/09/decoration-ideas.jpg",
    "2020/10/sneeze-screens-sneeze-guard.jpg",
    "2020/11/wedding-invitations-sydney.jpg",
    "2020/12/What-are-the-biggest-event-decoration-trends-for-2021.jpg",
    "2021/01/17-Wedding-Decorations-Never-Thought-Of.jpg",
    "2021/02/1-x-Avanti-Print-Every-excuse-you-need-to-buy-personalised-cupcake-toppers.jpg",
    "2021/03/avanti-print-blog.jpg",
    "2021/04/avantiprint-6-unique-gifts-for-birthdays-weddings-and-event-hosts.jpg",
    "2021/05/avanti-12-reasons-to-use-cake-toppers-at-your-next-event.jpg",
    "2021/06/Avanti-Print-How-to-make-your-Winter-event-as-stylish-as-possible.jpg",
    "2021/07/How-To-Create-The-Best-Name-Hoops.jpg",
    "2021/08/custom-puzzle.jpg",
    "2021/09/Decorations-Checklist-For-Your-Wedding-Day.jpg",
    "2021/10/Cooking-in-Style-Personalised-Kitchen-Products.jpg",
    "2021/11/How-Weddings-Have-Changed-In-Australia.jpg",
    "2021/12/A-guide-to-modern-decorations-for-traditional-events.jpg",
    "2022/01/8-Creative-Ideas-For-Decorating-Cakes-And-Cupcakes.jpg",
    "2022/02/Everything-you-need-to-know-about-Avanti-Print.jpg",
    "2022/03/10-customisable-gift-ideas-1.jpg",
    "2022/04/5-ways-to-make-your-house-a-home.jpg",
    "2022/05/How-to-decorate-a-cake-for-a-special-occasion.jpg",
    "2022/06/Where-to-find-the-best-custom-sneeze-guard.jpg",
    "2022/07/Best-decorations-for-a-kids-party.jpg",
    "2022/08/Spoiling-your-loved-ones-on-their-birthday.jpg",
    "2022/09/A-simple-guide-to-wedding-invitations.jpg",
    "2022/10/Decoration-ideas-for-religious-events-and-ceremonies.jpg",
    "2022/11/How-to-design-the-best-looking-birthday-cake.jpg",
    "2022/12/Custom-Acrylic-Wreaths.jpg",
    "2023/01/Where-to-buy-a-personalised-serving-board.jpg",
    "2023/02/Top-10-wedding-decorations-in-2023.jpg",
    "2023/03/Where-to-Get-the-Best-Custom-Cake-Toppers-in-Australia-1.jpg",
    "2023/04/5-Creative-Ways-to-Use-Cake-Toppers-for-Your-Next-Event.jpg",
    "2023/05/The-Rising-Popularity-of-Backdrops_-Enhancing-Your-Brands-Visual-Impact.jpg",
    "2023/07/The-Power-of-Personalisation-Exploring-the-World-of-Custom-Designs-in-Printing.jpg",
    "2023/07/The-Psychology-of-Personalisation-How-Custom-Designs-Tap-into-Consumer-Emotions.jpg",
    "2023/09/The-Rising-Trend-of-Modern-Wedding-Invitations.jpg",
    "2023/10/Exploring-the-Latest-Trends-in-Personalised-Gifts-for-2023.jpg",
    "2023/10/From-Welcome-Signs-and-Seating-Plans-to-Wedding-Invitations_.jpg",
    "2023/11/The-Impact-of-Colour-and-Design-on-Wedding-Invitations.jpg",
    "2024/04/How-to-Choose-the-Perfect-Cake-Topper-for-Your-Wedding-Theme-jpg.webp",
    "2024/04/Top-9-Wedding-Invitation-Card-Designs-of-2024-jpg.webp",
    "2024/05/Crafting-Connections-jpg.webp",
    "2024/05/Custom-Print-Solutions.jpg",
    "2024/07/Photo-Backdrop.jpg",
    "2024/07/Trends-in-Wedding-Invitation-Designs.jpg",
    "2024/09/Wallpaper-Trends-for-Modern-Homes.jpg",
    "2024/09/creative-ways-to-display-welcome-sign-board.jpg",
    "2024/10/best-ways-to-personalise-wedding-invitations.jpg",
    "2024/11/kids-room-with-wallpaper.jpg",
    "2025/01/Budget-Friendly-Christmas-Tree-Decorating-Ideas.jpg",
    "2025/01/Wallpaper-for-Your-Office-Environment.jpg",
    "2025/02/valentines-day-gift-card.jpg",
    "2025/04/1-copy-1.jpg",
    "2025/04/1-copy.jpg",
    "2025/04/A1-stadard.jpg",
    "2025/04/A2-stadard.jpg",
    "2025/04/A3-stadard.jpg",
    "2025/04/A4-stadard.jpg",
    "2025/04/A5-stadard.jpg",
    "2025/04/A6-stadard.jpg",
    "2025/04/A7-stadard.jpg",
    "2025/04/A8-stadard.jpg",
    "2025/04/A9-stadard.jpg",
    "2025/04/Acrylic-vs.-Glass-Sneeze-Guards.jpg",
    "2025/04/Age-Topper.jpg",
    "2025/04/AnniversaryTopper.jpg",
    "2025/04/BridetobeTopper.jpg",
    "2025/04/BridetobeTopper2.jpg",
    "2025/04/Close-Up-Design-1-1.jpg",
    "2025/04/Close-Up-Design-1.jpg",
    "2025/04/Close-Up-Design-10-1.jpg",
    "2025/04/Close-Up-Design-10-2.jpg",
    "2025/04/Close-Up-Design-10.jpg",
    "2025/04/Close-Up-Design-11-1.jpg",
    "2025/04/Close-Up-Design-11.jpg",
    "2025/04/Close-Up-Design-12-1.jpg",
    "2025/04/Close-Up-Design-12-2.jpg",
    "2025/04/Close-Up-Design-12-3.jpg",
    "2025/04/Close-Up-Design-12.jpg",
    "2025/04/Close-Up-Design-13-2.jpg",
    "2025/04/Close-Up-Design-13-3.jpg",
    "2025/04/Close-Up-Design-13.jpg",
    "2025/04/Close-Up-Design-14-1.jpg",
    "2025/04/Close-Up-Design-14-2.jpg",
    "2025/04/Close-Up-Design-14.jpg",
    "2025/04/Close-Up-Design-15-1.jpg",
    "2025/04/Close-Up-Design-15-2.jpg",
    "2025/04/Close-Up-Design-15.jpg",
    "2025/04/Close-Up-Design-16-1.jpg",
    "2025/04/Close-Up-Design-16-2.jpg",
    "2025/04/Close-Up-Design-16.jpg",
    "2025/04/Close-Up-Design-17-1.jpg",
    "2025/04/Close-Up-Design-17.jpg",
    "2025/04/Close-Up-Design-18-1.jpg",
    "2025/04/Close-Up-Design-18.jpg",
    "2025/04/Close-Up-Design-19-1.jpg",
    "2025/04/Close-Up-Design-19.jpg",
    "2025/04/Close-Up-Design-2-1.jpg",
    "2025/04/Close-Up-Design-2.jpg",
    "2025/04/Close-Up-Design-20-1.jpg",
    "2025/04/Close-Up-Design-20.jpg",
    "2025/04/Close-Up-Design-21-1.jpg",
    "2025/04/Close-Up-Design-21.jpg",
    "2025/04/Close-Up-Design-22-1.jpg",
    "2025/04/Close-Up-Design-22.jpg",
    "2025/04/Close-Up-Design-23.jpg",
    "2025/04/Close-Up-Design-3-1.jpg",
    "2025/04/Close-Up-Design-3-2.jpg",
    "2025/04/Close-Up-Design-3.jpg",
    "2025/04/Close-Up-Design-4-1.jpg",
    "2025/04/Close-Up-Design-4-2.jpg",
    "2025/04/Close-Up-Design-4.jpg",
    "2025/04/Close-Up-Design-5-1.jpg",
    "2025/04/Close-Up-Design-5-2.jpg",
    "2025/04/Close-Up-Design-5.jpg",
    "2025/04/Close-Up-Design-6-1.jpg",
    "2025/04/Close-Up-Design-6-2.jpg",
    "2025/04/Close-Up-Design-6.jpg",
    "2025/04/Close-Up-Design-7-1.jpg",
    "2025/04/Close-Up-Design-7.jpg",
    "2025/04/Close-Up-Design-8-1.jpg",
    "2025/04/Close-Up-Design-8-2.jpg",
    "2025/04/Close-Up-Design-8.jpg",
    "2025/04/Close-Up-Design-9-1.jpg",
    "2025/04/Close-Up-Design-9-2.jpg",
    "2025/04/Close-Up-Design-9.jpg",
    "2025/04/Communion-Cross-with-Name1.jpg",
    "2025/04/Complete-Wall-Design-13.jpg",
    "2025/04/Complete-Wall-Design-14.jpg",
    "2025/04/Complete-Wall-Design-15-2.jpg",
    "2025/04/Complete-Wall-Design-15.jpg",
    "2025/04/Complete-Wall-Design-8-1.jpg",
    "2025/04/CrossTopper1.jpg",
    "2025/04/Group-1.jpg",
    "2025/04/HAppy-bday-name-with-age.jpg",
    "2025/04/Happy-birthday.jpg",
    "2025/04/Happy-birthday2.jpg",
    "2025/04/Love-With-Arrow1.jpg",
    "2025/04/Name-Age1.jpg",
    "2025/04/Name-Ring1.jpg",
    "2025/04/Name-Topper.jpg",
    "2025/04/Name-age3.jpg",
    "2025/04/Name-age4.jpg",
    "2025/04/Name-age6.jpg",
    "2025/04/Name-age7.jpg",
    "2025/04/Name-ring2.jpg",
    "2025/04/NamewithCrossTopper.jpg",
    "2025/04/Oh-Baby-Wreath1.jpg",
    "2025/04/Original-Artboard-Design-1-1.jpg",
    "2025/04/Original-Artboard-Design-1.jpg",
    "2025/04/Original-Artboard-Design-10-1.jpg",
    "2025/04/Original-Artboard-Design-10-2.jpg",
    "2025/04/Original-Artboard-Design-10.jpg",
    "2025/04/Original-Artboard-Design-11-1.jpg",
    "2025/04/Original-Artboard-Design-11-2.jpg",
    "2025/04/Original-Artboard-Design-11.jpg",
    "2025/04/Original-Artboard-Design-12-1.jpg",
    "2025/04/Original-Artboard-Design-12-2.jpg",
    "2025/04/Original-Artboard-Design-12.jpg",
    "2025/04/Original-Artboard-Design-13-1.jpg",
    "2025/04/Original-Artboard-Design-13-2.jpg",
    "2025/04/Original-Artboard-Design-13-3.jpg",
    "2025/04/Original-Artboard-Design-14-1.jpg",
    "2025/04/Original-Artboard-Design-14-2.jpg",
    "2025/04/Original-Artboard-Design-15-1.jpg",
    "2025/04/Original-Artboard-Design-15-2.jpg",
    "2025/04/Original-Artboard-Design-16-1.jpg",
    "2025/04/Original-Artboard-Design-16-2.jpg",
    "2025/04/Original-Artboard-Design-16.jpg",
    "2025/04/Original-Artboard-Design-17-1.jpg",
    "2025/04/Original-Artboard-Design-17.jpg",
    "2025/04/Original-Artboard-Design-18-1.jpg",
    "2025/04/Original-Artboard-Design-18.jpg",
    "2025/04/Original-Artboard-Design-19-1.jpg",
    "2025/04/Original-Artboard-Design-19.jpg",
    "2025/04/Original-Artboard-Design-2-1.jpg",
    "2025/04/Original-Artboard-Design-2.jpg",
    "2025/04/Original-Artboard-Design-20-1.jpg",
    "2025/04/Original-Artboard-Design-20.jpg",
    "2025/04/Original-Artboard-Design-21-1.jpg",
    "2025/04/Original-Artboard-Design-21.jpg",
    "2025/04/Original-Artboard-Design-22-1.jpg",
    "2025/04/Original-Artboard-Design-22.jpg",
    "2025/04/Original-Artboard-Design-23.jpg",
    "2025/04/Original-Artboard-Design-3-1.jpg",
    "2025/04/Original-Artboard-Design-3-2.jpg",
    "2025/04/Original-Artboard-Design-3.jpg",
    "2025/04/Original-Artboard-Design-4-1.jpg",
    "2025/04/Original-Artboard-Design-4-2.jpg",
    "2025/04/Original-Artboard-Design-4.jpg",
    "2025/04/Original-Artboard-Design-5-1.jpg",
    "2025/04/Original-Artboard-Design-5-2.jpg",
    "2025/04/Original-Artboard-Design-5.jpg",
    "2025/04/Original-Artboard-Design-6-1.jpg",
    "2025/04/Original-Artboard-Design-6-2.jpg",
    "2025/04/Original-Artboard-Design-6.jpg",
    "2025/04/Original-Artboard-Design-7-1.jpg",
    "2025/04/Original-Artboard-Design-7-3.jpg",
    "2025/04/Original-Artboard-Design-7.jpg",
    "2025/04/Original-Artboard-Design-8-2.jpg",
    "2025/04/Original-Artboard-Design-8.jpg",
    "2025/04/Original-Artboard-Design-9-1.jpg",
    "2025/04/Original-Artboard-Design-9-2.jpg",
    "2025/04/Original-Artboard-Design-9.jpg",
    "2025/04/Twinkle-Twinkle-Little-Star1.jpg",
    "2025/04/avanti-custom.jpg",
    "2025/04/happy-21-liam.jpg",
    "2025/04/twenty-one.jpg",
    "2025/04/twenty-one1.jpg",
    "2025/05/A1-premium-ds.jpg",
    "2025/05/A1-premium.jpg",
    "2025/05/A1-stadard-ds.jpg",
    "2025/05/A2-premium-ds.jpg",
    "2025/05/A2-premium.jpg",
    "2025/05/A2-stadard-ds.jpg",
    "2025/05/A3-premium-ds.jpg",
    "2025/05/A3-premium.jpg",
    "2025/05/A3-stadard-ds.jpg",
    "2025/05/A4-premium-ds.jpg",
    "2025/05/A4-premium.jpg",
    "2025/05/A4-stadard-ds.jpg",
    "2025/05/A5-premium-ds.jpg",
    "2025/05/A5-premium.jpg",
    "2025/05/A5-stadard-ds.jpg",
    "2025/05/A6-premium-ds.jpg",
    "2025/05/A6-premium.jpg",
    "2025/05/A6-stadard-ds.jpg",
    "2025/05/A7-premium-ds.jpg",
    "2025/05/A7-premium.jpg",
    "2025/05/A7-stadard-ds.jpg",
    "2025/05/A8-premium-ds.jpg",
    "2025/05/A8-premium.jpg",
    "2025/05/A8-stadard-ds.jpg",
    "2025/05/A9-premium-ds.jpg",
    "2025/05/A9-premium.jpg",
    "2025/05/A9-stadard-ds.jpg",
    "2025/05/Birthday-Party-Items.jpg",
    "2025/05/Perfect-Wedding-Invitation.jpg",
    "2025/05/avanti-pullup-banner-design1-mockup.jpg",
    "2025/05/avanti-pullup-banner-design2-mockup.jpg",
    "2025/05/avanti-pullup-banner-design3-mockup.jpg",
    "2025/06/What-Makes-a-Wedding-Day-Truly-Memorable.jpg",
    "2025/06/mailer-boxes-1.jpg",
    "2025/06/mailer-boxes-2.jpg",
    "2025/06/mailer-boxes-3.jpg",
    "2025/06/shipping-cartoon-image-new.jpg",
    "2025/07/Creative-Cake-Topper-Ideas-for-Special-Moments.jpg",
    "2025/07/blank-cartoon-box.jpg",
    "2025/07/mailer-boxes-blank.jpg",
    "2025/09/Peel-and-Stick-Wallpaper-Ideas-to-Instantly-Refresh-Your-Home.jpg",
    "2025/09/What-Are-the-Must-Have-Design-Elements-for-Pull-Up-Banners.jpg",
    "2025/10/A-frame-02.jpg",
    "2025/10/A-frame-03.jpg",
    "2025/10/A-frame-5.jpg",
    "2025/10/A-frame-6.jpg",
    "2025/10/A-frame-fetured-img.jpg",
    "2025/10/A-frame4.jpg",
    "2025/10/Acm-02.jpg",
    "2025/10/Acm-03.jpg",
    "2025/10/Acm-1.jpg",
    "2025/10/Acm-4.jpg",
    "2025/10/Acm-5.jpg",
    "2025/10/Acm-6.jpg",
    "2025/10/Acm-7.jpg",
    "2025/10/corflute-1.jpg",
    "2025/10/corflute-2.jpg",
    "2025/10/corflute-3.jpg",
    "2025/10/corflute-4.jpg",
    "2025/10/corflute-5.jpg",
    "2025/10/corflute-6.jpg",
    "2025/10/enviro-board-1.jpg",
    "2025/10/enviro-board2.jpg",
    "2025/10/enviroboard-3.jpg",
    "2025/10/enviroboard-4.jpg",
    "2025/10/enviroboard-5.jpg",
    "2025/10/enviroboard-6.jpg",
    "2025/10/floor-decals-3.jpg",
    "2025/10/floor-decols-4.jpg",
    "2025/10/floor-decols.jpg",
    "2025/10/floor-decols2.jpg",
    "2025/10/floor-decols5.jpg",
    "2025/10/floor-decols6.jpg",
    "2025/10/foam-board-1.jpg",
    "2025/10/foam-board-2.jpg",
    "2025/10/foam-board-3.jpg",
    "2025/10/foam-board-4.jpg",
    "2025/10/foam-board-5.jpg",
    "2025/10/foam-board-6.jpg",
    "2025/10/posters-2.jpg",
    "2025/10/posters-3.jpg",
    "2025/10/posters-5.jpg",
    "2025/10/posters-6.jpg",
    "2025/10/pvc-2.jpg",
    "2025/10/pvc-foam-1.jpg",
    "2025/10/pvc3.jpg",
    "2025/10/pvc4.jpg",
    "2025/10/pvc5.jpg",
    "2025/10/pvc6.jpg",
    "2025/10/window-grahic-4.jpg",
    "2025/10/window-graphics-6.jpg",
    "2025/10/window-graphics1.jpg",
    "2025/10/window-graphics5.jpg",
    "2025/11/Peel-and-Stick-Wallpaper-Easily-at-Home.jpg",
    "2025/11/Use-Pull-Up-Banners-for-Your-Business.jpg",
    "2025/12/How-Do-Custom-Branded-Mailer-Boxes-Elevate-Premium-Packaging-Strategies.jpg",
    "2026/01/Custom-Printing-on-Shipping-Cartons.jpg",
    "2026/02/cake-topper-latest-model.jpg",
    "2026/03/How-Can-Print-Help-You-Tell-a-Brand-Story-People-Actually-Remember.jpg",
    "2026/04/Custom-ACM-Panels-the-Smartest-Branding-Move-for-Modern-Businesses.jpg",
    "2026/05/How-Do-Custom-Pull-Up-Banners-Transform-Local-Visibility-Into-Real-World-Impact.png",
    "2026/06/EOFY-sale-signage-including-a-pull-up-banner-and-A-frame.jpg",
    "2026/07/Custom-branded-mailer-box-being-opened-showing-a-considered-unboxing-experience.jpg",
    "2026/08/Pull-Up-Banners-That-Actually-Get-Read-Most-Dont.jpg"
  ];
  const OK_HOST = /(^|\.)avantiprint\.com\.au$/.test(location.hostname) || window.__AVANTI_PHOTO_TEST__;
  if (!OK_HOST) { alert('Open https://avantiprint.com.au first, then run this in that tab.'); return; }
  const BASE = location.origin + '/wp-content/uploads/';

  // progress box
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#17161a;color:#fff;font:14px/1.45 system-ui,sans-serif;padding:14px 16px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);width:300px';
  box.innerHTML = '<b>Collecting Avanti photos</b><div id="avp-t" style="margin:6px 0 8px">Starting...</div><div style="height:6px;background:#333;border-radius:3px"><div id="avp-b" style="height:6px;width:0;background:#c41e2a;border-radius:3px"></div></div>';
  document.body.appendChild(box);
  const show = (t, pct) => { box.querySelector('#avp-t').textContent = t; if (pct != null) box.querySelector('#avp-b').style.width = pct + '%'; };

  // fetch with retries, a few at a time
  const got = new Array(FILES.length), missing = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function grab(i) {
    const rel = FILES[i];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(BASE + rel, { credentials: 'include', cache: 'no-store' });
        const type = r.headers.get('content-type') || '';
        if (r.ok && /^image\//.test(type)) { got[i] = new Uint8Array(await r.arrayBuffer()); return; }
        if (r.status === 404) { missing.push(rel + '  (not on the live site)'); return; }
        if (attempt === 3) missing.push(rel + '  (HTTP ' + r.status + (type && !/^image\//.test(type) ? ', not an image' : '') + ')');
      } catch (e) { if (attempt === 3) missing.push(rel + '  (' + e.message + ')'); }
      await wait(800 * attempt);
    }
  }
  let next = 0, done = 0;
  async function worker() { while (next < FILES.length) { const i = next++; await grab(i); done++; show(`${done} of ${FILES.length} photos checked`, Math.round(done / FILES.length * 100)); } }
  await Promise.all([worker(), worker(), worker(), worker()]);

  // build a zip (stored, not compressed: photos are already compressed)
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
        dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  function add(name, data) {
    const n = enc.encode(name), crc = crc32(data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, n.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), n, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), n);
    offset += 30 + n.length + data.length;
  }
  let count = 0;
  FILES.forEach((rel, i) => { if (got[i]) { add('assets/products/' + rel.split('/').pop(), got[i]); count++; } });
  const note = `Avanti photos collected ${now.toISOString()}\n${count} of ${FILES.length} photos included.\n` +
    (missing.length ? `\nCould not be fetched (${missing.length}):\n` + missing.map(m => '  ' + m).join('\n') + '\n' : '\nNothing missing.\n');
  add('MISSING-PHOTOS.txt', enc.encode(note));
  const cdSize = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count + 1, true); end.setUint16(10, count + 1, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const blob = new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'avanti-photos.zip';
  document.body.appendChild(a); a.click(); a.remove();
  show(`Done: ${count} of ${FILES.length} photos in avanti-photos.zip (${(blob.size / 1048576).toFixed(1)} MB).` + (missing.length ? ` ${missing.length} couldn't be fetched, listed inside.` : ''), 100);
  console.log(note);
  window.__AVANTI_PHOTO_RESULT__ = { count, missing, bytes: blob.size };
})();
