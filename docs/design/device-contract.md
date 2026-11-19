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
| `m3:care:state` | — | `CareState` (below) |
| `m3:care:models` | — | `{ models: [InstalledModel] }` |
| `m3:care:usage` | `{ weekStart: "YYYY-MM-DD" }` (Monday) | `{ weekStart, days: { "YYYY-MM-DD": { "<model id>": { prompt, completion, total, requests } } }, apps: { "<app>": { total, models: { "<model id>": tokens } } }, readAt }` |
| `m3:care:log` | `{ since?: ms }` | `{ entries: [ { t, event, detail, by: "pc"|"device" } ] }` newest first, 7 days kept |
| `m3:care:setAcPower` | `{ on: bool }` | `{ acPower: bool }` (re-read from the device after the POST) |
| `m3:care:setPolicy` | `{ reload: "off"|"kept"|"all" }` | `{ reload }` |
| `m3:care:keep` | `{ id, on: bool }` | `{ kept: [id] }` |
| `m3:care:load` / `m3:care:unload` | `{ id }` | `{ ok: true }` or throws with a readable message |
| `m3:care:update` | `{ id }` | `{ taskId }` (async; progress via state) |
| `m3:care:updateAll` | — | `{ taskIds: [] }` |
| `m3:care:stopTask` | `{ taskId }` | `{ ok: true }` (stops after the current step) |

Push (main → renderer, `window.m3.on`): `m3:care:changed` with a fresh `CareState` whenever it changes
(at most once per second). The renderer may also poll `m3:care:state` every 5 s.

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
- Usage: `GET /api/v1/statistics/week_usage?start_date=YYYY-MM-DD`, `…/app_week_usage?start_date=…`.
- No uptime is exposed: an **outage** = the device stopped answering for more than 15 s and answered
  again. The device may bring a model back by itself after boot; restore only loads what is missing
  and never unloads anything.
- `{id}` in paths is URL-encoded per segment; the `/` between owner and name stays a `/`.

## PC-side state

`~/.config/tiinyos-linux/care.json` (policy, kept, last snapshot), `care-journal.json` (update steps,
written before each step), `care-log.jsonl` (activity log, 7 days). All writes atomic (tmp + rename).
