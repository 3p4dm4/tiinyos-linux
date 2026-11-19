// Update-flow tests for the device care engine (src/m3_care.js) against the
// fake Tiiny Pocket, driven through the stdin control channel
// (tests/fake_pocket_ctl.py): full update of an in-memory model, updateAll
// one at a time, power cut mid-download with journal resume, stop-after-step
// and resume, and restore waiting behind an update.
//
// Run: node --test tests/js/*.test.js
//
// Hard constraint honoured: no request is ever made to the real device.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CTL = path.join(REPO_ROOT, 'tests', 'fake_pocket_ctl.py');
const DUMMY_KEY = 'dummy-auth-key-not-a-real-token';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'care-upd-home-'));
fs.mkdirSync(path.join(HOME, '.local', 'tiiny'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.local', 'tiiny', 'config.json'),
  JSON.stringify({ account: { authKey: DUMMY_KEY } }));

const children = [];
const dirs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = 'tiiny/cogito-mini', G = 'tiiny/general-7b', E = 'tiiny/embed-small';

function readPort(cp) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('fake did not start in time')), 10000);
    cp.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const m = buf.match(/^LISTENING (\d+)\s*$/m);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    cp.on('error', (e) => { clearTimeout(timer); reject(e); });
    cp.on('exit', (c) => {
      if (!buf.match(/^LISTENING /m)) { clearTimeout(timer); reject(new Error('fake exited ' + c)); }
    });
  });
}

// Spawn the ctl-driven fake; send() is FIFO-matched to reply lines.
async function spawnCtl(scenario, speed = 2) {
  const cp = spawn('python3', [CTL, '--scenario', scenario, '--speed', String(speed)],
    { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(cp);
  const port = await readPort(cp);
  let buf = '';
  const waiters = [];
  cp.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith('LISTENING')) continue;
      try {
        const w = waiters.shift();
        if (w) { clearTimeout(w.timer); w.res(JSON.parse(line)); }
      } catch { /* not a reply: ignore */ }
    }
  });
  const send = (cmd) => new Promise((res, rej) => {
    const w = { res, rej, timer: setTimeout(
      () => { const j = waiters.indexOf(w); if (j >= 0) waiters.splice(j, 1);
        rej(new Error('no reply to ' + cmd.op)); }, 10000) };
    waiters.push(w);
    cp.stdin.write(JSON.stringify(cmd) + '\n');
  });
  return { base: 'http://127.0.0.1:' + port, send, stop: () => cp.kill('SIGKILL') };
}

function freshEngines(base, baseDir) {
  process.env.TIINY_BASE = base;
  process.env.HOME = HOME;
  for (const f of ['m3_device.js', 'm3_models.js', 'm3_care_store.js', 'm3_care.js'])
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', f))];
  return {
    care: require(path.join(REPO_ROOT, 'src', 'm3_care.js')),
    models: require(path.join(REPO_ROOT, 'src', 'm3_models.js')),
    store: require(path.join(REPO_ROOT, 'src', 'm3_care_store.js')).createStore(baseDir),
  };
}

const startEngine = (eng, baseDir) =>
  eng.care.start({ baseDir, pollMs: 0, outageMs: 300, loadPollMs: 100 });

// cut, stay down past the 300 ms threshold, back on; returns the two failing
// polls already driven so the engine observed the silence.
async function outage(ctl, eng) {
  await ctl.send({ op: 'cut' });
  await eng.care._pollOnce(); // failing: opens the outage
  await sleep(350);
  await eng.care._pollOnce(); // failing: past the threshold
}

after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('update: in-memory model — unload, delete, download, reload; journal written before each step and cleared at the end', async () => {
  const ctl = await spawnCtl('update_available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-u1-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce(); // snapshot [cogito]

  const { taskId } = await eng.care.update(C);
  await sleep(1500); // mid-download (3 s at speed 2)

  const j = eng.store.journal();
  assert.ok(j, 'the journal must exist while the update runs');
  assert.equal(j.model, C);
  assert.equal(j.step, 3); // downloading
  assert.equal(j.wasLoaded, true);
  const ct = eng.care.currentTask();
  assert.equal(ct.kind, 'update');
  assert.match(ct.line, /^Updating cogito-mini · step 3 of 4/);

  await sleep(6000); // download (3 s) + reload (1.5 s)
  await eng.care._pollOnce();

  const t = eng.care._S.tasks.get(taskId);
  assert.equal(t.state, 'done');
  assert.equal(eng.store.journal(), null, 'journal cleared on completion');
  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].version, '1.4.0'); // new version
  assert.equal(state.models[C].need_update, false);
  assert.equal(state.models[C].in_memory, true); // reloaded
  const log = eng.store.readLog().entries;
  assert.ok(log.some((e) => e.event === 'updated' && /1\.3\.0 → 1\.4\.0/.test(e.detail)),
    '"updated" entry logs old → new version');
  ctl.stop();
});

