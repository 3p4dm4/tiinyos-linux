/* M3 — Device care engine (main process).
 *
 * No Electron at module top level: the core runs under bare node against the
 * fake device (tests set TIINY_BASE). Electron is required only inside wire().
 *
 * What it does (contract: docs/design/device-contract.md):
 *   * 5 s poller: GET /api/v1/models/running (liveness) + GET /v1/models
 *   * reach: reachable / stale (link up, no good read >60 s) / unreachable
 *     (no answer >15 s)
 *   * outage = no answer for >15 s and then an answer again; the link drop is
 *     the discriminant (a pause with the link up is not an outage)
 *   * in-memory snapshot while reachable, persisted in care.json
 *   * restore per policy off|kept|all after an outage: loads only what is
 *     missing, one at a time, in load order, fitPlan first — a model that
 *     would evict something else is reported "not restored · needs …", never
 *     evicted
 *   * ac_power get/set (POST is docs-only: set re-reads the GET after)
 *   * updates: journal-driven and resumable — unload (if loaded) → DELETE →
 *     download (watched) → reload (if loaded); the journal is written before
 *     each step, on app start and after every outage it resumes from it;
 *     updateAll queues one model at a time; restore waits while an update runs
 *   * activity log (store): loads/unloads seen, outages, restore steps, updates;
 *     logEvent is exported so other modules (e.g. the benchmark) can log too
 *   * usage passthrough: week_usage / app_week_usage, weekStart = a Monday
 *
 * Tests drive it with start({ baseDir }) + the exported _pollOnce(); the 5 s
 * timer only runs inside the app.
 */
'use strict';
const { BASE, jget, jpost, jdelete } = require('./m3_device');
const { mpath, shortName, fitPlan, ensureLoaded, ensureUnloaded, runningIds } = require('./m3_models');
const { createStore } = require('./m3_care_store');
const lock = require('./m3_lock');
const path = require('path');

const POLL_MS = 5000;
let OUTAGE_MS = 15000; // no answer for >15 s and then an answer = outage
let STALE_MS = 60000;  // link up but no good read for >60 s = stale
const LOAD_TIMEOUT_MS = 15 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000; // multi-GB model over the USB link
let LOAD_POLL_MS = 1500;

const S = {
  store: null,        // set by start() (base dir injectable for tests)
  // Engine lock: the TiinyOS app and a standalone Device window may both load
  // this module. Only the process holding engine.lock acts (restore, updates,
  // journal resume, log/snapshot writes); any other one only reads, and takes
  // over when the holder goes away. Tests that never start the timer stay owner.
  owner: true,
  holder: null,       // the other process's lock record while we are not owner
  lockPath: null,
  timer: null,
  win: null,
  lastGood: 0,        // ms of last good read (0 = never)
  failSince: 0,       // ms, start of the current failing streak (0 = none)
  failKind: null,     // 'net' = no answer | 'http' = answered, bad read
  reach: { state: 'unreachable', lastRead: 0, since: 0, everyMs: POLL_MS },
  lastIds: [],        // in-memory ids of the last good read
  running: [],        // last good instances.running[]
  pending: [],        // last good instances.pending[]
  snapshot: [],       // [{ id, t }] load order, oldest first
  outage: null,       // open outage record (back = 0 until it closes)
  outages: [],        // closed outages, newest first (in memory, capped)
  tasks: new Map(),   // taskId -> task (CareState.tasks shape)
  taskSeq: 0,
  restore: null,      // active restore task or null
  restoreQueued: null, // closed outage waiting for the update queue to finish
  updateTask: null,    // active update task or null
  coldRestore: false,  // cold-start restore deferred behind an update
  ownRecent: new Map(),// model id -> expiry ms: this PC's own load/unload (for log attribution)
  acPower: null,      // null = unknown (unreachable or read failed)
  lastPush: 0,
};

/* ---------- reach ---------- */

// jget throws 'HTTP <n> …' when the device answers with an error status
// (link up) and a fetch/abort error when nothing answers (link down).
const failureKind = (e) =>
  /^HTTP \d{3}/.test(String((e && e.message) || '')) ? 'http' : 'net';

