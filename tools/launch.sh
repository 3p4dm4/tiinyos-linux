#!/usr/bin/env bash
# launch.sh — "checked" startup of TiinyOS (M3 clone) from the desktop shortcut.
#
# Installed by install.sh at <clone>/launch.sh; the desktop shortcut points here.
# Born 2026-11-17 from the "invisible windows" RCA (cause: GNOME mutter-x11-frames
# helper dead and never restarted → framed X windows were never shown).
#
# What it does, in order:
#   1. double-click lock
#   2. another TiinyOS install already open (they share ~/.config/TiinyOS →
#      single instance: a new launch would be "absorbed") → asks whether to close it
#   3. app.asar really contains the patches (asar header) → otherwise stops
#   4. Wayland session: X frame helper (mutter-x11-frames) alive → otherwise restarts it
#   5. non-blocking checks: Pocket reachable, /etc/hosts, Control Panel, watchdog
#   6. detached launch + verification: within 40s an app window is actually visible
# Log: ~/.cache/tiinyos/launch.log (startup) and ~/.cache/tiinyos/app.log (app).
set -uo pipefail

CLONE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RES="$CLONE/electron/resources"
LOGDIR="$HOME/.cache/tiinyos"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/launch.log"; APPLOG="$LOGDIR/app.log"
ICON="$RES/app-unpacked/out/renderer/tiiny-logo.png"
[[ -f "$LOG" && $(stat -c %s "$LOG") -gt 1000000 ]] && mv -f "$LOG" "$LOG.1"

log()  { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
note() { log "INFO $*"; notify-send -a TiinyOS -i "$ICON" "TiinyOS" "$*" 2>/dev/null || true; }
warn() { log "WARN $*"; notify-send -a TiinyOS -u normal -i "$ICON" "TiinyOS — warning" "$*" 2>/dev/null || true; }
die()  { log "FAIL $*"; notify-send -a TiinyOS -u critical -i "$ICON" "TiinyOS did not start" "$*" 2>/dev/null || true
         command -v zenity >/dev/null && zenity --error --title="TiinyOS" --text="$*" --width=420 2>/dev/null; exit 1; }

# PIDs of the main TiinyOS processes: identified by the BINARY (/proc/PID/exe),
# never by the command-line text — a shell containing the string
# "/electron/tiinyos" would be mistaken for the app (observed error 17/11).
main_pids() {
  local p exe cmd
  for p in $(pgrep -x tiinyos 2>/dev/null); do
    exe=$(readlink "/proc/$p/exe" 2>/dev/null) || continue
    [[ $exe == */electron/tiinyos ]] || continue
    cmd=$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null) || continue
    [[ $cmd == *"--type="* ]] && continue
    echo "$p"
  done
}
if [[ ${1:-} == --list-instances ]]; then
  for p in $(main_pids); do echo "$p $(readlink "/proc/$p/exe")"; done; exit 0
fi

log "==== startup requested (pid $$)"

# 1. double-click lock
exec 9>"$LOGDIR/launch.lock"
flock -n 9 || { log "another startup already in progress, exiting"; exit 0; }

# 2. instances already open
for p in $(main_pids); do
  exe=$(readlink "/proc/$p/exe" 2>/dev/null)
  if [[ $exe == "$CLONE/electron/tiinyos" ]]; then
    log "TiinyOS (M3) already open (pid $p): bringing it to the foreground"
    "$CLONE/run.sh" >>"$APPLOG" 2>&1 &   # the single instance receives second-instance and shows itself
    exit 0
  fi
  other=${exe%/electron/tiinyos}
  log "other installation open: pid $p from $other"
  if zenity --question --title="TiinyOS" --width=460 \
       --text="Another version of TiinyOS is already open:\n<tt>$other</tt>\n\nThe two versions cannot run together. Close it and start the correct one (M3)?" 2>/dev/null; then
    kill "$p"; for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && die "Cannot close the other version (pid $p). Close it from its tray menu and retry."
    log "closed pid $p"
  else
    log "user cancelled"; exit 0
  fi
done

