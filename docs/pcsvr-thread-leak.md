# pcsvr thread leak in our Linux shim (and what this repo does about it)

**TL;DR** — TiinyOS talks to a local "PC service" (`pcsvr`) on port 60000.
Tiiny ships it natively for Windows (`pcsvr.exe`). On Linux this port uses a
small **Python shim written by us**, not by Tiiny: it leaks threads, file
descriptors and CPU while the desktop app keeps its websocket open. Left alone
it maxes out your fans. The repo ships a user-level watchdog
(`tools/pcsvr-watchdog.sh` + systemd timer) that restarts the shim before it
gets dangerous.

> **Correction (2026-11-19).** Earlier versions of this page called this a
> *vendor* bug and said the shim ships inside the official bundle. That was
> wrong: the official bundle is the Windows installer and contains no Linux
> shim. The leak is ours. Tiiny's native Windows `pcsvr.exe` does not show it
> (thread count stable at 21 on Windows 11, observed 2026-11-18).

## Known gap: the shim is not in this repo yet

The Python shim currently lives only on the machine where the port was
developed, with that device's identity written into it; `build_clone.sh` and
`install.sh` do not create `electron/resources/pcsvr/linux/`. A
self-contained replacement (Rust, no runtime dependencies, reads the device
identity from the device itself, leak-free by design) is in progress on the
`feat/pcsvr-rust` branch and will be installed by `install.sh`. Until then a
fresh install may not list the device in the app.

## Symptoms observed (2026-11-16, SlimbookOS 24.0 (Ubuntu 24.04 base), TiinyOS 1.0.3)

* load average `7091` on 20 cores, CPU ~10000%, package ~79 °C, fans 5600 RPM
* one process (`python3 ./pcsvr -f pcsvr-api.yaml`, our shim, started by the
  app from `resources/pcsvr/linux/`) holding **13,312 threads** after ~1.5 days
* `top` showing ~5000 python threads at ~13 % CPU each
* eventually the shim dies on its own (functional death at the ~1024 fd limit:
  `EMFILE` storms in `pcsvr-shim.log`, process alive, port 60000 silent)

## Measured behaviour

| condition | leak rate |
|---|---|
| app idle, websocket open | ~1 thread/min |
| app reconnecting the WS every ~30 s (e.g. after the shim was restarted) | **~50 thread/min** (~25 threads per connection, never released) |

Each leaked thread also holds one fd; at ~1024 fds the shim goes deaf while
still running — a *live process is not a live service*.

## Mitigation shipped here

`tools/pcsvr-watchdog.sh`, run every 5 minutes by a **user** systemd timer:

1. **serving check, not process check**: any HTTP response on
   `http://127.0.0.1:60000/devices_list` (even 404 — the app uses the `/ws`
   variant) proves the event loop is alive; only no-response means dead.
2. dead/unresponsive → start the shim with `ulimit -n 65536` (so the fd wall
   can't kill the service before the thread gate acts);
3. `Threads > 1500` (≈30 min at the fast rate, 1/9 of the lethal level)
   → kill and restart. The app reconnects within 30 s; the user sees nothing.

Log: `~/.cache/flowstate/pcsvr-watchdog.log`. Verified live:
`leak: pid=916177 threads=1714 > 1500 -> restart` followed by
`WS upgrade ok` from the app 45 s later.

## Enable it

`install.sh` copies the script to `$CLONE/tools/` and the units to
`~/.config/systemd/user/`. Enabling is deliberately manual:

```bash
systemctl --user daemon-reload && systemctl --user enable --now pcsvr-watchdog.timer
systemctl --user list-timers pcsvr-watchdog.timer   # next run
tail ~/.cache/flowstate/pcsvr-watchdog.log         # "ok pid=… threads=…"
```

Disable: `systemctl --user disable --now pcsvr-watchdog.timer`.

## Notes for the curious

* The unit needs `KillMode=process`: with the default, systemd sweeps the
  nohup'd shim when the oneshot unit exits (observed at bring-up).
* The script matches the shim with `pgrep -xf` (exact cmdline): a plain `-f`
  also matches bash wrappers and shells that quote the pattern.
* This is a workaround for a bug in our own shim. Once the Rust replacement
  ships, the watchdog never fires and can be disabled.
