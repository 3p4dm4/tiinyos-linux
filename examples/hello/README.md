# `hello` — example tool (framework reference)

The smallest tool that touches every framework seam, kept out of the app on
purpose: nothing here is installed, no tray entry, no `standalone/tools.json`
entry. Copy it when you start a real tool.

## What it shows

| seam | where | rule it demonstrates |
|---|---|---|
| manifest | `hello.tool.json` | validates against `docs/framework/tool.schema.json`; declares only the three endpoints it actually calls, `device.models.loads/unloads: false`, `background.poller: null` |
| module contract | `m3_hello.js` | `open()` idempotent window, `wire(ipc)` idempotent and injectable, `attach(win)` for a window created elsewhere; no `require('electron')` at top level, so the handlers run under bare node |
| SDK resolution | `m3_hello.js` `sdk()` | the example lives in `examples/hello/`, the SDK in `src/`: each dependency resolves as "sibling first, else `../../src`", so the same file works here and after a copy into `src/`. `pagePath()`/`preloadPath()` do the same for the bundle layout (`out/main/` + `out/renderer/`) and the repo layout |
| IPC prefix | `m3:hello:*` | one prefix per tool: `m3:hello:summary`, `m3:hello:npu`, `m3:hello:version`; every handler returns plain JSON with `readAt` in epoch ms |
| preload rule | `src/m3_preload.js` | the page reaches main only through `window.m3.invoke`, which drops any channel not starting with `m3:`; the device auth key never leaves main (`jget` adds the header) |
| page | `hello.html`, `hello.css`, `m3hello/main.js` | strict CSP, no inline styles, no external resources, colours only through the `:root` tokens copied from `src/performance.css` (light + dark), loading / empty / error states, device strings escaped before `innerHTML` |
| test | `hello.test.js` | `tests/fake_pocket.py` on a loopback port with `TIINY_BASE` set **before** the require (the base URLs are read at module load), a stub `ipcMain`, and `wire()` called twice to prove idempotency |

```bash
node --test examples/hello/hello.test.js
python3 -c "import json,jsonschema; jsonschema.Draft202012Validator(json.load(open('docs/framework/tool.schema.json'))).validate(json.load(open('examples/hello/hello.tool.json')))"
```

The page itself is **not** verified in a real Electron window here — that needs
a clone and a device session (see `AGENTS.md`: a rendered page is not a visible
window; prove visibility with the window manager).

## Turning it into a real tool

1. Copy the files into `src/` (`m3_hello.js`, `hello.html`, `hello.css`, `m3hello/`,
   `hello.tool.json`), keep the names the manifest declares.
2. `install.sh`: add the copies (`m3_hello.js` → `out/main/`, `hello.html` +
   `hello.css` → `out/renderer/`, `m3hello/` → `out/renderer/m3hello`) and add
   `m3_hello.js` to the header-verify tuple next to the other `m3_*.js`.
3. Optional tray entry: `tools/patch_main.py` — a `{label:"Hello Pocket",
   click:()=>{…require("./m3_hello").open()…}}` entry plus its anchor-ladder
   step, with an idempotency marker (`"m3_hello" in s`); mirror it in
   `tests/test_patches.py`.
4. `standalone/tools.json`: add `"hello"` (then `standalone/launch.sh hello`),
   and set `standalone.enabled: true` in the manifest.
5. Move the test to `tests/js/hello.test.js` and point the requires at `src/`.
6. Verify: `python3 -m unittest tests.test_manifests`,
   `python3 -m unittest discover -s tests`, `node --test tests/js/*.test.js`,
   and the install/uninstall round-trip restoring `app.asar` byte-identically.
