#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONSET="$ROOT/build/icon.iconset"
mkdir -p "$ICONSET"
PNG="$ROOT/build/icon-1024.png"
qlmanage -t -s 1024 -o "$ROOT/build" "$ROOT/build/icon.svg" >/dev/null
if [[ -f "$ROOT/build/icon.svg.png" ]]; then
  mv "$ROOT/build/icon.svg.png" "$PNG"
fi
if [[ ! -f "$PNG" ]]; then
  # fallback: rsvg or sips from a generated pdf
  python3 - <<'PY'
import struct, zlib, pathlib
# minimal rasterizer fallback: write a solid PNG via sips after converting svg with macOS
print('need qlmanage png')
PY
fi
if [[ ! -f "$PNG" ]]; then
  echo "could not rasterize icon.svg" >&2
  exit 1
fi
for size in 16 32 64 128 256 512 1024; do
  sips -z "$size" "$size" "$PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
done
cp "$ICONSET/icon_32x32.png" "$ICONSET/icon_16x16@2x.png"
cp "$ICONSET/icon_64x64.png" "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$ROOT/build/icon.icns"
echo "wrote build/icon.icns"
