/* M3 music — main-process wiring tests: the IPC handlers that work without the Pocket
 * (takes listing, config write, cross-process lock refusal).
 *
 * electron is not installed here, so it is stubbed at require time and HOME is
 * redirected to a temp dir BEFORE m3_music.js loads (it derives CONFIG_PATH and
 * LOCK_PATH from os.homedir() at require time). Nothing in this file may reach
 * the network: global.fetch is replaced by a tripwire that fails the test. */
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

// --- isolated HOME (must happen before m3_music is required) ---
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'm3music-home-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));
const OUT = path.join(HOME, 'Musica', 'tiiny');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME; // os.homedir() on Windows, for symmetry

// --- device tripwire: any network use is a test failure, not a hang ---
let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls += 1;
  throw new Error(`test must not contact the device: ${url}`);
};

// --- electron stub: capture the IPC handlers m3_music registers at load ---
const handlers = {};
const electronStub = {
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  dialog: {},
  nativeTheme: { shouldUseDarkColors: true },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};
require('../../src/m3_music.js');
Module._load = origLoad;

// fresh config + takes folder for each test
function freshCfg(extra = {}) {
  fs.rmSync(OUT, { recursive: true, force: true }); // each test starts with an empty takes folder
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(lockPath(), { force: true });           // and with no lock held
  fs.mkdirSync(path.join(HOME, '.config', 'music-lab'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.config', 'music-lab', 'config.json'),
    JSON.stringify({ outDir: OUT, refsDir: path.join(HOME, 'refs'), ...extra }));
}
const lockPath = () => path.join(HOME, '.config', 'music-lab', 'generate.lock');
const FOREIGN = 1; // pid 1: alive, not ours, not signalable by a normal user

test('ipc: m3:music:takes lists the output folder (restart-proof list)', async () => {
  freshCfg();
  fs.writeFileSync(path.join(OUT, 'old.wav'), 'w');
  fs.writeFileSync(path.join(OUT, 'old.json'), JSON.stringify({ version: 1, createdAt: '2026-11-01T10:00:00Z', caption: 'old take' }));
  fs.writeFileSync(path.join(OUT, 'new.wav'), 'w');
  fs.writeFileSync(path.join(OUT, 'new.mp3'), 'm');
  fs.writeFileSync(path.join(OUT, 'new.json'), JSON.stringify({ version: 1, createdAt: '2026-11-19T10:00:00Z', caption: 'new take' }));
  fs.writeFileSync(path.join(OUT, 'notes.txt'), 'not a take');
  const takes = await handlers['m3:music:takes']();
  assert.equal(takes.length, 2);
  assert.ok(takes[0].wav.endsWith('new.wav'));
  assert.equal(takes[0].meta.caption, 'new take');
  assert.ok(takes[1].wav.endsWith('old.wav'));
  assert.equal(fetchCalls, 0, 'listing stays local');
});

test('ipc: m3:music:takes with no output folder is an empty list', async () => {
  freshCfg({ outDir: path.join(HOME, 'nowhere') });
  assert.deepEqual(await handlers['m3:music:takes'](), []);
});

test('ipc: m3:music:generate refuses while another process holds the lock', async () => {
  freshCfg();
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify({ pid: FOREIGN, startedAt: new Date().toISOString(), host: 'other-window' }) + '\n');
  // synchronous throw here (Electron would surface it as a rejected IPC promise)
  let err = null;
  try { handlers['m3:music:generate'](null, { caption: 'x' }); }
  catch (e) { err = e; }
  assert.ok(err, 'generate must refuse while a foreign lock is held');
  assert.match(err.message, /a generation is already running in another Music Lab window \(pid 1\)/);
  assert.equal(fetchCalls, 0, 'the refusal happens before any device call');
  // the foreign lock is left alone
  assert.equal(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid, FOREIGN);
});

test('ipc: m3:music:choose saves the model choice atomically', async () => {
  freshCfg();
  const before = new Set(fs.readdirSync(path.join(HOME, '.config', 'music-lab')));
  const cfg = await handlers['m3:music:choose'](null, { role: 'composer', id: 'ACE-Step/AceStep-XL-Turbo' });
  assert.equal(cfg.composer, 'ACE-Step/AceStep-XL-Turbo');
  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, '.config', 'music-lab', 'config.json'), 'utf8'));
  assert.equal(onDisk.composer, 'ACE-Step/AceStep-XL-Turbo');
  assert.equal(onDisk.outDir, OUT); // patch merged, not overwritten
  const after = fs.readdirSync(path.join(HOME, '.config', 'music-lab'));
  assert.deepEqual(after.filter(f => !before.has(f)), [], 'no tmp residue');
});

test('ipc: m3:music:config reports the temp config path (never the real home)', async () => {
  freshCfg();
  const cfg = await handlers['m3:music:config']();
  assert.equal(cfg.configPath, path.join(HOME, '.config', 'music-lab', 'config.json'));
  assert.ok(cfg.outDir.startsWith(HOME) && cfg.refsDir.startsWith(HOME));
});

test('ipc: every handler the store needs is registered', () => {
  for (const ch of ['m3:music:takes', 'm3:music:generate', 'm3:music:status', 'm3:music:choose', 'm3:music:config'])
    assert.equal(typeof handlers[ch], 'function', `${ch} missing`);
});
