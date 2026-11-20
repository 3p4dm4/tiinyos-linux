# Tool manifest (format 1, framework 0.4)

One JSON file per tool says what the tool is, which files it ships, which IPC
channels it owns, how it runs standalone, how it hooks into TiinyOS and what it
needs from the device. Schema: [`tool.schema.json`](tool.schema.json). The only
installed manifest today is the Device tool: [`src/device.tool.json`](../../src/device.tool.json);
the copy-me example is [`examples/hello/hello.tool.json`](../../examples/hello/hello.tool.json).

Framework 0.4.0 is the first version with manifests. The manifest is **not**
copied into the bundle and nothing inside TiinyOS reads it at runtime. Its
readers are repo tooling: the standalone launcher, the CI test
[`tests/test_manifests.py`](../../tests/test_manifests.py), and later
`patch_main.py` and `install.sh` generation (section 4).

## 1. Where it lives: `src/<id>.tool.json`

Every file of a tool stays in flat `src/`; the manifest sits next to the tool's
main module. There is no `src/tools/<id>/` tree. Reasons:

1. `install.sh` copies by explicit file name from `src/` into two bundle
   folders: main-process files to `out/main/`, pages and CSS to
   `out/renderer/`, renderer script folders to `out/renderer/<dir>`. The asar
   header check lists the same names. A manifest that lists exactly those names
   lets a later `install.sh` derive both lists with no path rewriting.
2. Modules require each other with flat relative paths inside the bundle
   (`require('./m3_device')`), and a page is resolved relative to the module
   (see `htmlPath()` in [`src/m3_performance.js`](../../src/m3_performance.js):
   `out/renderer/<page>` in the bundle, next to the module in the repo).
3. Discovery is a glob, `src/*.tool.json`. The file name must be
   `<id>.tool.json` (checked by CI).

[`standalone/tools.json`](../../standalone/tools.json) is the **registry of
enabled tool ids**: `{"tools": ["device"]}`. A tool with a manifest that is not
in the registry is work in progress and does not appear in the launcher. The
registry holds ids only; title, module and everything else come from the
manifest.

## 2. Fields

"Read by" says who uses the field in 0.4. *Declared* means the field is
validated by the schema and read by humans in review, but no code acts on it yet.

