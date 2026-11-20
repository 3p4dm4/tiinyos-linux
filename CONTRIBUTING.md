# Contributing a tool to TiinyOS on Linux

A **tool** is a window the feature pack adds to the official TiinyOS app: a
main-process module (`src/m3_<id>.js`), a renderer page (`src/<id>.html` + CSS
+ `src/m3<id>/*.js`), a set of IPC channels under one prefix, and a manifest
(`src/<id>.tool.json`, format in [docs/framework/MANIFEST.md](docs/framework/MANIFEST.md)).
The risks a second tool brings, and what the framework does about them, are in
[docs/framework/RISKS.md](docs/framework/RISKS.md).

Every tool runs in two ways and must work in both:

- **inside TiinyOS**: opened from the tray menu (`tools/patch_main.py` injects
  the item into the vendor bundle, `install.sh` copies your files into the
  asar), using the app's Electron;
- **standalone**: `standalone/launch.sh <id>` opens the same module in its own
  Electron process, without the TiinyOS app, reusing the clone's Electron
  binary (see [standalone/README.md](standalone/README.md)).

Read [AGENTS.md](AGENTS.md) first: vendor code is read-only except through the
anchor-based patch tools, everything `install.sh` adds must be removed by
`--uninstall`, and the build → install → launch → uninstall chain stays
testable end to end.

## 1. Before you start

```bash
git clone https://github.com/3p4dm4/tiinyos-linux && cd tiinyos-linux
./build_clone.sh --dest /tmp/t                 # official bundle + Electron, once (~1 GB)
python3 -m unittest discover -s tests -v       # patch-tool fixtures, fake device, manifests
node --test tests/js/*.test.js                 # node suites (they spawn the fake device)
```

You do not need a Tiiny Pocket to develop a tool: `tests/fake_pocket.py` is a
scriptable fake device on loopback (its docstring lists the endpoints and
scenarios) and the env var `TIINY_BASE` points `src/m3_device.js` at it.

The example tool [`examples/hello/`](examples/hello/README.md) is the smallest
tool that goes through every step below: manifest, module with an injectable
`wire(ipc)`, one IPC prefix, a page on the shared tokens and a node test against
the fake device. It is not installed; copy it into `src/` to start your own.

## 2. Add a tool, end to end

1. **Pick an id**: lowercase, `^[a-z][a-z0-9-]{1,23}$`. It names everything:
   `src/m3_<id>.js`, `src/<id>.html`, `src/m3<id>/`, the manifest
   `src/<id>.tool.json`, the IPC prefix `m3:<id>`, the standalone profile
   `~/.config/tiinyos-linux/standalone-<id>`.
2. **Scaffold**: copy `examples/hello/` into `src/` and rename (its README lists the steps).
3. **Write the manifest** `src/<id>.tool.json` and validate it:
   `python3 -m unittest tests.test_manifests`.
4. **Main module** (`src/m3_<id>.js`): export `open()`; see section 3 for
   `wire` and the rules. Register every handler under `m3:<id>:`. Device I/O
   only through the shared modules (section 5).
5. **Renderer** (`src/<id>.html`, `src/<id>.css`, `src/m3<id>/*.js`): plain
   HTML/CSS/JS, no bundler, no framework, the CSP of `src/performance.html`
   (`connect-src 'none'`: the page never talks to the device, only to main via
   `window.m3.invoke`). Follow section 7.
6. **Standalone**: set `standalone.enabled: true` with the window geometry in
   the manifest and add your id to `standalone/tools.json`. Run
   `standalone/launch.sh <id>`; `standalone/launch.sh --list` shows what the
   launcher sees.
7. **TiinyOS hooks**: add the tray item in `tools/patch_main.py` by extending
   `PATCH` with
   `{label:"<title>",click:()=>{try{require("./m3_<id>").open()}catch(e){console.error("[M3] <id>:",e)}}}`
   and extend the idempotency ladder (the marker is the require path, never
   the label). Add the fixture test in `tests/test_patches.py` (see
   `TestPatchMain`). Declare the same label in `hooks.tray` of the manifest; CI
   checks the two agree. Floating Ball and tooltip contributions are declared
   in the manifest only (`hooks.activity`); `src/m3_activity.js` stays the
   single classifier.
8. **install.sh**: add each main file to the `cp` line that targets
   `"$UNP/out/main/"` as `"$HERE"/src/<file>`, page and CSS to the
   `out/renderer/` line, your renderer dir as a `rm -rf` + `cp -r
   "$HERE/src/<dir>"` pair, and every main file to the header-verify list.
   CI greps for exactly those spellings. Nothing else: no new asar folders, no
   vendor file edits, no new desktop entries unless `--uninstall` removes them.