function computeReach(now) {
  if (!S.failSince)
    return { state: 'reachable', lastRead: S.lastGood, since: 0, everyMs: POLL_MS };
  const age = S.lastGood ? now - S.lastGood : now - S.failSince;
  if (S.failKind === 'net')
    return age > OUTAGE_MS
      ? { state: 'unreachable', lastRead: S.lastGood, since: S.failSince, everyMs: POLL_MS }
      : { state: 'reachable', lastRead: S.lastGood, since: 0, everyMs: POLL_MS }; // wobble
  return age > STALE_MS
    ? { state: 'stale', lastRead: S.lastGood, since: S.failSince, everyMs: POLL_MS }
    : { state: 'reachable', lastRead: S.lastGood, since: 0, everyMs: POLL_MS };
}

/* ---------- snapshot ---------- */

// In-memory ids in load order (oldest first = the restore order): kept ids
// keep their place, vanished ids drop out (a later load re-appends them).
function touchSnapshot(ids) {
  const now = Date.now();
  const seen = new Set();
  const next = [];
  for (const s of S.snapshot)
    if (ids.includes(s.id)) { next.push(s); seen.add(s.id); }
  for (const id of ids) if (!seen.has(id)) next.push({ id, t: now });
  S.snapshot = next;
  if (S.store && S.owner) S.store.setLastSnapshot(now, next.map((x) => x.id));
}

/* ---------- activity log ---------- */

// { t, event, detail, by: "pc"|"device" }; 'device' = this PC did not ask.
const logEvent = (event, detail = '', by = 'pc') =>
  S.store && S.owner ? S.store.log(event, detail, by) : null;

// Own actions (this PC asked for the load/unload) are marked with a short
// window: the device reports asynchronously, so the next poll's diff must
// still be able to attribute the change to us.
const markOwn = (id) => S.ownRecent.set(String(id), Date.now() + 30000);
const isOwn = (id) => (S.ownRecent.get(String(id)) || 0) > Date.now();

// Diff between two good reads: loads/unloads this PC did not ask for are
// "by another client" (by = device); ones it did are by = pc. Suppressed
// while an outage is open: the models left because the device went down,
// the outage record already documents before/after.
function diffAndLog(prevIds, nowIds) {
  if (S.outage && !S.outage.back) return;
  const prev = new Set(prevIds), now = new Set(nowIds);
  for (const id of nowIds) if (!prev.has(id))
    logEvent('loaded', shortName(id), isOwn(id) ? 'pc' : 'device');
  for (const id of prevIds) if (!now.has(id))
    logEvent('unloaded', shortName(id), isOwn(id) ? 'pc' : 'device');
}

/* ---------- outage ---------- */

function openOutage(lostAt) {
  if (S.outage && !S.outage.back) return;
  S.outage = {
    lost: lostAt, back: 0,
    beforeIds: S.snapshot.map((x) => x.id),
    backIds: [], restored: [], notRestored: [],
  };
  logEvent('outage-start', 'device stopped answering', 'device');
}

function closeOutage(now, ids) {
  const o = S.outage;
  if (!o) return;
  o.back = now;
  o.backIds = [...ids];
  const gap = Math.round((now - o.lost) / 1000);
  logEvent('outage',
    `no answer for ${gap} s · link back · ${ids.length} model(s) in memory`, 'device');
  S.outages.unshift(o);
  if (S.outages.length > 20) S.outages.length = 20;
  S.outage = null;
  startRestore(o); // policy decides whether it does anything
}

/* ---------- poll ---------- */

