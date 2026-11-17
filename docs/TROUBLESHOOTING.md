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

Known vendor thread leak in the `pcsvr` shim. Confirm:
`awk '/Threads/{print $2}' /proc/$(pgrep -xf 'python3 ./pcsvr -f pcsvr-api.yaml')/status`
— hundreds and climbing is it. Fix: enable the shipped watchdog, see
[vendor-thread-leak.md](vendor-thread-leak.md).

## Device features stop working while the app stays open

The shim can die functionally (fd exhaustion: process alive, port 60000
silent). The watchdog restarts it within 5 min; by hand:
`pkill -xf 'python3 ./pcsvr -f pcsvr-api.yaml'` and restart the app (it
relaunches the shim).

## `Could not load the "sharp" module` / `Desktop integration detect failed`

Upstream warnings, non-fatal. Ignore.

## `--no-sandbox` errors when launching manually

The bundle currently requires `--no-sandbox` on Linux; `run.sh` already
passes it. If you launch `electron/tiinyos` yourself, include it.

## Feature windows missing (no Performance / Control Panel in tray)

The feature pack is not applied to the clone you are running — you are
pointing at the pristine bundle or another clone. Rerun `./install.sh
--clone-dir <your clone>` and check `[tiinyos-linux] verify: header OK`.
