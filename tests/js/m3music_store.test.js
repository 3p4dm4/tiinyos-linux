/* M3 music store — tests: sidecar shape, take listing, cross-process lock, atomic write.
 * Node's built-in test runner only (node --test tests/js/): the store must stay
 * electron-free, which is exactly what this exercises in a bare Node process. */
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const store = require('../../src/m3music_store');

// a temp dir per test, all removed when the file finishes; never touches the real output folder
const dirs = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'm3music-store-'));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const write = (p, s) => fs.writeFileSync(p, s);
const READ = 'aia ooh hmm, a wall of sound'; // sample caption, no personal data

/* ---------- sidecarFor ---------- */
test('sidecar: shape, basenames only, nulls for missing fields', () => {
  const s = store.sidecarFor({
    createdAt: '2026-11-19T10:00:00.000Z',
    caption: READ, lyrics: '[intro]\naia [stop]', seconds: 180, seed: 42,
    composer: 'ACE-Step/AceStep-XL-Turbo', writer: 'some-org/ChatModel',
    // a full path sneaks in from a sloppy caller: must come out as a name
    reference: '/home/someone/Musica/references/track.mp3',
    elapsedSec: 95,
    wav: '/out/takes/my-take.wav', mp3: '/out/takes/my-take.mp3',
  });
  assert.equal(s.version, 1);
  assert.equal(s.createdAt, '2026-11-19T10:00:00.000Z');
  assert.equal(s.caption, READ);
  assert.equal(s.reference, 'track.mp3'); // basename, never a path
  assert.ok(!s.reference.includes('/') && !s.reference.includes('\\'));
  assert.deepEqual(s.files, { wav: 'my-take.wav', mp3: 'my-take.mp3' });
  for (const f of Object.values(s.files)) assert.ok(!f.includes('/') && !f.includes('\\'));
  // model ids legitimately carry '/' (id namespace, not a filesystem path)
  assert.equal(s.composer, 'ACE-Step/AceStep-XL-Turbo');
});

test('sidecar: missing fields become null, createdAt defaults to now', () => {
  const before = Date.now();
  const s = store.sidecarFor({ caption: 'x' });
  const after = Date.now();
  assert.equal(s.caption, 'x');
  assert.equal(s.lyrics, null);
  assert.equal(s.seed, null);
  assert.equal(s.reference, null);
  assert.deepEqual(s.files, { wav: null, mp3: null });
  const t = Date.parse(s.createdAt);
  assert.ok(t >= before && t <= after, 'createdAt is a fresh ISO timestamp');
});

/* ---------- listTakes ---------- */
test('listTakes: newest first, pairs wav/mp3 by basename, absolute paths inside dir', () => {
  const d = tmpdir();
  write(path.join(d, 'old.wav'), 'w'); write(path.join(d, 'old.mp3'), 'm');
  write(path.join(d, 'old.json'), JSON.stringify(store.sidecarFor({
    createdAt: '2026-11-01T10:00:00Z', caption: 'the old one', seed: 1,
    wav: 'old.wav', mp3: 'old.mp3',
  })));
  write(path.join(d, 'new.wav'), 'w'); write(path.join(d, 'new.mp3'), 'm');
  write(path.join(d, 'new.json'), JSON.stringify(store.sidecarFor({
    createdAt: '2026-11-19T10:00:00Z', caption: 'the new one', seed: 2,
    wav: 'new.wav', mp3: 'new.mp3',
  })));
  const takes = store.listTakes(d);
  assert.equal(takes.length, 2);
  assert.equal(takes[0].wav, path.join(d, 'new.wav'));
  assert.equal(takes[0].mp3, path.join(d, 'new.mp3'));
  assert.equal(takes[0].meta.caption, 'the new one');
  assert.equal(takes[1].wav, path.join(d, 'old.wav'));
  for (const t of takes) for (const f of [t.wav, t.mp3])
    assert.ok(f.startsWith(d + path.sep), 'absolute path inside dir');
});

