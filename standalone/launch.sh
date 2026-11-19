#!/usr/bin/env bash
# TiinyOS tools — standalone launcher (one launcher for every tool).
#
# The clone's Electron is a packaged build: it ALWAYS loads the resources/app
# that sits next to its own binary and ignores any app path on argv. So we keep
# a small symlink FARM around the clone's binary where resources/app points at
# our checkout's standalone/ host. No second download, no copies: the binary is
# hard-linked, the rest of the Electron dir is symlinked, and resources/app is
# re-pointed at the checkout it is launched from on EVERY launch (observed: the
# farm of the first checkout that ran wins otherwise, so launching from another
# worktree silently ran that old code).
#
# Usage:
#   ./launch.sh <tool>            run one tool standalone (see ./launch.sh --list)
#   ./launch.sh --list            list the available tools
#
# Env:
#   TIINY_ELECTRON_DIR    where the clone's Electron lives (default ~/.local/tiinyos-clone/electron)
#   TIINY_TOOLS_FLAGS     extra Chromium flags passed to the app (e.g. --disable-gpu)
#   XDG_CACHE_HOME        where the cached farm lives (default ~/.cache)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

TOOLS_JSON="$HERE/tools.json"
# available tool names (keys of tools.json); python3 is a hard dep of this repo
TOOLS="$(python3 -c 'import json,sys; print(" ".join(sorted(json.load(open(sys.argv[1])))))' "$TOOLS_JSON" 2>/dev/null || true)"

list_tools() {
  printf 'Available tools:\n'
  for t in $TOOLS; do
    title="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]].get("title",""))' "$TOOLS_JSON" "$t" 2>/dev/null || true)"
    printf '  %-10s %s\n' "$t" "$title"
  done
  echo
  echo "Run one: $0 <tool>"
}

# --list (and no args) just shows the tools and exits
if [[ "${1:-}" == "--list" || -z "${1:-}" ]]; then
  list_tools
  exit 0
fi

TOOL="${1:-}"
if [[ " $TOOLS " != *" $TOOL "* ]]; then
  echo "unknown tool: '$TOOL'" >&2
  echo "available tools: ${TOOLS:-<none — is tools.json next to this script?>}" >&2
  exit 1
fi

SRC="${TIINY_ELECTRON_DIR:-${HOME}/.local/tiinyos-clone/electron}"
[[ -x "$SRC/tiinyos" ]] || { echo "no clone Electron at $SRC — run build_clone.sh first (or set TIINY_ELECTRON_DIR)" >&2; exit 1; }

FARM="${XDG_CACHE_HOME:-$HOME/.cache}/tiiny-tools/electron"
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
fi

# re-point resources/app at THIS checkout's standalone host (the only uncached part)
if [[ -d "$FARM/resources/app" && ! -L "$FARM/resources/app" ]]; then
  # a real directory here would make ln -sfn nest inside it — remove it first
  rm -rf "$FARM/resources/app"
fi
mkdir -p "$FARM/resources"
ln -sfn "$HERE" "$FARM/resources/app"
echo "[tiiny-tools] standalone '$TOOL' launched from checkout: $HERE" >&2

# The tool name goes to the app as the TIINY_TOOL ENV VAR, not an argv: a
# packaged Electron consumes/ignores argv after the app path (it is already
# committed to resources/app), so env is the channel that reliably survives.
# main.js reads TIINY_TOOL, requires the matching module from ../src and opens it.
export TIINY_TOOL="$TOOL"
shift   # drop the tool name from argv; anything after it is passed through as-is

# --no-sandbox: the clone's chrome-sandbox is npm-downloaded (owner is the user,
#   not root) so Chromium refuses to start with it; the vendor app disables the
#   sandbox in its own code — this launcher does it explicitly.
# NOTE: no --disable-gpu by default — on this hardware (verified via
#   gnome-screenshot pixel stats) software rendering paints the window BLACK on
#   screen while the page itself is fine. Opt in: TIINY_TOOLS_FLAGS=--disable-gpu
exec "$FARM/tiinyos" ${TIINY_TOOLS_FLAGS:-} --no-sandbox "$@"
