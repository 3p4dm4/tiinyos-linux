'use strict';
// node:test for the pure Device-UI helpers (src/m3perf/helpers.js).
// No DOM, no IPC: everything here is arithmetic on plain objects/strings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../src/m3perf/helpers.js');

// A fixed reference instant (local) so time tests do not depend on the clock.
const NOW = new Date(2026, 10, 19, 16, 42, 18).getTime(); // 2026-11-19 16:42:18
const at = (h, m, s) => new Date(2026, 10, 19, h, m, s == null ? 0 : s).getTime();

/* ---------------- numbers ---------------- */
test('fmtInt uses en thousands separators', () => {
  assert.equal(H.fmtInt(1102), '1,102');
  assert.equal(H.fmtInt(14615900), '14,615,900');
  assert.equal(H.fmtInt(0), '0');
  assert.equal(H.fmtInt(850), '850');
  assert.equal(H.fmtInt(null), '—');
});

test('compact buckets into M / K / raw', () => {
  assert.equal(H.compact(14615900), '14.6M');
  assert.equal(H.compact(2782900), '2.8M');
  assert.equal(H.compact(2850), '3K');
  assert.equal(H.compact(850), '850');
  assert.equal(H.compact(0), '0');
});

test('fmtBytes picks GB/MB/KB', () => {
  assert.equal(H.fmtBytes(16.5 * 1073741824), '16.5 GB');
  assert.equal(H.fmtBytes(0.9 * 1073741824), '0.9 GB');
  assert.equal(H.fmtBytes(1.9 * 1073741824), '1.9 GB');
  assert.equal(H.fmtBytes(96 * 1048576), '96.0 MB');
  assert.equal(H.fmtBytes(512 * 1024), '512 KB');
});

test('pct rounds and nulls out', () => {
  assert.equal(H.pct(34.4), '34%');
  assert.equal(H.pct(0), '0%');
  assert.equal(H.pct(null), '—');
});

/* ---------------- time ---------------- */
test('fmtTime is 24 h with seconds', () => {
  assert.equal(H.fmtTime(NOW), '16:42:18');
  assert.equal(H.fmtTime(at(0, 5, 9)), '00:05:09');
  assert.equal(H.fmtTime(null), '—');
});

test('fmtTimeShort drops seconds', () => {
  assert.equal(H.fmtTimeShort(NOW), '16:42');
});

test('fmtDate / fmtDateShort handle dates, ms and ISO strings', () => {
  assert.equal(H.fmtDate(new Date(2026, 10, 19)), '2026-11-19');
  assert.equal(H.fmtDate('2026-11-09'), '2026-11-09');
  assert.equal(H.fmtDateShort('2026-11-19'), '11-19');
});

test('dow maps Monday-start weeks', () => {
  assert.equal(H.dow('2026-11-16'), 'Mon');
  assert.equal(H.dow('2026-11-19'), 'Thu');
  assert.equal(H.dow('2026-11-22'), 'Sun');
});

test('fmtDur and fmtDurApprox', () => {
  assert.equal(H.fmtDur(49), '49 s');
  assert.equal(H.fmtDur(190), '3 min 10 s');
  assert.equal(H.fmtDur(3600 + 240), '1 h 4 min');
  assert.equal(H.fmtDurApprox(180), '~3 min');
  assert.equal(H.fmtDurApprox(40), '~40 s');
  assert.equal(H.fmtDurApprox(3900), '~1 h');
});

/* ---------------- weeks ---------------- */
test('mondayOf / addDays / weekDates stay Monday-anchored', () => {
  assert.equal(H.mondayOf('2026-11-19'), '2026-11-16');
  assert.equal(H.mondayOf('2026-11-22'), '2026-11-16');
  assert.equal(H.mondayOf('2026-11-23'), '2026-11-23');
  assert.equal(H.addDays('2026-11-16', 6), '2026-11-22');
  const w = H.weekDates('2026-11-16');
  assert.equal(w.length, 7);
  assert.equal(w[0], '2026-11-16');
  assert.equal(w[6], '2026-11-22');
});

test('weekRange counts days so far', () => {
  const r = H.weekRange('2026-11-16', '2026-11-19');
  assert.equal(r.start, '2026-11-16');
  assert.equal(r.end, '2026-11-22');
  assert.equal(r.daysSoFar, 4);
  assert.equal(H.weekRange('2026-11-16').daysSoFar, null);
});

/* ---------------- usage aggregation ---------------- */
// Shape mirrors the m3:device:usage contract:
//   days: { "<YYYY-MM-DD>": { "<model id>": {prompt, completion, total, requests} } }
const DAYS = {
  '2026-11-16': {
    'a/chat': { prompt: 100, completion: 50, total: 150, requests: 10 },
    'b/embed': { prompt: 40, completion: 0, total: 40, requests: 8 },
  },
  '2026-11-17': {
    'a/chat': { prompt: 200, completion: 100, total: 300, requests: 20 },
  },
  '2026-11-18': {},
};

