# Device window — engine ↔ UI contract (v0.4.0)

The Device window (today's Performance window, renamed) is built from two halves that
must agree on this contract. Design and copy: [device-design.md](device-design.md),
visual reference: [device-mockup.html](device-mockup.html) (static, fake data).

## Files

| file | role |
|---|---|
| `src/m3_device.js` | HTTP helpers. `BASE`/`P8800` can be overridden with env `TIINY_BASE` (tests point it at the fake device) |
| `src/m3_care.js` | **engine** (main process): poller, outage detection, restore, update journal, power setting, activity log, usage |
| `src/m3_performance.js` | window + existing IPC (`m3:models`, `m3:sysstatus`, `m3:npustatus`, `m3:store`, `m3:benchmark`); requires `m3_care` and wires it |
| `src/performance.html`, `src/performance.css`, `src/m3perf/*.js` | **UI** (renderer), four tabs: Status · Models · Usage · Power |
| `tests/fake_pocket.py` | fake device for tests (std-only Python HTTP server, scriptable scenarios) |

Window title: **Device**. File names stay (`performance.*`, `m3perf/`) so the bundle patch does not change.

## IPC (renderer → main, `window.m3.invoke`)

All payloads are plain JSON. Times are epoch milliseconds; the UI formats them (en, 24 h).

| channel | args | returns |
|---|---|---|
| `m3:device:state` | — | `CareState` (below) |
| `m3:device:models` | — | `{ models: [InstalledModel] }` |
| `m3:device:usage` | `{ weekStart: "YYYY-MM-DD" }` (Monday) | `{ weekStart, days: { "YYYY-MM-DD": { "<model id>": { prompt, completion, total, requests } } }, apps: { "<app>": { total, models: { "<model id>": tokens } } }, readAt }` |
| `m3:device:log` | `{ since?: ms }` | `{ entries: [ { t, event, detail, by: "pc"|"device" } ] }` newest first, 7 days kept |
| `m3:device:setAcPower` | `{ on: bool }` | `{ acPower: bool }` (re-read from the device after the POST) |
| `m3:device:setPolicy` | `{ reload: "off"|"kept"|"all" }` | `{ reload }` |
| `m3:device:keep` | `{ id, on: bool }` | `{ kept: [id] }` |
| `m3:device:load` / `m3:device:unload` | `{ id }` | `{ ok: true }` or throws with a readable message |
| `m3:device:update` | `{ id }` | `{ taskId }` (async; progress via state) |
| `m3:device:updateAll` | — | `{ taskIds: [] }` |
| `m3:device:stopTask` | `{ taskId }` | `{ ok: true }` (stops after the current step) |

Push (main → renderer, `window.m3.on`): `m3:device:changed` with a fresh `CareState` whenever it changes
(at most once per second). The renderer may also poll `m3:device:state` every 5 s.

### CareState

```json
{
  "reach": { "state": "reachable|stale|unreachable", "lastRead": 0, "since": 0, "everyMs": 5000 },
  "running": [ { "id": "", "status": "", "progress": 0, "activeRequests": 0,
                 "lastInference": 0, "npu": 0 } ],
  "pending": [ "model id" ],
  "tasks": [ { "id": "", "kind": "restore|update|download|benchmark", "label": "",
               "where": "pc|device", "state": "queued|running|waiting|done|failed|interrupted",
               "progress": 0.0, "step": 1, "steps": 4, "startedAt": 0, "note": "" } ],
  "policy": { "reload": "off|kept|all" },
  "kept": [ "model id" ],
  "acPower": true,
  "outages": [ { "lost": 0, "back": 0, "beforeIds": [], "backIds": [],
                 "restored": [], "notRestored": [ { "id": "", "reason": "" } ] } ],
  "lastSnapshot": { "t": 0, "ids": [] }
}
```

`acPower` is `null` when unknown (device unreachable or the read failed).

### InstalledModel

From `GET /api/v1/models/?including_downloading=true` (fields verified on a device 2026-11-19):
`id, display_name, type, status, progress, total_size, npu_usage, version, version_label, need_update,
update_title, update_desc` plus `kept: bool` and `inMemory: bool` added by the engine.

## Device facts the engine relies on (verified 2026-11-19 unless marked)

- Running: `GET /api/v1/models/running` → `instances.running[]` (`model_id, status, progress,
  active_request_count, use_time, last_inference_time, created_at, npu_usage`) and `pending[]`.
- Load: `POST /api/v1/models/{id}/start` then poll `/v1/models` + `GET /api/v1/models/{id}/get_progress`
  (tested sequence); fit check `GET /api/v1/models/{id}/unload_candidate`. Unload `POST …/stop`.
- Power: `GET /api/v1/sys/ac_power/` → `{"status","ac_power"}`; `POST` `{"switch":0|1}` (POST: docs only).
- Updates: `DELETE /api/v1/models/{id}`, `POST /api/v1/models/{id}/download` (docs only, untested);
  a download is assumed NOT to survive a device reboot: after an outage the journal restarts it.
- Usage: `GET /api/v1/statistics/week_usage?start_date=YYYY-MM-DD` → dates at the top level, then
  model id → `{prompt_tokens, completion_tokens, total_tokens, request_count}`; `…/app_week_usage?start_date=…`
  → app name at the top level → `{total_tokens, models: {id: tokens}}`, apps `TiinyOS` (the app sends
  `X-App-Id: TiinyOS`) and `default` (requests without that header: agents, other API clients)
  (observed on a device 2026-11-20). The engine maps them to the IPC names above.
- No uptime is exposed: an **outage** = the device stopped answering for more than 15 s and answered
  again. The device may bring a model back by itself after boot; restore only loads what is missing
  and never unloads anything.
- `{id}` in paths is URL-encoded per segment; the `/` between owner and name stays a `/`.

## Data lock and unlock (verified 2026-11-20/22, TiinyOS 0.1.39, unless marked)

Not used by the Device window today (the TiinyOS app unlocks); written down for every client that
must tell "locked" from "down" (the Omarchy plugin, scripts). Served by the fake: scenarios `locked`
and `unlock_refused`, controls `lock()`, `set_unlock_fault()`, `restore_power(..., locked=True)`.

- After **every** reboot `/data` (LUKS2, detached header) is locked. Until it is unlocked nginx
  answers **502** with its HTML page on every endpoint except the three below, before any auth check.
  So "502 everywhere" while `/v1/data/state` answers means locked, not down.
- `GET /v1/data/state` — no Bearer, works while locked:
  - locked: `{"boot_state":"ready","credential_state":"password_or_auth_key_required","data_state":"locked","format":"luks2-detached-header","requires_unlock":true,"serivice_status":"pending","supports_recovery":true}`
  - unlocked: `{"boot_state":"ready","data_state":"unlocked","key_arch":"vault","requires_unlock":false,"serivice_status":"ok"}`
  - `credential_state`, `format` and `supports_recovery` are present only while locked.
  - the key is spelled `serivice_status` by the device; read `serivice_status || service_status`.
    Ready = `data_state == "unlocked"` and status `ok` (the app's own rule).
  - `unlocking` exists (the vendor app and TTt poll for it); its exact shape is *assumed*.
- `POST /api/v1/account/auth` `{"password", "device_id"?}` — no Bearer → `auth_key` (plus
  `device_id`, `user_info`). Wrong password: answer **not captured** (the fake's 401
  `password_wrong` is *assumed*).
- `POST /api/v1/account/unlock_with_auth_key` `{"auth_key"}` — no Bearer, the auth key alone
  unlocks (no decryption password). Normal: `data_state: "unlocking"`, then poll `/v1/data/state`.
  An auth key survives reboots: the app unlocks with its stored key after each one.
  After unlock the device may bring models back by itself (see "outage" above); the fake's locked
  scenarios keep `tiiny/cogito-mini` in memory for that reason.
- **Refused unlock (fault, 2026-11-20 → 22):** `{"status":"ok","data_state":"locked",…}` returned
  immediately and the state never moves, for any key and any client. Cause: an unconfirmed A/B OS
  boot fell back to the previous system, which cannot open the vault keys. Fixed only on the device
  (vendor support kit). Classify it by **body + unchanged `data_state`**, not by response time.
  Never auto-retry it.
- `GET /api/v1/sys/device_info` (Bearer, needs `/data`) → `tiiny_os` is the OS version (0.1.39).
- `POST /api/v1/connect` is a **session**: one client at a time, a second one drops the first. A
  client that only wants state must not call it.

## PC-side state

`~/.config/tiinyos-linux/care.json` (policy, kept, last snapshot), `care-journal.json` (update steps,
written before each step), `care-log.jsonl` (activity log, 7 days). All writes atomic (tmp + rename).
