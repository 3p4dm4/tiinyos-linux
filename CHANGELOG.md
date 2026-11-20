# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/): the minor number grows with new
features, the patch number with fixes. The current version is in `VERSION`.

Every pull request that changes code adds a line under **Unreleased** (CI checks it).

## [Unreleased]

## [0.4.0] — 2026-11-20

Device care: the Performance window becomes the **Device** window, with an engine that keeps the
Pocket's models in memory across power cuts and updates them safely. First version of the tool
framework: every tool also runs standalone, and other people can add tools.

### Added
- **Device window** (tray › Device, or the "Tiiny Device" desktop entry): four tabs.
  - *Status*: live CPU/RAM/NPU/disk, what is in memory and answering right now, running tasks,
    the activity log (7 days, kept on this PC), benchmark runs, and the **Connection check** —
    for each of the 14 device names the app uses, where it resolves and whether it answers, with
    the exact `/etc/hosts` line to add for the names that are missing (no key is sent).
  - *Models*: in memory and installed on the device, release dates, **Update** and **Update all**
    with a confirmation that lists the steps (unload, delete, download, reload).
  - *Usage*: tokens per day and per model for any week, stacked chart with a table twin, totals
    per app ("API clients" = requests without the app's `X-App-Id`, such as agents).
  - *Power*: the device's power-on-after-a-cut setting, which models to reload after an outage
    (nothing / the ones marked Keep loaded / everything that was in memory), restore progress
    and the outages seen from this PC.
  - A strip on every tab: device reach, the request in flight and the running task.
- **Device care engine** (`src/m3_care.js`, `m3_care_store.js`, `m3_models.js`): polls every 5 s;
  an outage (no answer for more than 15 s, then an answer) is recorded with what was in memory
  before and what came back by itself, then the missing models are reloaded one at a time per
  policy — a model that no longer fits is reported, nothing is ever unloaded to make room.
  Updates are journaled before each step and resume after a power cut or an app restart. State
  lives in `~/.config/tiinyos-linux/` (atomic writes). While a restore or update runs, the tray
  tooltip and the Floating Ball dot show it.
- **Standalone tools**: `standalone/launch.sh <tool>` (and `--list`) runs a tool without the
  TiinyOS app, from the same source, reusing the clone's Electron; one instance per tool. The
  engine takes `~/.config/tiinyos-linux/engine.lock`, so when the app and the standalone window
  both run, only one of them restores and updates.
- **Tool framework**: a manifest per tool (`src/<id>.tool.json`, schema in `docs/framework/`)
  checked by `tests/test_manifests.py` against the schema, `install.sh`, the tray patch, the
  standalone registry and the IPC handlers; `CONTRIBUTING.md`, `docs/framework/MANIFEST.md`,
  `docs/framework/RISKS.md`; the example tool `examples/hello/` (not installed).
- **Tests without a device**: a fake Tiiny Pocket (`tests/fake_pocket.py`, scenarios for slow
  loads, a full NPU, power cuts and updates; `TIINY_BASE` points the client at it), a control
  driver for power cuts mid-test, node suites for engine, UI helpers and window, and an
  end-to-end run (`tests/e2e/run_e2e.sh`): fresh clone → `install.sh` → the shipped bundle in a
  real Electron against the fake → `--uninstall` restores the pristine bundle byte for byte.
- `VERSION` file and this changelog; `install.sh` and `update.sh` print the version
  (`update.sh` shows `old → new`). Releases are tagged `vX.Y.Z` on GitHub.

### Changed
- Tray item "Performance" is now "Device"; the benchmark stays (Status and Models).
- `install.sh --uninstall` keeps your settings in `~/.config/tiinyos-linux`; the new `--purge`
  also removes them.
- `install.sh` ships the engine, lock and connection-check modules and checks all of them, the
  benchmark included, in the repacked bundle.

### Fixed
- The preload bridge passed `invoke` on any IPC channel; it now allows only `m3:*`, both ways.
- README and `build_clone.sh` asked for two device names in `/etc/hosts`; the app uses 14
  (`docs/network.md`). The README also described a `:8080` rewrite that does not exist.

## [0.3.0] — 2026-11-19

### Added
- **Linux PC service in Rust** (`pcsvr-rs/`): the local service the app needs to see the
  device, which Tiiny ships only for Windows. One ~640 KB binary, std only, a cap on every
  resource, leak test in CI; device identity read from the device itself (#10).
- Fresh README screenshots (#13).

### Changed
- `install.sh` builds and installs the PC service (needs `cargo`) and retires the old
  `pcsvr-watchdog` timer (#10).
- On Linux only the Floating Ball itself takes clicks: its window is shaped to the ball,
  so the transparent area around it no longer blocks the windows below; the activity dot
  sits on the ball (#12).

### Fixed
- The PC service never logs request bodies: the app posts the device auth key on every
  reconnect, and it ended up in the log (#14).
- Docs: the thread leak was in our own Python shim, not in Tiiny's code (#9); device.json
  fields checked on a real device (#11); README rewritten for readers (#8); remaining Italian
  copy translated (#7).

## [0.2.0] — 2026-11-18

### Added
- `update.sh`: one-command update of an installed clone (#3).
- Performance window: disk card, NPU temperature/power, model store grouped by category (#2).
- Activity indicator: device busy state in the tray tooltip and on the Floating Ball (#5).

### Fixed
- Performance window in one language (English), light theme via the OS setting, one card
  row, token-based pill colours (#2, #4).

## [0.1.0] — 2026-11-17

### Added
- Feature pack for the official TiinyOS app on Linux: Performance window (live device
  metrics, capability-aware benchmark) and Control Panel window, both in the tray menu;
  reversible `install.sh` (pristine `app.asar.orig`, `--uninstall`).
- `build_clone.sh` to fetch the official bundle and Electron.
- Desktop launcher with pre-flight checks; documentation (AGENTS, troubleshooting, test report).
- CI quality gate: shell/Python/JS syntax, patch-tool fixture tests, secrets scan.

### Fixed
- Floating Ball dead on Linux (click-through, blur-hide), kept out of the taskbar; dock icon;
  the Control Panel no longer opens the browser (#1).

[Unreleased]: https://github.com/3p4dm4/tiinyos-linux/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/3p4dm4/tiinyos-linux/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/3p4dm4/tiinyos-linux/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/3p4dm4/tiinyos-linux/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/3p4dm4/tiinyos-linux/releases/tag/v0.1.0