async function pollOnce() {
  if (!S.owner) claim(); // the holder may have quit since the last poll
  const t0 = Date.now();
  let ids = null;
  try {
    const run = await jget(`${BASE}/api/v1/models/running`, 8000);
    S.running = (run.instances && run.instances.running) || [];
    S.pending = (run.instances && run.instances.pending) || [];
    try { // secondary read: in-memory list (degradation, not an outage)
      const v1 = await jget(`${BASE}/v1/models`, 8000);
      const v1ids = (v1.data || []).map((x) => x.id);
      if (v1ids.length) ids = v1ids;
    } catch { /* keep the running[] ids */ }
    if (ids === null) ids = S.running.map((r) => r.model_id);
  } catch (e) {
    S.failKind = failureKind(e);
    if (!S.failSince) S.failSince = t0;
    // The link went down: open the outage record (idempotent). An 'http'
    // failure (link up, bad read) never opens one: a pause is not an outage.
    if (S.failKind === 'net' && S.lastGood) openOutage(S.lastGood);
    S.reach = computeReach(Date.now());
    S.acPower = null; // no read while the device is silent
    pushIfChanged();
    return;
  }

  const now = Date.now();
  const wasDown = S.failSince > 0;
  const wasCold = S.lastGood === 0;
  const gap = S.lastGood ? now - S.lastGood : null;
  const netDown = S.failKind === 'net';
  S.failSince = 0; S.failKind = null;
  S.lastGood = now;
  S.reach = { state: 'reachable', lastRead: now, since: 0, everyMs: POLL_MS };

  let closedOutage = false;
  if (S.outage) {
    if (gap != null && gap > OUTAGE_MS) {
      closeOutage(now, ids); // real outage: record + restore
      closedOutage = true;
    } else {
      // brief blip under the 15 s threshold: not an outage, drop the record
      S.outage = null;
    }
  } else if (wasDown && netDown && S.lastGood === 0) {
    // The device was down before this engine ever read it (app started
    // mid-outage): the gap is unknowable, so no record, just a note.
    logEvent('recovered', 'device answers again (it was already down at start)', 'device');
  }
  // A diff is meaningful between two comparable reads only: the first read
  // (cold start) just initialises, and a read that closes an outage is
  // explained by the outage record (before/after), not by single events.
  if (!wasCold && !closedOutage) diffAndLog(S.lastIds, ids);
  S.lastIds = [...ids];
  touchSnapshot(ids);
  // On app start and after every outage: pick a journal-resident update back
  // up. A cold start (first read, or app started while the device was down)
  // additionally re-fills what the device is missing per policy — that covers
  // a device reboot that happened while the app was closed (no outage was
  // observed, so nothing else would trigger a restore).
  if (wasCold) S.coldRestore = true;
  maybeResume();
  if (wasCold) startRestore(null);

  try {
    const a = await jget(`${BASE}/api/v1/sys/ac_power/`, 8000);
    S.acPower = !!a.ac_power;
  } catch { S.acPower = null; } // unknown: the read failed, do not guess

  pushIfChanged();
}

/* ---------- restore ---------- */

// After an outage: load what the policy wants and the device does not have,
// one at a time, in load order. Never unloads anything: a model that would
// evict another is reported and skipped.
async function startRestore(outage) {
  if (!S.owner || S.restore) return null;
  // One thing at a time on the device: while an update runs (or is waiting in
  // the journal) the restore defers and runs when the update queue finishes.
  if (S.updateTask || S.store.journal()) {
    if (outage) S.restoreQueued = outage;
    return null;
  }
  S.coldRestore = false; // the cold window is over whether we act or not
  const care = S.store.care();
  if (care.policy.reload === 'off') return null;
  // Load order source: the outage record (what was in memory when the link
  // dropped — the live snapshot is empty by now if the restore was deferred);
  // otherwise the current/persisted snapshot (cold-start restore).
  const source = outage && outage.beforeIds && outage.beforeIds.length
    ? outage.beforeIds
    : S.snapshot.map((x) => x.id);
  const want = (care.policy.reload === 'all'
    ? source
    : source.filter((id) => care.kept.includes(id)));
  if (!want.length) return null;
  // The task is created before the first await: currentTask() and the
  // activity line must see it as soon as the poll that triggered it returns.
  const task = newTask('restore', shortName(want[0]), 'pc');
  S.restore = task;
  task.state = 'running';
  const have = new Set(await runningIds().catch(() => []));
  const missing = want.filter((id) => !have.has(id));
  if (!missing.length) { // everything the policy wants is already back
    task.state = 'done';
    task.progress = 1;
    S.restore = null;
    pushIfChanged();
    return task;
  }
  task.steps = missing.length;
  let done = 0;
  for (const id of missing) {
    if (task.stopRequested) { task.state = 'interrupted'; break; }
    task.step = done + 1;
    task.label = shortName(id);
    task.note = `${done + 1} of ${missing.length}`;
    let plan = null;
    try { plan = await fitPlan(id); } catch { /* unreachable mid-restore: skip */ }
    if (plan && !plan.fits) {
      const why = `needs ${Math.round(plan.npuRequired)} NPU, ${Math.round(plan.npuAvailable)} free — would unload ${plan.evicts.map(shortName).join(', ')}`;
      if (outage) outage.notRestored.push({ id, reason: why });
      logEvent('not-restored', `${shortName(id)} · ${why}`);
      task.note = why;
      pushIfChanged();
      continue; // never evict
    }
    markOwn(id);
    try {
      await ensureLoaded(id, (p) => {
        if (p != null) { task.progress = p / 100; pushIfChanged(); }
      }, { timeoutMs: LOAD_TIMEOUT_MS, pollMs: LOAD_POLL_MS });
      if (outage) outage.restored.push(id);
      logEvent('restored', shortName(id));
      done++;
      task.progress = done / missing.length;
    } catch (e) {
      if (outage) outage.notRestored.push({ id, reason: e.message });
      logEvent('restore-failed', `${shortName(id)} · ${e.message}`);
      task.note = e.message;
      if (!task.stopRequested) { task.state = 'failed'; break; }
    } finally {
      pushIfChanged();
    }
  }
  if (task.state === 'running') {
    task.state = task.stopRequested ? 'interrupted' : 'done';
    task.progress = 1;
  }
  S.restore = null;
  pushIfChanged();
  return task;
}