9. **Tests, CHANGELOG, PR** (sections 6, 8, 9).

## 3. Main-module rules

- **No Electron at module top level** when the module has logic worth testing
  under bare node. Require it inside `open()` / `wire()` (`src/m3_care.js`:
  "lazy on purpose"). Pure helpers go to a separate file with no Electron at
  all (`src/m3_models.js`, `src/m3_care_store.js`, `src/m3_lock.js`).
- `wire(ipc)` should take an optional `ipcMain`-like object
  (`{ handle(name, fn), removeHandler(name) }`) so tests register handlers with
  a stub; when omitted it requires Electron. Do not call `wire()` at load in
  new tools. Today `src/m3_performance.js` does wire at load and its tests stub
  the whole `electron` module through `Module._load`; existing modules migrate
  when touched.
- `open()` is idempotent: if the window exists, `show()` + `focus()` and
  return. Windows: `contextIsolation: true`, `nodeIntegration: false`,
  `preload: path.join(__dirname, 'm3_preload.js')`, `setMenu(null)`,
  `backgroundColor` equal to the page's `--bg` token. The page path must
  resolve in both places the module can live: `out/renderer/<page>` in the
  bundle, next to the module in `src/` (see `htmlPath()` in
  `src/m3_performance.js`).
- Push events: keep the window reference the module needs inside `open()` and
  check `!win.isDestroyed()` before every `webContents.send` (the Device
  engine does this in `pushIfChanged`).
- **The auth key never reaches the renderer.** It is read in main from
  `~/.local/tiiny/config.json` by `m3_device.authKey()` and sent only as a
  header. Never return it, log it or put it in an event payload (the PC
  service leaked it once by logging request bodies; fixed in 0.3.0).
- Long jobs: fire-and-forget handler, progress through a push event, state
  kept in the module and exposed by a state handler so a window that opens
  mid-job catches up (Device: `m3:device:update` returns a `taskId`, progress
  travels in `m3:device:changed`, `m3:device:stopTask` stops it). Anything
  that must run in one process at a time takes a lock file through `m3_lock`
  (section 5) and declares it in `background.locks`.
- Timeouts on every device call (`jget` 8 s, `jpost` / `jdelete` 60 s
  defaults). A cold model load can take minutes: `ensureLoaded` posts `start`
  with 180 s and polls up to 15 minutes by default; pass your own
  `timeoutMs` when that is wrong for you.
- State on the PC is written atomically (tmp file + rename,
  `src/m3_care_store.js`) under `~/.config/…`, declared in `background.state`.
  Never in the repo, never in the clone.
- English or Italian inside one file, never mixed (AGENTS.md "Style"). English
  for anything the user sees.

## 4. IPC naming

- Request/response: `ipcMain.handle('m3:<id>:<verb>', …)`, called from the
  page as `window.m3.invoke('m3:<id>:<verb>', arg)`. One plain-JSON argument
  object, plain-JSON return. Errors: `throw new Error('<readable sentence>')`;
  the renderer shows `e.message`.
- Push: `webContents.send('m3:<id>:<event>', payload)`, received with
  `window.m3.on('m3:<id>:<event>', cb)`; `on` returns an unsubscribe function.
- The preload (`src/m3_preload.js`) lets through only channels starting with
  `m3:`, both ways: `invoke` returns a rejected promise and `on` throws for any
  other channel. One rule for all tools; there is no per-tool allow-list.
- The prefix is unique and declared in the manifest (`ipc.prefix`). CI checks
  that every `….handle('m3:…')` literal in your main files (on `ipcMain` or an
  injected `ipc`) starts with it or is listed in `ipc.legacy`.
- Times are epoch milliseconds; the renderer formats them
  (`docs/design/device-contract.md`).

## 5. Shared modules

Framework files in `src/` that every tool may require. They are not listed in
any manifest's `main.files`. A change to their exported signatures is a
framework change: it goes in the CHANGELOG and moves `VERSION`. *Internal*
means a tool must not depend on it.

