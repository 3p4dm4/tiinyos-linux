# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/): the minor number grows with new
features, the patch number with fixes. The current version is in `VERSION`.

Every pull request that changes code adds a line under **Unreleased** (CI checks it).

## [Unreleased]

### Added
- Device window design and engine/UI contract (`docs/design/`) for 0.4.0 Device care.
- `VERSION` file and this changelog; `install.sh` and `update.sh` print the version
  (`update.sh` shows `old → new`). Releases are tagged `vX.Y.Z` on GitHub.

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

[Unreleased]: https://github.com/3p4dm4/tiinyos-linux/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/3p4dm4/tiinyos-linux/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/3p4dm4/tiinyos-linux/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/3p4dm4/tiinyos-linux/releases/tag/v0.1.0