/* ---------- updates (journal-driven, resumable) ---------- */

// An update is four steps; the journal (store.journal()) is written BEFORE
// each step, so an app restart or a power cut resumes exactly where it
// stopped:
//   1 unload (only if it was in memory)
//   2 DELETE the installed copy
//   3 download (POST + progress watch)
//   4 reload (only if it was in memory)
// A download in flight is considered lost after a device reboot: step 3
// re-issues it. Resume re-checks the device state per step, so a step that
// already finished before the cut is skipped, not redone.

// Store list: the fake answers {data:[...]}; accept other shapes too.
const storeList = async () => {
  const r = await jget(`${BASE}/api/v1/models/?including_downloading=true`, 15000);
  if (Array.isArray(r.data)) return r.data;
  if (Array.isArray(r.entries)) return r.entries;
  if (Array.isArray(r.groups)) return r.groups.flatMap((g) => g.entries || []);
  return [];
};
const storeEntry = async (id) => (await storeList()).find((e) => e.id === id) || null;

// Watches a download until it stops reporting 'downloading'. 'fail' throws;
// a net failure (device gone) propagates — the journal owns the resume point.
async function watchDownload(model, task, onProgress) {
  for (let waited = 0; waited < DOWNLOAD_TIMEOUT_MS; waited += LOAD_POLL_MS) {
    let st;
    try {
      st = await jget(`${BASE}/api/v1/models/${mpath(model)}/get_progress`, 10000);
    } catch (e) {
      if (failureKind(e) === 'net') throw e;
      throw new Error('progress read failed: ' + e.message);
    }
    if (st.status === 'fail')
      throw new Error(`download failed (${st.error_code || st.message || 'unknown'})`);
    if (st.status !== 'downloading') {
      const e = await storeEntry(model);
      if (!e || e.need_update)
        throw new Error('download finished but the model is not updated');
      onProgress(1);
      return e;
    }
    onProgress(typeof st.progress === 'number' ? st.progress / 100 : 0);
    await new Promise((r) => setTimeout(r, LOAD_POLL_MS));
  }
  throw new Error('download timed out');
}