| field | type | required | meaning | read by (0.4) |
|---|---|---|---|---|
| `manifest` | const `1` | yes | format version of this file | all |
| `id` | `^[a-z][a-z0-9-]{1,23}$` | yes | tool id; file names and the IPC prefix derive from it | launcher, CI |
| `title` | string, 1-40 chars | yes | window title and launcher label | launcher (`launch.sh --list`) |
| `version` | semver | yes | tool version, independent of the framework | docs, review |
| `description` | string, 1-200 chars | yes | one sentence, English | docs |
| `minFramework` | semver | yes | lowest `VERSION` of this repo the tool runs on | CI: `minFramework <= VERSION` |
| `main.module` | `m3_<x>.js` | yes | entry module in `src/`, copied to `out/main/`; exports `open()` (section 3) | launcher, CI |
| `main.files` | list of `m3*.js` | yes | every main-process file of the tool, module included. **Shared framework files are not listed**: `m3_device.js`, `m3_models.js`, `m3_activity.js`, `m3_preload.js`, `m3_lock.js` | CI: exist in `src/`, copied by `install.sh`, in the header-verify list |
| `renderer.page` | `<x>.html` | yes | the page `open()` loads; copied to `out/renderer/` | CI |
| `renderer.files` | list of html/css/png/svg | yes | files in `src/` copied to `out/renderer/` | CI: exist, copied |
| `renderer.dirs` | list of `m3<x>` | no | renderer script folders (`m3perf`) | CI: exist, copied |
| `ipc.prefix` | `^m3:[a-z][a-z0-9-]*$` | yes | every request handler of the tool is `<prefix>:<name>`. Should be `m3:<id>`; unique across manifests | CI |
| `ipc.legacy` | list of channels | no | handlers outside the prefix, grandfathered (Device: `m3:models`, `m3:sysstatus`, `m3:npustatus`, `m3:store`, `m3:benchmark`) | CI |
| `ipc.events` | list of channels | no | main-to-renderer push channels (`webContents.send`); must start with `m3:` or the preload rejects them (Device: `m3:device:changed`) | declared |
| `standalone.enabled` | bool | yes | the tool can run via `standalone/launch.sh <id>` | launcher, CI (every registry id must have it `true`) |
| `standalone.singleInstance` | bool, default `true` | no | one standalone process per tool (section 4). The host always requests the lock today | declared |
| `standalone.window` | `{width, height, minWidth, minHeight}` | when enabled | window geometry. The host does not create the window; the module's `open()` does, so keep the two equal (Device: 1100x760, min 800x500) | declared |
| `standalone.icon` | renderer file | no | window icon | declared |
| `standalone.backgroundColor` | `{dark, light}` hex | no | equals the page's `--bg` token in each theme, so the window does not flash before the page paints | declared |
| `hooks.tray.label` | string, 1-24 chars | no | tray menu label | CI: the label is written by `tools/patch_main.py` for this module |
| `hooks.tray.order` | int >= 0 | with label | position among the added items (Device = 10; Control Panel has no manifest and follows Device in the patch) | declared; patch generation later |
| `hooks.activity.contributes` | bool | no | the tool has a task the activity indicator should show | declared (Device is wired by hand: `m3_activity.js` calls `m3_care.currentTask()`) |
| `hooks.activity.export` | identifier | no | name of the exported function returning the current task or `null` (Device: `currentTask`) | declared |
| `device.endpoints` | list of `"<VERB> <path>"` | yes | every device endpoint the tool calls; `{id}` for the model segment | review |
| `device.models.loads` / `unloads` | bool | yes | the tool may load / unload models (NPU memory is shared) | review |
| `device.models.evicts` | const `false` | no | a tool never evicts another model silently: `fitPlan` first, then ask the user | schema |
| `device.models.types` | list | no | model store `type` values the tool consumes | docs |
| `background.poller` | `null` or `{everyMs >= 1000, endpoints}` | yes | a timer that polls the device while the window is closed (Device: 5000 ms) | review: total device load |
| `background.locks` | list of names | no | cross-process locks the tool takes, as files `~/.config/tiinyos-linux/<name>.lock` via `m3_lock` (Device: `engine`) | review |
| `background.state` | `{dir, files}` | no | PC-side files under `~/.config/<dir>/` (Device: `tiinyos-linux/` with `care.json`, `care-journal.json`, `care-log.jsonl`, `engine.lock`). This is the list of **personal data never to commit** | review, secrets scan |

## 3. What `main.module` exports (module contract)

| export | contract | status in 0.4 |
|---|---|---|
| `open()` | opens or focuses the tool window; idempotent (if the window exists: `show()` + `focus()` and return). Electron is used inside. Resolves its page in both places it can live (bundle `out/renderer/`, repo `src/`). | **required**: the tray item calls `require("./<module>").open()`, the standalone host calls it after `whenReady()` |
| `wire(ipc?)` | registers every handler under `ipc.prefix`; idempotent (guard flag or `removeHandler` before `handle`). Should accept an optional `ipcMain`-like object (`{ handle, removeHandler }`) so node tests register handlers without stubbing Electron; when omitted it requires Electron lazily. | **recommended for new tools**. Not implemented in Device: `m3_performance.js` registers its handlers at load (`wire()` at the end of the module, guarded by a flag), and `m3_care.wire(win)` requires Electron lazily inside the call and uses `removeHandler`. No consumer calls `wire()` today; handlers are registered at load or from `open()` |
| `attach(win)` | gives the module the window that receives its push events | **not called by the host in 0.4**. Device keeps its window inside `open()`: `care.wire(win)` stores it and sends `m3:device:changed` to it |

