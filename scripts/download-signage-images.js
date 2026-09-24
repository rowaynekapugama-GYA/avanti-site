/* Avanti: download the 52 SIGNAGE photos first (corflute, ACM, foam PVC, foamboard, EnviroBoard,
 * posters, window graphics, floor decals, A-frames). The full set is download-images.js.
 *
 * WHY: avantiprint.com.au blocks scripted downloads and image hotlinking, so the new site
 * cannot load photos from it. Your logged-in browser can.
 *
 * HOW:
 *   1. Open https://avantiprint.com.au in Chrome and let it load.
 *   2. Open the console (Option + Command + J on Mac, Ctrl + Shift + J on Windows).
 *   3. Paste this whole file and press Enter.
 *   4. Click "Allow" if Chrome asks about downloading multiple files.
 *   5. Zip the downloaded images and send them over (they go in assets/products/).
 *
 * Or skip all this: whoever has cPanel/FTP can zip the files listed in
 * images-to-download.txt straight from wp-content/uploads.
 */
(async () => {
  const URLS = [
  "https://avantiprint.com.au/wp-content/uploads/2025/10/A-frame-02.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/A-frame-03.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/A-frame-5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/A-frame-6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/A-frame-fetured-img.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/A-frame4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/Acm-02.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/Acm-03.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/Acm-1.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/Acm-4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/Acm-5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/Acm-6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/Acm-7.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/corflute-1.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/corflute-2.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/corflute-3.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/corflute-4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/corflute-5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/corflute-6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/enviro-board-1.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/enviro-board2.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/enviroboard-3.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/enviroboard-4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/enviroboard-5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/enviroboard-6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/floor-decals-3.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/floor-decols-4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/floor-decols.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/floor-decols2.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/floor-decols5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/floor-decols6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/foam-board-1.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/foam-board-2.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/foam-board-3.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/foam-board-4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/foam-board-5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/foam-board-6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/posters-2.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/posters-3.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/posters-5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/posters-6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/pvc-2.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/pvc-foam-1.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/pvc3.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/pvc4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/pvc5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/pvc6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/window-grahic-4.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/window-graphics-6.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/window-graphics1.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2025/10/window-graphics5.jpg",
  "https://avantiprint.com.au/wp-content/uploads/2026/06/EOFY-sale-signage-including-a-pull-up-banner-and-A-frame.jpg"
];
  if (!location.hostname.endsWith("avantiprint.com.au")) { console.error("Run this on an avantiprint.com.au page"); return; }
  let ok = 0; const failed = [];
  for (const url of URLS) {
    const name = url.split("/").pop();
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) { failed.push(name + " (HTTP " + res.status + ")"); continue; }
      const blob = await res.blob();
      if (!blob.type.startsWith("image/")) { failed.push(name + " (not an image)"); continue; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      ok++; console.log("\u2713 " + name);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) { failed.push(name + " (" + e.message + ")"); }
  }
  console.log("Downloaded " + ok + " of " + URLS.length);
  if (failed.length) { console.log("Failed:"); failed.forEach(f => console.log("  - " + f)); }
})();