async function runUpdate(model, from, to, wasLoaded, startStep, queue, task) {
  S.updateTask = task;
  task.state = 'running';
  task.steps = 4;
  // 'to' is only a label from the store list; the real new version comes from
  // the store entry once the download finished (newVersion).
  let newVersion = to || null;
  try {
    for (let step = startStep; step <= 4; step++) {
      if (task.stopRequested) {
        // Stop "after the current step": the journal keeps the resume point
        // (a stopped update is not complete; the next start picks it up).
        S.store.writeJournal({ model, from, to, step, wasLoaded,
          startedAt: task.startedAt, queue });
        task.state = 'interrupted';
        task.note = 'stopped before step ' + step;
        logEvent('update-stopped', `${shortName(model)} · stopped before step ${step}`);
        break;
      }
      S.store.writeJournal({ model, from, to, step, wasLoaded,
        startedAt: task.startedAt, queue });
      task.step = step;
      task.label = shortName(model);
      task.note = `step ${step} of 4`;
      if (step === 1 && wasLoaded) {
        const have = await runningIds().catch(() => []);
        if (have.has(model)) {
          markOwn(model);
          await ensureUnloaded(model, null,
            { timeoutMs: LOAD_TIMEOUT_MS, pollMs: LOAD_POLL_MS });
        }
      } else if (step === 2) {
        const e = await storeEntry(model);
        if (e && e.status !== 'downloading') {
          await jdelete(`${BASE}/api/v1/models/${mpath(model)}`, 120000); // may take a while
        } // already deleted, or a download is in flight: nothing to do
      } else if (step === 3) {
        const e = await storeEntry(model);
        if (!(e && !e.need_update)) { // not up to date yet: (re)start the download
          await jpost(`${BASE}/api/v1/models/${mpath(model)}/download`, {}, 30000);
          const done = await watchDownload(model, task,
            (p) => { task.progress = p; pushIfChanged(); });
          newVersion = done.version || newVersion; // the store entry after the download
        }
      } else if (step === 4 && wasLoaded) {
        markOwn(model);
        await ensureLoaded(model, (p) => {
          if (p != null) { task.progress = p / 100; pushIfChanged(); }
        }, { timeoutMs: LOAD_TIMEOUT_MS, pollMs: LOAD_POLL_MS });
      }
    }
    if (task.state !== 'interrupted') {
      task.state = 'done';
      task.progress = 1;
      S.store.clearJournal();
      logEvent('updated', `${shortName(model)} · ${from || '?'} → ${newVersion || 'updated'}`);
    }
  } catch (e) {
    // Device gone (power cut) or hard error: the journal written before this
    // step is the resume point; keep it and release the slot.
    task.state = 'interrupted';
    task.note = e.message;
    logEvent('update-interrupted', `${shortName(model)} · step ${task.step} · ${e.message}`);
  } finally {
    S.updateTask = null;
    pushIfChanged();
  }
  if (queue.length && task.state === 'done') {
    const [next, ...rest] = queue;
    const nt = S.tasks.get(next.taskId);
    if (nt) { nt.state = 'running'; nt.step = 0; nt.progress = 0; nt.note = 'from queue'; }
    runUpdate(next.model, next.from, next.to, next.wasLoaded, 1, rest,
      nt || newTask('update', shortName(next.model), 'pc'));
  } else if (S.restoreQueued) {
    const o = S.restoreQueued;
    S.restoreQueued = null;
    startRestore(o);
  } else if (S.coldRestore) {
    // cold-start restore that deferred behind this update: run it now
    S.coldRestore = false;
    startRestore(null);
  }
}

// Resume: on app start and after every outage. No-op unless a journal exists
// and no update is already running.
async function maybeResume() {
  if (!S.owner || S.updateTask) return;
  const j = S.store.journal();
  if (!j) return;
  if (S.restore) return; // restore is running; it defers while this journal exists
  const queue = (j.queue || []).filter((q) => q.model !== j.model);
  const task = newTask('update', shortName(j.model), 'pc');
  task.note = `resumed at step ${j.step}`;
  logEvent('update-resumed', `${shortName(j.model)} · step ${j.step}`);
  runUpdate(j.model, j.from, j.to, j.wasLoaded, j.step, queue, task);
}

// Starts an update of one installed model. If a journal for the same model
// exists (a stopped/interrupted update), it resumes from there — even when
// the download already completed (need_update is then false, but the reload
// step is still pending). Throws if the model is unknown, not installed, up
// to date, or another update is in flight.
async function update(modelId) {
  notOwner();
  if (S.restore) throw new Error('restore in progress, try again shortly');
  if (S.updateTask) throw new Error('an update is already running');
  const e = await storeEntry(modelId);
  if (!e) throw new Error('model not found on device');
  if (e.status !== 'installed' && e.status !== 'stopped' && e.status !== 'loaded')
    throw new Error('model not installed (status ' + e.status + ')');
  const j = S.store.journal();
  if (j && j.model !== modelId)
    throw new Error('another update is in flight (' + shortName(j.model) + ')');
  const isResume = !!(j && j.model === modelId);
  if (!e.need_update && !isResume) throw new Error('model is up to date');
  const wasLoaded = isResume ? j.wasLoaded : (await runningIds()).has(modelId);
  const task = newTask('update', shortName(modelId), 'pc');
  const startStep = isResume ? j.step : 1;
  const queue = isResume ? (j.queue || []).filter((q) => q.model !== modelId) : [];
  if (isResume) {
    task.note = `resumed at step ${startStep}`;
    logEvent('update-resumed', `${shortName(modelId)} · step ${startStep}`);
  }
  runUpdate(modelId, e.version, e.version_label || null, wasLoaded, startStep, queue, task);
  return { taskId: task.id };
}

