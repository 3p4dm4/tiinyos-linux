#!/usr/bin/env bash
# build_clone.sh — assemble a runnable TiinyOS Linux "clone": official bundle
# (downloaded by you from Tiiny's public CDN) + upstream Electron 37.4.0.
# Nothing proprietary is shipped in this repository: you download the official
# artifacts yourself, exactly as the vendor's updater would.
#
# Usage: ./build_clone.sh [--dest DIR]
set -euo pipefail
DEST="${HOME}/.local/tiinyos-clone"
[[ "${1:-}" == "--dest" ]] && DEST="$2"

BUNDLE_URL="https://files.tiinycdn.com/update/blobs/tiinyos-1.0.3-windows-amd64.exe"
ELECTRON_URL="https://github.com/electron/electron/releases/download/v37.4.0/electron-v37.4.0-linux-x64.zip"
# NOTE: verify both URLs and the Electron version against
# analysis/00_artifact_manifest.md in the project before trusting mirrors.

for t in curl 7z unzip; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
mkdir -p "$DEST/tools"
cd "$DEST"

echo "[1/4] official bundle"
[[ -f bundle.exe ]] || curl -fL --retry 3 -o bundle.exe "$BUNDLE_URL"
echo "[2/4] extract app.asar from the NSIS installer"
rm -rf nsis; mkdir nsis
7z x -onsis bundle.exe '$PLUGINSDIR/app-64.7z' >/dev/null
A7Z="$(find nsis -name 'app-64.7z' | head -1)"; [ -n "$A7Z" ] || { echo "app-64.7z not found inside the installer" >&2; exit 1; }
7z x -oapp "$A7Z" 'resources/app.asar' 'resources/app.asar.unpacked/*' >/dev/null
rm -rf nsis

echo "[3/4] Electron 37.4.0 (linux-x64)"
[[ -f electron.zip ]] || curl -fL --retry 3 -o electron.zip "$ELECTRON_URL"
rm -rf electron electron-bin; mkdir electron-bin
unzip -q electron.zip -d electron-bin
mv electron-bin electron
mv electron/electron electron/tiinyos 2>/dev/null || true
chmod +x electron/tiinyos
mkdir -p electron/resources
mv -f app/resources/app.asar electron/resources/app.asar
cp -a app/resources/app.asar.unpacked electron/resources/ 2>/dev/null || true
rm -rf app

echo "[4/4] launcher"
cat > run.sh <<EOF
#!/bin/bash
exec $DEST/electron/tiinyos --no-sandbox --ozone-platform=x11 "\$@" $DEST/electron/resources/app.asar
EOF
chmod +x run.sh

cat <<'EOF'

Clone assembled. Two manual steps remain (they need root / per-network knowledge):

  1. Device name resolution — the app resolves *.api.tiiny hostnames to the
     Pocket's USB network IP. Add to /etc/hosts (IP of the device, e.g. from
     `ip addr` on the usb0/usb1 interface):
        <device-ip>  api.tiiny  models.api.tiiny  <see README "network">

  2. Run it:  ~/.local/tiinyos-clone/run.sh
     Then apply the feature pack:  ./install.sh --clone-dir <DIR>
EOF