test('listTakes: legacy takes without sidecars still list (meta null)', () => {
  const d = tmpdir();
  write(path.join(d, 'legacy-a.wav'), 'w');
  const t0 = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(d, 'legacy-a.wav'), t0, t0);
  write(path.join(d, 'legacy-b.mp3'), 'm'); // orphan: no wav, no json
  const takes = store.listTakes(d);
  assert.equal(takes.length, 2);
  const a = takes.find(t => t.wav && t.wav.endsWith('legacy-a.wav'));
  assert.ok(a && a.mp3 === null && a.meta === null);
  const b = takes.find(t => t.mp3 && t.mp3.endsWith('legacy-b.mp3'));
  assert.ok(b && b.wav === null && b.meta === null);
  // newest first by mtime: legacy-a (older) after the orphan
  assert.equal(takes[0].mp3, b.mp3);
});

test('listTakes: broken sidecar degrades to meta:null, never throws', () => {
  const d = tmpdir();
  write(path.join(d, 'x.wav'), 'w');
  write(path.join(d, 'x.json'), '{ this is not json');
  write(path.join(d, 'y.json'), '[1,2,3]'); // valid JSON but not an object: not a sidecar
  const takes = store.listTakes(d);
  const x = takes.find(t => t.wav && t.wav.endsWith('x.wav'));
  assert.ok(x && x.meta === null);
  assert.equal(takes.length, 1); // y.json without y.wav/.mp3 is not a take
});

test('listTakes: missing dir and junk files are ignored', () => {
  assert.deepEqual(store.listTakes(path.join(tmpdir(), 'nope')), []);
  const d = tmpdir();
  write(path.join(d, 'readme.txt'), 'not a take');
  write(path.join(d, 'cfg.tmp.123.456'), '{'); // atomic-write residue
  write(path.join(d, 't.wav'), 'w'); write(path.join(d, 't.mp3'), 'm');
  const takes = store.listTakes(d);
  assert.equal(takes.length, 1);
  assert.equal(takes[0].wav, path.join(d, 't.wav'));
});

test('listTakes: limit caps the result, newest first', () => {
  const d = tmpdir();
  for (let i = 0; i < 5; i++) {
    write(path.join(d, `t${i}.wav`), 'w');
    write(path.join(d, `t${i}.json`), JSON.stringify(store.sidecarFor({
      createdAt: new Date(1700000000000 + i * 1000).toISOString(), wav: `t${i}.wav`,
    })));
  }
  const takes = store.listTakes(d, 2);
  assert.equal(takes.length, 2);
  assert.ok(takes[0].wav.endsWith('t4.wav'));
  assert.ok(takes[1].wav.endsWith('t3.wav'));
});

/* ---------- lock ---------- */
// pid 1 is alive on any Linux box; as a normal user it is not signalable,
// which is exactly the "foreign live process" case (kill(pid,0) -> EPERM).
const FOREIGN = 1;

test('lock: acquire, readLock shows the holder', () => {
  const d = tmpdir();
  const p = path.join(d, 'generate.lock');
  const r = store.acquireLock(p, { host: 'test-a' });
  assert.deepEqual(r, { acquired: true, holder: null });
  assert.equal(store.readLock(p).pid, process.pid);
  assert.equal(store.readLock(p).host, 'test-a');
  assert.ok(Date.parse(store.readLock(p).startedAt) > 0);
});

test('lock: second acquire with a live foreign holder is refused, names the pid', () => {
  const d = tmpdir();
  const p = path.join(d, 'generate.lock');
  store.acquireLock(p, { host: 'test-a' });
  const r = store.acquireLock(p, { pid: FOREIGN, host: 'test-b' }, 30 * 60 * 1000);
  assert.equal(r.acquired, false);
  assert.equal(r.holder.pid, process.pid); // the other window's pid, for the error message
});

