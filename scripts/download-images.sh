#!/bin/bash
# Avanti: download product photos from the live site straight into assets/products/.
#
# Run from the site folder (the one containing index.html):
#   bash scripts/download-images.sh                 # all photos (scripts/images-to-download.txt)
#   bash scripts/download-images.sh blog            # blog cover photos (scripts/images-blog.txt)
#   bash scripts/download-images.sh signage         # just the 52 signage and A-frame photos
#
# If the site blocks the requests (the summary shows HTTP 403 or "not an image"), copy your
# browser cookie and run again with it (see the guide):
#   COOKIE='paste-cookie-here' bash scripts/download-images.sh signage
#
# Files already downloaded are skipped, so it is safe to run as many times as you like.

cd "$(dirname "$0")/.." || exit 1
if [ ! -f index.html ]; then echo "Run this from the Avanti site folder (where index.html is)."; exit 1; fi

LIST="scripts/images-to-download.txt"
[ "$1" = "signage" ] && LIST="scripts/images-signage.txt"
[ "$1" = "blog" ] && LIST="scripts/images-blog.txt"
[ -n "$LIST_OVERRIDE" ] && LIST="$LIST_OVERRIDE"
if [ ! -f "$LIST" ]; then echo "Cannot find $LIST"; exit 1; fi

OUT="assets/products"
mkdir -p "$OUT"
UA="${AGENT:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36}"
REF="${REFERER:-https://avantiprint.com.au/}"

echo "Downloading from $LIST (each photo gives up after 30 seconds)..."
total=0; got=0; skipped=0; failed=0; FAILS=""
TMP="$(mktemp)"

while IFS= read -r url || [ -n "$url" ]; do
  url="$(echo "$url" | tr -d '\r' | sed 's/^ *//;s/ *$//')"
  [ -z "$url" ] && continue
  total=$((total+1))
  name="${url##*/}"
  if [ -s "$OUT/$name" ]; then skipped=$((skipped+1)); continue; fi

  if [ -n "$COOKIE" ]; then
    res="$(curl -sL --connect-timeout 10 --max-time 30 -o "$TMP" -w '%{http_code} %{content_type}' -A "$UA" -e "$REF" \
      -H 'Accept: image/avif,image/webp,image/png,image/*,*/*;q=0.8' -H "Cookie: $COOKIE" "$url")"
  else
    res="$(curl -sL --connect-timeout 10 --max-time 30 -o "$TMP" -w '%{http_code} %{content_type}' -A "$UA" -e "$REF" \
      -H 'Accept: image/avif,image/webp,image/png,image/*,*/*;q=0.8' "$url")"
  fi
  code="${res%% *}"; type="${res#* }"

  if [ "$code" = "200" ] && echo "$type" | grep -qi '^image/'; then
    mv "$TMP" "$OUT/$name"; chmod 644 "$OUT/$name"; got=$((got+1)); echo "  ok   $name"
  else
    [ "$code" = "000" ] && code="timed out"
    failed=$((failed+1)); FAILS="$FAILS
  $name  (HTTP $code, $type)"; echo "  FAIL $name  (HTTP $code)"
  fi
  sleep 0.3
done < "$LIST"
rm -f "$TMP"

echo ""
echo "Done: $got downloaded, $skipped already had, $failed failed (of $total)."
if [ "$failed" -gt 0 ]; then
  echo "Failed:$FAILS"
  echo ""
  echo "If most failed with 202, 403, timed out or a text/html type, the site is blocking scripts."
  echo "Copy your browser cookie (see the guide) and run again with COOKIE='...' in front."
fi
