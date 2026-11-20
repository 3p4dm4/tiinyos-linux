// Node tests for src/m3_care_store.js in a temp dir (never touches real config).
//
// Run: node --test tests/js/*.test.js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, defaultCare, LOG_KEEP_MS } =
  require(path.resolve(__dirname, '..', '..', 'src', 'm3_care_store.js'));

const dirs = [];
const tmpStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-store-'));
  dirs.push(dir);
  return createStore(dir);
};

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('a fresh store has the default care state', () => {
  const s = tmpStore();
  assert.deepEqual(s.care(), defaultCare());
  assert.equal(s.journal(), null);
  assert.deepEqual(s.readLog().entries, []);
});

test('setPolicy validates and persists; a second store instance sees it', () => {
  const s = tmpStore();
  assert.throws(() => s.setPolicy('yolo'), /bad reload policy/);
  s.setPolicy('kept');
  const fresh = createStore(s.dir);
  assert.equal(fresh.care().policy.reload, 'kept');
  s.setPolicy('all');
  assert.equal(s.care().policy.reload, 'all');
});

test('setKept dedupes, sorts and persists', () => {
  const s = tmpStore();
  s.setKept(['tiiny/b', 'tiiny/a', 'tiiny/b']);
  assert.deepEqual(s.care().kept, ['tiiny/a', 'tiiny/b']);
  assert.deepEqual(createStore(s.dir).care().kept, ['tiiny/a', 'tiiny/b']);
  s.setKept([]);
  assert.deepEqual(s.care().kept, []);
});

test('setLastSnapshot persists the ids in the given order', () => {
  const s = tmpStore();
  s.setLastSnapshot(123, ['first-loaded', 'second-loaded']);
  assert.deepEqual(createStore(s.dir).care().lastSnapshot,
    { t: 123, ids: ['first-loaded', 'second-loaded'] });
});

test('care.json corrupted or half-written degrades to defaults, not a crash', () => {
  const s = tmpStore();
  s.setPolicy('all');
  fs.writeFileSync(path.join(s.dir, 'care.json'), '{"policy": {"reload": "all"'); // torn
  assert.equal(s.care().policy.reload, 'off'); // default, no throw
});

test('journal: write before a step, read it back, clear when done', () => {
  const s = tmpStore();
  const rec = { model: 'tiiny/x', from: '1.0', to: '2.0', step: 3, wasLoaded: true,
    startedAt: 42, queue: [] };
  s.writeJournal(rec);
  assert.deepEqual(createStore(s.dir).journal(), rec);
  s.writeJournal({ ...rec, step: 4 }); // overwrite before the next step
  assert.equal(createStore(s.dir).journal().step, 4);
  s.clearJournal();
  assert.equal(s.journal(), null);
  s.clearJournal(); // idempotent
});

test('log: appends newest-first readable entries with t/event/detail/by', () => {
  const s = tmpStore();
  s.log('loaded', 'a model', 'device');
  s.log('outage', 'no answer for 40 s');
  s.log('restored', 'a model', 'pc');
  const { entries } = s.readLog();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.event),
    ['restored', 'outage', 'loaded']); // newest first
  assert.equal(entries[0].by, 'pc');
  assert.equal(entries[2].by, 'device');
  assert.ok(entries.every((e) => typeof e.t === 'number' && e.t <= Date.now()));
});

test('log: rotates to 7 days (old entries drop on the next append)', () => {
  const s = tmpStore();
  const now = Date.now();
  const old = { t: now - LOG_KEEP_MS - 1000, event: 'ancient', detail: '', by: 'pc' };
  const young = { t: now - 1000, event: 'recent', detail: '', by: 'pc' };
  fs.writeFileSync(path.join(s.dir, 'care-log.jsonl'),
    [JSON.stringify(old), JSON.stringify(young)].join('\n') + '\n');
  s.log('new', '', 'pc'); // triggers the rotation
  const { entries } = s.readLog();
  assert.deepEqual(entries.map((e) => e.event), ['new', 'recent']); // ancient gone
});

test('log: a torn line is skipped, the rest of the log survives', () => {
  const s = tmpStore();
  const e = { t: Date.now() - 1000, event: 'ok', detail: '', by: 'pc' };
  fs.writeFileSync(path.join(s.dir, 'care-log.jsonl'),
    '{"t": ' + e.t + ', "event": "broken"' + '\n' + JSON.stringify(e) + '\n');
  assert.deepEqual(s.readLog().entries, [e]);
});

test('readLog honours sinceMs', () => {
  const s = tmpStore();
  const now = Date.now();
  const e = (t, event) => JSON.stringify({ t, event, detail: '', by: 'pc' });
  fs.writeFileSync(path.join(s.dir, 'care-log.jsonl'),
    [e(now - 3000, 'first'), e(now - 1000, 'second')].join('\n') + '\n');
  const { entries } = s.readLog(now - 2000);
  assert.deepEqual(entries.map((x) => x.event), ['second']);
});
