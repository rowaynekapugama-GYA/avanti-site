#!/usr/bin/env bash
# Avanti, download every artwork template PDF from the live site. (v2)
#
# v1 scraped each product page for .pdf links. That proved unreliable: the live
# site rate-limits rapid curl requests (pages come back "not reachable"), and the
# template widget's markup does not use plain double-quoted href="...pdf", so the
# links were invisible to the old pattern even when a page did load.
#
# v2 does not depend on scraping. Every template URL was already enumerated from
# the live product pages, so the list is embedded below and downloaded directly,
# with retries and pacing. A scrape pass runs afterwards, with a much broader
# pattern, only to catch anything new that has been added since.
#
# Usage (run from the folder that contains index.html):
#   chmod +x scripts/fetch-templates.sh
#   ./scripts/fetch-templates.sh
#
# Then:  zip -r templates.zip assets/templates

set -uo pipefail

BASE="https://avantiprint.com.au"
OUT="assets/templates"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

if [[ ! -f index.html ]]; then
  echo "Run this from the folder that contains index.html." >&2
  exit 1
fi

mkdir -p "$OUT"
MANIFEST="$OUT/manifest.csv"
echo "product,filename,url,bytes" > "$MANIFEST"

# curl with browser-ish headers, retries and a real timeout.
fetch() {  # fetch <url> <dest|-->
  local url="$1" dest="$2"
  curl -sSL -A "$UA" \
    -H "Accept: text/html,application/xhtml+xml,application/pdf,*/*" \
    -H "Accept-Language: en-AU,en;q=0.9" \
    -H "Referer: $BASE/" \
    --compressed --retry 4 --retry-delay 3 --retry-all-errors \
    --connect-timeout 20 --max-time 120 \
    -o "$dest" -w "%{http_code}" "$url" 2>/dev/null
}

# ---------------------------------------------------------------
# Known templates, enumerated from the live product pages 18 Sep 2026.
# Format: product|url
# ---------------------------------------------------------------
KNOWN=(
  "corflute-signs|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Corflute-Sign-600x400mm.pdf"
  "corflute-signs|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Corflute-Sign-600x600mm.pdf"
  "corflute-signs|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Corflute-Sign-600x800mm.pdf"
  "corflute-signs|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Corflute-Sign-800x1200mm.pdf"
  "corflute-signs|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Corflute-Sign-1200x1200mm.pdf"
  "corflute-signs|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Corflute-Sign-1200x2400mm.pdf"
  "acm-panels|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Aluminium-Composite-Panel-600x400mm.pdf"
  "acm-panels|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Aluminium-Composite-Panel-600x600mm.pdf"
  "acm-panels|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Aluminium-Composite-Panel-600x800mm.pdf"
  "acm-panels|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Aluminium-Composite-Panel-800x1200mm.pdf"
  "acm-panels|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Aluminium-Composite-Panel-1200x1200mm.pdf"
  "acm-panels|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Aluminium-Composite-Panel-1200x2400mm.pdf"
  "foamboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-Board-600x400mm.pdf"
  "foamboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-Board-600x600mm.pdf"
  "foamboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-Board-600x800mm.pdf"
  "foamboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-Board-800x1200mm.pdf"
  "foamboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-Board-1200x1200mm.pdf"
  "foamboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-Board-1200x2400mm.pdf"
  "foam-pvc|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-PVC-600x400mm.pdf"
  "foam-pvc|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-PVC-600x600mm.pdf"
  "foam-pvc|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-PVC-600x800mm.pdf"
  "foam-pvc|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-PVC-800x1200mm.pdf"
  "foam-pvc|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-PVC-1200x1200mm.pdf"
  "foam-pvc|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Foam-PVC-1200x2400mm.pdf"
  "enviroboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Enviro-Board-600x400mm.pdf"
  "enviroboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Enviro-Board-600x600mm.pdf"
  "enviroboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Enviro-Board-600x800mm.pdf"
  "enviroboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Enviro-Board-800x1200mm.pdf"
  "enviroboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Enviro-Board-1200x1200mm.pdf"
  "enviroboard|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Enviro-Board-1200x2400mm.pdf"
  "posters|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Posters-210x297mm-A4.pdf"
  "posters|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Posters-297x420mm-A3.pdf"
  "posters|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Posters-420x594mm-A2.pdf"
  "posters|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Poster-841x594mm-A1.pdf"
  "posters|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Poster-841x1189mm-A0.pdf"
  "posters|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-Posters-894x841mm-A1.pdf"
  "window-graphics|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-WIndow-DecaL-300x400mm.pdf"
  "window-graphics|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-WIndow-DecaL-400x600mm.pdf"
  "window-graphics|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-WIndow-DecaL-800x600mm.pdf"
  "window-graphics|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-WIndow-DecaL-1000x800mm.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-300x300mm-Square-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-ROUND-300x300mm-round-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-400x400mm-Square-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-ROUND-400x400mm-round-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-600x600mm-Square-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-ROUND-600x600mm-round-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-800x800mm-Square-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-ROUND-800x800mm-round-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-1000x1000mm-Square-cut.pdf"
  "floor-decals|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-FLOOR-DECAL-ROUND-1000x1000mm-round-cut.pdf"
  "a-frames (metal face)|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-A-Frame-600x900mm.pdf"
  "a-frames (metal face)|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-A-Frame-900x1200mm.pdf"
  "a-frames (corflute insertable)|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-A-Frame-600x900mm-Insertable.pdf"
  "a-frames (corflute insertable)|https://avantiprint.com.au/wp-content/uploads/2025/10/ARTWORK-SPEC-FORM-A-Frame-1200x900mm-Insertable.pdf"
  "pull-up-banners|https://avantiprint.com.au/wp-content/uploads/2025/07/ARTWORK-SPEC-FORM-Roll-Up-Banner-2200x850mm.pdf"
  "pull-up-banners|https://avantiprint.com.au/wp-content/uploads/2025/07/ARTWORK-SPEC-FORM-Roll-Up-Banner-1400x850mm.pdf"
)

