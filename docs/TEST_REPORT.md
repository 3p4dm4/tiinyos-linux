# End-to-end test report — 2026-11-17

Full chain of this repository was exercised from scratch on a real desktop
Linux machine, exactly as a new community user would follow the README.

## Environment

| item | value |
|---|---|
| OS | SlimbookOS 24.0 (Ubuntu 24.04 base), GNOME 46 on Wayland/XWayland, x86_64 |
| device | Tiiny Pocket, USB-C, reachable via `/etc/hosts` entries |
| bundle | TiinyOS 1.0.3 (official CDN), Electron 37.4.0 linux-x64 |
| date | 2026-11-16 → 2026-11-17 |

## Steps executed and observed evidence

1. **`build_clone.sh`** (fresh `/tmp` dest, nothing pre-installed)
   - downloaded official NSIS bundle (132 MB) + Electron 37.4.0 (109 MB),
     extracted `app.asar` (160,398,743 bytes), wrote `run.sh`. Exit 0.
2. **`install.sh --clone-dir <dest>`**
   - `patch_main: applied (both items)`, `fix_unpacked: marked 228 entries,
     header 2339396 -> 2343044 bytes`, `verify: header OK`. Exit 0.
3. **First launch, virgin profile** (`--user-data-dir` isolated)
   - windows mapped by X: `TiinyOS` 800x600 (login), `Tray Panel` 380x516,
     `Chat` 1050x800, `Floating Ball` 462x300; login window renders the
     TiinyOS dark theme (pixel analysis of a window crop).
4. **Second launch, copied logged-in profile**
   - same four windows as the production instance; startup log shows
     `StartupVersionReport … "sn-ready","source":"authenticated-device-id"`.
   - note: Electron keeps a `SingletonLock` inside the profile — when cloning
     a profile of a *running* instance you must delete `Singleton*` first,
     otherwise the second copy quits itself (observed: `Early before-quit`).
5. **`install.sh --uninstall --clone-dir <dest>`**
   - `uninstalled: pristine app.asar restored`; restored file is
     **byte-identical** to `app.asar.orig` (`cmp` clean), archive listable
     with `asar list`, and the pristine app **launches again** (window up).
6. **Watchdog install path** (added 2026-11-17; watchdog retired 2026-11-19,
   replaced by `pcsvr-rs`): `install.sh` copies
   `tools/pcsvr-watchdog.sh` into the clone and writes the systemd units with
   `ExecStart` sed'ed to the actual clone dir (verified with a non-default
   `--clone-dir`); the uninstall step removes script and units (verified).
   The watchdog itself ran live for a day on the production clone: both
   branches observed firing — unresponsive-restart and
   `leak: pid=… threads=1714 > 1500 -> restart`, app reconnecting ~45 s later.
7. **Feature use over days on the production clone** (same artifacts):
   chat replies (~6 s on the device 35B model), Performance benchmark window
   with CSV export, embedded Control Panel from tray, device reconnect after
   shim restart.
8. **Launcher + window-frame recovery** (added 2026-11-17 evening): the
   desktop icon runs `<clone>/launch.sh`. Live on GNOME 46 / XWayland: icon →
   pre-flight checks pass → app starts → tray Control Panel and Performance
   confirmed on screen (`xwininfo` IsViewable, compositor screenshot), one
   dock entry with the Tiiny logo, Floating Ball carries
   `_NET_WM_STATE_SKIP_TASKBAR`, no stray browser tab. The recovery path was
   exercised on a real failure: `mutter-x11-frames` had crashed hours earlier
   (journal: "received an X Window System error"), every decorated X11 window
   created after that point — TiinyOS or `xlogo` — stayed frame-waiting; the
   launcher restarts the helper and the windows appear again
   (see TROUBLESHOOTING).

## Known non-defects observed during testing

- Two app instances cannot hold the device session at the same time: the
  second one logs `/connect probe failed` while the first is connected.
  This is the product's single-client design, not a defect of this repo.
- `sharp` native module warning at startup is upstream and non-fatal.
- `Desktop integration detect failed for KiloCode-Tiiny Manifest` warning is
  upstream and non-fatal.

## Verdict

README install path is verified end to end: **clone → install → run (login and
logged-in) → launcher → uninstall → pristine restored and runnable**. No step
required anything outside the documented toolchain.
