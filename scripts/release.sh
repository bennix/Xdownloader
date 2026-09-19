#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
  echo "请先 export APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID" >&2
  exit 1
fi

bash scripts/prepare-bins.sh
npx electron-vite build
npx electron-builder --mac dmg

DMG="$(ls -1 "$ROOT"/release/Xdownloader-*-arm64.dmg | tail -1)"
echo "DMG: $DMG"

if command -v gh >/dev/null && gh auth status -h github.com >/dev/null 2>&1; then
  if ! git remote get-url origin >/dev/null 2>&1; then
    gh repo create bennix/Xdownloader --public --source=. --remote=origin --push || true
  else
    git push -u origin HEAD
  fi
  gh release create "v1.0.0" "$DMG" --title "Xdownloader 1.0.0" --notes "公证 DMG，内置 aria2 / yt-dlp / ffmpeg。" || gh release upload "v1.0.0" "$DMG" --clobber
else
  echo "GitHub CLI 未登录。请运行：gh auth login -h github.com"
  echo "然后：git remote add origin https://github.com/bennix/Xdownloader.git && git push -u origin main"
fi