## 4. What each consumer reads

**Standalone launcher** ([`standalone/launch.sh`](../../standalone/launch.sh) +
[`standalone/main.js`](../../standalone/main.js)). `launch.sh <id>` checks that
`id` is in `tools.json`, builds or reuses one symlink farm around the clone's
Electron for all tools (`${XDG_CACHE_HOME:-~/.cache}/tiiny-tools/electron`,
rebuilt when the Electron version changes), re-points `resources/app` at this
checkout's `standalone/` on every launch, and execs Electron with the tool id in
the env var `TIINY_TOOL`. It is an env var and not an argument because a
packaged Electron ignores the app path on argv. `main.js` reads `TIINY_TOOL`,
rejects an id that is not in `tools.json`, sets the app name `tiiny-<id>` and
`userData` to `~/.config/tiinyos-linux/standalone-<id>` **before**
`requestSingleInstanceLock()` (Electron keys the lock on the `userData`
directory), requires `src/<main.module>` and calls `open()`. The per-tool lock
is not yet verified on a running Electron. `launch.sh --list` prints each
registry id with its manifest `title`.

**CI** ([`tests/test_manifests.py`](../../tests/test_manifests.py), stdlib;
`jsonschema` used when installed, otherwise a built-in check of the required
fields and the `id` pattern). For every `src/*.tool.json`:

- the file name is `<id>.tool.json`;
- the manifest validates against the schema;
- ids and `ipc.prefix` are unique;
- every file in `main.files` and `renderer.files` exists in `src/` and appears
  in an `install.sh` copy line as `"$HERE"/src/<file>`; every `renderer.dirs`
  entry exists and appears as `"$HERE/src/<dir>"`;
- every file in `main.files` is in the `install.sh` header-verify list;
- `minFramework <= VERSION`;
- for a tool with `hooks.tray`, `tools/patch_main.py` writes
  `{label:"<label>",click:()=>{try{require("./<module>").open()`;
- every id in `standalone/tools.json` has a manifest with `standalone.enabled`
  `true`;
- every `….handle('m3:<ch>'` literal in `main.files` (on `ipcMain` or an
  injected `ipc`, plus the engine's `once('<ch>')` re-wiring form) is under
  `ipc.prefix` or in `ipc.legacy`.

The example manifests in `examples/<id>/` follow the same schema, file-name and
prefix rules, with their files next to the manifest; the `install.sh`,
registry and tray checks do not apply to them (they are not installed).

**patch_main.py (later, 0.5 or after).** Generate the tray items from the
manifests sorted by `hooks.tray.order`; the idempotency marker stays the
require path.

**install.sh (later).** Derive the copy lists and the header-verify list from
the manifests.

## 5. Out of 0.4

Runtime manifest reading inside TiinyOS; an NPU arbiter (manifests only
*declare* loads and unloads; the rule is `fitPlan` first and never evict);
per-tool preloads or per-tool channel allow-lists (one shared `m3:` rule for
every tool, see [RISKS.md](RISKS.md)); endpoint enforcement; the
activity-indicator contributor runtime (declared only; `m3_activity.classify`
stays the single decider); tool discovery or a marketplace; a versioned SDK
package; i18n.

## 6. Notes on the Device manifest

- `ipc.prefix` is `m3:device`; the push event is `m3:device:changed`. The
  five channels in `ipc.legacy` predate the manifest and stay as they are.
- `hooks.tray.label` is `Device` and matches what `tools/patch_main.py` writes.
- The Device tool shares `~/.config/tiinyos-linux/` with the framework (the
  standalone profiles live in `standalone-<id>` under it). `install.sh
  --uninstall` leaves that folder alone; `install.sh --purge` removes it.
- Control Panel (`m3_cp.js`) and the Floating Ball fixes (`m3_ballshape.js`)
  are shipped by `install.sh` but are not tools with a manifest in 0.4.