echo "Downloading ${#KNOWN[@]} known template PDFs..."
echo

got=0; failed=0; failed_list=()
for entry in "${KNOWN[@]}"; do
  prod="${entry%%|*}"
  url="${entry#*|}"
  fname="$(basename "${url%%\?*}")"
  dest="$OUT/$fname"

  if [[ -f "$dest" ]] && head -c 4 "$dest" | grep -q '%PDF'; then
    size=$(wc -c < "$dest" | tr -d ' ')
    echo "$prod,$fname,$url,$size" >> "$MANIFEST"
    got=$((got+1))
    printf '  %-58s cached\n' "$fname"
    continue
  fi

  code=$(fetch "$url" "$dest")
  if [[ "$code" == "200" ]] && head -c 4 "$dest" | grep -q '%PDF'; then
    size=$(wc -c < "$dest" | tr -d ' ')
    echo "$prod,$fname,$url,$size" >> "$MANIFEST"
    got=$((got+1))
    printf '  %-58s ok (%s KB)\n' "$fname" "$((size/1024))"
  else
    rm -f "$dest"
    failed=$((failed+1)); failed_list+=("$fname (HTTP ${code:-timeout})")
    printf '  %-58s FAILED (HTTP %s)\n' "$fname" "${code:-timeout}"
  fi
  sleep 1.5   # be polite; this is what tripped up v1
done

# ---------------------------------------------------------------
# Bonus pass: scrape the product pages for any template we do not know about.
# Broad pattern, catches single quotes, unquoted, data-attributes and
# JSON-escaped slashes. Purely additive; failures here are not a problem.
# ---------------------------------------------------------------
PRODUCTS=(
  a-frames foam-pvc enviroboard corflute-signs corflute-signs-custom-dimensions
  acm-panels acm-panels-custom-dimensions foamboard foamboard-custom
  posters posters-custom window-graphics window-graphics-custom-dimensions
  floor-decals floor-decals-custom pull-up-banner premium-pull-up-banner-stands
  double-sided-standard-pull-up-banner-stand double-sided-premium-pull-up-banner-stand
)

echo
echo "Checking product pages for any template not in the known list..."
tmp="$(mktemp -d)"; new=0
for slug in "${PRODUCTS[@]}"; do
  code=$(fetch "$BASE/product/$slug/" "$tmp/page.html")
  [[ "$code" != "200" ]] && { printf '  %-45s page unavailable (HTTP %s)\n' "$slug" "${code:-timeout}"; sleep 2; continue; }

  pdfs=$(sed 's|\\/|/|g' "$tmp/page.html" \
    | grep -oiE "(https?://[^\"'\''[:space:]<>()]+|/wp-content/uploads/[^\"'\''[:space:]<>()]+)\.pdf" \
    | sed -E "s|^/|$BASE/|" | sort -u)

  while IFS= read -r pdf; do
    [[ -z "$pdf" ]] && continue
    fname="$(basename "${pdf%%\?*}")"
    grep -q ",$fname," "$MANIFEST" && continue
    code=$(fetch "$pdf" "$OUT/$fname")
    if [[ "$code" == "200" ]] && head -c 4 "$OUT/$fname" | grep -q '%PDF'; then
      size=$(wc -c < "$OUT/$fname" | tr -d ' ')
      echo "$slug,$fname,$pdf,$size" >> "$MANIFEST"
      new=$((new+1)); printf '  NEW: %s (%s)\n' "$fname" "$slug"
    else
      rm -f "$OUT/$fname"
    fi
    sleep 1.5
  done <<< "$pdfs"
  sleep 2
done
rm -rf "$tmp"

echo
echo "-----------------------------------------------------------"
echo "Known templates downloaded: $got of ${#KNOWN[@]}"
echo "New templates found:        $new"
echo "Unique files on disk:       $(ls -1 "$OUT"/*.pdf 2>/dev/null | wc -l | tr -d ' ')"
echo "Total size:                 $(du -sh "$OUT" 2>/dev/null | cut -f1)"
echo "Manifest:                   $MANIFEST"

if ((failed)); then
  echo
  echo "These failed to download (re-run the script; it skips what it already has):"
  printf '  - %s\n' "${failed_list[@]}"
fi

echo
echo "Next:  zip -r templates.zip assets/templates"
echo "then send me templates.zip and I will self-host them in the build."
