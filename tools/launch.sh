#!/usr/bin/env bash
# launch.sh — avvio "con controlli" di TiinyOS (clone M3) dal collegamento desktop.
#
# Installato da install.sh in <clone>/launch.sh; il collegamento desktop punta qui.
# Nato 2026-11-17 dall'RCA "finestre invisibili" (causa: helper GNOME
# mutter-x11-frames morto e mai rilanciato → finestre X con cornice mai mostrate).
#
# Cosa fa, in ordine:
#   1. lock anti doppio-clic
#   2. altra installazione TiinyOS già aperta (condividono ~/.config/TiinyOS →
#      una sola istanza: il nuovo avvio verrebbe "assorbito") → chiede se chiuderla
#   3. app.asar contiene davvero le patch (header asar) → altrimenti si ferma
#   4. sessione Wayland: helper cornici X (mutter-x11-frames) vivo → altrimenti lo rilancia
#   5. controlli non bloccanti: Pocket raggiungibile, /etc/hosts, Control Panel, watchdog
#   6. avvio staccato + verifica: entro 40s una finestra dell'app è davvero visibile
# Log: ~/.cache/tiinyos/launch.log (avvio) e ~/.cache/tiinyos/app.log (app).
set -uo pipefail

CLONE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RES="$CLONE/electron/resources"
LOGDIR="$HOME/.cache/tiinyos"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/launch.log"; APPLOG="$LOGDIR/app.log"
ICON="$RES/app-unpacked/out/renderer/tiiny-logo.png"
[[ -f "$LOG" && $(stat -c %s "$LOG") -gt 1000000 ]] && mv -f "$LOG" "$LOG.1"