test('updateAll: both updatable models, one at a time, queue kept in the journal', async () => {
  const ctl = await spawnCtl('update_available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-u2-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce();

  const { taskIds } = await eng.care.updateAll();
  assert.equal(taskIds.length, 2);

  await sleep(1200); // while the first model updates…
  const j = eng.store.journal();
  assert.ok(j && j.queue && j.queue.length === 1, 'second model waits in the journal queue');
  assert.equal(j.queue[0].model, G);

  await sleep(9000); // first: 4.5 s + second: ~3.5 s
  await eng.care._pollOnce();

  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].version, '1.4.0');
  assert.equal(state.models[C].in_memory, true); // was in memory: reloaded
  assert.equal(state.models[G].version, '2.1.0');
  assert.equal(state.models[G].in_memory, false); // was not loaded: not loaded
  assert.equal(eng.store.journal(), null);
  const tasks = [...eng.care._S.tasks.values()];
  assert.equal(tasks.filter((t) => t.state === 'done').length, 2);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.equal(log.filter((e) => e === 'updated').length, 2);
  ctl.stop();
});

test('power cut mid-download: journal survives, the outage closes, the update resumes from step 3 and finishes', async () => {
  const ctl = await spawnCtl('update_available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-u3-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce();

  await eng.care.update(C);
  await sleep(1200); // mid-download
  await outage(ctl, eng);
  await ctl.send({ op: 'restore_power', boot_models: [] }); // download lost
  await eng.care._pollOnce(); // outage closes; resume from the journal

  await sleep(6500); // download again (3 s) + reload (1.5 s)
  await eng.care._pollOnce();

  assert.equal(eng.store.journal(), null);
  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].version, '1.4.0');
  assert.equal(state.models[C].in_memory, true);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.ok(log.includes('update-interrupted'), 'the cut interrupted the run');
  assert.ok(log.includes('update-resumed'), 'the journal resume is logged');
  assert.ok(log.includes('updated'));
  assert.ok(eng.care._S.outages.length === 1, 'one outage record');
  ctl.stop();
});

test('stop after the current step keeps the journal; a new update() resumes from it (even with need_update already false)', async () => {
  const ctl = await spawnCtl('update_available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-u4-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce();

  const { taskId } = await eng.care.update(C);
  await sleep(1000); // mid-download
  assert.equal(eng.care._stopTask(taskId), true);
  await sleep(3500); // the in-flight download runs out, then the loop bails

  const j = eng.store.journal();
  assert.ok(j, 'a stopped update keeps its journal (it is not complete)');
  assert.equal(j.step, 4); // stop applied before the reload step
  assert.equal(eng.care._S.tasks.get(taskId).state, 'interrupted');
  let state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].version, '1.4.0'); // download did finish on the device
  assert.equal(state.models[C].need_update, false);
  assert.equal(state.models[C].in_memory, false);

  const { taskId: t2 } = await eng.care.update(C); // resumes, does not restart
  await sleep(2500); // reload only
  await eng.care._pollOnce();

  assert.equal(eng.store.journal(), null);
  assert.equal(eng.care._S.tasks.get(t2).state, 'done');
  state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].in_memory, true);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.ok(log.includes('update-stopped'));
  assert.ok(log.filter((e) => e === 'update-resumed').length >= 1);
  ctl.stop();
});

test('restore waits while an update runs: after a cut, the update finishes first, then the policy restore fills the rest', async () => {
  const ctl = await spawnCtl('update_available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-u5-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce(); // snapshot [cogito]
  await ctl.send({ op: 'load', id: E }); // another client adds embed…
  await sleep(1700); // …load finishes (3 s sim at speed 2 = 1.5 s wall)
  await eng.care._pollOnce(); // snapshot [cogito, embed]
  eng.store.setPolicy('all');

  await eng.care.update(C);
  await sleep(1200); // mid-download
  await outage(ctl, eng);
  await ctl.send({ op: 'restore_power', boot_models: [] });
  await eng.care._pollOnce(); // restore defers (journal), update resumes

  await sleep(7000); // download 3 s + reload 1.5 s, then the deferred restore (0.75 s)
  await eng.care._pollOnce();

  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].version, '1.4.0');
  assert.equal(state.models[C].in_memory, true); // back via the UPDATE, not the restore
  assert.equal(state.models[E].in_memory, true); // back via the deferred RESTORE
  const o = eng.care._S.outages[0];
  assert.ok(o && o.restored.includes(E), 'the restore only loaded what was still missing');
  assert.ok(!o.restored.includes(C));
  assert.ok(!o.notRestored.some((x) => x.id === E));
  assert.equal(eng.store.journal(), null);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.ok(log.includes('restored'), 'embed-small was restored by this PC');
  ctl.stop();
});