| module | export | signature | status |
|---|---|---|---|
| `m3_device` | `BASE`, `P8800` | base URLs; `TIINY_BASE` overrides both | shared |
| | `jget(url, timeoutMs=8000)` | GET → JSON, throws `HTTP <status> <url>` | shared |
| | `jpost(url, body, timeoutMs=60000)` | POST JSON → JSON | shared |
| | `jdelete(url, timeoutMs=60000)` | DELETE → JSON | shared |
| | `authKey()` | reads the key from disk | internal: main process only, never across IPC |
| `m3_models` | `mpath(id)` | percent-encode each segment of `owner/name`, keep the `/` | shared |
| | `shortName(id)` | `owner/name` → `name` | shared |
| | `runningIds()` | `Set` of ids in memory (`GET /v1/models`) | shared |
| | `fitPlan(id)` | `{id, fits, evicts, npuRequired, npuAvailable}` from `unload_candidate`; normalises the device and fake shapes | shared |
| | `ensureLoaded(id, onProgress, {timeoutMs, pollMs})` | start + poll until in memory; throws on refusal or timeout | shared |
| | `ensureUnloaded(id, onProgress, {timeoutMs, pollMs})` | stop + poll until gone | shared |
| | `unload(id)` | `POST …/stop`, fire and forget | shared |
| `m3_lock` | `acquire(path, {staleMs, tool})` → `{ok, holder, stale}` | exclusive-create lock file `{pid, startedAt, host, tool}`; stale when the pid is dead, older than `staleMs`, or unreadable for more than 5 s; re-acquire by the owner is idempotent | shared |
| | `release(path)` → `{ok, holder}` | only the owning pid may remove it | shared |
| | `holder(path)`, `isStale(path, {staleMs})`, `pidAlive(pid)`, `DEFAULT_PATH` | diagnostics; default path `~/.config/tiinyos-linux/engine.lock` | shared |
| `m3_activity` | `classify({util, models, loadedCount})` → `{label, busy}` | pure state decider for the tray and Floating Ball | shared |
| | `start(tray)`, `shortName`, `_tick` | the poller wired by `tools/patch_activity.py` | internal |
| `m3_care` | `state()`, `currentTask()`, `logEvent(…)`, `start()`, `wire(win)`, … | the Device engine | internal to Device |
| `m3_preload` | `window.m3.invoke(ch, ...args)`, `window.m3.on(ch, cb)` → unsubscribe | renderer bridge, shared by all tools | shared |

Rules of use: a tool that loads a model calls `fitPlan` first and shows the
user what would be evicted before `ensureLoaded`. A tool never unloads a model
it did not load without asking. `evicts` is `false` in every manifest.

## 6. Testing against the fake device

Node suites live in `tests/js/*.test.js` (`node:test`, no dependencies) and
run in CI after the Python step. The pattern (`tests/js/models.test.js`):

1. a temp `HOME` with `.local/tiiny/config.json` =
   `{"account":{"authKey":"<dummy>"}}`: the fake answers 401 without a Bearer
   header;
2. spawn `python3 tests/fake_pocket.py --port 0 --scenario <normal|slow_load|npu_full|power_cut|update_available> --speed 50`
   and read `LISTENING <port>` from its stdout. For runtime control (power
   cut, restore, scenario switch, ground truth) spawn `tests/fake_pocket_ctl.py`
   instead and send one JSON command per line on its stdin;
3. set `process.env.TIINY_BASE = 'http://127.0.0.1:<port>'` and `HOME`, then
   **re-require** `m3_device.js` and your module fresh: both capture their env
   at load;
4. register the handlers with a stub `ipc` and invoke them directly; assert on
   the JSON shapes and on **what the fake did** (`{"op":"state"}` on the
   control channel);
5. kill the children in `after()`.

Hard rule: **no test contacts the real device**, ever. A test that must stay
offline sets `TIINY_BASE` to a loopback port nothing listens on
(`tests/js/care_lock.test.js`). The fake's `normal` scenario has a model in
memory; `npu_full` holds three models at 95 %.

Patch tools are tested on fixtures, never on the vendor bundle
(`tests/test_patches.py`): apply once, idempotent, fail loudly on drift.

End to end: `tests/e2e/run_e2e.sh` builds a fresh clone from the CDN, runs
`install.sh` on it, boots the *shipped* asar in the clone's own Electron
(under `xvfb-run`) against the fake device, drives every Device flow through
the real preload bridge, then checks that `--uninstall` restores the pristine
asar byte for byte. It needs network for the first clone and a few minutes;
`--reuse` keeps a built clone.

## 7. UI rules

The pages are plain HTML/CSS with the OS theme. `src/performance.css` is the
reference: tokens on `:root`, light as the base, dark via the OS preference or
a manual `data-theme` toggle. A new tool's CSS uses the same token names and
values. Design decisions follow the rules listed at the end of
[docs/design/device-design.md](docs/design/device-design.md) (`color-*`,
`type-*`, `table-*`, `state-*`, `dialog-*`, `motion-*`, `slop-*`); the Device
window shows them applied. In short:

- **Tokens, never raw colours**: `--bg --surface --surface-2 --line
  --line-strong --text --muted --accent --accent-ink --ok --warn --bad`, plus
  `--series-1…8` for data series, in both themes. Semantic colour only
  (accent, severity); status is never colour alone: glyph + word.
- **Contrast**: text at least 4.5:1, borders and controls at least 3:1 against
  their background, in both themes.
