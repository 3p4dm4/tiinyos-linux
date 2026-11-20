// Example tool `hello` — node test against the fake device (no Electron, no
// real device). TIINY_BASE is set BEFORE the module is required, because
// src/m3_device.js reads it at load time; wire() gets a stub ipcMain, so the
// handlers are plain functions we can call directly.
//
// Run: node --test examples/hello/hello.test.js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const MODULE = path.join(__dirname, 'm3_hello.js');
const DUMMY_KEY = 'dummy-auth-key-not-a-real-token';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hello-home-'));
fs.mkdirSync(path.join(HOME, '.local', 'tiiny'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.local', 'tiiny', 'config.json'),
  JSON.stringify({ account: { authKey: DUMMY_KEY } }));
const realHome = process.env.HOME;
process.env.HOME = HOME; // os.homedir() follows HOME on POSIX

const children = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  fs.rmSync(HOME, { recursive: true, force: true });
  if (realHome !== undefined) process.env.HOME = realHome;
  else delete process.env.HOME;
});

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

async function spawnFake(scenario) {
  const cp = spawn('python3', [path.join(ROOT, 'tests', 'fake_pocket.py'),
    '--port', '0', '--scenario', scenario, '--speed', '50'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await readPort(cp);
  children.push(cp);
  return 'http://127.0.0.1:' + port;
}

// Fresh require chain so BASE/P8800 pick up the current TIINY_BASE.
function freshHello(base) {
  process.env.TIINY_BASE = base;
  for (const f of ['m3_device.js', 'm3_models.js']) delete require.cache[require.resolve(path.join(SRC, f))];
  delete require.cache[require.resolve(MODULE)];
  const handlers = {};
  const registrations = [];
  const ipc = {
    handle: (ch, fn) => { registrations.push(ch); handlers[ch] = fn; },
    removeHandler: () => {},
  };
  require(MODULE).wire(ipc);
  return { handlers, registrations };
}

test('hello: every handler is registered under the m3:hello prefix', async () => {
  const { handlers, registrations } = freshHello(await spawnFake('normal'));
  for (const ch of ['m3:hello:summary', 'm3:hello:npu', 'm3:hello:version'])
    assert.equal(typeof handlers[ch], 'function', ch);
  for (const ch of Object.keys(handlers)) assert.ok(ch.startsWith('m3:hello:'), ch);
});

test('hello: wire is idempotent (a second call registers nothing)', async () => {
  process.env.TIINY_BASE = await spawnFake('normal');
  delete require.cache[require.resolve(MODULE)];
  const hello = require(MODULE);
  const seen = [];
  const ipc = { handle: (ch) => seen.push(ch), removeHandler: () => {} };
  hello.wire(ipc);
  hello.wire(ipc);
  assert.deepEqual(seen, ['m3:hello:summary', 'm3:hello:npu', 'm3:hello:version']);
});

test('hello: summary lists the model the normal scenario holds in memory', async () => {
  const { handlers } = freshHello(await spawnFake('normal'));
  const s = await handlers['m3:hello:summary']();
  assert.ok(s.base.startsWith('http://127.0.0.1:'), 'never the real device');
  assert.equal(s.sys.ok, true);
  assert.equal(s.sys.status, 'ok');
  assert.deepEqual(s.inMemory.map((m) => m.id), ['tiiny/cogito-mini']);
  assert.equal(s.inMemory[0].name, 'cogito-mini'); // shortName strips the owner
  assert.ok(Number.isInteger(s.readAt));
});

test('hello: npu_full reports three models and memory near the budget', async () => {
  const { handlers } = freshHello(await spawnFake('npu_full'));
  const s = await handlers['m3:hello:summary']();
  assert.equal(s.inMemory.length, 3);
  const n = await handlers['m3:hello:npu']();
  assert.equal(typeof n.util, 'number');
  assert.equal(n.memTotalMb, 4096);
  assert.ok(n.memUsedMb > 3500 && n.memUsedMb <= 4096, '95% of the NPU budget used');
  assert.ok(Number.isInteger(n.readAt));
});

test('hello: version answers the tool id and version', async () => {
  const { handlers } = freshHello(await spawnFake('normal'));
  assert.deepEqual(await handlers['m3:hello:version'](), { tool: 'hello', version: '0.1.0' });
});

test('hello: a device that does not answer yields a readable error, not a hang', async () => {
  const { handlers } = freshHello('http://127.0.0.1:1'); // closed port on loopback
  await assert.rejects(handlers['m3:hello:npu'](), /fetch failed|ECONNREFUSED/);
});
