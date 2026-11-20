#!/usr/bin/env bash
# run_e2e.sh — end-to-end proof of the device care engine against a FAKE pocket.
#
# Full chain, nothing touching the real device or the real install:
#   build_clone.sh  -> fresh clone from the official CDN artifacts
#   install.sh      -> feature pack applied (asar repacked, patches verified)
#   harness.js      -> the clone's own Electron boots the INSTALLED asar
#                      contents + real preload against tests/fake_pocket_ctl.py
#                      and drives every care flow through the renderer bridge
#   install.sh --uninstall -> pristine app.asar restored byte-identically
#
# Usage: tests/e2e/run_e2e.sh [--dest DIR] [--reuse]
#   --dest DIR   work dir (default /tmp/m3e2e)
#   --reuse      keep an already-built clone in DIR (skips the CDN downloads)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DEST=/tmp/m3e2e
REUSE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --reuse) REUSE=1; shift ;;
    *) echo "usage: $0 [--dest DIR] [--reuse]" >&2; exit 2 ;;
  esac
done
CLONE="$DEST/clone"; HOME_DIR="$DEST/home"; PROFILE="$DEST/profile"
say() { echo "[e2e] $*"; }
cleanup() {
  # kill anything this script left behind (fake pocket, harness electron)
  if [[ -n "${HARNESS_PID:-}" ]]; then kill "$HARNESS_PID" 2>/dev/null || true; fi
  pkill -P $$ 2>/dev/null || true
}
trap cleanup EXIT

# 1. clone (downloads are cached inside DEST by build_clone.sh itself)
if [[ $REUSE -eq 1 && -f "$CLONE/electron/resources/app.asar" ]]; then
  say "reusing clone in $CLONE"
else
  if [[ -f "$HOME/.local/tiinyos-clone/electron-v37.4.0-linux-x64.zip" && ! -f "$CLONE/electron.zip" ]]; then
    mkdir -p "$CLONE"; ln -sf "$HOME/.local/tiinyos-clone/electron-v37.4.0-linux-x64.zip" "$CLONE/electron.zip"
  fi
  say "building clone in $CLONE (CDN download the first time)"
  "$REPO/build_clone.sh" --dest "$CLONE" >/dev/null
fi

# 2. scratch HOME: dummy auth key for the fake, isolated config/desktop state
rm -rf "$HOME_DIR" "$PROFILE"
mkdir -p "$HOME_DIR/.local/tiiny" "$PROFILE"
printf '{"account":{"authKey":"e2e-dummy-key"}}' > "$HOME_DIR/.local/tiiny/config.json"

# 3. apply the feature pack exactly like the real installer.
#    rustup reads its toolchain config from $HOME/.rustup, and HOME is a scratch
#    dir here — point it (and CARGO_HOME) at the real ones so pcsvr builds too.
say "install.sh --clone-dir $CLONE"
# NB: compute the real paths BEFORE the HOME= prefix — prefix assignments
# apply left to right, so $HOME inside the same prefix is already the scratch one.
RU_HOME="${RUSTUP_HOME:-$HOME/.rustup}"; CA_HOME="${CARGO_HOME:-$HOME/.cargo}"
HOME="$HOME_DIR" RUSTUP_HOME="$RU_HOME" CARGO_HOME="$CA_HOME" \
  "$REPO/install.sh" --clone-dir "$CLONE" | sed 's/^/[install] /'

# 4. extract the SHIPPED asar; the harness runs those files, not the repo copies
ASAR_BIN="$CLONE/tools/node_modules/.bin/asar"
[[ -x "$ASAR_BIN" ]] || ASAR_BIN="npx --yes @electron/asar"
rm -rf "$DEST/unpacked"; mkdir -p "$DEST/unpacked"
sh -c "$ASAR_BIN extract '$CLONE/electron/resources/app.asar' '$DEST/unpacked'"
[[ -f "$DEST/unpacked/out/main/m3_care.js" ]] || { say "m3_care.js not in the shipped asar"; exit 1; }
say "shipped asar extracted (m3_care.js present)"

# 5. the harness: real Electron, real preload, fake device, all care flows.
#    A binary that ships resources/app.asar always boots that app and ignores
#    a CLI app path, so test with a copy whose app.asar is removed (hardlinks,
#    the clone itself is untouched) -> default_app runs our harness instead.
say "running harness (all care flows, real timings — ~3 min)"
rm -rf "$DEST/electron-test"
cp -al "$CLONE/electron" "$DEST/electron-test" 2>/dev/null || cp -a "$CLONE/electron" "$DEST/electron-test"
rm -f "$DEST/electron-test/resources/app.asar"
set +e
E2E_MAIN="$DEST/unpacked/out/main" E2E_CTL="$HERE/../fake_pocket_ctl.py" \
HOME="$HOME_DIR" timeout 420 \
  xvfb-run -a "$DEST/electron-test/tiinyos" --no-sandbox --ozone-platform=x11 \
  --user-data-dir="$PROFILE" "$HERE/harness.js" 2> >(grep -v -E "libva|GetVSyncParametersIfAvailable|GPU stall|dbus" >&2)
RC=$?
set -e
[[ $RC -eq 0 ]] || { say "harness FAILED (exit $RC)"; exit $RC; }

# 6. reversibility: uninstall must restore the pristine asar byte for byte
say "install.sh --uninstall"
HOME="$HOME_DIR" "$REPO/install.sh" --clone-dir "$CLONE" --uninstall | sed 's/^/[uninstall] /'
RES="$CLONE/electron/resources"
cmp "$RES/app.asar" "$RES/app.asar.orig" \
  && say "pristine app.asar restored byte-identically" \
  || { say "UNINSTALL DID NOT RESTORE the pristine asar"; exit 1; }

say "E2E PASS"
