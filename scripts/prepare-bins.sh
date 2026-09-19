#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/resources/bin"
LIB="$DEST/lib"
mkdir -p "$LIB"

copy_real() {
  local src="$1"
  local name="$2"
  if [[ ! -e "$src" ]]; then
    echo "missing $src" >&2
    exit 1
  fi
  cp -fL "$src" "$DEST/$name"
  chmod +x "$DEST/$name"
}

if [[ ! -x "$DEST/yt-dlp" ]]; then
  echo "downloading standalone yt-dlp…"
  curl -fsSL -o "$DEST/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
  chmod +x "$DEST/yt-dlp"
fi

copy_real /opt/homebrew/bin/aria2c aria2c
copy_real /opt/homebrew/bin/ffmpeg ffmpeg
copy_real /opt/homebrew/bin/ffprobe ffprobe

python3 "$ROOT/scripts/bundle-dylibs.py" "$DEST/aria2c" "$LIB"
python3 "$ROOT/scripts/bundle-dylibs.py" "$DEST/ffmpeg" "$LIB"
python3 "$ROOT/scripts/bundle-dylibs.py" "$DEST/ffprobe" "$LIB"

echo "bundled tools:"
ls -lh "$DEST" | sed -n '1,20p'
"$DEST/aria2c" --version | head -1
"$DEST/ffmpeg" -version | head -1
"$DEST/yt-dlp" --version
