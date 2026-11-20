# Troubleshooting

Symptoms we actually hit, with the cause and the fix.

## App window closes immediately on start

A previous instance is still running. Electron stores a `SingletonLock` in the
profile directory (`~/.config/TiinyOS`); a second instance defers to the first
and quits (`Early before-quit event` in the log). Check with
`pgrep -af tiinyos`, or — if you are deliberately running a second copy for
testing with a copied profile — delete `Singleton*` from the copy first.

## Log says `/connect probe failed` but the app is open

Another app instance already holds the device session: one device, one
client. Close the other instance. Not a bug of this feature pack.

## App does not see the device (login hangs, "offline")

Device name resolution is manual: the bundle resolves hostnames like
`auth.api.tiiny` via `/etc/hosts`. See [network.md](network.md) for the exact
lines, then `curl -s -m 3 http://auth.api.tiiny/` to confirm reachability.

## Fans go loud after hours/days of uptime, system slow

Thread leak of our old Python `pcsvr` shim (not Tiiny's code). Confirm:
`pgrep -xf 'python3 ./pcsvr -f pcsvr-api.yaml'` finds a process. Fix: re-run
`./install.sh` (installs the Rust service), stop the old shim with
`pkill -xf 'python3 ./pcsvr -f pcsvr-api.yaml'`, restart the app — see
[pcsvr-thread-leak.md](pcsvr-thread-leak.md).

## Device features stop working while the app stays open

Check the local service: `curl -s -m 3 localhost:60000/status` must answer
`{"ok": true, ...}`. No answer from the old Python shim is its fd exhaustion
(see above). No answer at all and no process: `launch.sh` warns when
`electron/resources/pcsvr/linux/pcsvr` is missing — re-run `./install.sh`.
The app restarts the service itself when nothing answers on port 60000.

## `Could not load the "sharp" module` / `Desktop integration detect failed`

Upstream warnings, non-fatal. Ignore.

## `--no-sandbox` errors when launching manually

The bundle currently requires `--no-sandbox` on Linux; `run.sh` already
passes it. If you launch `electron/tiinyos` yourself, include it.

## Feature windows missing (no Device / Control Panel in tray)

The feature pack is not applied to the clone you are running — you are
pointing at the pristine bundle or another clone. Rerun `./install.sh
--clone-dir <your clone>` and check `[tiinyos-linux] verify: header OK`.

## Windows show up in the dock / Activities but never on screen (GNOME, Wayland)

Device, Control Panel — in fact any X11 window with a native title bar
opened after a certain moment — get a dock entry but stay empty. Cause
(observed 2026-11-17, GNOME 46): `mutter-x11-frames`, the GNOME helper that
draws title bars for X11 windows, crashed (`journalctl --user -b | grep
mutter-x11-fram` shows "received an X Window System error") and mutter does
not restart it, so every new decorated X11 window waits forever for its frame
(`xprop -id <win> WM_STATE` = Iconic, `_MUTTER_NEEDS_FRAME` = 1). Frameless
windows (Chat, Floating Ball) are unaffected, which makes it look like an app
bug. `xlogo` reproduces it without TiinyOS.

Fix: start the app from the desktop icon / `launch.sh` — it restarts the
helper when missing. By hand:
`DISPLAY=:0 XAUTHORITY=<the -auth file of the Xwayland process> GDK_BACKEND=x11 setsid /usr/libexec/mutter-x11-frames &`.
Logging out and back in also restores it.

Note for testing: a CDP screenshot or `did-finish-load` does not prove a
window is visible (the page renders even when the window never appears);
check the window state (`xwininfo -id <win>` → IsViewable) or a compositor
screenshot (`gnome-screenshot -f out.png`).

## Clicks next to the Floating Ball do nothing / the activity dot is far from the ball

Older installs only (before 2026-11-19). The ball lives in a transparent
462x300 window; the old Linux fix kept the whole window clickable, so that
invisible rectangle swallowed clicks, and the activity dot sat in its corner.
Rerun `./install.sh`: on Linux the window is now shaped to the ball when idle
(`src/m3_ballshape.js`). Check: click right next to the ball — the window
below must react.

## Floating Ball listed as an extra, icon-less window in the taskbar

Electron 37 ignores `skipTaskbar` on Linux/X11 (option and setter alike —
`xprop -id <win> _NET_WM_STATE` never shows `_NET_WM_STATE_SKIP_TASKBAR`).
`tools/patch_skip_taskbar.py` sets it with `wmctrl` whenever the Floating
Ball, Tray Panel or mini window is shown: install `wmctrl` and rerun
`./install.sh`. A dock entry with a generic icon instead of the Tiiny logo
means an old desktop entry: rerun `./install.sh` (it now writes the right
`Icon=` and `StartupWMClass=tiinyos`).

## Control Panel opens in the web browser as well as in its window

Older installs only. The vendor bundle sends every navigation to a
non-vendor URL to the system browser; the panel's own redirect after
sign-in hit it. `src/m3_cp.js` now replaces that guard on the Control Panel
window (same-origin navigations allowed, nothing opened outside): rerun
`./install.sh`.
