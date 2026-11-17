#!/usr/bin/env bash
# install.sh — apply the TiinyOS-Linux feature pack to an existing TiinyOS clone.
#
# Adds (all reversible):
#   * Performance window: capability-aware benchmark of the Tiiny Pocket device
#   * Control Panel window: the community Tiiny Control Panel embedded in the app
#   * Tray menu entries for both
#
# Usage:
#   ./install.sh [--clone-dir DIR] [--dry-run]
#   ./install.sh --uninstall [--clone-dir DIR]
#
# The pristine bundle is never touched: the first run saves app.asar.orig and
# every apply regenerates app.asar from it. Rollback is --uninstall (or
# restoring app.asar.orig by hand).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLONE="${TIINYOS_CLONE_DIR:-$HOME/.local/tiinyos-clone}"
DRY=0; ACTION=install
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clone-dir) CLONE="$2"; shift 2 ;;
    --dry-run)   DRY=1; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help)   sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

RES="$CLONE/electron/resources"
UNP="$RES/app-unpacked"
run() { if [[ $DRY == 1 ]]; then echo "DRY: $*"; else "$@"; fi }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }
say() { printf '[tiinyos-linux] %s\n' "$*"; }

if [[ $ACTION == uninstall ]]; then
  [[ -f "$RES/app.asar.orig" ]] || { say "nothing to uninstall (no app.asar.orig)"; exit 0; }
  run cp "$RES/app.asar.orig" "$RES/app.asar"
  run rm -f "$HOME/Desktop/TiinyOS.desktop" "$HOME/Desktop/Tiiny Control Panel.desktop"
  run rm -f "$CLONE/tools/pcsvr-watchdog.sh"
  run rm -f "$HOME/.config/systemd/user/pcsvr-watchdog.service" "$HOME/.config/systemd/user/pcsvr-watchdog.timer"
  say "uninstalled: pristine app.asar restored. Restart the app."
  say "if you enabled the watchdog timer: systemctl --user disable --now pcsvr-watchdog.timer"
  exit 0
fi

need python3
[[ -f "$RES/app.asar" ]] || { say "no app.asar under $RES — point --clone-dir at your TiinyOS clone"; exit 1; }

ASAR_BIN="${ASAR_BIN:-}"
if [[ -z "$ASAR_BIN" ]]; then
  if [[ -x "$CLONE/tools/node_modules/.bin/asar" ]]; then ASAR_BIN="$CLONE/tools/node_modules/.bin/asar"
  else need npx; ASAR_BIN="npx --yes @electron/asar"; fi
fi

# 1. pristine backup (once; every apply starts from it, never chains)
if [[ ! -f "$RES/app.asar.orig" ]]; then
  say "saving pristine backup app.asar.orig"
  run cp "$RES/app.asar" "$RES/app.asar.orig"
fi

# 2. extract from the pristine copy (the asar CLI derives the unpacked dir
#    from the filename, so extract through a temp dir)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
run cp "$RES/app.asar.orig" "$TMP/app.asar"
[[ -d "$RES/app.asar.unpacked" ]] && run ln -s "$RES/app.asar.unpacked" "$TMP/app.asar.unpacked"
run rm -rf "$UNP"
run sh -c "$ASAR_BIN extract '$TMP/app.asar' '$UNP'"

# 3. feature files
run cp "$HERE"/src/m3_performance.js "$HERE"/src/m3_device.js "$HERE"/src/m3_bench.js \
       "$HERE"/src/m3_preload.js "$HERE"/src/m3_cp.js "$UNP/out/main/"
run cp "$HERE"/src/performance.html "$HERE"/src/performance.css "$UNP/out/renderer/"
run rm -rf "$UNP/out/renderer/m3perf"
run cp -r "$HERE/src/m3perf" "$UNP/out/renderer/m3perf"

# 4. surgical patch of the minified main bundle (idempotent, markers-based)
run python3 "$HERE/tools/patch_main.py" "$UNP/out/main/index.js"

