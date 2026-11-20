// End-to-end tests for the device care engine (src/m3_care.js) against the
// fake Tiiny Pocket, driven through the stdin control channel
// (tests/fake_pocket_ctl.py). The engine runs under bare node: no Electron.
//
// Timings: start({ outageMs: 300, loadPollMs: 100, pollMs: 0 }) shrinks the
// contract values (15 s / 1.5 s / 5 s) for tests; _pollOnce() is driven by
// hand so no real wall-clock waiting is needed beyond the marked sleeps.
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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'care-engine-home-'));
fs.mkdirSync(path.join(HOME, '.local', 'tiiny'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.local', 'tiiny', 'config.json'),
  JSON.stringify({ account: { authKey: DUMMY_KEY } }));

const children = [];
const dirs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function spawnCtl(scenario, speed = 50) {
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
  return {
    base: 'http://127.0.0.1:' + port,
    send,
    stop: () => { cp.kill('SIGKILL'); },
  };
}

// Fresh engine + models + store against a given fake (modules capture env at
// require time, so they are re-required with a clean cache per test).
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
const events = (eng) => eng.care.state().outages;

after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

const C = 'tiiny/cogito-mini', G = 'tiiny/general-7b', E = 'tiiny/embed-small';

async function loadEmbed(eng) {
  await eng.models.ensureLoaded(E, null, { pollMs: 100 });
}

// Build the common pre-outage state: cogito + embed in memory, both in the
// snapshot (load order).
async function setupTwoModels(eng) {
  await eng.care._pollOnce(); // snapshot: [cogito]
  await loadEmbed(eng);       // +embed (75 NPU, fits)
  await eng.care._pollOnce(); // snapshot: [cogito, embed]
}

async function powerCutAndBack(ctl, eng, bootModels, policy) {
  const { store, care } = eng;
  if (policy) store.setPolicy(policy);
  await ctl.send({ op: 'cut' });
  await care._pollOnce(); // failing poll: opens the outage, goes unreachable
  await sleep(350);       // longer than outageMs(300)
  await care._pollOnce(); // still down past the threshold
  await ctl.send({ op: 'restore_power', boot_models: bootModels || [] });
  await care._pollOnce(); // closes the outage, runs the restore
  await sleep(800);       // let the restore task finish
  await care._pollOnce(); // settle the state
}

test('reachable: reach state, snapshot, ac_power and CareState shape', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e1-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce();
  const S = eng.care._S;

  assert.equal(S.reach.state, 'reachable');
  assert.ok(S.reach.lastRead > 0);
  assert.equal(S.acPower, false); // fake default: off out of the box
  assert.deepEqual(S.snapshot.map((x) => x.id), [C]);

  const st = eng.care.state();
  for (const k of ['reach', 'running', 'pending', 'tasks', 'policy', 'kept',
    'acPower', 'outages', 'lastSnapshot'])
    assert.ok(k in st, 'CareState missing ' + k);
  assert.equal(st.running.length, 1);
  assert.equal(st.running[0].id, C);
  assert.equal(st.running[0].status, 'loaded');
  assert.equal(st.policy.reload, 'off'); // conservative default
  assert.equal(st.lastSnapshot.ids.length, 1);
  ctl.stop();
});

test('outage: no answer >15s(=300ms) -> unreachable, answer again -> outage record', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e2-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce();

  await ctl.send({ op: 'cut' });
  await eng.care._pollOnce();
  assert.equal(eng.care._S.reach.state, 'reachable'); // wobble under the threshold
  await sleep(350);
  await eng.care._pollOnce();
  assert.equal(eng.care._S.reach.state, 'unreachable');
  assert.equal(eng.care._S.outage.back, 0); // open
  assert.deepEqual(eng.care._S.outage.beforeIds, [C]);

  await ctl.send({ op: 'restore_power', boot_models: [C] });
  await eng.care._pollOnce();
  assert.equal(eng.care._S.reach.state, 'reachable');
  const outages = events(eng);
  assert.equal(outages.length, 1);
  assert.deepEqual(outages[0].beforeIds, [C]);
  assert.deepEqual(outages[0].backIds, [C]);
  assert.ok(outages[0].back > outages[0].lost);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.ok(log.includes('outage-start') && log.includes('outage'));
  ctl.stop();
});

test('restore policy "all": loads only what is missing, in load order, keeps what the device brought back', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e3-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await setupTwoModels(eng); // snapshot [cogito, embed], both in memory

  await powerCutAndBack(ctl, eng, [], 'all'); // the device comes back empty

  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].in_memory, true, 'cogito restored');
  assert.equal(state.models[E].in_memory, true, 'embed restored');
  const o = events(eng)[0];
  assert.deepEqual(o.restored, [C, E]); // load order, oldest first
  assert.deepEqual(o.notRestored, []);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.ok(log.filter((e) => e === 'restored').length === 2);
  ctl.stop();
});

test('restore policy "kept": only the kept model comes back, nothing else is touched', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e4-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await setupTwoModels(eng);
  eng.store.setKept([E]);

  await powerCutAndBack(ctl, eng, [], 'kept');

  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[E].in_memory, true, 'kept model restored');
  assert.equal(state.models[C].in_memory, false, 'non-kept model left alone');
  assert.deepEqual(events(eng)[0].restored, [E]);
  ctl.stop();
});

test('restore policy "off": nothing is loaded after the outage', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e5-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await setupTwoModels(eng);

  await powerCutAndBack(ctl, eng, [], 'off');

  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].in_memory, false);
  assert.equal(state.models[E].in_memory, false);
  assert.deepEqual(events(eng)[0].restored, []);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.ok(!log.includes('restored'));
  ctl.stop();
});