log()  { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
note() { log "INFO $*"; notify-send -a TiinyOS -i "$ICON" "TiinyOS" "$*" 2>/dev/null || true; }
warn() { log "WARN $*"; notify-send -a TiinyOS -u normal -i "$ICON" "TiinyOS — attenzione" "$*" 2>/dev/null || true; }
die()  { log "FAIL $*"; notify-send -a TiinyOS -u critical -i "$ICON" "TiinyOS non avviato" "$*" 2>/dev/null || true
         command -v zenity >/dev/null && zenity --error --title="TiinyOS" --text="$*" --width=420 2>/dev/null; exit 1; }

# PID dei processi principali TiinyOS: si riconoscono dal BINARIO (/proc/PID/exe),
# mai dal testo della riga di comando — una shell che contiene la stringa
# "/electron/tiinyos" verrebbe scambiata per l'app (errore osservato 17/11).
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

log "==== avvio richiesto (pid $$)"

# 1. lock anti doppio-clic
exec 9>"$LOGDIR/launch.lock"
flock -n 9 || { log "altro avvio già in corso, esco"; exit 0; }

# 2. istanze già aperte
for p in $(main_pids); do
  exe=$(readlink "/proc/$p/exe" 2>/dev/null)
  if [[ $exe == "$CLONE/electron/tiinyos" ]]; then
    log "TiinyOS (M3) già aperto (pid $p): lo porto in primo piano"
    "$CLONE/run.sh" >>"$APPLOG" 2>&1 &   # l'istanza unica riceve second-instance e si mostra
    exit 0
  fi
  other=${exe%/electron/tiinyos}
  log "altra installazione aperta: pid $p da $other"
  if zenity --question --title="TiinyOS" --width=460 \
       --text="È già aperta un'altra versione di TiinyOS:\n<tt>$other</tt>\n\nLe due versioni non possono girare insieme. Chiuderla e avviare quella corretta (M3)?" 2>/dev/null; then
    kill "$p"; for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && die "Non riesco a chiudere l'altra versione (pid $p). Chiudila dal suo menu tray e riprova."
    log "chiusa pid $p"
  else
    log "utente ha annullato"; exit 0
  fi
done

# 3. le patch sono davvero nell'app?
python3 - "$RES/app.asar" >>"$LOG" 2>&1 <<'EOF' || die "L'app non contiene le funzioni M3 (Performance/Control Panel).
Reinstalla con:  ./install.sh --clone-dir $CLONE  (dal repo tiinyos-linux)"
import json, sys
d = open(sys.argv[1], "rb").read(1 << 23)
n = int.from_bytes(d[12:16], "little")
h = d[16:16 + n].decode()
miss = [f for f in ("performance.html", "m3_performance.js", "m3_cp.js") if f not in h]
if miss: print("asar check: mancano", miss); sys.exit(1)
print("asar check: ok")
EOF

# 4. helper cornici GNOME (RCA 17/11: se muore, le finestre X con cornice non compaiono mai)
if [[ ${XDG_SESSION_TYPE:-} == wayland ]] && pgrep -x Xwayland >/dev/null; then
  if ! pgrep -f '^/usr/libexec/mutter-x11-frames' >/dev/null && [[ -x /usr/libexec/mutter-x11-frames ]]; then
    XW=$(pgrep -x Xwayland | head -1)
    XA=$(tr '\0' '\n' <"/proc/$XW/cmdline" | grep -A1 -x -- '-auth' | tail -1)
    log "mutter-x11-frames assente: lo rilancio (auth $XA)"
    DISPLAY=${DISPLAY:-:0} XAUTHORITY=${XA:-${XAUTHORITY:-}} GDK_BACKEND=x11 \
      setsid /usr/libexec/mutter-x11-frames >>"$LOGDIR/mutter-x11-frames.log" 2>&1 </dev/null &
    sleep 1.5
    pgrep -f '^/usr/libexec/mutter-x11-frames' >/dev/null \
      && note "Riparato un componente di GNOME (cornici finestre) che si era fermato." \
      || warn "L'helper cornici di GNOME non riparte: le finestre Performance/Control Panel potrebbero non comparire. Rimedio sicuro: esci e rientra nella sessione."
  else
    log "mutter-x11-frames ok"
  fi
fi

# 5. controlli non bloccanti
DEV=$(getent hosts auth.api.tiiny | awk '{print $1}')
if [[ -z $DEV ]]; then
  warn "Manca la riga *.api.tiiny in /etc/hosts: l'app non troverà il Pocket."
elif ! timeout 2 bash -c "</dev/tcp/$DEV/80" 2>/dev/null; then
  warn "Pocket non raggiungibile ($DEV): controlla il cavo USB. L'app parte comunque."
else
  log "Pocket raggiungibile ($DEV)"
fi
export TIINY_CP_DIR="${TIINY_CP_DIR:-$HOME/.local/share/tiinyos-linux/control-panel}"   # stesso default di m3_cp.js
if timeout 2 bash -c '</dev/tcp/127.0.0.1/8765' 2>/dev/null; then log "Control Panel già attivo su :8765"
elif [[ -f ${TIINY_CP_DIR:-/nonexistent}/tiiny_ui.py ]]; then log "Control Panel spento: lo avvierà l'app da $TIINY_CP_DIR"
else warn "Control Panel non trovato in $TIINY_CP_DIR (./fetch_control_panel.sh): la finestra Control Panel non funzionerà."; fi
command -v wmctrl >/dev/null || warn "Manca wmctrl (sudo apt install wmctrl): la Floating Ball comparirà anche nella barra delle applicazioni."
systemctl --user is-active --quiet pcsvr-watchdog.timer || warn "Watchdog pcsvr non attivo (systemctl --user enable --now pcsvr-watchdog.timer)."

# 6. avvio staccato + verifica visibilità reale
[[ -f "$APPLOG" ]] && mv -f "$APPLOG" "$APPLOG.1"
cd "$CLONE" || die "cartella $CLONE mancante"
setsid "$CLONE/run.sh" >>"$APPLOG" 2>&1 </dev/null &
log "avviato run.sh (pid $!)"
flock -u 9

for _ in $(seq 1 40); do
  sleep 1
  MP=$(main_pids | head -1)
  [[ -z $MP ]] && continue
  for w in $(DISPLAY=${DISPLAY:-:0} wmctrl -lp 2>/dev/null | awk -v p="$MP" '$3==p{print $1}'); do
    if DISPLAY=${DISPLAY:-:0} xwininfo -id "$w" 2>/dev/null | grep -q IsViewable; then
      log "OK: finestra visibile ($w, pid $MP)"; exit 0
    fi
  done
done
if [[ -z $(main_pids) ]]; then
  die "TiinyOS si è chiuso subito dopo l'avvio. Dettagli: $APPLOG"
fi
warn "TiinyOS è avviato ma nessuna finestra risulta visibile dopo 40s. Dettagli: $LOG"
exit 1
