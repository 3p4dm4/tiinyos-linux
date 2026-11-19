# AGENTS.md — working rules for AI agents in this repo

## What this repo is

Feature pack that patches the official TiinyOS Electron bundle to run on Linux
with two added windows (Performance, embedded Control Panel) plus the Linux
PC service (`pcsvr-rs/`, Rust) the app needs to see the device. There is **no proprietary code here**: the bundle is downloaded at
build time by `build_clone.sh`. Keep it that way — never commit bundle
artifacts, `app.asar*`, Electron binaries, or anything under a clone dir.

## Hard constraints

1. **Vendor code is read-only except one file.** The only permitted edit to
   the minified vendor bundle is `tools/patch_main.py` (idempotent, marker
   based: `M3-PERF` / `M3-CP`). New features ship as new files under `src/`
   injected by the patch. Never rewrite vendor sources, never reformat the
   minified bundle.
2. **Reversibility.** Anything `install.sh` adds must be removed by
   `install.sh --uninstall`. If you add a step, extend both paths.
3. **The chain must stay testable end to end** (it has been, see
   `docs/TEST_REPORT.md`): `build_clone.sh` → `install.sh` → app starts →
   `--uninstall` restores the pristine bundle byte-identically.

## How to test changes without touching a real install

```bash
./build_clone.sh --dest /tmp/t            # fresh clone from CDN
HOME=/tmp/thome ASAR_BIN=<asar> ./install.sh --clone-dir /tmp/t
/tmp/t/electron/tiinyos --no-sandbox --ozone-platform=x11 \
    --user-data-dir=/tmp/tp /tmp/t/electron/resources/app.asar &
```

Rules learned the hard way:

* **Never operate on real user paths (`~/.config/TiinyOS`, the real clone) to
  prepare a test.** Use `--user-data-dir` / `--clone-dir` / a scratch `HOME`.
  A `cp -a SRC DEST` where DEST exists copies *inside* DEST — build profile
  copies into a non-existent path.
* A copied profile contains Electron's `SingletonLock`; delete `Singleton*`
  or the test instance quits itself.
* Two app instances cannot hold the device session at once — `/connect probe
  failed` in the second one is expected, not a defect.
* `pkill -f PATTERN` matches your own shell if PATTERN appears in the command
  you are running (twice burned). Use exact `pgrep -xf`, a PID file, or a
  split pattern.
* A live process is not a live service: health checks must probe the port and
  accept **any** HTTP response (the shim answers 404 on `/devices_list` even
  when healthy; `curl -sf` treats that as death and restart-loops a healthy
  service).
* **A rendered page is not a visible window.** `did-finish-load`, CDP
  `capturePage` and DevTools screenshots all succeed even when the window
  never appeared on screen. Prove visibility with the window manager
  (`xwininfo -id <win>` → IsViewable, `wmctrl -l`) or a compositor screenshot
  (`gnome-screenshot -f`). On GNOME/XWayland a crashed `mutter-x11-frames`
  silently breaks every new decorated X11 window while Electron keeps
  reporting `isVisible=true` (see TROUBLESHOOTING).

## Key files

| file | role |
|---|---|
| `build_clone.sh` | official NSIS bundle + upstream Electron → clean clone |
| `install.sh` | unpack pristine asar, inject `src/`, run patch, repack with correct unpacked/integrity flags, verify header, desktop entries, build + install `pcsvr-rs`, retire the old watchdog |
| `tools/patch_main.py` | tray menu entries (markers `M3-PERF`, `M3-CP`); idempotent |
| `tools/patch_ball_*.py`, `tools/patch_skip_taskbar.py` | Linux fixes for the Floating Ball / panels (click, blur-hide, taskbar via `wmctrl`); anchor-based, fail on bundle drift |
| `tools/launch.sh` | installed as `<clone>/launch.sh`, target of the desktop icon: pre-flight checks + "window really on screen" check |
| `tools/fix_unpacked.py` | restores unpacked/integrity flags lost by asar pack |
| `pcsvr-rs/`, `tools/build_pcsvr.sh` | the Linux PC service in Rust (std only) and its build/stage script; `cargo test` includes the 500-connection leak test |
| `src/` | feature files (main-process js, renderer html/css, `m3perf/`) |

## Docs map

* README — human entry point (install, how it works, limitations)
* `docs/network.md` — device USB-network setup
* `docs/pcsvr-thread-leak.md` — RCA of the leak in our old Linux shim + the Rust fix
* `docs/TROUBLESHOOTING.md` — symptom → cause → fix
* `docs/TEST_REPORT.md` — what "verified" means here, with evidence

## Style

Lean-first, one file one job, comments carry the *why* (measured numbers,
observed failure modes). Italian or English, not mixed inside one file.
Verify before claiming done: run what you changed, quote the output.
