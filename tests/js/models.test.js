// Node tests for src/m3_models.js against the fake Tiiny Pocket.
//
// Each test that needs a different scenario spawns its own fake on an
// ephemeral loopback port (--speed 50 keeps simulated loads/downloads short),
// points TIINY_BASE + HOME at it, and re-requires the modules fresh (they
// capture BASE / authKey at require time).
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
const DUMMY_KEY = 'dummy-auth-key-not-a-real-token';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-models-home-'));
fs.mkdirSync(path.join(HOME, '.local', 'tiiny'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.local', 'tiiny', 'config.json'),
  JSON.stringify({ account: { authKey: DUMMY_KEY } }));

const children = [];
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

// Spawn a standalone fake with one scenario; returns its base URL.
async function spawnFake(scenario, speed = 50) {
  const cp = spawn('python3',
    [path.join(REPO_ROOT, 'tests', 'fake_pocket.py'),
     '--port', '0', '--scenario', scenario, '--speed', String(speed)],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await readPort(cp);
  children.push(cp);
  return 'http://127.0.0.1:' + port;
}

// Re-require m3_device + m3_models with the given base (both capture env at load).
function freshModels(base) {
  process.env.TIINY_BASE = base;
  process.env.HOME = HOME;
  for (const f of ['m3_device.js', 'm3_models.js'])
    delete require.cache[require.resolve(path.join(REPO_ROOT, 'src', f))];
  return require(path.join(REPO_ROOT, 'src', 'm3_models.js'));
}

after(() => {
  for (const cp of children) cp.kill('SIGKILL');
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('mpath percent-encodes id segments but keeps the separator', () => {
  const { mpath } = freshModels('http://127.0.0.1:1'); // env irrelevant here
  assert.equal(mpath('tiiny/cogito-mini'), 'tiiny/cogito-mini');
  assert.equal(mpath('owner/my model'), 'owner/my%20model');
  assert.equal(mpath('a/b c/d e'), 'a/b%20c/d%20e');
});

test('ensureLoaded loads an installed model that is not in memory', async () => {
  const base = await spawnFake('normal');
  try {
    const models = freshModels(base);
    const before = await models.runningIds();
    assert.ok(!before.has('tiiny/embed-small'), 'precondition: not in memory');
    await models.ensureLoaded('tiiny/embed-small', null, { pollMs: 250 });
    const after = await models.runningIds();
    assert.ok(after.has('tiiny/embed-small'), 'embed-small in memory after load');
  } finally {
    // leave the other fake instances untouched; this one is killed in test.after
  }
});

test('ensureLoaded is a no-op for a model already in memory', async () => {
  const base = await spawnFake('normal');
  const models = freshModels(base);
  const t0 = Date.now();
  await models.ensureLoaded('tiiny/cogito-mini'); // already loaded in the scenario
  assert.ok(Date.now() - t0 < 1500, 'returned without polling a load');
  assert.ok((await models.runningIds()).has('tiiny/cogito-mini'));
});

test('a slow load reports progress ticks through onProgress', async () => {
  const base = await spawnFake('slow_load');
  const models = freshModels(base);
  const seen = [];
  await models.ensureLoaded('tiiny/embed-small', (p) => p != null && seen.push(p), { pollMs: 50 });
  assert.ok(seen.length >= 2, 'expected several progress ticks, got ' + JSON.stringify(seen));
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i] > seen[i - 1], 'progress must rise: ' + JSON.stringify(seen));
  assert.ok(seen[seen.length - 1] < 100, 'ticks stop once loaded');
  assert.ok((await models.runningIds()).has('tiiny/embed-small'));
});

test('a load that cannot finish within timeoutMs throws a timeout error', async () => {
  const base = await spawnFake('slow_load');
  const models = freshModels(base);
  await assert.rejects(
    () => models.ensureLoaded('tiiny/embed-small', null, { pollMs: 50, timeoutMs: 100 }),
    (e) => /did not load/.test(e.message),
  );
  // the refused/unfinished load is not in memory
  assert.ok(!(await models.runningIds()).has('tiiny/embed-small'));
});

test('npu_full: a model that does not fit is refused, and fitPlan names the eviction', async () => {
  const base = await spawnFake('npu_full');
  const models = freshModels(base);
  const plan = await models.fitPlan('tiiny/general-7b'); // 80% needed, 5% free
  assert.equal(plan.fits, false);
  assert.ok(plan.evicts.length >= 1, 'device names at least one model it would evict');
  await assert.rejects(
    () => models.ensureLoaded('tiiny/general-7b', null, { pollMs: 50 }),
    (e) => /insufficient NPU|409/.test(e.message),
  );
  // and it was NOT loaded: nothing evicted by us
  assert.ok(!(await models.runningIds()).has('tiiny/general-7b'));
});

test('fitPlan reports a free NPU as fitting with no eviction', async () => {
  const base = await spawnFake('normal');
  const models = freshModels(base);
  const plan = await models.fitPlan('tiiny/embed-small'); // 15% needed, 40% free
  assert.equal(plan.fits, true);
  assert.deepEqual(plan.evicts, []);
});

test('unload removes a model from memory', async () => {
  const base = await spawnFake('normal');
  const models = freshModels(base);
  await models.ensureLoaded('tiiny/embed-small', null, { pollMs: 250 });
  await models.unload('tiiny/embed-small');
  assert.ok(!(await models.runningIds()).has('tiiny/embed-small'));
});
