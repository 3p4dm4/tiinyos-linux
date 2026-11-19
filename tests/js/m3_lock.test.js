// Node tests for the cross-process engine lock (src/m3_lock.js).
//
// Everything runs against a temp dir with fabricated pids/mtime — never the
// real engine lock and never the real device. Run: node --test tests/js/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lock = require('../../src/m3_lock.js');

// A fresh temp dir per test so the cases never see each other's lock file.
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm3lock-'));
}
function lockPath(d) { return path.join(d, 'engine.lock'); }

// Find a pid that is (right now) NOT running, to simulate a dead holder.
function findDeadPid() {
  // start high and unlikely; walk down until kill(0) says "gone" (ESRCH)
  let pid = 2147483646;
  for (let i = 0; i < 20000; i++, pid -= 3) {
    try { process.kill(pid, 0); }           // alive (or EPERM) → try another
    catch (e) { if (e.code === 'ESRCH') return pid; }
  }
  throw new Error('could not find a dead pid to test with');
}

// A pid that IS running and is not this process: models a *different* holder
// whose lock must be respected (not clobbered).
function findLiveForeignPid() {
  for (let pid = 1; pid < 5000; pid++) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 0); return pid; }        // exists (success or EPERM)
    catch { /* gone, keep looking */ }
  }
  throw new Error('could not find a live foreign pid to test with');
}

test('acquire creates the lock and records holder fields', () => {
  const d = tmpdir();
  const r = lock.acquire(lockPath(d), { tool: 'device' });
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.equal(r.holder.pid, process.pid);
  assert.equal(r.holder.tool, 'device');
  assert.ok(typeof r.holder.startedAt === 'number');
  assert.ok(r.holder.host.length > 0);
  // on disk, valid JSON with the same pid
  const onDisk = JSON.parse(fs.readFileSync(lockPath(d), 'utf8'));
  assert.equal(onDisk.pid, process.pid);
});

test('a live foreign holder blocks a second acquirer (and blocks release)', () => {
  const d = tmpdir();
  const p = lockPath(d);
  const foreign = findLiveForeignPid();
  assert.notEqual(foreign, process.pid);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: foreign, startedAt: Date.now(), host: 'h', tool: 'other' }));
  // acquire: a live, non-stale foreign lock is NOT taken over
  const r = lock.acquire(p, { tool: 'device' });
  assert.equal(r.ok, false, 'a live foreign holder wins');
  assert.equal(r.holder.pid, foreign, 'reports the real holder');
  // release: we are not the owner, so we cannot remove it
  assert.equal(lock.release(p).ok, false);
  assert.ok(fs.existsSync(p), 'foreign lock untouched');
});

test('re-acquire by the owning pid is idempotent (single engine, same process)', () => {
  const d = tmpdir();
  const p = lockPath(d);
  lock.acquire(p, { tool: 'device' });
  const again = lock.acquire(p, { tool: 'device' });
  assert.equal(again.ok, true);
  assert.equal(again.stale, false);
});

test('release removes the lock only for the owner', () => {
  const d = tmpdir();
  const p = lockPath(d);
  const ok = lock.acquire(p, { tool: 'device' });
  assert.equal(ok.ok, true);
  // owner release succeeds
  assert.equal(lock.release(p).ok, true);
  assert.equal(lock.holder(p), null, 'lock gone after owner release');

  // non-owner release is refused: write a lock with a foreign (live-or-dead) pid
  const dead = findDeadPid();
  fs.writeFileSync(p, JSON.stringify({ pid: dead, startedAt: Date.now(), host: 'h', tool: 'x' }));
  const no = lock.release(p);
  assert.equal(no.ok, false, 'a non-owner pid cannot release');
  assert.ok(fs.existsSync(p), 'the non-owner lock was not removed');
  assert.equal(no.holder.pid, dead);
});

test('a stale lock (dead holder pid) is taken over by a new acquirer', () => {
  const d = tmpdir();
  const p = lockPath(d);
  const dead = findDeadPid();
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: dead, startedAt: Date.now(), host: 'h', tool: 'old' }));
  const r = lock.acquire(p, { tool: 'device' });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true, 'took over a stale (dead-pid) lock');
  assert.equal(r.holder.pid, process.pid);
});

test('a lock older than staleMs is taken over even if the pid is alive', () => {
  const d = tmpdir();
  const p = lockPath(d);
  const foreign = findLiveForeignPid();       // a live pid that is NOT us (no owner short-circuit)
  const old = Date.now() - 60000;            // 60 s ago, well past a 5 s staleMs
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: foreign, startedAt: old, host: 'h', tool: 'x' }));
  const r = lock.acquire(p, { staleMs: 5000, tool: 'device' });
  assert.equal(r.ok, true);
  assert.equal(r.stale, true, 'age bound overrode a live pid');
});

test('an unreadable lock is stale only once older than 5 s', () => {
  const d = tmpdir();
  const p = lockPath(d);
  fs.mkdirSync(d, { recursive: true });
  // (a) fresh garbage: NOT stale yet
  fs.writeFileSync(p, 'not-json');
  assert.equal(lock.isStale(p), false, 'fresh unreadable lock is not stale');
  assert.equal(lock.acquire(p).ok, false, 'cannot take a fresh unreadable lock');
  // (b) backdate it past 5 s: now stale
  const past = Date.now() / 1000 - 10;
  fs.utimesSync(p, past, past);
  assert.equal(lock.isStale(p), true, 'old unreadable lock is stale');
  assert.equal(lock.acquire(p).stale, true, 'took over the old unreadable lock');
});

test('holder() returns the recorded holder, or null when absent', () => {
  const d = tmpdir();
  const p = lockPath(d);
  assert.equal(lock.holder(p), null, 'no lock yet');
  lock.acquire(p, { tool: 'device' });
  assert.equal(lock.holder(p).pid, process.pid);
});