test('a model that does not fit is reported, never evicts anything', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e6-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce(); // snapshot [cogito]
  await eng.models.unload(C); // swap: cogito out…
  await eng.models.ensureLoaded(G, null, { pollMs: 100 }); // …general-7b in (80)
  await eng.care._pollOnce(); // snapshot [general-7b]
  await loadEmbed(eng); // +embed (95 of 100)
  await eng.care._pollOnce(); // snapshot [general-7b, embed]

  // the device boots with cogito by itself: 60 used, 40 free
  await powerCutAndBack(ctl, eng, [C], 'all');

  const state = await ctl.send({ op: 'state' });
  assert.equal(state.models[C].in_memory, true, 'boot model kept');
  assert.equal(state.models[E].in_memory, true, 'embed restored (fits in 40)');
  assert.equal(state.models[G].in_memory, false, 'general-7b NOT restored (does not fit)');
  assert.equal(state.models[G].installed, true, '…but still installed');
  const o = events(eng)[0];
  assert.equal(o.notRestored[0].id, G);
  assert.match(o.notRestored[0].reason, /needs 80/);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.ok(log.includes('not-restored'));
  ctl.stop();
});

test('ac_power: get reflects the device, set posts and re-reads', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e7-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);

  assert.equal(await eng.care.getAcPower(), false);
  assert.equal(await eng.care.setAcPower(true), true);
  assert.equal((await ctl.send({ op: 'state' })).ac_power, true); // the POST really went
  assert.equal(await eng.care.setAcPower(false), false);
  assert.equal((await ctl.send({ op: 'state' })).ac_power, false);
  const log = eng.store.readLog().entries.map((e) => e.event);
  assert.equal(log.filter((e) => e === 'ac-power').length, 2);
  ctl.stop();
});

test('usage: device counters become the contract shape, apps included (weekStart is a Monday)', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e8-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);

  const monday = eng.care.mondayOf(new Date('2026-11-19T12:00:00Z'));
  assert.equal(monday, '2026-11-16');
  const u = await eng.care.usage(monday);
  assert.equal(u.weekStart, monday);
  assert.ok(u.readAt > 0);
  const days = Object.keys(u.days).sort();
  assert.equal(days.length, 7);
  assert.equal(days[0], monday);
  const firstDay = u.days[days[0]];
  for (const mid of Object.keys(firstDay))
    for (const k of ['prompt', 'completion', 'total', 'requests'])
      assert.equal(typeof firstDay[mid][k], 'number');

  // device names (prompt_tokens…) become the contract names, values kept:
  // the fake's first model on the first day has prompt 1000 / completion 500
  const first = firstDay[Object.keys(firstDay).sort()[0]];
  assert.deepEqual(first, { prompt: 1000, completion: 500, total: 1500, requests: 1 });

  // apps come with the same call (contract) and as total, not total_tokens
  assert.ok(u.apps.TiinyOS && u.apps.default);
  assert.equal(typeof u.apps.TiinyOS.total, 'number');
  assert.ok(u.apps.TiinyOS.total > 0);
  assert.ok(Object.keys(u.apps.TiinyOS.models).length >= 1);
  const a = await eng.care.appUsage(monday);
  assert.deepEqual(a.apps, u.apps);
  ctl.stop();
});

test('currentTask reports the running restore with a label and progress; stopTask stops after the current step', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e9-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await setupTwoModels(eng);
  eng.store.setPolicy('all');
  assert.equal(eng.care.currentTask(), null); // idle

  await ctl.send({ op: 'cut' });
  await eng.care._pollOnce(); // failing poll: opens the outage
  await sleep(350);
  await ctl.send({ op: 'restore_power', boot_models: [] });
  await eng.care._pollOnce(); // closes the outage, starts the restore
  const ct = eng.care.currentTask();
  assert.ok(ct, 'a restore task should be visible');
  assert.equal(ct.kind, 'restore');
  assert.match(ct.line, /^Restoring .* · \d+%/);
  const taskId = ct.id;
  eng.care._stopTask(taskId);
  await sleep(800); // let the in-flight load finish, then the loop bails
  await eng.care._pollOnce();
  const t = eng.care._S.tasks.get(taskId);
  assert.equal(t.state, 'interrupted');
  ctl.stop();
});

test('activity log: expected entries with the right "by" marks, newest first', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-e10-')); dirs.push(dir);
  const eng = freshEngines(ctl.base, dir);
  startEngine(eng, dir);
  await eng.care._pollOnce();

  await ctl.send({ op: 'load', id: E }); // another client loads embed
  await sleep(150); // the 60 ms (sim 3 s) load completes
  await eng.care._pollOnce(); // sees it: by = device
  eng.store.setPolicy('all');
  await ctl.send({ op: 'cut' });
  await eng.care._pollOnce(); // failing poll: opens the outage
  await sleep(350);
  await ctl.send({ op: 'restore_power', boot_models: [] });
  await eng.care._pollOnce(); // outage + restore by this PC
  await sleep(800);
  await eng.care.setAcPower(true);

  const entries = eng.store.readLog().entries;
  assert.deepEqual(entries.map((e) => e.event),
    ['ac-power', 'restored', 'restored', 'outage', 'outage-start', 'loaded']);
  const by = Object.fromEntries(entries.map((e) => [e.event + ':' + e.detail, e.by]));
  assert.equal(by['loaded:' + E.split('/')[1]], 'device'); // not this PC
  assert.equal(by['ac-power:set to on'], 'pc');
  ctl.stop();
});