# 5. repack + restore unpacked flags
run sh -c "$ASAR_BIN pack '$UNP' '$RES/app.asar.new'"
run python3 "$HERE/tools/fix_unpacked.py" "$RES/app.asar.new" "$RES/app.asar.unpacked" "$RES/app.asar.new.fixed"
run mv "$RES/app.asar.new.fixed" "$RES/app.asar.new"
run mv "$RES/app.asar.new" "$RES/app.asar"

# 6. verify the header actually contains the feature files (skipped in dry-run:
#    nothing was repacked, the on-disk asar is still the pristine one)
if [[ $DRY == 0 ]]; then
python3 - "$RES/app.asar" <<'EOF'
import json, sys
d = open(sys.argv[1], "rb").read()
n = int.from_bytes(d[12:16], "little")
h = json.dumps(json.loads(d[16:16 + n]))
for f in ("performance.html", "m3_performance.js", "m3_cp.js"):
    assert f in h, f"{f} missing from header"
assert "integrity" in h, "no integrity block"
print("[tiinyos-linux] verify: header OK")
EOF
fi

# 7. desktop entries (app + control panel launcher)
if [[ $DRY == 0 ]]; then
  mkdir -p "$HOME/.local/share/applications" "$HOME/Desktop"
  cat > "$HOME/.local/share/applications/tiinyos.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=TiinyOS
Comment=Tiiny Pocket desktop client (Linux)
Exec=$CLONE/run.sh
Path=$CLONE
Icon=$CLONE/electron/resources/app-unpacked/out/renderer/tiiny-logo.png
Terminal=false
Categories=Utility;
EOF
  cat > "$HOME/.local/share/applications/tiiny-control-panel.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Tiiny Control Panel
Comment=Local control panel for the Tiiny device (opens signed in)
Exec=python3 $HOME/.local/share/tiinyos-linux/control-panel/tiiny_ui.py
Path=$HOME/.local/share/tiinyos-linux/control-panel
Terminal=false
Categories=Utility;
EOF
  cp "$HOME/.local/share/applications/tiinyos.desktop" "$HOME/Desktop/TiinyOS.desktop"
  cp "$HOME/.local/share/applications/tiiny-control-panel.desktop" "$HOME/Desktop/Tiiny Control Panel.desktop"
  chmod +x "$HOME/Desktop/TiinyOS.desktop" "$HOME/Desktop/Tiiny Control Panel.desktop"
fi

# 7b. pcsvr watchdog (vendor thread-leak guard, see docs/vendor-thread-leak.md)
run mkdir -p "$CLONE/tools"
run cp "$HERE/tools/pcsvr-watchdog.sh" "$CLONE/tools/pcsvr-watchdog.sh"
run chmod +x "$CLONE/tools/pcsvr-watchdog.sh"
run mkdir -p "$HOME/.config/systemd/user"
# ExecStart must point at THIS clone, wherever the user put it
if [[ $DRY == 1 ]]; then
  echo "DRY: sed ExecStart -> $CLONE/tools/pcsvr-watchdog.sh into ~/.config/systemd/user/"
else
  sed "s#%h/.local/tiinyos-clone/tools/pcsvr-watchdog.sh#$CLONE/tools/pcsvr-watchdog.sh#" \
    "$HERE/tools/systemd/pcsvr-watchdog.service" > "$HOME/.config/systemd/user/pcsvr-watchdog.service"
  cp "$HERE/tools/systemd/pcsvr-watchdog.timer" "$HOME/.config/systemd/user/"
fi

say "done. Restart the app ($CLONE/run.sh)."
say "recommended: guard the vendor thread leak (docs/vendor-thread-leak.md):"
say "  systemctl --user daemon-reload && systemctl --user enable --now pcsvr-watchdog.timer"
say "rollback anytime: ./install.sh --uninstall"
