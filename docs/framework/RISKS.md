# Risks for contributors, and the 0.4 guardrails

What can break when a second tool joins the feature pack, and what the
framework does about it in 0.4. Field names refer to [MANIFEST.md](MANIFEST.md).

## 1. Minified-bundle anchors (the one thing a contributor cannot fix locally)

**What breaks.** Every tray item lives in one string replacement on one anchor
of the vendor bundle ([`tools/patch_main.py`](../../tools/patch_main.py)). An
upstream TiinyOS release that reformats that menu makes `patch_main` exit with
"bundle drifted" and *all* tools disappear from the tray at once; a
contributor's PR is then red for reasons unrelated to their tool. The
idempotency ladder in `patch_main.py` grows one branch per tool: each new tool
must know the exact text the previous one produced, so two branches that both
extend `PATCH` conflict.

**Guardrails in 0.4.**
(a) Fixture tests stay mandatory per patch tool
([`tests/test_patches.py`](../../tests/test_patches.py)): apply, re-apply
without duplicates, drift. The patch tools never run on the vendor bundle in
tests.
(b) The manifest declares `hooks.tray` and `tests/test_manifests.py` asserts
that `patch_main.py` writes that label for that module: a label drift is caught
by a test, not by a user.
(c) The order of the patch tools in `install.sh` stays fixed:
`patch_activity.py` needs the output of `patch_ball_click.py` as its anchor.
Deferred: generating `PATCH` from the manifests (0.5 or after), which removes
the ladder.

## 2. Preload channel allow-list (one rule for every tool)

**What breaks.** All tools share one preload,
[`src/m3_preload.js`](../../src/m3_preload.js). It exposes `window.m3.invoke`
and `window.m3.on` and lets through only channels that start with `m3:`:
`invoke` returns a rejected promise and `on` throws for anything else. That is
one shared rule, not a per-tool one: the renderer of tool A can still invoke
the channels of tool B. A contributor who registers a handler outside `m3:` is
not stopped by the preload at registration time; the page simply cannot reach
it.

**Guardrails in 0.4.**
(a) The `m3:` rule applies both ways (`invoke` and `on`), and `on` returns an
unsubscribe function. Tested in `tests/js/m3_preload.test.js`.
(b) CI: every `….handle('m3:…')` literal in a tool's `main.files` starts
with its `ipc.prefix` or is in `ipc.legacy`; prefixes are unique across
manifests.
Out of scope: per-tool preloads or a per-tool allow-list. Documented, not fixed.

## 3. Single instance per tool (standalone)

**What breaks.** The standalone host relies on
`app.requestSingleInstanceLock()`. With one generic `standalone/` folder, every
tool would share the default `userData` path and therefore the same lock:
launching one tool while another is open would make one of them quit. The
symlink farm is one per machine and `resources/app` is re-pointed on every
launch: two tools launched from two different checkouts race on that symlink.
And the in-app window plus a standalone window of the same tool are two
processes anyway; the Electron lock never covers that case.

**Guardrails in 0.4.**
(a) [`standalone/main.js`](../../standalone/main.js) sets the app name
`tiiny-<id>` and `userData` = `~/.config/tiinyos-linux/standalone-<id>`
**before** `requestSingleInstanceLock()`, so the lock is per tool. A second
launch of the same tool is meant to focus the existing window and exit. This
is not yet verified on a running Electron; the repo's tests do not exercise it.
(b) One farm, one `standalone/` host: `launch.sh <id>` only changes the
`TIINY_TOOL` env var, and a stderr line says which checkout is running.
(c) Any shared mutable resource is protected by an `m3_lock` file declared in
`background.locks`, never by the Electron lock. The Device care engine takes
`~/.config/tiinyos-linux/engine.lock` through
[`src/m3_lock.js`](../../src/m3_lock.js): only the holder polls, restores
models, runs updates and writes the log; the other process shows the same
state, refuses updates with a message naming the holder, and takes over when
the holder quits (`tests/js/care_lock.test.js`). A lock is stale when its pid
is gone, when it is older than the caller's `staleMs`, or when it is unreadable
for more than 5 s.
(d) The farm keeps `--no-sandbox` (the clone's `chrome-sandbox` is not owned
by root) and no `--disable-gpu` by default (software rendering painted the
window black on the test hardware); opt in with `TIINY_TOOLS_FLAGS`.

## 4. NPU contention between tools

**What breaks.** The Pocket holds a few models at a time and refuses or evicts
when the budget is full (`tests/fake_pocket.py`, scenario `npu_full`: three
models in memory at 95 %). Two tools can each believe they own the NPU: the
Device engine reloads missing models after an outage while another tool loads
its own model. The Device poller runs every 5 s even with the window closed,
and the activity indicator polls every 5 s too: N tools times their pollers is
N times the device load on a USB link. A tool that calls `POST …/start`
directly bypasses `fitPlan` and evicts someone else's model silently.

**Guardrails in 0.4.**
(a) The manifest declares `device.models.loads` / `unloads`, and `evicts:
false` is a schema constant. Review rule: load = `fitPlan` → show what would be
evicted → user confirms → `ensureLoaded`. The Device restore follows it: a
model that would evict another is reported "not restored" and skipped
([`src/m3_care.js`](../../src/m3_care.js)).
(b) Every background poller is declared with its interval and endpoints;
minimum 1000 ms in the schema, 5 s by convention. Reviewers add them up.
(c) Shared helpers only ([`src/m3_models.js`](../../src/m3_models.js)), so the
load sequence is one code path.
Deferred: a main-process NPU arbiter or queue.

## 5. Other things that will bite contributors

- **Framework modules capture env at require time.** `m3_device.js` reads
  `TIINY_BASE` and `HOME` when loaded. Tests set both and then re-require the
  modules (`tests/js/models.test.js`).
- **`wire()` at module load.** `m3_performance.js` registers its handlers when
  required, so tests must stub `electron` through `Module._load`
  (`tests/js/care_wiring.test.js`, `tests/js/m3_preload.test.js`). New tools
  should take an injectable `ipc` and not wire at load; existing modules
  migrate when touched.
- **`install.sh` copy lists are hand-maintained.** A forgotten file passes
  syntax checks and fails only at install. `tests/test_manifests.py` checks
  that every manifest file is in a copy line and that every main-process file
  is in the header-verify list.
- **Uninstall symmetry.** Anything added outside the asar (desktop entries,
  the clone's `launch.sh`, the PC service) is removed by `install.sh
  --uninstall`. User state under `~/.config/tiinyos-linux/` is kept by
  `--uninstall` and removed by `--purge`.
- **Fake vs real device shapes differ.** `unload_candidate` answers
  `model_id` / `npu_required` / `npu_available` on the device and
  `unload_candidates` / `required_npu` / `available_npu` on the fake;
  `fitPlan` normalises both. A tool tested only against the fake can misread
  the real answer. The fake marks untested shapes with `# assumed`;
  [`docs/design/device-contract.md`](../design/device-contract.md) marks facts
  verified on a device. A PR that adds a device fact says which it is.