test('usageTotals sums across days and models', () => {
  const t = H.usageTotals(DAYS);
  assert.equal(t.prompt, 340);
  assert.equal(t.completion, 150);
  assert.equal(t.total, 490);
  assert.equal(t.requests, 38);
});

test('usageByModel sorts by total and derives perReq/share', () => {
  const m = H.usageByModel(DAYS);
  assert.deepEqual(m.map(x => x.id), ['a/chat', 'b/embed']);
  assert.equal(m[0].total, 450);
  assert.equal(m[0].perReq, 15); // 450 / 30
  assert.equal(m[0].share, 450 / 490);
  assert.equal(m[1].perReq, 5);   // 40 / 8
});

test('usagePerDay keeps per-model tokens and day totals', () => {
  const d = H.usagePerDay(DAYS);
  assert.equal(d.length, 3);
  assert.equal(d[0].dow, 'Mon');
  assert.equal(d[0].total, 190);
  assert.equal(d[0].byModel['a/chat'], 150);
  assert.equal(d[2].total, 0); // empty day
});

test('busiestDay picks the max-total day with its request count', () => {
  const b = H.busiestDay(DAYS);
  assert.equal(b.date, '2026-11-17');
  assert.equal(b.total, 300);
  assert.equal(b.requests, 20);
});

test('usageByApp shares and per-model breakdown', () => {
  const APPS = {
    TiinyOS: { total: 300, models: { 'a/chat': 250, 'b/embed': 50 } },
    default: { total: 190, models: { 'a/chat': 190 } },
  };
  const a = H.usageByApp(APPS);
  assert.deepEqual(a.map(x => x.app), ['TiinyOS', 'default']);
  assert.equal(a[0].share, 300 / 490);
  assert.equal(a[1].models['a/chat'], 190);
});

/* ---------------- series slots ---------------- */
test('seriesSlots assigns first-sight slots 1..8 and folds the rest into Other', () => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'];
  const { map, other } = H.seriesSlots(ids);
  assert.equal(map['m1'], 1);
  assert.equal(map['m8'], 8);
  assert.deepEqual(other, ['m9', 'm10']);
  // idempotent: re-seeing an id does not change its slot
  assert.equal(H.seriesSlots(['m1', 'm1']).map['m1'], 1);
});

/* ---------------- strip text ---------------- */
test('stripReach renders reachable / stale / unreachable', () => {
  const ok = H.stripReach({ state: 'reachable', lastRead: NOW, everyMs: 5000 }, NOW);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.word, 'Reachable');
  assert.match(ok.detail, /^last read 16:42:18 · every 5 s$/);

  const stale = H.stripReach({ state: 'stale', lastRead: at(16, 35, 40), everyMs: 5000 }, NOW);
  assert.equal(stale.state, 'warn');
  assert.match(stale.detail, /\(6 min 38 s ago\)/);

  const dead = H.stripReach({ state: 'unreachable', since: at(16, 31, 12), lastRead: at(16, 31, 7), everyMs: 5000 }, NOW);
  assert.equal(dead.state, 'bad');
  assert.equal(dead.word, 'Unreachable');
  assert.match(dead.detail, /since 16:31:12/);
  assert.match(dead.detail, /numbers below are from 16:31:07/);
});

test('stripReach reports a missing engine instead of crashing', () => {
  const r = H.stripReach(null, NOW);
  assert.equal(r.state, 'bad');
  assert.equal(r.word, 'Engine not available');
});

test('requestsLine sums requests and names the busiest model', () => {
  const r = H.requestsLine([
    { id: 'org/A', activeRequests: 1 },
    { id: 'org/B', activeRequests: 2 },
    { id: 'org/C', activeRequests: 0 },
  ]);
  assert.equal(r.count, 3);
  assert.equal(r.model, 'B');
  assert.equal(H.requestsLine([]).count, 0);
});

test('topTask orders restore > update > download > benchmark', () => {
  const tasks = [
    { id: 'b', kind: 'benchmark', state: 'running' },
    { id: 'd', kind: 'download', state: 'running', progress: 0.62 },
    { id: 'u', kind: 'update', state: 'waiting' },
    { id: 'r', kind: 'restore', state: 'waiting' },
  ];
  assert.equal(H.topTask(tasks).id, 'r');
  // a running download beats a queued restore? no: restore wins by kind regardless of state rank here
  assert.equal(H.topTask([tasks[3], tasks[1]]).id, 'r');
});

test('taskLine formats each kind', () => {
  assert.equal(H.taskLine(null), 'idle');
  assert.equal(
    H.taskLine({ kind: 'restore', label: 'org/AceStep-XL-Turbo', progress: 0.4, step: 1, steps: 3 }),
    'Restoring · AceStep-XL-Turbo 40% · 1 of 3');
  assert.equal(
    H.taskLine({ kind: 'update', label: 'd3-flash', progress: 0.62, step: 3, steps: 4 }),
    'Updating d3-flash · step 3 of 4 · downloading 62%');
  assert.equal(
    H.taskLine({ kind: 'download', label: 'org/ASR', progress: 0.62 }),
    'Downloading ASR · 62%');
});

