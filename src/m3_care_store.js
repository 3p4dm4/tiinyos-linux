/* M3 — Device care: PC-side state store (no Electron).
 *
 * Files (all in one base dir, default ~/.config/tiinyos-linux/):
 *   care.json         policy {reload: off|kept|all}, kept model ids, last
 *                     in-memory snapshot (ids in load order, oldest first — the
 *                     restore order)
 *   care-journal.json the update in flight: {model, from, to, step, wasLoaded,
 *                     startedAt, queue} — written BEFORE each step so a power
 *                     cut or app restart can resume it
 *   care-log.jsonl    activity log, one JSON entry per line {t, event, detail,
 *                     by: "pc"|"device"}, 7 days kept (rotated on each append)
 *
 * Every write is atomic (tmp file + rename): a crash never leaves a half
 * JSON behind. The base dir is injectable so tests run in a temp dir and
 * never touch the real config.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_BASE = path.join(os.homedir(), '.config', 'tiinyos-linux');
const CARE_NAME = 'care.json';
const JOURNAL_NAME = 'care-journal.json';
const LOG_NAME = 'care-log.jsonl';
const LOG_KEEP_MS = 7 * 24 * 3600 * 1000;
const POLICIES = ['off', 'kept', 'all'];

function defaultCare() {
  // reload defaults to 'off': restoring multi-GB models after a power cut is
  // an explicit user choice, never a silent default.
  return {
    policy: { reload: 'off' },
    kept: [],
    lastSnapshot: null, // { t: ms, ids: [id, ...] } load order, oldest first
  };
}

function createStore(baseDir) {
  const dir = baseDir || DEFAULT_BASE;
  const file = (name) => path.join(dir, name);
  const ensureDir = () => fs.mkdirSync(dir, { recursive: true });

  function writeText(name, text) {
    ensureDir();
    const tmp = file(name) + `.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file(name)); // atomic: readers see old or new, never half
  }
  const writeAtomic = (name, obj) =>
    writeText(name, JSON.stringify(obj, null, 1) + '\n');
  function readJson(name) {
    try {
      const o = JSON.parse(fs.readFileSync(file(name), 'utf8'));
      return o && typeof o === 'object' ? o : null;
    } catch { return null; } // missing or unreadable = default, never throws
  }

  /* ---------- care.json ---------- */
  function care() {
    const c = readJson(CARE_NAME) || {};
    const d = defaultCare();
    return {
      policy: {
        reload: POLICIES.includes(c.policy && c.policy.reload)
          ? c.policy.reload : d.policy.reload,
      },
      kept: Array.isArray(c.kept) ? c.kept.map(String) : [],
      lastSnapshot: c.lastSnapshot && typeof c.lastSnapshot.t === 'number' &&
        Array.isArray(c.lastSnapshot.ids)
        ? { t: c.lastSnapshot.t, ids: c.lastSnapshot.ids.map(String) }
        : null,
    };
  }
  const saveCare = (patch) => {
    const c = { ...care(), ...patch };
    writeAtomic(CARE_NAME, c);
    return c;
  };
  function setPolicy(reload) {
    if (!POLICIES.includes(reload)) throw new Error('bad reload policy: ' + reload);
    return saveCare({ policy: { reload } });
  }
  const setKept = (ids) => saveCare({ kept: [...new Set((ids || []).map(String))].sort() });
  // ids kept in the order the caller gives them (the engine maintains load
  // order, oldest first — the restore order); the store only dedupes.
  const setLastSnapshot = (t, ids) =>
    saveCare({ lastSnapshot: { t, ids: [...new Set((ids || []).map(String))] } });

  /* ---------- care-journal.json ---------- */
  // The journal holds at most one in-flight update (plus the queue of the
  // updateAll that started it). Written before every step: after a reboot the
  // journal says which step was committed and which one was in flight.
  const journal = () => readJson(JOURNAL_NAME);
  const writeJournal = (rec) => { writeAtomic(JOURNAL_NAME, rec); return rec; };
  function clearJournal() {
    try { fs.unlinkSync(file(JOURNAL_NAME)); } catch { /* never present: fine */ }
  }

  /* ---------- care-log.jsonl ---------- */
  function readLogLines() {
    let raw;
    try { raw = fs.readFileSync(file(LOG_NAME), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.t === 'number' && typeof e.event === 'string') out.push(e);
      } catch { /* a torn line is skipped, the rest of the log survives */ }
    }
    return out;
  }
  // Append one entry and rotate: anything older than 7 days is dropped.
  function log(event, detail = '', by = 'pc') {
    const now = Date.now();
    const fresh = now - LOG_KEEP_MS;
    const keep = readLogLines().filter((e) => e.t >= fresh);
    keep.push({ t: now, event, detail, by });
    writeText(LOG_NAME, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return keep[keep.length - 1];
  }
  // Newest first, 7 days only; sinceMs further limits to entries after it.
  // The file is chronological, so equal timestamps keep append order (later = newer).
  const readLog = (sinceMs = 0) => {
    const fresh = Date.now() - LOG_KEEP_MS;
    const entries = readLogLines()
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.t >= fresh && e.t >= (sinceMs || 0))
      .sort((a, b) => (b.e.t - a.e.t) || (b.i - a.i))
      .map(({ e }) => e);
    return { entries };
  };

  return {
    dir,
    care, setPolicy, setKept, setLastSnapshot,
    journal, writeJournal, clearJournal,
    log, readLog,
  };
}

module.exports = { createStore, defaultCare, LOG_KEEP_MS, DEFAULT_BASE };
