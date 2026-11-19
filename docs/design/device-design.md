# Device window — design proposal, revision 2 (replaces "Performance — device")

Scope: `src/performance.*`, `src/m3perf/*`, `src/m3_activity.js`. Mockup: `mockup.html` (English throughout, en formats: `16.5 GB`, `1,102`, `2026-11-19`, 24-hour times). Marks: **API** = in DEVICE-API.md; **OWNER** = verified on the real device 2026-11-19 (brief); **ASSUMED** = my guess about device behaviour, to verify before building.

## 1. Names

- **Window: "Device".** The object is the device; performance is one of four questions brought to it.
- **Tabs: Status · Models · Usage · Power.** Recommendation: **four tabs** — Usage has its own clock (weeks, read every 60 s) and its own navigation; inside Status it would be a second time control under the 5-second one, and the tab would scroll past the live data to reach it. Status = now (seconds), Models = inventory, Usage = this week, Power = when the plug drops.
- **"Keep loaded"** not pin, **"Reload missing models"** not restore policy, **"Outages seen from this PC"** names the source, **"Right now"** for the activity block (the community Control Panel's words, which users already know).

## 2. Information architecture

| Where | What | Why |
|---|---|---|
| Header | title, tabs, device + TiinyOS version, theme | one bar |
| Strip (always) | reachable/stale/unreachable + `last read hh:mm:ss` + cadence · **requests in flight** (count + model) · the one running task with %, Details button | time always visible (barra P5, rule/state-last-read); the same line goes to the Floating Ball tooltip and the tray so the three surfaces never disagree. One task only: the busiest of restore > update > download > benchmark |
| **Status** | KPI row · **Right now**: In memory (what each loaded model is doing now) + Tasks (what device and PC are working on) · **Activity log** (today, newest first) · Benchmark runs · strip-state preview | "how is it now" in one tab, from seconds (KPI) to the last hours (log). Hero cards stay a compact row (rule/slop-stat-card) |
| **Models** | summary + filters · Updates (only if any `need_update`) · All models in one grouped table | one table gains filter, state and actions; downloading models appear in their type group with a Pause button |
| **Usage** | week navigation · week KPI row · stacked columns per day by model + legend + table twin · By model table · By app table · other states | one time control (the week) scopes everything below it (dataviz: one filter row above everything it scopes) |
| **Power** | When power returns (AC switch + Reload missing models) · Restore in progress · Outages + advice | the three outage decisions sit together; Keep loaded is set in Models and consumed here |

### 2.1 Activity in progress — placement: strip (one line) + Status tab (the full picture), never duplicated

- **Strip** carries two facts only: `N request(s) · <model>` and the one running task with its meter. Reason: it is visible from every tab and from the Ball/tray, and a 32 px line holds exactly two facts before it wraps at 1100 px (measured: three items + meter + button wrapped; cut to two).
- **Status › Right now** holds the rows: the strip has no room for per-model request counts, pending loads, downloads, restore/update steps or benchmarks, and each of those needs its own Stop/Pause/Cancel.
  - **In memory** = `GET /api/v1/models/running` → `instances.running[]` (OWNER): `active_request_count` → "Answering 1 request · 8 s" (the seconds come from `last_inference_time` or the PC's own request start, ASSUMED which is more precise), `status` + `progress` → "Loading 40%", `last_inference_time` → "Last used", `created_at` → row title "Loaded 16:32:01", `npu_usage` → NPU. `pending[]` (OWNER) → "Queued · after AceStep" rows with a Skip button. `use_time` is not shown until its meaning is confirmed (cumulative busy seconds? idle seconds?) — ASSUMED.
  - **Tasks** = one row per thing in flight: restore (PC journal), update step (PC journal), download (`GET /api/v1/models/?including_downloading=true`, status + progress, OWNER), benchmark (PC). Columns Task · Where (device / this PC) · Progress · Started · Left · action. "Where" says who to blame when it stalls.
  - A loading model appears in In memory (as the device reports it) and, when the PC started it, inside the restore's Tasks row — not as a third row.
- **Activity log** = PC-side journal, 7 days, rolling file; the device publishes no event log (ASSUMED: none found in DEVICE-API.md). Sources: diff of `running[]` between polls (loaded/unloaded "by another client" when this PC did not ask), downloads start/finish, restore and update steps, outages (stopped answering / answers again, with the no-answer duration and how many models were in memory before and after), benchmarks. Columns When · Event · Detail · Seen by. Outage rows reuse the status vocabulary (✕ / ●) so the log reads in grayscale. "Earlier days" opens the previous days in the same table.

### 2.2 Usage — placement: own tab

- **Week navigation**: Previous week · This week (pressed) · Next week (disabled on the current week) · "Week of 2026-11-16 · Mon … to Sun … · 4 days so far" · "counted on the device, every client included · read 16:42:00 · every 60 s". `start_date` = the Monday; the device returns 7 days (OWNER). Loading a week keeps the previous chart and tables at reduced opacity (no skeleton flash, no layout shift).
- **KPI row** (five compact cells, no hero): tokens this week (compact + exact), prompt, completion, requests (+ tokens per request), busiest day. Derived from `week_usage` sums.
- **Chart** — stacked columns per day by model, from `GET /api/v1/statistics/week_usage?start_date=…` (OWNER). Built with the dataviz method: form = change over time of a part-to-whole → stacked columns; color = identity only, slots 1..8 of the reference categorical palette on `:root` (`--series-1..8`, light and dark steps), **assigned the first time a model appears in usage and kept across weeks** (color follows the entity, never its rank); a 9th model folds into "Other". Marks: 24 px columns, 2 px surface gap between segments, 4 px rounded top on the top segment only, hairline gridlines, solid baseline, total on each cap (selective labels: caps only, never every segment), text in text tokens. Legend always present (5 series). Hover and keyboard focus (each column is a `g[tabindex=0][role=img]` with the full breakdown as its name) show the same tooltip above the cap; `<title>` is the no-JS fallback. **Table twin** under the chart (`<details>`: Day × model × total, 7 rows) — required by the relief rule: three light-mode series sit below 3:1 on white (aqua 2.82, yellow 2.17, magenta 2.69, measured by the validator), so identity never rests on hue alone. Palette validated with `validate_palette.js`: light and dark both pass lightness, chroma, CVD separation (worst adjacent ΔE 9.1 / 8.4) and the normal-vision floor (19.6 / 19.3).
- **By model table**: Model (swatch + name) · Prompt · Completion · Total · Share · Requests · Tokens / request, sorted by total, footer with sums. The table is the primary reading; the chart is the shape.
- **By app table**: from `GET /api/v1/statistics/app_week_usage?start_date=…` (OWNER): App · Tokens · Share · one numeric column per model. The endpoint reports totals per app, not per day and not prompt/completion — the note says so. "default" = requests that name no app (ASSUMED: API clients and this window's benchmarks).
- Other states (in the mockup's preview table): empty week, 502 while the TiinyOS app reconnects (shows the last reading's time), week loading.

Removed: the single long scroll, uppercase eyebrows, category cards, primary Benchmark on every row, it-IT formats, version numbers (1.1/1.2).

## 3. Components against the 11 questions

**Strip.** Job: is what I see fresh, is the device busy for me? Not for: per-action errors (they sit in the row). Breaks: a third item wraps at 1100 px → two items max, `white-space: nowrap`, task ellipses. States: fresh; stale (>60 s, amber, "Read now"); unreachable (red, "since hh:mm:ss · USB link down · numbers below are from …"); 502 while the app reconnects after boot is named (API). Color only on the status word, glyph + word (rule/color-not-only-signal). No pulsing (rule/motion-loop-not-loading).

**KPI rows** (6 live cells in Status, 5 weekly cells in Usage). 3 columns under 900 px. Meter amber ≥85 %, red ≥95 %. Loading: reserved height with "—"; failed: "✕" + HTTP error. Unit after the value, tabular. No icons.

**Tables** (in memory, tasks, activity log, runs, updates, all models, by day, by model, by app, restore, outages). Row 36 px, cell padding 4/12 (rule/table-density, measured 36 px in every tab); numbers right, tabular (rule/table-numeric-right). Each row fits one line at 1100 px (measured after cutting the "Loaded at" column and the long notes). Empty: "No benchmark run yet. Press Benchmark on a model in memory." / "No outage seen from this PC." / "No update available · checked 16:42" / "No usage recorded for the week of …". Error: real status + next step in the row. Loading row at the same height (rule/state-loading-reserve). Every action a `<button type="button">`; Keep loaded checkbox inside a 24 px label (rule/target-size-24); the chart's table twin behind a native `<summary>` (24 px target).

**Buttons.** One secondary style; primary only on Update. Pending: spinner inside (guarded by `prefers-reduced-motion`), label kept, `aria-busy`, disabled (rule/pending-contract, pending-label-swap). Week buttons: This week is `aria-pressed`, Next week `disabled` on the current week.

**AC power switch.** Native checkbox `role="switch"`, bound label, helper by `aria-describedby`, state text "Off · device setting" (`GET /api/v1/sys/ac_power/` → `{"ac_power": false}` today, OWNER). Pending until GET confirms; error text under the help; disabled when unreachable.

**Reload missing models radios.** Fieldset + legend; the counts in the labels are live. Stored on the PC (ASSUMED: no device setting exists).

**Chart.** Native SVG generated from one data object (the same object feeds legend and table twin, so they cannot disagree); redrawn on resize at real pixel width (no scaled text: SVG text is 12 px like every label). Tooltip `role="status"`; focus ring on the column (rule/focus-outline-removed is not triggered: outline kept).

**Dialogs.** Native `<dialog>`: Escape = cancel with no request, focus returns to the opener (verified by the Playwright helper), Tab loops (rule/dialog-escape-cancel, dialog-focus-return, dialog-tab-loop).

## 4. Flows

**Outage and restore.** Detection: the device stops answering and the PC sees the USB link drop; the outage closes when the device answers again (OWNER: `device_info` has no uptime or boot time, so the link drop is the discriminant; a pause with the link still up — a long render — is not an outage). When it answers, `running[]` is read first: the device may have brought a model back on its own (OWNER: after the last reboot a chat model was already in memory). The restore loads only what the policy wants **and is missing**, never unloads what the device brought back, in last-loaded order with `POST /api/v1/models/{id}/launch` (API), one at a time, progress from `running[]` status + progress (OWNER). Before each load `GET …/{id}/unload_candidate` (API): `unload_required` → row "Not restored · 6.8 of 16.5 GB free" + "Load anyway" (opens the normal unload confirmation); nothing evicted silently. Progress in strip, Status › Tasks, Power › Restore in progress, the activity log and the Ball/tray line via a new `classify()` state before Downloading. Stop ends the queue after the current load; Skip drops one queued model. The outage table records In memory before / Back on its own / Restore result.

**Update one model.** Row data `need_update`, `version` (installed, a date such as 20261109), `version_label` (available, 20261119), `update_title`, `update_desc` from `GET /api/v1/models/?including_downloading=true` (OWNER). Shown as dates: `2026-11-09 → 11-19` in the All models row (full date in the row title), `2026-11-09` / `2026-11-19` in the Updates table, `update_title` as the "Update" column, `update_desc` quoted verbatim in the dialog. The dialog lists the four steps marking skipped ones, download size, time (ASSUMED from measured link speed) and the power warning with today's outage count. Steps: unload (`/stop`, API) → delete (`DELETE /api/v1/models/{id}`, API docs) → download (`/download`, API docs) → reload (`/launch`) only if it was in memory. Each step is journaled on the PC before it runs (`{model, from, to, step, started, wasLoaded}`); strip: "Updating d3-flash · step 3 of 4 · downloading 62% · ~4 min".

**Power cut mid-update.** On reconnect the journal is read first: step 2 done, 3 unfinished → download restarted or resumed (ASSUMED: survival of a partial download across reboot is unknown; `pause_download`/`interrupt` exist, resume-after-reboot is not documented). Row: "Interrupted at step 3 · resumes when the device answers". Restore waits for the update (device does one thing at a time, API).

**Update all.** Queue, one at a time, same dialog with order and total time; a cut pauses it at the same step.

**Usage week.** Previous/Next move `start_date` by 7 days; This week = the current Monday. Both endpoints are read once per minute for the shown week only; past weeks are cached on the PC for the session (ASSUMED: the device keeps past weeks — the brief shows 7 days from any `start_date`, retention unknown).

## 5. Copy

- Strip: `● Reachable · last read 16:42:18 · every 5 s` · `1 request · Huihui-Ornith` · `Restoring · AceStep-XL-Turbo 40% · 1 of 3` · `✕ Unreachable since 16:31:12 · USB link down · retrying every 5 s · numbers below are from 16:31:07` · `◐ Stale · last read 16:35:40 (6 min ago)`.
- Ball/tray: the strip's two facts in one line: "Restoring AceStep-XL-Turbo · 40% · 1 request in flight"; idle: "Idle · 3 models in memory".
- Activity log: `16:32:01 · Device answers again · no answer for 49 s · USB link back · 1 model in memory (Ornith)`; `13:05:02 · Loaded · d3-flash · by another client · device`.
- Update dialog: "Update Qwen3.6-35B-A3B-Turbo to the 2026-11-19 release? Installed: 2026-11-09. Tiiny ships the update as a new model: the old one is deleted first, then 16.5 GB are downloaded." + `update_title` — "`update_desc`" verbatim + the four steps + the power warning.
- Not restored: "Not restored · 6.8 of 16.5 GB free" + Load anyway.
- Advice (role=status, ≥2 outages in 24 h): "Unreliable power. 4 cuts today, 14 to 48 minutes apart. Each time the USB link dropped, the device answered again after 44 to 57 s with one model in memory, and this PC reloaded the others (about 3 min). Use the wall adapter…"
- Usage notes: "counted on the device, every client included"; "the device reports totals per app, not per day"; "default = requests that name no app".

## 6. Rules applied

color-raw, color-semantic-only (accent + severity + series only; series never used for status), color-not-only-signal, color-contrast-text, color-nontext-contrast (24 token pairs tested in both palettes, series contrast reported) · type-neutral-scale (4 sizes used: 12/13/14/16, labels 12 px), type-tabular-nums · table-density, table-numeric-right · state-empty, state-error, state-loading-reserve, state-last-read · action-button-type · form-label-unbound, form-field-unlabeled · dialog-escape-cancel, dialog-focus-return, dialog-tab-loop · motion-reduced (spinner keyframes guarded) · slop-emoji, slop-hype-copy, slop-stat-card, slop-card-in-card. Dataviz: one axis, fixed-order categorical slots, legend + table twin, cap labels only, 24 px marks with 2 px surface gaps, palette validated by script in both modes.

Verification: `ui-check` on `mockup.html` → 0 findings (its blind spots — rendered contrast, keyboard, overflow — are covered by `verify_mockup.py`: token contrast both palettes, 1100×800 render of all four tabs in light and dark, no horizontal scroll, rows 36 px, targets ≥24 px, font sizes {12,13,14,16}, chart integrity (7 columns, 5 legend entries, 7 table rows, columns ≤24 px, tooltip visible on hover), dialog focus return).

## 7. Open questions

1. `use_time` in `running[]`: cumulative busy time or idle time? It decides whether In memory shows "busy 12 min today" next to "Last used".
2. Does a download survive a device reboot? It changes the update warning and the estimate.
3. How far back does `week_usage` go (retention), and does `app_week_usage` ever report an app other than "TiinyOS" and "default" (e.g. Tiiny Studio by name)?