// Queues every installed model that has an update, one at a time.
async function updateAll() {
  notOwner();
  if (S.restore) throw new Error('restore in progress, try again shortly');
  if (S.updateTask) return { taskIds: [S.updateTask.id] };
  const queue = (await storeList())
    .filter((e) => e.need_update && e.status !== 'downloading')
    .map((e) => ({ model: e.id, from: e.version, to: e.version_label || null,
      wasLoaded: false, taskId: '' }));
  if (!queue.length) return { taskIds: [] };
  const have = await runningIds().catch(() => new Set());
  for (const q of queue) {
    q.wasLoaded = have.has(q.model);
    q.taskId = newTask('update', shortName(q.model), 'pc').id;
  }
  logEvent('update-all', `${queue.length} update(s) queued, one at a time`);
  const first = queue.shift();
  runUpdate(first.model, first.from, first.to, first.wasLoaded, 1, queue,
    S.tasks.get(first.taskId));
  return { taskIds: [...queue.map((q) => q.taskId), first.taskId] };
}

/* ---------- ac power ---------- */

const getAcPower = async () => {
  try {
    const a = await jget(`${BASE}/api/v1/sys/ac_power/`, 8000);
    S.acPower = !!a.ac_power;
  } catch { S.acPower = null; }
  return S.acPower;
};

// POST is docs-only (untested on the device): we set it and re-read the GET.
const setAcPower = async (on) => {
  await jpost(`${BASE}/api/v1/sys/ac_power/`, { switch: on ? 1 : 0 }, 30000);
  logEvent('ac-power', on ? 'set to on' : 'set to off');
  return getAcPower();
};

/* ---------- usage (passthrough, docs+OWNER shapes) ---------- */

// weekStart must be a Monday 'YYYY-MM-DD'; the device returns 7 days from it.
const mondayOf = (d = new Date()) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const off = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - off);
  return x.toISOString().slice(0, 10);
};

const usage = async (weekStart = mondayOf()) => ({
  weekStart,
  days: await jget(`${BASE}/api/v1/statistics/week_usage?start_date=${weekStart}`, 15000),
  readAt: Date.now(),
});

const appUsage = async (weekStart = mondayOf()) => ({
  weekStart,
  apps: await jget(`${BASE}/api/v1/statistics/app_week_usage?start_date=${weekStart}`, 15000),
  readAt: Date.now(),
});

/* ---------- tasks ---------- */

// CareState.tasks row. One at a time: restore and updates serialize on the
// device (it does one thing at a time).
function newTask(kind, label, where = 'pc') {
  const id = 't' + (++S.taskSeq);
  const t = {
    id, kind, label, where,
    state: 'queued', // queued|running|waiting|done|failed|interrupted
    progress: 0, step: 0, steps: 0,
    startedAt: Date.now(),
    note: '', stopRequested: false,
  };
  S.tasks.set(id, t);
  if (S.tasks.size > 50) { // keep the log small: drop the oldest done/failed
    for (const [k, v] of S.tasks)
      if (v.state !== 'running' && v.state !== 'queued' && v.state !== 'waiting') {
        S.tasks.delete(k);
        break;
      }
  }
  return t;
}

function stopTask(id) {
  const t = S.tasks.get(id);
  if (!t) return false;
  t.stopRequested = true; // stops after the current step (contract)
  if (t.state === 'queued') t.state = 'interrupted';
  return true;
}

// The single busiest task for the strip / ball / tray line (contract: one
// line only). Restore beats update beats download beats benchmark.
function currentTask() {
  const rank = { restore: 0, update: 1, download: 2, benchmark: 3 };
  const active = [...S.tasks.values()]
    .filter((t) => ['queued', 'running', 'waiting'].includes(t.state))
    .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.startedAt - b.startedAt);
  if (!active.length) return null;
  const t = active[0];
  let line;
  if (t.kind === 'restore')
    line = `Restoring ${t.label} · ${Math.round(t.progress * 100)}%`;
  else if (t.kind === 'update')
    line = `Updating ${t.label} · step ${t.step} of ${t.steps}` +
      (t.progress ? ` · ${Math.round(t.progress * 100)}%` : '');
  else if (t.kind === 'download')
    line = `Downloading ${t.label} · ${Math.round(t.progress * 100)}%`;
  else
    line = `Benchmarking ${t.label}`;
  return { id: t.id, kind: t.kind, label: t.label, line, progress: t.progress };
}

