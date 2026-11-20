# TiinyOS tools — standalone

Run a TiinyOS tool as its own app, **without opening the TiinyOS app**. Same
source as the feature pack (`../src`), same config, same device — so a window
you use standalone and the identical in-app window stay in sync. Inside
TiinyOS a tool only adds hooks (tray item, Floating Ball, tooltip); standalone
is the same tool with the app shell removed.

```bash
./launch.sh <tool>     # run one tool
./launch.sh --list     # list the available tools
```

Available tools today: **device** (the Device window). The tool lives in
[`tools.json`](tools.json).

## Launcher

`launch.sh <tool>` reuses the Electron binary from your TiinyOS clone
(`~/.local/tiinyos-clone/electron`) — no second download, no copies:

* **the cached symlink farm** lives in `~/.cache/tiiny-tools/electron`
  (or `$XDG_CACHE_HOME/tiiny-tools/electron`); `resources/app` is re-pointed
  at the checkout it is launched from on **every** launch, and a one-line
  stderr log says which checkout is running (otherwise the first checkout that
  ever ran would silently win).
* **why the farm exists** — the clone's Electron is a *packaged* build: it
  always loads the `resources/app` that sits next to its own binary and ignores
  any app path on argv. So we hard-link the binary, symlink the rest of the
  Electron dir, and repoint `resources/app` at this checkout.
* **the tool name is passed as the `TIINY_TOOL` env var, not an argv** — a
  packaged Electron ignores argv after the app path, so env is the channel
  that reliably survives to the host.

### Env vars

| var | meaning |
|---|---|
| `TIINY_ELECTRON_DIR` | where the clone's Electron lives (default `~/.local/tiinyos-clone/electron`) |
| `TIINY_TOOLS_FLAGS` | extra Chromium flags, e.g. `--disable-gpu` if your GPU crashes Electron at startup (off by default: software rendering paints the window black on this hardware) |
| `XDG_CACHE_HOME` | where the cached farm lives (default `~/.cache`) |
| `TIINY_TOOL` | set by the launcher; read by `main.js` — you don't set it yourself |

## Per-tool single instance

Each tool runs **at most once**: a second launch of the *same* tool restores
and focuses the existing window, then exits. Different tools run side by side.

This is done by giving each tool its own **name + userData *before* requesting
the single-instance lock**. Electron's `app.requestSingleInstanceLock()` places
its lock inside `app.getPath('userData')`, so the lock is keyed on that
directory (not argv): `main.js` sets `tiiny-<tool>` as the app name and
`~/.config/tiinyos-linux/standalone-<tool>` as userData *before* the call,
which is what lets Device and Music Lab standalone coexist while each stays
single. (The real Electron behaviour of this is not exercised in this repo's
tests — it needs a running Electron, and it is not verified yet.)

## How a tool registers

1. The tool has a manifest `src/<tool>.tool.json` (format:
   [`../docs/framework/MANIFEST.md`](../docs/framework/MANIFEST.md)) with
   `standalone.enabled: true`; the host reads `title` and `main.module` from it.
   The module must export `open()` that creates its window.
2. Add the tool id to [`tools.json`](tools.json): `{ "tools": ["device", "<tool>"] }`.
   A tool with a manifest but not listed here is work in progress and does not
   appear in the launcher.
3. That module must work outside the app: its own window, preload and renderer
   paths resolved from its location (the Device module resolves its html to
   either the bundle or the repo — see `src/m3_performance.js`).
4. Nothing else changes: the launcher, host, per-tool lock and (for the Device
   entry) the desktop icon are all generic. `tests/test_manifests.py` checks the
   manifest against the schema, the registry and the repo.

The engine that talks to the device runs in one process at a time: it takes
`~/.config/tiinyos-linux/engine.lock` ([`../src/m3_lock.js`](../src/m3_lock.js)),
so the TiinyOS app and the standalone Device window can run together.

## Requirements

The Pocket reachable on the network (`api.tiiny` resolves — same
`/etc/hosts` line as the main app, see [`../docs/network.md`](../docs/network.md))
and the Electron binary from `build_clone.sh`.
