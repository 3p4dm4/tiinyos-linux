# pcsvr thread leak in our old Linux shim (fixed by pcsvr-rs)

**TL;DR** — TiinyOS talks to a local "PC service" (`pcsvr`) on port 60000.
Tiiny ships it natively for Windows (`pcsvr.exe`). On Linux this port uses a
small **Python shim written by us**, not by Tiiny: it leaks threads, file
descriptors and CPU while the desktop app keeps its websocket open. Left alone
it maxes out your fans. **Fixed:** the shim is replaced by `pcsvr-rs/`, a Rust
service with a cap on every resource, built and installed by `install.sh`.
The user-level watchdog that used to restart the Python shim is retired.

> **Correction (2026-11-19).** Earlier versions of this page called this a
> *vendor* bug and said the shim ships inside the official bundle. That was
> wrong: the official bundle is the Windows installer and contains no Linux
> shim. The leak is ours. Tiiny's native Windows `pcsvr.exe` does not show it
> (thread count stable at 21 on Windows 11, observed 2026-11-18).

## The fix: pcsvr-rs

`pcsvr-rs/` (std only, no `unsafe`, one ~640 KB binary) reproduces the
contract the app uses and reads the device identity from the device itself
(`device.json`), so it works for any Pocket. Every connection thread has an
exit condition and every resource a cap (16 websockets, oldest closed first;
256 connection threads; size-capped log). Its leak test opens and drops 500
websockets and 500 HTTP connections and checks that threads and fds return
to baseline; it runs in CI. Details: [`pcsvr-rs/README.md`](../pcsvr-rs/README.md).

`install.sh` builds it (needs `cargo`), installs it at
`electron/resources/pcsvr/linux/pcsvr` where the app starts it, and keeps
the old shim as `pcsvr.before-install` for `--uninstall`.

## Upgrading a machine that ran the watchdog

`install.sh` disables and removes the `pcsvr-watchdog` timer and units. Then
stop the old shim so the app can start the new service:

```bash
pkill -xf 'python3 ./pcsvr -f pcsvr-api.yaml'
# restart the app, then:
curl -s localhost:60000/status
```

The sections below are the original diagnosis, kept as the record of why.

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

## How it was mitigated before the fix (retired 2026-11-19)

A user systemd timer ran `tools/pcsvr-watchdog.sh` every 5 minutes: any HTTP
answer on port 60000 counted as alive (a live process is not a live service),
no answer meant restart with `ulimit -n 65536`, and `Threads > 1500` meant
kill and restart. It kept machines usable — on the last night it still
restarted the shim at 1,724 threads — but it treated the symptom. It is no
longer shipped.