/* ---------- CareState ---------- */

function state() {
  const care = S.store ? S.store.care() : { policy: { reload: 'off' }, kept: [] };
  return {
    reach: S.reach,
    running: S.running.map((r) => ({
      id: r.model_id, status: r.status, progress: r.progress ?? 0,
      activeRequests: r.active_request_count ?? 0,
      lastInference: r.last_inference_time || 0, npu: r.npu_usage ?? 0,
    })),
    pending: [...S.pending],
    tasks: [...S.tasks.values()].map((t) => ({
      id: t.id, kind: t.kind, label: t.label, where: t.where, state: t.state,
      progress: t.progress, step: t.step, steps: t.steps,
      startedAt: t.startedAt, note: t.note,
    })),
    policy: care.policy,
    kept: care.kept,
    acPower: S.acPower,
    outages: S.outages,
    lastSnapshot: S.store ? S.store.care().lastSnapshot : null,
    engine: { owner: S.owner, holder: S.holder ? { pid: S.holder.pid, tool: S.holder.tool } : null },
  };
}

function pushIfChanged() {
  const now = Date.now();
  if (now - S.lastPush < 1000) return; // ≤1/s (contract)
  S.lastPush = now;
  if (S.win && !S.win.isDestroyed()) S.win.webContents.send('m3:device:changed', state());
}

/* ---------- lifecycle ---------- */

// Take engine.lock if free or stale (holder pid gone). No age bound: a live
// holder keeps it until it quits.
function claim() {
  if (!S.lockPath) return;
  const was = S.owner;
  let r;
  try { r = lock.acquire(S.lockPath, { tool: process.env.TIINY_TOOL || 'tiinyos' }); }
  catch (e) { r = { ok: false, holder: null }; console.error('[M3] engine lock:', e.message); }
  S.owner = r.ok;
  S.holder = r.ok ? null : r.holder;
  if (S.owner && !was) {
    console.log('[M3] care engine: this process now runs restore and updates');
    maybeResume();
  }
}

function notOwner() {
  if (S.owner) return;
  const who = S.holder ? `${S.holder.tool || 'another app'} (pid ${S.holder.pid})` : 'another app';
  throw new Error(`updates run in ${who}; use the Device window there`);
}

// Start the engine (idempotent). baseDir injects the store dir (tests use a
// temp dir; the app uses the default ~/.config/tiinyos-linux). pollMs = 0
// disables the timer (tests drive _pollOnce by hand); outageMs/staleMs/
// loadPollMs shrink the contract timings for tests only.
function start(opts = {}) {
  if (S.timer) return S;
  if (!S.store) S.store = createStore(opts.baseDir);
  if (opts.outageMs) OUTAGE_MS = opts.outageMs;
  if (opts.staleMs) STALE_MS = opts.staleMs;
  if (opts.loadPollMs) LOAD_POLL_MS = opts.loadPollMs;
  // seed the snapshot from the last session (persisted in care.json)
  const prev = S.store.care().lastSnapshot;
  if (prev) S.snapshot = prev.ids.map((id) => ({ id, t: prev.t }));
  const pm = opts.pollMs === undefined ? POLL_MS : opts.pollMs;
  if (pm > 0 || opts.lock) {
    S.lockPath = path.join(S.store.dir, 'engine.lock');
    S.owner = false;
    claim();
    if (!S.exitHook) {
      S.exitHook = true;
      process.once('exit', () => { if (S.owner && S.lockPath) lock.release(S.lockPath); });
    }
  }
  if (pm > 0) {
    S.timer = setInterval(() => { pollOnce().catch(() => {}); }, pm);
    if (S.timer.unref) S.timer.unref(); // never hold the process open in tests
    pollOnce().catch(() => {}); // first read right away
    console.log('[M3] care engine started (poll every ' + (pm / 1000) + ' s)');
  }
  return S;
}

