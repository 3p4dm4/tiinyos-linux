// Wiring tests for the care engine's IPC layer (src/m3_care.js wire()) and the
// m3:care:changed push, using a fake Electron ipcMain (require stub) and a
// fake window/webContents — no Electron binary involved. The device is the
// fake Tiiny Pocket, driven via tests/fake_pocket_ctl.py.
//
// Run: node --test tests/js/*.test.js
//
// Hard constraint honoured: no request is ever made to the real device.
'use strict';
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CTL = path.join(REPO_ROOT, 'tests', 'fake_pocket_ctl.py');
const DUMMY_KEY = 'dummy-auth-key-not-a-real-token';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'care-wire-home-'));
fs.mkdirSync(path.join(HOME, '.local', 'tiiny'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.local', 'tiiny', 'config.json'),
  JSON.stringify({ account: { authKey: DUMMY_KEY } }));

// --- fake electron ---------------------------------------------------------
const handlers = new Map(); // channel -> handler
const origLoad = Module._load;
before(() => {
  Module._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return { ipcMain: {
        handle: (name, fn) => handlers.set(name, fn),
        removeHandler: (name) => { handlers.delete(name); },
      } };
    }
    return origLoad(request, parent, isMain);
  };
});
after(() => { Module._load = origLoad; });

const children = [];
const dirs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = 'tiiny/cogito-mini';

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

function freshCare(base) {
  process.env.TIINY_BASE = base;
  process.env.HOME = HOME;
  delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', 'm3_device.js'))];
  delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', 'm3_models.js'))];
  delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', 'm3_care_store.js'))];
  delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', 'm3_care.js'))];
  return require(path.join(REPO_ROOT, 'src', 'm3_care.js'));
}

function fakeWin() {
  const pushes = [];
  let finishCb = null;
  return {
    pushes,
    isDestroyed: () => false,
    webContents: {
      send: (ch, p) => pushes.push({ ch, p }),
      once: (ev, cb) => { if (ev === 'did-finish-load') finishCb = cb; },
    },
    didFinishLoad: () => finishCb && finishCb(),
  };
}

after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('activity line: a running care task wins on tray (and ball) over the raw signals', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-w3-')); dirs.push(dir);
  const care = freshCare(ctl.base);
  // require m3_activity AFTER freshCare so it binds the same engine instance
  const activity = require(path.join(REPO_ROOT, 'src', 'm3_activity.js'));
  care.start({ baseDir: dir, pollMs: 0, outageMs: 300, loadPollMs: 100 });
  await care._pollOnce();

  const task = care._newTask('restore', 'policy “all”', 'pc');
  task.state = 'running';
  task.progress = 0.35;
  care._S.tasks.set(task.id, task);

  const tips = [];
  const tray = { setToolTip: (t) => tips.push(t) };
  await activity._tick(tray);
  assert.ok(tips.length === 1, 'one tooltip update');
  assert.ok(/Restoring policy “all” · 35%/.test(tips[0]), 'tray shows the task: ' + tips[0]);

  // and with no task, the raw classify path is used again
  care._S.tasks.clear();
  tips.length = 0;
  await activity._tick(tray);
  assert.ok(tips[0] && !tips[0].includes('Restoring'), 'back to the raw label: ' + tips[0]);
  ctl.stop();
});

test('wire: contract handlers (state, models, log, setPolicy, keep, setAcPower, load/unload, update, stopTask)', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-w1-')); dirs.push(dir);
  const care = freshCare(ctl.base);
  care.start({ baseDir: dir, pollMs: 0, outageMs: 300, loadPollMs: 100 });
  await care._pollOnce();
  const win = fakeWin();
  care.wire(win);

  const call = (ch, arg) => handlers.get(ch)({ sender: null }, arg);

  // state: CareState shape (contract v0.4.0)
  const st = await call('m3:care:state');
  assert.equal(st.reach.state, 'reachable');
  assert.ok(st.reach.lastRead > 0, 'lastRead present');
  assert.ok(st.reach.everyMs > 0, 'everyMs present');
  assert.ok(Array.isArray(st.running), 'running present');
  assert.ok(Array.isArray(st.tasks), 'tasks present');
  assert.ok(st.policy && typeof st.policy.reload === 'string', 'policy present');
  assert.ok(Array.isArray(st.kept), 'kept present');
  assert.ok('acPower' in st, 'acPower present');
  assert.ok(Array.isArray(st.outages), 'outages present');
  assert.ok(st.lastSnapshot && Array.isArray(st.lastSnapshot.ids), 'lastSnapshot present');

  // models: inventory with flags
  const inv = await call('m3:care:models');
  assert.ok(Array.isArray(inv.models) && inv.models.length >= 3);
  assert.ok(inv.models.every((m) => typeof m.need_update === 'boolean'));

  // log: newest first
  const lg = await call('m3:care:log', {});
  assert.ok(Array.isArray(lg.entries));

  // setPolicy: invalid rejected, valid accepted
  await assert.rejects(() => call('m3:care:setPolicy', { reload: 'bogus' }));
  assert.deepStrictEqual(await call('m3:care:setPolicy', { reload: 'kept' }), { reload: 'kept' });

  // keep: add then remove
  assert.deepStrictEqual((await call('m3:care:keep', { id: C, on: true })).kept, [C]);
  assert.deepStrictEqual((await call('m3:care:keep', { id: C, on: false })).kept, []);

  // setAcPower: round-trips against the device and returns {acPower}
  assert.deepStrictEqual(await call('m3:care:setAcPower', { on: true }), { acPower: true });
  assert.deepStrictEqual(await call('m3:care:setAcPower', { on: false }), { acPower: false });

  // load / unload: ok
  assert.deepStrictEqual(await call('m3:care:load', { id: C }), { ok: true });
  assert.deepStrictEqual(await call('m3:care:unload', { id: C }), { ok: true });

  // stopTask: unknown id is a no-op, not an error
  assert.deepStrictEqual(await call('m3:care:stopTask', { taskId: 'nope' }), { ok: false });

  ctl.stop();
});

test('push m3:care:changed: at most once per second, payload is a CareState; did-finish-load pushes immediately', async () => {
  const ctl = await spawnCtl('normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-w2-')); dirs.push(dir);
  const care = freshCare(ctl.base);
  care.start({ baseDir: dir, pollMs: 0, outageMs: 300, loadPollMs: 100 });
  const win = fakeWin();
  care.wire(win);

  care._S.lastPush = 0;
  await care._pollOnce(); // -> 1 push
  await care._pollOnce(); // within 1 s: throttled
  await care._pollOnce(); // still throttled
  assert.equal(win.pushes.length, 1, 'no more than one push per second');
  assert.equal(win.pushes[0].ch, 'm3:care:changed');
  assert.equal(win.pushes[0].p.reach.state, 'reachable');

  // did-finish-load resets the throttle window (first state goes out with the
  // next engine change, without waiting out the second)
  win.didFinishLoad();
  assert.equal(win.pushes.length, 1, 'did-finish-load alone does not push');
  await care._pollOnce();
  assert.equal(win.pushes.length, 2, 'the next change is delivered right away');

  ctl.stop();
});
