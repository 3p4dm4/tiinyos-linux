# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/): the minor number grows with new
features, the patch number with fixes. The current version is in `VERSION`.

Every pull request that changes code adds a line under **Unreleased** (CI checks it).

## [Unreleased]

### Added
- **Connection check** (Device › Status › Connection, `src/m3_netcheck.js`): for each of the 14
  device names the app uses, where it resolves (`/etc/hosts` or DNS) and the HTTP answer of a
  plain `GET /` (no key sent), with one verdict and one remedy per name, and the exact
  `/etc/hosts` line for the names that are missing or point elsewhere, with a Copy button.
- **Tool manifests** (`src/<id>.tool.json`, schema `docs/framework/tool.schema.json`): each tool
  declares its files, IPC prefix, standalone window, tray hook, device endpoints and PC state;
  `tests/test_manifests.py` checks it against the schema, `install.sh`, `tools/patch_main.py`,
  the standalone registry and the IPC handlers in the code. First manifest: `device`.
  `standalone/tools.json` is now only the list of enabled tools (`{"tools": ["device"]}`); the
  launcher and host read title and module from the manifest.
- **Standalone launcher for every tool** (`standalone/`): `standalone/launch.sh <tool>`
  (plus `--list`) runs a TiinyOS tool as its own app without the TiinyOS app, from the same
  source — today **Device**. It builds a symlink farm around the clone's Electron and passes the
  tool via env; each tool is single-instance (its own name + userData before the lock). The
  Device window (`src/m3_performance.js`) now resolves its renderer html in both the bundle and
  the repo.
- **Cross-process engine lock** (`src/m3_lock.js`, pure Node): `acquire`/`release`/`holder` with a
  pid-ownership and staleness model, so the care engine runs in exactly one process; tested in
  `tests/js/m3_lock.test.js`.
- The care engine takes that lock (`engine.lock` next to its state files): when the TiinyOS app and
  the standalone Device window both run, only the lock holder restores models, runs updates and
  writes the log; the other window shows the same state, refuses updates with a message naming
  the holder, and takes over when the holder quits (`tests/js/care_lock.test.js`).
- **"Tiiny Device" desktop entry** (`install.sh`), pointing at the standalone launcher; removed on
  `--uninstall`.
- **Device care engine** (`src/m3_care.js`, `src/m3_care_store.js`, `src/m3_models.js`):
  the background engine behind the Device window. A 5 s poller tracks device reach;
  a power cut is recorded with what was in memory when the link dropped and what came
  back, then the kept models are reloaded per policy (`off` / `kept` / `all`) once the
  device is up again — the device boots with nothing in memory, so without this the
  models silently disappear. Updates are journal-driven (`unload → delete → download →
  reload`, journal written before each step) so they resume after a power cut or an
  app restart, one model at a time (`updateAll` queues); `ac_power` gates the eager
  behaviour; per-model and app usage and a 7-day activity log are exposed. State
  (`care.json`, `care-journal.json`, `care-log.jsonl`) lives under
  `~/.config/tiinyos-linux/` with atomic writes.
- The full `m3:device:*` IPC contract of `docs/design/device-contract.md` v0.4.0 on the
  Device window, plus one `m3:device:changed` push (at most one per second) carrying the
  CareState.
- The engine starts with the activity indicator — the one injection point every
  installed bundle has — so upgrading an existing install gets it without reopening
  the Device window; while a care task runs, the tray tooltip and the ball dot follow
  the task ("restoring…", "updating General 7B · step 3/4") instead of the raw signals.
- End-to-end test (`tests/e2e/run_e2e.sh`): fresh clone from the CDN → `install.sh` →
  the *shipped* asar runs inside a real Electron against the fake pocket and every
  flow is driven through the real preload bridge — reach, load/unload, policy/keep,
  restore after a power cut, an update that bumps the device version, a power cut
  mid-download that resumes from the journal, `updateAll`, fit refusal (the device's
  own "insufficient NPU" reaches the renderer), `ac_power`, usage, the log and the
  state files on disk — then `--uninstall` restores the pristine asar byte-identically.
- Fake-pocket control driver (`tests/fake_pocket_ctl.py`): cut and restore the device
  power and switch scenarios mid-test, so outage and resume paths are testable.
- Fake Tiiny Pocket for tests (`tests/fake_pocket.py`, stdlib only): a scriptable
  device on loopback with scenarios (normal, slow_load, npu_full, power_cut,
  update_available) and simulated time; `src/m3_device.js` base URL is now
  overridable with env `TIINY_BASE` so the JS client can be tested against it
  (Python + Node test suites).
- Device window design and engine/UI contract (`docs/design/`) for 0.4.0 Device care.
- `VERSION` file and this changelog; `install.sh` and `update.sh` print the version
  (`update.sh` shows `old → new`). Releases are tagged `vX.Y.Z` on GitHub.

### Changed
- Tray menu item "Performance" is now "Device", and the Performance window is now the Device
  window: four tabs (Status, Models, Usage, Power), a persistent strip with device reach, the
  running request and the running task, light and dark themes; every care view shows "not
  available" when the engine cannot answer. Benchmark stays in Status and Models.
- `install.sh --uninstall` keeps your settings in `~/.config/tiinyos-linux`; the new `--purge` also
  removes them (restore policy, kept models, activity log, update journal, standalone profiles).
- `install.sh` now ships the care-engine modules next to the window files, and
  `src/m3_device.js` gained a JSON `DELETE` verb (the update flow needs it).

### Fixed
- README and `build_clone.sh` asked for `api.tiiny models.api.tiiny` only; the app uses 14 names
  (`docs/network.md`), and the README described a `:8080` rewrite that does not exist.
- `install.sh` now also checks that `m3_bench.js` (the benchmark) made it into the repacked bundle.
- The preload bridge passed `invoke` on any IPC channel; it now allows only `m3:*`, both ways,
  and adds the `on` event subscription the Device window needs.

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