test('shortName keeps the last path segment', () => {
  assert.equal(H.shortName('org/name'), 'name');
  assert.equal(H.shortName('plain'), 'plain');
});

test('useTags derives the Use pills from type + capabilities', () => {
  // chat (main capability / Image-Text-to-Text) + vision
  assert.deepEqual(
    H.useTags({ type: 'Image-Text-to-Text', capabilities: ['main'], supports_vision: true }),
    ['chat', 'vision']);
  // decision (systemone) takes precedence over chat
  assert.deepEqual(
    H.useTags({ type: 'Text Classification', capabilities: ['systemone'] }),
    ['decision']);
  // embedding
  assert.deepEqual(H.useTags({ type: 'Text Embedding', capabilities: ['embedding'] }), ['embedding']);
  // music / media are not chat
  assert.deepEqual(H.useTags({ type: 'Music Generation', capabilities: ['music'] }), ['music']);
  // speech + asr
  assert.deepEqual(H.useTags({ type: 'Text-to-Speech', capabilities: ['tts'] }), ['speech']);
  assert.deepEqual(H.useTags({ type: 'ASR', capabilities: [] }), ['asr']);
  // nothing recognised -> raw type, lowercased
  assert.deepEqual(H.useTags({ type: 'OCR' }), ['ocr']);
});

test('appLabel: "default" is shown as API clients, other names unchanged', () => {
  assert.equal(H.appLabel('default'), 'API clients (default)');
  assert.equal(H.appLabel('TiinyOS'), 'TiinyOS');
});

test('stripReach: first paint says Reading; a CareState with an empty pending[] is not first paint', () => {
  assert.equal(H.stripReach(null, NOW, true).word, 'Reading');
  // CareState carries pending: [] (loads in progress); it must not read as "first paint"
  const care = { reach: { state: 'reachable', lastRead: NOW, everyMs: 5000 }, pending: [] };
  assert.equal(H.stripReach(care.reach, NOW, care.firstPaint).word, 'Reachable');
});

test('fmtVersion shows the device date versions as dates', () => {
  assert.equal(H.fmtVersion('20261109'), '2026-11-09');
  assert.equal(H.fmtVersion('1.4.0'), '1.4.0');
  assert.equal(H.fmtVersion(null), '');
});

test('updateSteps: unload/reload only for a model in memory; question names both dates', () => {
  const m = { id: 'tiiny/Qwen3.6-35B-A3B', display_name: 'Qwen3.6-35B-A3B', version: '20261109', version_label: '20261119', total_size: 16.5e9 };
  assert.deepEqual(H.updateSteps(m, false).map((s) => s.skip), [true, false, false, true]);
  assert.deepEqual(H.updateSteps(m, true).map((s) => s.skip), [false, false, false, false]);
  assert.match(H.updateSteps(m, true)[2].text, /^Download 15\.4 GB$/); // fmtBytes is binary (GiB), as everywhere in the window
  assert.equal(H.updateQuestion(m), 'Update Qwen3.6-35B-A3B to the 2026-11-19 release? Installed: 2026-11-09.');
});

test('powerView reads the contract CareState (policy.reload, outages, restore task)', () => {
  const care = {
    policy: { reload: 'all' }, kept: ['a/k'], acPower: null,
    running: [{ id: 'a/m' }], lastSnapshot: { t: 1, ids: ['a/m', 'a/k'] },
    outages: [{ lost: 1000, back: 50000, beforeIds: ['a/m', 'a/k'], backIds: ['a/m'], restored: ['a/k'], notRestored: [] }],
    tasks: [{ id: 't1', kind: 'restore', label: 'x', state: 'running', step: 1, steps: 2, progress: 0.4, startedAt: 9 }],
  };
  const v = H.powerView(care, [{ id: 'a/s' }]);
  assert.equal(v.available, true);
  assert.equal(v.reload, 'all');
  assert.equal(v.acPower, null);
  assert.equal(v.lastInMemory, 2);
  assert.deepEqual(v.models.map((m) => [m.id, m.inMemory]), [['a/s', false], ['a/m', true], ['a/k', false]]);
  const o = v.outages[0];
  assert.deepEqual([o.stoppedAt, o.answeredAt, o.noAnswerSec, o.inMemoryBefore, o.backOnItsOwn], [1000, 50000, 49, 2, 1]);
  assert.equal(o.restore.state, 'Restored');
  assert.equal(v.restore.taskId, 't1');
  assert.deepEqual(v.restore.models.map((r) => r.state), ['Restored', 'Loading']);
  assert.equal(H.powerView(null, null).available, false);
});
