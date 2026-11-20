// Node harness: proves src/m3_device.js can be driven against the fake device.
//
// We spawn the fake on an ephemeral loopback port, point TIINY_BASE at it, give
// the module a throwaway HOME with a dummy auth key (so authKey() is non-empty
// and jget/jpost send the Authorization header the device requires), then re-
// require m3_device.js FRESH and exercise jget/jpost over real HTTP.
//
// Run: node --test tests/js/*.test.js
//
// Hard constraint honoured: no request is ever made to the real device. The
// "falls back" test only asserts the base-URL constants; every live call goes
// to 127.0.0.1.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEVICE_MODULE = path.join(REPO_ROOT, 'src', 'm3_device.js');
const DUMMY_KEY = 'dummy-auth-key-not-a-real-token';

let child;
let fakeBase;
let homeDir;
const realHome = process.env.HOME;

function readPort(cp) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('fake did not start in time')), 10000);
    cp.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const m = buf.match(/^LISTENING (\d+)\s*$/m);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    cp.stderr.on('data', () => {});
    cp.on('error', (e) => { clearTimeout(timer); reject(e); });
    cp.on('exit', (c) => {
      if (!buf.match(/^LISTENING /m)) { clearTimeout(timer); reject(new Error('fake exited ' + c)); }
    });
  });
}

function freshDevice() {
  delete require.cache[require.resolve(DEVICE_MODULE)];
  return require(DEVICE_MODULE);
}

before(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pocket-home-'));
  fs.mkdirSync(path.join(homeDir, '.local', 'tiiny'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.local', 'tiiny', 'config.json'),
    JSON.stringify({ account: { authKey: DUMMY_KEY } }));
  process.env.HOME = homeDir; // os.homedir() follows HOME on POSIX

  child = spawn('python3', ['tests/fake_pocket.py', '--port', '0', '--speed', '50'],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await readPort(child);
  fakeBase = 'http://127.0.0.1:' + port;
});

after(async () => {
  if (child) child.kill('SIGKILL');
  if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  if (realHome !== undefined) process.env.HOME = realHome;
  else delete process.env.HOME;
});

test('falls back to the real device when TIINY_BASE is unset', () => {
  delete process.env.TIINY_BASE;
  const dev = freshDevice();
  assert.equal(dev.BASE, 'http://api.tiiny');
  assert.equal(dev.P8800, 'http://p8800.api.tiiny');
  // no HTTP here on purpose: this branch must never touch the real device
});

test('TIINY_BASE overrides both base URLs to the same fake', () => {
  process.env.TIINY_BASE = fakeBase;
  const dev = freshDevice();
  assert.equal(dev.BASE, fakeBase);
  assert.equal(dev.P8800, fakeBase);
  assert.equal(dev.authKey(), DUMMY_KEY); // proves the auth plumbing the fake relies on
});

test('jget reaches the fake for models, running, npu and sys', async () => {
  process.env.TIINY_BASE = fakeBase;
  const dev = freshDevice();
  const models = await dev.jget(dev.BASE + '/v1/models');
  assert.ok(Array.isArray(models.data) && models.data.length >= 1);
  assert.equal(models.data[0].id, 'tiiny/cogito-mini');

  const running = await dev.jget(dev.BASE + '/api/v1/models/running');
  const ids = running.instances.running.map((r) => r.model_id);
  assert.ok(ids.includes('tiiny/cogito-mini'), 'cogito-mini should be running');
  for (const r of running.instances.running) {
    for (const k of ['model_id', 'status', 'progress', 'active_request_count', 'npu_usage'])
      assert.ok(k in r, 'running entry missing ' + k);
  }

  const store = await dev.jget(dev.BASE + '/api/v1/models/?including_downloading=true');
  assert.ok(store.data.every((m) => typeof m.id === 'string' && typeof m.npu_usage === 'number'));

  const npu = await dev.jget(dev.P8800 + '/api/v1/npu/status');
  assert.ok('util_percent' in npu.devices[0]);

  const sys = await dev.jget(dev.P8800 + '/api/v1/sys/status');
  assert.equal(sys.status, 'ok');
});

test('jpost drives ac_power and starts a load', async () => {
  process.env.TIINY_BASE = fakeBase;
  const dev = freshDevice();
  const off = await dev.jpost(dev.BASE + '/api/v1/sys/ac_power/', { switch: 0 });
  assert.equal(off.ac_power, false);
  const on = await dev.jpost(dev.BASE + '/api/v1/sys/ac_power/', { switch: 1 });
  assert.equal(on.ac_power, true);

  const start = await dev.jpost(dev.BASE + '/api/v1/models/tiiny/embed-small/start');
  assert.equal(start.status, 'ok');
});

test('the fake enforces the auth header at the HTTP layer', async () => {
  const r = await fetch(fakeBase + '/v1/models'); // no Authorization header
  assert.equal(r.status, 401);
  assert.equal((await r.json()).detail, 'Authorization header is missing');
});
