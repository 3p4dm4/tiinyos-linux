#!/usr/bin/env bash
# Music Lab standalone — launcher.
# The clone's Electron binary is a packaged build: it always loads the
# resources/app.asar sitting next to it and ignores an app path on argv.
# So we build a small symlink farm around the clone's binary where
# resources/app points at this folder instead. No second download, no copies.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

SRC="${MUSIC_LAB_ELECTRON_DIR:-${HOME}/.local/tiinyos-clone/electron}"
[[ -x "$SRC/tiinyos" ]] || { echo "no clone Electron at $SRC — run build_clone.sh first (or set MUSIC_LAB_ELECTRON_DIR)" >&2; exit 1; }

FARM="${XDG_CACHE_HOME:-$HOME/.cache}/music-lab-standalone/electron"
# rebuild when missing or when the clone's Electron version changed
if [[ ! -e "$FARM/version" ]] || ! cmp -s "$FARM/version" "$SRC/version" 2>/dev/null; then
  rm -rf "$FARM"
  mkdir -p "$FARM/resources"
  for f in "$SRC"/*; do
    b="$(basename "$f")"; [[ "$b" == resources ]] && continue
    if [[ "$b" == tiinyos ]]; then
      # hard link, not symlink: Electron resolves a symlinked exe back to its
      # real directory and would load the vendor app.asar again
      ln "$f" "$FARM/$b" || cp "$f" "$FARM/$b"
    else
      ln -s "$f" "$FARM/$b"
    fi
  done
  for f in "$SRC"/resources/*; do
    b="$(basename "$f")"
    case "$b" in app.asar|app.asar.*|app.asar.unpacked|app|default_app.asar) continue;; esac
    ln -s "$f" "$FARM/resources/$b"
  done
  ln -s "$HERE" "$FARM/resources/app"
fi

# --no-sandbox: the clone's chrome-sandbox is npm-downloaded (owner is the user,
#   not root) so Chromium refuses to start with it; the vendor app disables the
#   sandbox in its own code — this launcher does it explicitly.
# NOTE: no --disable-gpu by default — on this hardware (verified 18/11 via
# gnome-screenshot pixel stats) software rendering paints the window BLACK on
# screen while the page itself is fine. The main app launcher runs with GPU on.
# If your GPU crashes Electron at startup, opt in:  MUSIC_LAB_FLAGS=--disable-gpu ./launch.sh
exec "$FARM/tiinyos" ${MUSIC_LAB_FLAGS:-} --no-sandbox "$@"
