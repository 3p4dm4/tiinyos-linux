#!/usr/bin/env bash
# build_pcsvr.sh — build the Rust pcsvr (pcsvr-rs/) and stage a deployable dir.
#
# Why: on Linux there is no pcsvr.exe; our old Python shim stood in —
# and that shim leaks threads (docs/pcsvr-thread-leak.md). pcsvr-rs is a
# drop-in replacement with no runtime deps; this script produces the artifact
# and optionally installs it into a clone's pcsvr directory, where the app
# would start it instead of `python3 ./pcsvr -f pcsvr-api.yaml`.
#
# Usage:
#   tools/build_pcsvr.sh                     # build + stage in dist/pcsvr/
#   tools/build_pcsvr.sh --dest DIR          # stage somewhere else
#   tools/build_pcsvr.sh --install DIR       # stage, then copy into a pcsvr dir
#   tools/build_pcsvr.sh --debug             # debug build (faster compile)
#   tools/build_pcsvr.sh --test              # run the test suite first
#   tools/build_pcsvr.sh --no-strip          # keep symbols
#
# Nothing here touches a running service: --install only copies files into the
# directory you name; restarting the app/shim is your call. install.sh calls
# this script and puts the binary where the app starts it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE="$HERE/../pcsvr-rs"
DEST="$HERE/../dist/pcsvr"
PROFILE=release
RUN_TESTS=0
STRIP=1
INSTALL_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)    DEST="$2"; shift 2 ;;
    --install) INSTALL_DIR="$2"; shift 2 ;;
    --debug)   PROFILE=debug; shift ;;
    --test)    RUN_TESTS=1; shift ;;
    --no-strip) STRIP=0; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

CDIR="$(cd "$CRATE" && pwd)"
cd "$CDIR"

command -v cargo >/dev/null || { echo "cargo not found" >&2; exit 1; }

# Offline by default: the crate has zero dependencies, so the network is never
# needed and a build must not depend on it.
CARGO_FLAGS=(--offline)

if [[ $RUN_TESTS -eq 1 ]]; then
  echo "== test ($PROFILE)"
  # single-threaded on purpose for tests/leak.rs: it reads process-wide
  # counters (threads, fds) that a parallel test would move.
  cargo test "${CARGO_FLAGS[@]}" -- --test-threads=1
fi

echo "== build ($PROFILE)"
cargo build "${CARGO_FLAGS[@]}" --profile "$PROFILE"
BIN="$CDIR/target/$PROFILE/pcsvr"
[[ -x "$BIN" ]] || { echo "binary not produced: $BIN" >&2; exit 1; }

mkdir -p "$DEST"
install -m 0755 "$BIN" "$DEST/pcsvr"
[[ $STRIP -eq 1 ]] && command -v strip >/dev/null && strip "$DEST/pcsvr" 2>/dev/null || true

# Config: ship the example only. A real pcsvr-api.yaml holds whoever's device
# identity it was written for, so it is never committed nor copied here.
[[ -f "$DEST/pcsvr-api.yaml" ]] || install -m 0644 "$CDIR/pcsvr-api.yaml.example" "$DEST/pcsvr-api.yaml.example"
install -m 0644 "$CDIR/README.md" "$DEST/README.md"

echo
echo "staged in: $(cd "$DEST" && pwd)"
ls -l "$DEST"
echo
"$DEST/pcsvr" --version || true
echo "deps (must be libc/libgcc only):"
ldd "$DEST/pcsvr" | sed 's/^/  /'

if [[ -n "$INSTALL_DIR" ]]; then
  echo
  echo "== install -> $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$DEST/pcsvr" "$INSTALL_DIR/pcsvr"
  [[ -f "$INSTALL_DIR/pcsvr-api.yaml" ]] || {
    echo "  no pcsvr-api.yaml in $INSTALL_DIR — copied the example; edit it (device identity is read from the device at runtime, the file is only a fallback)"
    install -m 0644 "$CDIR/pcsvr-api.yaml.example" "$INSTALL_DIR/pcsvr-api.yaml"
  }
  echo "  done. To actually run it instead of the Python shim:"
  echo "    1. stop the running shim: pkill -xf 'python3 ./pcsvr -f pcsvr-api.yaml'"
  echo "    2. restart the app: it starts $INSTALL_DIR/pcsvr by itself"
  echo "    3. curl -s localhost:60000/status"
fi