# 3. are the patches really in the app?
python3 - "$RES/app.asar" >>"$LOG" 2>&1 <<'EOF' || die "The app does not contain the M3 features (Performance/Control Panel).
Reinstall with:  ./install.sh --clone-dir $CLONE  (from the tiinyos-linux repo)"
import json, sys
d = open(sys.argv[1], "rb").read(1 << 23)
n = int.from_bytes(d[12:16], "little")
h = d[16:16 + n].decode()
miss = [f for f in ("performance.html", "m3_performance.js", "m3_cp.js") if f not in h]
if miss: print("asar check: missing", miss); sys.exit(1)
print("asar check: ok")
EOF

# 4. GNOME frame helper (RCA 17/11: if it dies, framed X windows never appear)
if [[ ${XDG_SESSION_TYPE:-} == wayland ]] && pgrep -x Xwayland >/dev/null; then
  if ! pgrep -f '^/usr/libexec/mutter-x11-frames' >/dev/null && [[ -x /usr/libexec/mutter-x11-frames ]]; then
    XW=$(pgrep -x Xwayland | head -1)
    XA=$(tr '\0' '\n' <"/proc/$XW/cmdline" | grep -A1 -x -- '-auth' | tail -1)
    log "mutter-x11-frames missing: restarting it (auth $XA)"
    DISPLAY=${DISPLAY:-:0} XAUTHORITY=${XA:-${XAUTHORITY:-}} GDK_BACKEND=x11 \
      setsid /usr/libexec/mutter-x11-frames >>"$LOGDIR/mutter-x11-frames.log" 2>&1 </dev/null &
    sleep 1.5
    pgrep -f '^/usr/libexec/mutter-x11-frames' >/dev/null \
      && note "Repaired a GNOME component (window frames) that had stopped." \
      || warn "The GNOME frame helper will not restart: Performance/Control Panel windows may not appear. Safe remedy: log out and back in."
  else
    log "mutter-x11-frames ok"
  fi
fi

# 5. non-blocking checks
DEV=$(getent hosts auth.api.tiiny | awk '{print $1}')
if [[ -z $DEV ]]; then
  warn "Missing *.api.tiiny line in /etc/hosts: the app will not find the Pocket."
elif ! timeout 2 bash -c "</dev/tcp/$DEV/80" 2>/dev/null; then
  warn "Pocket unreachable ($DEV): check the USB cable. The app starts anyway."
else
  log "Pocket reachable ($DEV)"
fi
export TIINY_CP_DIR="${TIINY_CP_DIR:-$HOME/.local/share/tiinyos-linux/control-panel}"   # same default as m3_cp.js
if timeout 2 bash -c '</dev/tcp/127.0.0.1/8765' 2>/dev/null; then log "Control Panel already running on :8765"
elif [[ -f ${TIINY_CP_DIR:-/nonexistent}/tiiny_ui.py ]]; then log "Control Panel stopped: the app will start it from $TIINY_CP_DIR"
else warn "Control Panel not found in $TIINY_CP_DIR (./fetch_control_panel.sh): the Control Panel window will not work."; fi
command -v wmctrl >/dev/null || warn "wmctrl missing (sudo apt install wmctrl): the Floating Ball will also appear in the taskbar."
systemctl --user is-active --quiet pcsvr-watchdog.timer || warn "pcsvr watchdog not active (systemctl --user enable --now pcsvr-watchdog.timer)."

# 6. detached launch + real visibility verification
[[ -f "$APPLOG" ]] && mv -f "$APPLOG" "$APPLOG.1"
cd "$CLONE" || die "folder $CLONE missing"
setsid "$CLONE/run.sh" >>"$APPLOG" 2>&1 </dev/null &
log "started run.sh (pid $!)"
flock -u 9

for _ in $(seq 1 40); do
  sleep 1
  MP=$(main_pids | head -1)
  [[ -z $MP ]] && continue
  for w in $(DISPLAY=${DISPLAY:-:0} wmctrl -lp 2>/dev/null | awk -v p="$MP" '$3==p{print $1}'); do
    if DISPLAY=${DISPLAY:-:0} xwininfo -id "$w" 2>/dev/null | grep -q IsViewable; then
      log "OK: visible window ($w, pid $MP)"; exit 0
    fi
  done
done
if [[ -z $(main_pids) ]]; then
  die "TiinyOS quit right after startup. Details: $APPLOG"
fi
warn "TiinyOS is running but no window is visible after 40s. Details: $LOG"
exit 1