- **Type scale** `--fs-1…5` = 12/13/14/16/20 px, labels never below 12;
  numbers tabular and right-aligned in tables; row height `--row-h` = 36 px.
- **English, en formats**: `16.5 GB`, `1,102`, `2026-11-19`, 24-hour times.
  No emoji, no hype copy, no uppercase eyebrows.
- **States**: every live number has loading (reserved height, `—`), error
  (real HTTP status + next step in place) and empty copy; show `last read
  hh:mm:ss` next to polled data; pending buttons keep their label, `aria-busy`,
  disabled; no looping animation as a loading signal.
- **Controls**: `<button type="button">`, labels bound to fields, targets at
  least `--target` = 24 px, native `<dialog>` with Escape = cancel and focus
  return to the opener.
- **Window**: `backgroundColor` = `--bg` of the current theme; `setMenu(null)`;
  min size in the manifest; nothing may need a horizontal scroll at `minWidth`.
- CSP as in `src/performance.html`: `default-src 'none'`, scripts and styles
  from `'self'` and `file:` only, no inline scripts or `style=""` attributes,
  no remote resources, `connect-src 'none'`.

## 8. CHANGELOG, versions, CI

- Every PR that touches `src/`, `tools/`, `pcsvr-rs/`, `standalone/`,
  `install.sh`, `update.sh`, `build_clone.sh` or `fetch_control_panel.sh` adds
  a line under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog); CI
  fails otherwise.
- The framework version is `VERSION` (semver, releases tagged `vX.Y.Z`). Your
  tool has its own `version` in the manifest and states `minFramework`; 0.4.0
  is the first framework version with manifests.
- CI gates (`.github/workflows/ci.yml`), run them locally first:
  `bash -n` on each shell script it lists; `python3 -m py_compile tools/*.py
  tests/*.py`; `python3 -m unittest discover -s tests -v`; `node --check` on
  every `.js` in `src/`, `standalone/` and `examples/hello/` (not in
  `src/<dir>/`); `cargo clippy` + `cargo test` in `pcsvr-rs/`;
  `node --test tests/js/*.test.js examples/hello/hello.test.js`;
  `bash tools/check_secrets.sh` (fail-closed: 32-hex tokens, `TNYM…` serials,
  JWT-like tokens, private key blocks, credentials in URLs; findings are
  reported as file:line, the content is never echoed).
- `main` is protected and this workflow is the required check.

## 9. Review checklist (maintainers tick, contributors pre-check)

- [ ] Manifest validates; id and `ipc.prefix` unique; every listed file exists
      and is copied by `install.sh`; main files in the header-verify list;
      `minFramework <= VERSION`.
- [ ] `install.sh --uninstall` still restores the pristine asar
      byte-identically; no new file outside `out/main/` and `out/renderer/`.
- [ ] Patch tools: new anchors unique, idempotent, fixture tests for apply,
      re-apply and drift; the tray label in the manifest matches the patch.
- [ ] No Electron at the top level of testable modules; `wire()` not called at
      load; `open()` idempotent and resolving its page in bundle and repo.
- [ ] All channels under the prefix (or in `ipc.legacy`); no auth key or
      device serial in any return value, event or log line.
- [ ] Model loads go through `fitPlan` → user confirmation → `ensureLoaded`;
      nothing evicted silently; `background.poller` interval at least 5 s and
      justified.
- [ ] Node tests against the fake for every handler that touches the device;
      offline tests point `TIINY_BASE` at a dead loopback port; Python tests
      for any fake-device change.
- [ ] Standalone: `launch.sh <id>` opens the window from a clean farm; works
      from a second checkout (farm re-pointed, stderr line names the checkout).
- [ ] UI: tokens only, both themes, en formats, states (loading, error, empty,
      last read), CSP unchanged, no horizontal scroll at `minWidth`.
- [ ] CHANGELOG line; README table row if user-facing; `docs/` updated when a
      device fact changed, marked verified on device or assumed.
- [ ] CI green; secrets scan clean.

## 10. Never commit

- The vendor bundle or anything derived from it: `app.asar*`, `app-unpacked/`,
  Electron binaries, clone directories (AGENTS.md, `.gitignore`).
- Keys and identities: the device auth key (`~/.local/tiiny/config.json`),
  device serials (`TNYM…`), a `pcsvr-api.yaml` with a real uuid, `~/.env*`,
  tokens of any kind. The scan is fail-closed and never echoes content.
- Personal device data: `~/.config/tiinyos-linux/*` (care state, journal,
  log, standalone profiles), usage statistics, screenshots with a real serial
  or key visible, logs from `~/.local/tiinyos-clone/logs/`.
- Test residue: real home paths in fixtures, lock files, `__pycache__`,
  `node_modules`.
