#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output_root="${1:-$repo_root/package/macos}"
if [[ "$output_root" != /* ]]; then
  output_root="$repo_root/$output_root"
fi
desktop_dir="$repo_root/image-judge/apps/desktop"
dist_root="$output_root/dist"
work_root="$output_root/.build"

mkdir -p "$dist_root" "$work_root" "$output_root/.pyinstaller"
# Keep PyInstaller's cache inside the explicit output workspace. This makes
# packaging reproducible and avoids deleting a user-owned global cache during
# --clean.
export PYINSTALLER_CONFIG_DIR="$output_root/.pyinstaller"
cd "$desktop_dir"

python -m PyInstaller imagejudge.spec --noconfirm --clean \
  --distpath "$dist_root" --workpath "$work_root"

app_path="$dist_root/ImageJudge.app"
if [[ ! -d "$app_path" ]]; then
  echo "ImageJudge.app was not produced" >&2
  exit 1
fi

# Ad-hoc signing makes the local bundle launchable without requiring a
# developer certificate. A release pipeline can replace this with a notarized
# Developer ID signature.
if command -v codesign >/dev/null 2>&1; then
  codesign --deep --force --sign - "$app_path" >/dev/null 2>&1 || true
fi

arch="$(uname -m)"
archive="$output_root/ImageJudge-macos-${arch}.zip"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$archive"
cp "$archive" "$output_root/ImageJudge-macos.zip"

printf 'macOS app: %s\narchive: %s\n' "$app_path" "$archive"