// Reset the module state (test isolation between scenarios in one process).
function _reset() {
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  if (S.lockPath && S.owner) lock.release(S.lockPath);
  S.owner = true; S.holder = null; S.lockPath = null;
  S.store = null; S.win = null;
  S.lastGood = 0; S.failSince = 0; S.failKind = null;
  S.reach = { state: 'unreachable', lastRead: 0, since: 0, everyMs: POLL_MS };
  S.lastIds = []; S.running = []; S.pending = [];
  S.snapshot = []; S.outage = null; S.outages = [];
  S.tasks = new Map(); S.taskSeq = 0; S.restore = null;
  S.restoreQueued = null; S.updateTask = null; S.coldRestore = false;
  S.ownRecent = new Map(); S.acPower = null; S.lastPush = 0;
  OUTAGE_MS = 15000; STALE_MS = 60000; LOAD_POLL_MS = 1500;
}

// Register the m3:device:* IPC (contract table) and push m3:device:changed to the
// Device window. Electron is required here, not at module top level, so the
// core stays testable under bare node. Called once by m3_performance.
// Inventory for the Models tab: every installed model with its update
// state, whether it is in memory, and whether this PC keeps it loaded.
async function installedModels() {
  const [list, have] = await Promise.all([storeList(),
    runningIds().catch(() => new Set())]);
  const care = S.store.care();
  const kept = new Set(care.kept);
  return { models: list.map((e) => ({
    id: e.id, display_name: e.display_name || e.name || '', type: e.type || '',
    status: e.status || '', progress: e.progress ?? 0,
    total_size: e.total_size || 0, npu_usage: e.npu_usage ?? 0,
    version: e.version || '', version_label: e.version_label || '',
    need_update: !!e.need_update,
    update_title: e.update_title || '', update_desc: e.update_desc || '',
    kept: kept.has(e.id), inMemory: have.has(e.id),
  }))};
}

function wire(win) {
  const { ipcMain } = require('electron'); // lazy on purpose
  S.win = win || null;
  const once = (name) => {
    try { ipcMain.removeHandler(name); } catch { /* first run */ }
    return ipcMain.handle.bind(ipcMain, name);
  };
  once('m3:device:state')(() => state());
  once('m3:device:models')(() => installedModels());
  once('m3:device:usage')((_e, arg) => usage(arg && arg.weekStart));
  once('m3:device:appUsage')((_e, arg) => appUsage(arg && arg.weekStart));
  once('m3:device:log')((_e, arg) => S.store.readLog(arg && arg.since));
  once('m3:device:setAcPower')(async (_e, arg) =>
    ({ acPower: await setAcPower(!!(arg && arg.on)) }));
  once('m3:device:setPolicy')(async (_e, arg) => {
    const reload = String((arg && arg.reload) || 'off');
    if (!['off', 'kept', 'all'].includes(reload)) throw new Error('bad policy: ' + reload);
    S.store.setPolicy(reload);
    return { reload };
  });
  once('m3:device:keep')(async (_e, arg) => {
    const care = S.store.care();
    const kept = new Set(care.kept);
    const id = String((arg && arg.id) || '');
    if (arg && arg.on) kept.add(id); else kept.delete(id);
    S.store.setKept([...kept]);
    return { kept: S.store.care().kept };
  });
  once('m3:device:load')(async (_e, arg) => {
    const id = String((arg && arg.id) || '');
    markOwn(id);
    await ensureLoaded(id);
    return { ok: true };
  });
  once('m3:device:unload')(async (_e, arg) => {
    const id = String((arg && arg.id) || '');
    markOwn(id);
    await ensureUnloaded(id);
    return { ok: true };
  });
  once('m3:device:update')(async (_e, arg) => update(String((arg && arg.id) || '')));
  once('m3:device:updateAll')(() => updateAll());
  once('m3:device:stopTask')((_e, arg) => {
    const id = String((arg && (arg.taskId != null ? arg.taskId : arg.id)) || '');
    return { ok: stopTask(id) };
  });
  if (win && win.webContents) {
    win.webContents.once('did-finish-load', () => {
      pushIfChanged(); S.lastPush = 0; // deliver the first state right away
    });
  }
  return S;
}

module.exports = {
  POLL_MS, OUTAGE_MS, STALE_MS,
  _S: S, _pollOnce: pollOnce, _startRestore: startRestore,
  _newTask: newTask, _stopTask: stopTask, _state: state, _reset, _claim: claim,
  getAcPower, setAcPower, usage, appUsage, mondayOf, logEvent, markOwn,
  currentTask, state, start, wire, installedModels,
  update, updateAll, maybeResume,
};
