#!/usr/bin/env bash
# update.sh — pull the latest feature pack and re-apply it to an installed clone.
#
# What it does:
#   1. git pull --ff-only in this repo (refuses a dirty checkout)
#   2. if HEAD moved, re-runs install.sh on the clone (asar is regenerated
#      from the pristine app.asar.orig, so re-applying is idempotent)
#   3. restarts the app if it was running through launch.sh
#
# Usage:
#   ./update.sh [--clone-dir DIR] [--dry-run] [--no-restart]
#
# Exit codes: 0 = up to date or updated; 1 = refused (dirty repo, no clone);
# anything else = a step failed (nothing was restarted in that case).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLONE="${TIINYOS_CLONE_DIR:-$HOME/.local/tiinyos-clone}"
DRY=0; RESTART=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clone-dir) CLONE="$2"; shift 2 ;;
    --dry-run)   DRY=1; shift ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help)   sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

run() { if [[ $DRY == 1 ]]; then echo "DRY: $*"; else "$@"; fi; }
say() { printf '[tiinyos-linux] %s\n' "$*"; }

git -C "$HERE" rev-parse --git-dir >/dev/null 2>&1 || {
  say "not a git checkout: $HERE (clone the repo first)"; exit 1; }
[[ -z "$(git -C "$HERE" status --porcelain)" ]] || {
  say "repo has uncommitted changes — commit or stash them first"; exit 1; }
[[ -f "$CLONE/electron/resources/app.asar.orig" ]] || {
  say "no installed clone at $CLONE (run install.sh first)"; exit 1; }

was_running=0
pgrep -f "$CLONE/electron/tiinyos" >/dev/null 2>&1 && was_running=1

OLD="$(git -C "$HERE" rev-parse HEAD)"
OLDV="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"
BR="$(git -C "$HERE" rev-parse --abbrev-ref HEAD)"
if [[ $DRY == 1 ]]; then
  say "dry-run: fetch only, no changes"
  git -C "$HERE" fetch --quiet
  NEW="$(git -C "$HERE" rev-parse "origin/$BR")"
  NEWV="$(git -C "$HERE" show "origin/$BR:VERSION" 2>/dev/null || echo unknown)"
else
  say "pulling $HERE ..."
  git -C "$HERE" pull --ff-only
  NEW="$(git -C "$HERE" rev-parse HEAD)"
  NEWV="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"
fi

if [[ "$NEW" == "$OLD" ]]; then
  say "already up to date (${NEW:0:7})"; exit 0
fi

say "version $OLDV → $NEWV (${OLD:0:7} → ${NEW:0:7})"
say "re-applying install.sh to $CLONE ..."
run "$HERE/install.sh" --clone-dir "$CLONE"

if [[ $RESTART == 1 && $was_running == 1 && $DRY == 0 ]]; then
  say "restarting the running instance ..."
  pkill -f "$CLONE/electron/tiinyos" || true
  sleep 2
  if [[ -x "$CLONE/launch.sh" ]]; then
    setsid "$CLONE/launch.sh" >/dev/null 2>&1 < /dev/null &
  else
    say "launch.sh missing or not executable — start the app manually"
  fi
elif [[ $was_running == 1 ]]; then
  say "app was running: restart it manually (or drop --no-restart)"
fi
say "done ($( [[ $DRY == 1 ]] && echo dry-run || echo "now at ${NEW:0:7}" ))"
