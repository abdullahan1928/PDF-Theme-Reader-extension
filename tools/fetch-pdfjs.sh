#!/usr/bin/env bash
# Downloads PDF.js and copies only what the extension uses into ../pdfjs.
# SLIM=1 ./fetch-pdfjs.sh   skips CJK character maps (saves ~1.7 MB).
set -euo pipefail

VERSION="6.4.299"
URL="https://github.com/mozilla/pdf.js/releases/download/v${VERSION}/pdfjs-${VERSION}-dist.zip"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT   # temp files never end up inside the extension folder

echo "Downloading PDF.js ${VERSION}..."
curl -L --fail -o "$TMP/dist.zip" "$URL"
unzip -q "$TMP/dist.zip" -d "$TMP/x"

OUT="$ROOT/pdfjs"
rm -rf "$OUT"
mkdir -p "$OUT/wasm"

cp "$TMP/x/build/pdf.mjs" "$TMP/x/build/pdf.worker.mjs" "$OUT/"
cp -r "$TMP/x/web/standard_fonts" "$OUT/"
# Image decoders and their JS fallbacks; the PDF scripting engine is not needed.
cp "$TMP/x/web/wasm/"* "$OUT/wasm/"
rm -f "$OUT/wasm/quickjs-eval."*
if [ "${SLIM:-0}" != "1" ]; then cp -r "$TMP/x/web/cmaps" "$OUT/"; fi
cp "$TMP/x/LICENSE" "$OUT/LICENSE"

echo "PDF.js ${VERSION} installed in $OUT"
du -sh "$OUT"