test('lock: stale by dead pid is replaced', async () => {
  // a real dead pid: spawn a short-lived process and wait for it to exit
  const pid = await new Promise(resolve => {
    const c = spawn('true');
    c.on('exit', () => resolve(c.pid));
  });
  const d = tmpdir();
  const p = path.join(d, 'generate.lock');
  write(p, JSON.stringify({ pid, startedAt: new Date().toISOString(), host: 'dead' }) + '\n');
  assert.equal(store.readLock(p).pid, pid); // the leaked lock is in place
  const r = store.acquireLock(p, { host: 'test-a' });
  assert.equal(r.acquired, true);
  assert.equal(store.readLock(p).pid, process.pid); // replaced
});

test('lock: stale by age (live pid, too old) is replaced; validHolder says null', () => {
  const d = tmpdir();
  const p = path.join(d, 'generate.lock');
  write(p, JSON.stringify({
    pid: FOREIGN, startedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), host: 'old',
  }) + '\n');
  assert.equal(store.validHolder(p, 30 * 60 * 1000), null); // over-age: not a real blocker
  const r = store.acquireLock(p, { host: 'test-a' }, 30 * 60 * 1000);
  assert.equal(r.acquired, true);
  assert.equal(store.readLock(p).pid, process.pid);
});

test('lock: validHolder reports a fresh foreign holder, hides ours and dead ones', () => {
  const d = tmpdir();
  const p = path.join(d, 'generate.lock');
  write(p, JSON.stringify({ pid: FOREIGN, startedAt: new Date().toISOString(), host: 'x' }) + '\n');
  assert.equal(store.validHolder(p, 30 * 60 * 1000), FOREIGN);
  // ours: a freshly acquired lock never reports itself
  const p2 = path.join(d, 'ours.lock');
  store.acquireLock(p2, { host: 'us' });
  assert.equal(store.validHolder(p2, 30 * 60 * 1000), null);
  write(p, JSON.stringify({ pid: -1, startedAt: new Date().toISOString(), host: 'x' }) + '\n');
  assert.equal(store.validHolder(p, 30 * 60 * 1000), null);
});

test('lock: release only by the owner', () => {
  const d = tmpdir();
  const p = path.join(d, 'generate.lock');
  // someone else's lock: untouched
  write(p, JSON.stringify({ pid: FOREIGN, startedAt: new Date().toISOString(), host: 'x' }) + '\n');
  assert.equal(store.releaseLock(p), false);
  assert.ok(fs.existsSync(p));
  // our lock (fresh path): released
  const p2 = path.join(d, 'ours.lock');
  store.acquireLock(p2, { host: 'us' });
  assert.equal(store.releaseLock(p2), true);
  assert.ok(!fs.existsSync(p2));
  // releasing twice / missing file: false, no throw
  assert.equal(store.releaseLock(p2), false);
});

test('lock: readLock tolerates missing and broken files', () => {
  const d = tmpdir();
  const p = path.join(d, 'generate.lock');
  assert.equal(store.readLock(p), null);
  write(p, '{broken');
  assert.equal(store.readLock(p), null);
  write(p, '"just a string"');
  assert.equal(store.readLock(p), null);
});

/* ---------- writeJsonAtomic ---------- */
test('atomic write: content, no tmp residue, overwrite works', () => {
  const d = tmpdir();
  const p = path.join(d, 'config.json');
  const obj = { outDir: '/tmp/x', writer: 'a/b' };
  store.writeJsonAtomic(p, obj);
  assert.equal(fs.readFileSync(p, 'utf8'), JSON.stringify(obj, null, 2) + '\n');
  assert.deepEqual(fs.readdirSync(d), ['config.json']); // no .tmp.* left behind
  store.writeJsonAtomic(p, { outDir: '/tmp/y' }); // overwrite
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { outDir: '/tmp/y' });
});

test('atomic write: a failing write leaves the old file intact and no tmp', () => {
  const d = tmpdir();
  const p = path.join(d, 'config.json');
  store.writeJsonAtomic(p, { a: 1 });
  assert.throws(() => store.writeJsonAtomic(path.join(p, 'impossible'), { a: 2 }));
  // dir is a file here, so rename cannot succeed: old content survives
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).a, 1);
  assert.deepEqual(fs.readdirSync(d), ['config.json']);
});
