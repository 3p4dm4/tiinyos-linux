<div align="center">

[![CI](https://img.shields.io/github/actions/workflow/status/3p4dm4/tiinyos-linux/ci.yml?branch=main&label=CI)](https://github.com/3p4dm4/tiinyos-linux/actions)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey.svg)

</div>

<div align="center">
  <img src="docs/assets/performance-window.png" alt="TiinyOS on Linux — performance window" width="800"/>
</div>

# TiinyOS — Linux

Use your Tiiny Pocket from Linux — the official TiinyOS app, patched to run on Linux, plus extras the official app doesn't ship.

> **Not affiliated with Tiiny.** The official desktop app is macOS/Windows-only; this is an independent, community port.

## Quick start

```bash
# 1. Download the official bundle + Electron (one time, ~1 GB)
~/.local/tiinyos-clone/build_clone.sh

# 2. Point api.tiiny at your device — build_clone.sh prints the line for you
#    (login fails without it; see docs/network.md)
echo "<device-ip>  api.tiiny  models.api.tiiny" | sudo tee -a /etc/hosts

# 3. Fetch the community Control Panel (optional)
./fetch_control_panel.sh

# 4. Apply the feature pack to the clone
cd ~/.local/tiinyos-clone && ./install.sh

# 5. Launch
./launch.sh          # or the "TiinyOS" desktop icon
```

## Tested

The full chain (build → install → launch → uninstall → pristine restored
and runnable) was verified end to end on SlimbookOS 24.0 with a Tiiny Pocket
(2026-11-17) — see [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md) for the
step-by-step evidence.

What this port covers: login, chat, model manager, and the extras in the
table below. Pages of the official app not exercised by this port may still
have rough edges on Linux — open an issue with the log from
`~/.local/tiinyos-clone/logs/`.

## What you get

| Feature | What it does |
|---|---|
| **Performance window** | A live view of the device: RAM, storage, NPU state, model store, process footprint |
| **Control Panel** | The device's management pages (models, network, power) as a native window — no browser needed |
| **Floating Ball** | A draggable overlay with device status (RAM / NPU / models in memory); on Linux only the ball itself takes clicks, the transparent area around it lets them through |
| **Activity indicator** | Shows whether the Pocket is working — downloading, loading a model, generating, idle — on the Floating Ball and in the tray tooltip; [details below](#activity-indicator) |
| **Agent store** | Browse, install, and update AI agents straight from the Linux app |
| **Linux PC service** | `pcsvr`, the local service the app needs to see the device, which Tiiny ships only for Windows: ours is a small Rust binary (`pcsvr-rs/`) with a cap on every resource, built by `install.sh` — it replaced a Python shim that leaked threads, see [docs/pcsvr-thread-leak.md](docs/pcsvr-thread-leak.md) |

## Activity indicator

The official app does not show when the Pocket is busy. The indicator asks the
device every 5 seconds (read-only: NPU status, model store, models in memory)
and shows one state:

| state | when | Floating Ball | tray tooltip |
|---|---|---|---|
| Downloading | a model is being downloaded | orange dot, pulsing | `TiinyOS — Downloading <model> · 42%` |
| Loading | a model is being loaded into memory | orange dot, pulsing | `TiinyOS — Loading <model> · 70%` |
| Working | NPU utilization at 25% or more (generation, inference) | orange dot, pulsing | `TiinyOS — Working · NPU 63%` |
| Idle | device reachable, nothing of the above | green dot, only while the cursor is on the ball | `TiinyOS — Idle · 2 model(s) in memory` |
| Unreachable | the device does not answer | same as Idle (green dot on hover) — only the text tells them apart | `TiinyOS — Device unreachable` |

The dot sits on the top-right of the ball; hovering the ball shows the same
text as its tooltip. Code: `src/m3_activity.js` (the `classify()` function is
pure and decides the state), wired by `tools/patch_activity.py`.

## How it works

Everything is added by patching the Electron bundle locally (asar header
rewritten, anchor-based patches). `install.sh` keeps a pristine copy and
rolls back with one command:

```bash
./install.sh --uninstall
```

## Updating

When new work lands in this repo, update the installed clone with one
command:

```bash
cd <path-to>/tiinyos-linux      # this repo
./update.sh                 # git pull + re-apply install.sh + restart if running
./update.sh --dry-run       # show what would change (fetch only)
./update.sh --no-restart    # update files, keep the app as-is
```

It refuses to run on a dirty checkout or on a clone that was never
installed, and it does nothing when you are already up to date.
`install.sh` always regenerates `app.asar` from the pristine
`app.asar.orig`, so re-applying is idempotent. If you prefer doing it by
hand: `git pull && ./install.sh`.

## Network

The official client hard-codes `https://api.tiiny` / `models.api.tiiny`.
The port rewrites both to `http://api.tiiny:8080/v1` (see
[docs/network.md](docs/network.md) for the full picture, including the
`/etc/hosts` line and what happens if the device is on a different subnet).

## Uninstall

`./uninstall.sh` restores the pristine `app.asar`, removes the desktop
entries and the `/etc/hosts` shim line, and deletes the clone.

## Known issues

- **`install.sh` needs Rust (`cargo`)** to build the Linux PC service — get it
  from [rustup.rs](https://rustup.rs). Without it everything else installs, but
  the app may not see the device.
- **No uuid in `device.json`** — the service reads the serial (`serial_number`)
  and name from the device; a uuid is reported only if you set `Shim.Uuid` in
  `pcsvr-api.yaml`. The app identifies the device by its serial; see
  `pcsvr-rs/README.md`.
- **Crash on startup on some hardware** — Electron's VSync is unstable on a
  few GPUs; the launcher falls back to `--disable-gpu` automatically.
- **X11-only today** — Wayland users: run under X11 (or XWayland) for now.
- **Model downloads** — the device-side download manager is not part of this
  port; models are installed through the device's own tooling or the
  Control Panel.

## Agent store on Linux

The official store targets macOS/Windows binaries; on Linux some agents
install fine, others don't. [`docs/agent-store.md`](docs/agent-store.md)
lists what we measured and the workaround for each case.

## Launcher details

`launch.sh` (in the clone) starts Electron with a status tray and a crash
watchdog, and writes to `~/.local/tiinyos-clone/logs/launch.log`. The
desktop entry points at the same script, so icon and terminal behave
identically.

## For AI agents

If you're an agent working in this repo: read the README first, then
`docs/TEST_REPORT.md`. The canonical test flow is
`build_clone.sh → /etc/hosts → install.sh → launch.sh → verify →
uninstall.sh → re-launch pristine`. Don't guess at the vendor bundle;
verify against the live app with Electron DevTools or the CDP port.

## License

MIT for everything in this repository (see `LICENSE`). The official TiinyOS
bundle remains Tiiny's property — this repo only ships the patches.

---

*Independent community project. Not affiliated with, endorsed by, or
associated with Tiiny Inc.*
