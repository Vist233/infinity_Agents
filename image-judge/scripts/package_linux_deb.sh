#!/usr/bin/env bash
set -euo pipefail

# Build a small Debian package from the PyInstaller onedir output.
# Usage: package_linux_deb.sh <pyinstaller-output-dir> <output-dir>

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dist_dir="${1:-${repo_dir}/package/linux/ImageJudge}"
output_dir="${2:-${repo_dir}/package}"

if [[ ! -x "${dist_dir}/ImageJudge" ]]; then
  echo "PyInstaller output not found: ${dist_dir}/ImageJudge" >&2
  exit 1
fi
if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "dpkg-deb is required; run this script on Debian/Ubuntu or install dpkg." >&2
  exit 1
fi

if [[ -n "${IMAGEJUDGE_VERSION:-}" ]]; then
  package_version="${IMAGEJUDGE_VERSION}"
else
  package_version="$(python - "${repo_dir}/image-judge/pyproject.toml" <<'PY'
import tomllib
from pathlib import Path
import sys

with Path(sys.argv[1]).open("rb") as handle:
    print(tomllib.load(handle)["project"]["version"])
PY
)"
fi

staging_dir="${output_dir}/.imagejudge-deb"
rm -rf "${staging_dir}"
mkdir -p \
  "${staging_dir}/DEBIAN" \
  "${staging_dir}/usr/lib/imagejudge" \
  "${staging_dir}/usr/bin" \
  "${staging_dir}/usr/share/applications"

cp -a "${dist_dir}/." "${staging_dir}/usr/lib/imagejudge/"

cat > "${staging_dir}/DEBIAN/control" <<EOF
Package: imagejudge
Version: ${package_version}
Section: science
Priority: optional
Architecture: amd64
Maintainer: Infinity Agents
Description: ImageJudge desktop visual classification client
 Reference-guided image batch classification with a local BYOK model gateway.
EOF

cat > "${staging_dir}/usr/bin/imagejudge" <<'EOF'
#!/bin/sh
exec /usr/lib/imagejudge/ImageJudge/ImageJudge "$@"
EOF
chmod 0755 "${staging_dir}/usr/bin/imagejudge"

cat > "${staging_dir}/usr/share/applications/imagejudge.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=ImageJudge
Comment=Reference-guided visual classification
Exec=imagejudge
Terminal=false
Categories=Science;Utility;
EOF

deb_path="${output_dir}/ImageJudge_${package_version}_amd64.deb"
rm -f "${deb_path}"
dpkg-deb --build --root-owner-group "${staging_dir}" "${deb_path}"
rm -rf "${staging_dir}"
echo "Created ${deb_path}"
