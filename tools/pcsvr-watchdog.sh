#!/usr/bin/env bash
# pcsvr-watchdog.sh — keep the TiinyOS pcsvr shim healthy (vendor thread-leak guard).
# Why this exists: docs/vendor-thread-leak.md (full RCA with evidence).
#
# Policy per 5-min tick:
#   - shim dead or unresponsive (port answers nothing) -> start it
#   - shim threads > MAX_THREADS (leak grown back)     -> kill and restart
# MAX_THREADS is data-driven: 1500 is ~30 min at the observed fast leak rate
# (~50 thread/min) and 1/9 of the level where the vendor shim died on its own
# (~13k). A restart is invisible to the app: it reconnects within 30 s.
#
# Paths default to the clone built by install.sh; override with env:
#   TIINYOS_CLONE_DIR   (default ~/.local/tiinyos-clone)
#   PCSVR_WATCHDOG_LOG  (default ~/.cache/flowstate/pcsvr-watchdog.log)
set -u
CLONE="${TIINYOS_CLONE_DIR:-$HOME/.local/tiinyos-clone}"
SHIM_DIR="$CLONE/electron/resources/pcsvr/linux"
MAX_THREADS="${PCSVR_MAX_THREADS:-1500}"
LOG="${PCSVR_WATCHDOG_LOG:-$HOME/.cache/flowstate/pcsvr-watchdog.log}"
mkdir -p "$(dirname "$LOG")"
ts() { date '+%F %T'; }

start_shim() {
  # Raise the fd limit first: pcsvr leaks one fd per leaked thread and died
  # functionally at the inherited ~1024 fds (EMFILE: process alive, port
  # silent) long before the thread threshold could act. With 65536 the thread
  # threshold is the only gate.
  ( ulimit -n 65536 2>/dev/null; cd "$SHIM_DIR" \
      && nohup python3 ./pcsvr -f pcsvr-api.yaml >>pcsvr-shim.log 2>&1 & )
  echo "$(ts) started shim" >> "$LOG"
}

# Serving check, not process check: an EMFILE-stalled shim still holds the port
# but answers nothing. ANY HTTP response means the event loop is alive —
# /devices_list answers 404 even when healthy (the app uses the /ws variant);
# `curl -sf` would treat that 404 as death and restart a healthy shim every
# tick (bug observed during bring-up: restart loop every 5 min).
# Only a missing response (000: timeout/refused) is death.
alive() {
  local P="$1"
  [ -n "$P" ] && [ -d "/proc/$P" ] \
    && [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:60000/devices_list 2>/dev/null)" != "000" ]
}

# -x exact cmdline: plain -f also matches bash wrappers and any shell whose
# command line quotes the pattern (real bring-up bug: it guarded a 1-thread
# wrapper and never saw the real python).
P="$(pgrep -xf 'python3 ./pcsvr -f pcsvr-api.yaml' | head -1)"
if ! alive "$P"; then
  [ -n "$P" ] && { echo "$(ts) shim unresponsive (EMFILE?) pid=$P -> restart" >> "$LOG"; kill "$P" 2>/dev/null; sleep 1; kill -9 "$P" 2>/dev/null; }
  echo "$(ts) shim not running -> start" >> "$LOG"
  start_shim
  exit 0
fi
T="$(awk '/Threads/{print $2}' /proc/$P/status 2>/dev/null)"
if [ -z "$T" ]; then
  exit 0   # died between check and read: next tick handles it
fi
if [ "$T" -gt "$MAX_THREADS" ]; then
  echo "$(ts) leak: pid=$P threads=$T > $MAX_THREADS -> restart" >> "$LOG"
  kill "$P"; sleep 3
  kill -9 "$P" 2>/dev/null
  start_shim
else
  echo "$(ts) ok pid=$P threads=$T" >> "$LOG"
fi
