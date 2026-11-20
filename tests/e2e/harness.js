'use strict';
/* E2E harness: the installed feature pack, inside a real Electron main
 * process, against the fake Tiiny Pocket (tests/fake_pocket_ctl.py).
 *
 * What it proves that the unit tests cannot:
 *   - the code that SHIPS (the asar-unpacked out/main files, the asar the
 *     installer produced) boots an engine in a real Electron process;
 *   - the real preload bridge (window.m3) round-trips the m3:care:* IPC
 *     contract from a renderer, including rejections and the
 *     m3:care:changed push;
 *   - the full care flows complete end to end at real timings (5 s poll,
 *     15 s outage window): restore after a power cut, update, a power cut
 *     mid-download that resumes from the journal, updateAll, fit refusal,
 *     ac_power, usage, log;
 *   - the engine's state files (care.json, care-log.jsonl) land in the
 *     user's config dir and hold the events.
 *
 * Nothing ever touches the real device: the fake is the only device, on a
 * loopback port, with a dummy auth key in a scratch HOME.
 *
 * Launched by tests/e2e/run_e2e.sh with the clone's Electron binary:
 *   E2E_MAIN=<asar-unpacked>/out/main \
 *   E2E_RENDERER_DIR=<asar-unpacked>/out/renderer \
 *   E2E_CTL=<repo>/tests/fake_pocket_ctl.py \
 *   HOME=<scratch> ELECTRON_RUN_AS_NODE= <electron> --no-sandbox harness.js
 *
 * Prints one "E2E <name> OK" line per verified behaviour and exits non-zero
 * on the first failure.
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const MAIN = process.env.E2E_MAIN;
const CTL_SCRIPT = process.env.E2E_CTL;
const CONFIG_DIR = path.join(process.env.HOME, '.config', 'tiinyos-linux');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitUntil(desc, ms, probe) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      let ok = false;
      try { ok = !!(await probe()); } catch (_) { ok = false; }
      if (ok) { clearInterval(timer); resolve(); }
      else if (Date.now() - t0 > ms) {
        clearInterval(timer);
        reject(new Error(`timed out after ${Math.round(ms / 1000)} s: ${desc}`));
      }
    }, 500);
  });
}

/* ---- fake pocket control channel (stdin JSON, one reply per line) ---- */
const ctl = {
  proc: null, base: '',
  async start() {
    this.proc = spawn('python3', [CTL_SCRIPT, '--scenario', 'normal', '--speed', '1']);
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.queue = [];
    let resolved = false;
    this.rl.on('line', (line) => {
      if (line.startsWith('LISTENING ')) {
        this.base = 'http://127.0.0.1:' + line.split(' ')[1];
        if (!resolved) { resolved = true; this.baseReady(); }
        return;
      }
      const w = this.queue.shift();
      if (w) w(JSON.parse(line));
    });
    this.proc.stderr.on('data', () => {}); // the fake logs to stderr; ignore
    await waitUntil('fake pocket to listen', 10000, () => resolved);
  },
  baseReady() {},
  async send(cmd) {
    const w = new Promise((r) => this.queue.push(r));
    this.proc.stdin.write(JSON.stringify(cmd) + '\n');
    const timeout = new Promise((_, rj) => setTimeout(() => rj(new Error('ctl timeout: ' + cmd.op)), 15000));
    return Promise.race([w, timeout]);
  },
  stop() { try { this.proc.stdin.destroy(); this.proc.kill(); } catch (_) {} },
};

function main() {
  const ok = (name, detail = '') =>
    console.log(`E2E ${name} OK${detail ? ' — ' + detail : ''}`);

  (async () => {
    await ctl.start();
    process.env.TIINY_BASE = ctl.base; // read by the installed m3_device at require time
    console.log('E2E fake pocket OK — ' + ctl.base);

    // The INSTALLED modules, not the repo copies.
    const care = require(path.join(MAIN, 'm3_care.js'));
    const store = require(path.join(MAIN, 'm3_care_store.js'))
      .createStore(CONFIG_DIR);
    care.start(); // default timings: 5 s poll, 15 s outage window

    // Real window with the installed preload; the renderer talks through
    // window.m3 exactly like the Device page would.
    const win = new BrowserWindow({ width: 900, height: 600, show: false,
      webPreferences: { preload: path.join(MAIN, 'm3_preload.js'), contextIsolation: true } });
    await win.loadFile(path.join(__dirname, 'e2e_probe.html'));
    care.wire(win);
    const invoke = (ch, arg = null) =>
      win.webContents.executeJavaScript(
        `window.m3.invoke(${JSON.stringify(ch)}, ${JSON.stringify(arg)})`);
    await win.webContents.executeJavaScript(
      `window.__pushes = []; window.m3.on('m3:care:changed', (s) => {
         window.__pushes.push(s.reach && s.reach.state); }); 'subscribed'`);
    ok('harness up', 'real Electron + installed modules + preload bridge');

    // 1. reach: the engine sees the (fake) device and the bridge reports it
    await waitUntil('engine to reach the fake device', 15000,
      () => care.state().reach.state === 'reachable');
    const st1 = await invoke('m3:care:state');
    if (st1.reach.state !== 'reachable') throw new Error('bridge state says ' + st1.reach.state);
    if (!st1.running.some((m) => m.id === 'tiiny/cogito-mini')) throw new Error('cogito-mini not in bridge running list: ' + JSON.stringify(st1.running));
    ok('reach', 'engine and bridge agree the device is reachable');

    // 2. model inventory + load/unload through the bridge
    const models = await invoke('m3:care:models');
    if (models.models.length < 3) throw new Error('expected the full store list, got ' + models.models.length);
    const embed = models.models.find((m) => m.id === 'tiiny/embed-small');
    if (!embed || embed.need_update !== false) throw new Error('embed-small row wrong');
    await invoke('m3:care:load', { id: 'tiiny/embed-small' }); // 3 s sim load
    await waitUntil('bridge to see embed-small loaded', 20000,
      async () => (await invoke('m3:care:state')).running.some((m) => m.id === 'tiiny/embed-small'));
    await invoke('m3:care:unload', { id: 'tiiny/embed-small' });
    await waitUntil('bridge to see embed-small unloaded', 20000,
      async () => !(await invoke('m3:care:state')).running.some((m) => m.id === 'tiiny/embed-small'));
    ok('models + load/unload', models.models.length + ' models through the renderer bridge');

    // 3. policy/keep, then the power cut: the outage opens, closes, and the
    //    kept policy restores what was in memory (boot restores nothing).
    const pol = await invoke('m3:care:setPolicy', { reload: 'all' });
    if (pol.reload !== 'all') throw new Error('setPolicy returned ' + JSON.stringify(pol));
    const keep = await invoke('m3:care:keep', { id: 'tiiny/cogito-mini', on: true });
    if (!keep.kept.includes('tiiny/cogito-mini')) throw new Error('keep did not stick');
    ok('setPolicy + keep', 'policy=all, kept=cogito-mini, persisted through the bridge');

    await ctl.send({ op: 'cut' });
    await waitUntil('reach to go unreachable (15 s window)', 40000,
      () => care.state().reach.state === 'unreachable');
    await ctl.send({ op: 'restore_power', boot_models: [] });
    const before = care.state().outages.length;
    await waitUntil('outage to close and restore to finish', 60000, async () => {
      const s = care.state();
      return s.reach.state === 'reachable' && s.outages.length > before
        && s.outages[s.outages.length - 1].restored.includes('tiiny/cogito-mini');
    });
    const dev = await ctl.send({ op: 'state' });
    const inMem = Object.keys(dev.models).filter((id) => dev.models[id].in_memory);
    if (!inMem.includes('tiiny/cogito-mini')) throw new Error('restore did not put cogito back: ' + inMem);
    ok('restore after power cut', 'policy=all restored ' + JSON.stringify(inMem) + ' from nothing');

    // 4. single update through the bridge, to a real version bump on the device
    await ctl.send({ op: 'set_scenario', name: 'update_available' });
    const up = await invoke('m3:care:update', { id: 'tiiny/cogito-mini' });
    if (!up.taskId) throw new Error('update returned no taskId');
    await waitUntil('update task to finish', 40000,
      async () => {
        const s = await invoke('m3:care:state');
        const t = s.tasks.find((x) => x.id === up.taskId);
        return t && (t.state === 'done' || t.state === 'failed');
      });
    const dev2 = await ctl.send({ op: 'state' });
    if (dev2.models['tiiny/cogito-mini'].version !== '1.4.0')
      throw new Error('device still on ' + dev2.models['tiiny/cogito-mini'].version);
    if (!dev2.models['tiiny/cogito-mini'].in_memory) throw new Error('updated model not reloaded');
    ok('update', 'cogito-mini 1.3.0 → 1.4.0 and reloaded');

    // 5. power cut mid-download: the journal survives the reboot and the
    //    update resumes from the download step after the outage closes.
    await invoke('m3:care:update', { id: 'tiiny/general-7b' });
    await sleep(6000); // 3 s unload skipped (not loaded) → mid 6 s download
    await ctl.send({ op: 'cut' });
    await waitUntil('reach to go unreachable again', 40000,
      () => care.state().reach.state === 'unreachable');
    await ctl.send({ op: 'restore_power', boot_models: [] });
    const journalPath = path.join(CONFIG_DIR, 'care-journal.json');
    await waitUntil('resumed update to finish and the journal to be cleaned', 90000, async () => {
      const s = care.state();
      return s.reach.state === 'reachable' && !fs.existsSync(journalPath);
    });
    const dev3 = await ctl.send({ op: 'state' });
    if (dev3.models['tiiny/general-7b'].version !== '2.1.0')
      throw new Error('resumed update left the device on ' + dev3.models['tiiny/general-7b'].version);
    const jlog = store.readLog(0).entries;
    if (!jlog.some((e) => e.event === 'update-resumed')) throw new Error('no update-resumed event in the log');
    ok('power cut mid-download', 'journal resume took general-7b to 2.1.0');

    // 6. fit refusal: NPU nearly full, the big model must be refused, not loaded
    await ctl.send({ op: 'set_scenario', name: 'npu_full' });
    await waitUntil('engine to see the npu_full state', 15000,
      () => care.state().running.length === 3);
    let refused = null;
    try { await invoke('m3:care:load', { id: 'tiiny/general-7b' }); }
    catch (e) { refused = String(e.message || e); }
    if (!refused) throw new Error('general-7b loaded although it does not fit (95% NPU used)');
    if (!/insufficient NPU/i.test(refused))
      throw new Error('refusal did not carry the device reason: ' + refused);
    const dev4 = await ctl.send({ op: 'state' });
    if (dev4.models['tiiny/general-7b'].in_memory) throw new Error('refused model is in memory');
    ok('fit refusal', refused.slice(0, 80));

    // 7. ac power + usage through the bridge
    const ac = await invoke('m3:care:setAcPower', { on: true });
    if (ac.acPower !== true) throw new Error('setAcPower returned ' + JSON.stringify(ac));
    const st7 = await invoke('m3:care:state');
    if (!st7.acPower) throw new Error('state does not reflect ac power');
    const usage = await invoke('m3:care:usage', {});
    if (!usage.weekStart || !usage.days || !usage.readAt)
      throw new Error('usage shape wrong: ' + JSON.stringify(usage).slice(0, 120));
    ok('ac_power + usage', 'acPower=true; usage week ' + usage.weekStart);

    // 8. updateAll: a fresh scenario, both updatable models queued one at a time
    await ctl.send({ op: 'set_scenario', name: 'update_available' });
    await waitUntil('engine to see updates pending', 15000, async () => {
      const ms = await invoke('m3:care:models');
      return ms.models.filter((m) => m.need_update).length === 2;
    });
    const all = await invoke('m3:care:updateAll', {});
    if (!Array.isArray(all.taskIds) || all.taskIds.length !== 2)
      throw new Error('updateAll returned ' + JSON.stringify(all));
    await waitUntil('updateAll queue to drain', 90000, async () => {
      const s = await invoke('m3:care:state');
      return all.taskIds.every((id) => {
        const t = s.tasks.find((x) => x.id === id);
        return t && t.state === 'done';
      });
    });
    const dev5 = await ctl.send({ op: 'state' });
    if (dev5.models['tiiny/cogito-mini'].version !== '1.4.0' ||
        dev5.models['tiiny/general-7b'].version !== '2.1.0')
      throw new Error('updateAll left the device at ' +
        dev5.models['tiiny/cogito-mini'].version + ' / ' + dev5.models['tiiny/general-7b'].version);
    ok('updateAll', 'two models updated one at a time to 1.4.0 / 2.1.0');

    // 9. the log, the files on disk, and the push channel
    const log = await invoke('m3:care:log', { since: 0 });
    const kinds = new Set(log.entries.map((e) => e.event));
    for (const k of ['loaded', 'restored', 'updated', 'update-all', 'update-resumed', 'outage'])
      if (!kinds.has(k)) throw new Error('no "' + k + '" event in the care log: ' + [...kinds]);
    if (!fs.existsSync(path.join(CONFIG_DIR, 'care.json')))
      throw new Error('care.json missing under ' + CONFIG_DIR);
    if (!fs.existsSync(path.join(CONFIG_DIR, 'care-log.jsonl')))
      throw new Error('care-log.jsonl missing under ' + CONFIG_DIR);
    ok('log + state files', [...kinds].sort().join(',') + ' — care.json + care-log.jsonl on disk');

    const pushes = await win.webContents.executeJavaScript('window.__pushes');
    if (pushes.length < 5)
      throw new Error('renderer received only ' + pushes.length + ' m3:care:changed pushes');
    if (pushes.some((s) => typeof s !== 'string'))
      throw new Error('a push payload was not a CareState');
    ok('m3:care:changed push', pushes.length + ' CareState pushes reached the renderer');

    const guard = await win.webContents.executeJavaScript(
      `(function(){ try { window.m3.on('m3:care:state', () => {}); return 'accepted'; }
         catch (e) { return 'rejected: ' + e.message; } })()`);
    if (!String(guard).startsWith('rejected'))
      throw new Error('preload accepted a non-whitelisted channel: ' + guard);
    ok('preload guard', 'window.m3.on refuses channels other than m3:care:changed');

    console.log('E2E ALL OK');
    ctl.stop();
    app.exit(0);
  })().catch((e) => {
    console.error('E2E FAILED:', (e && e.stack) || e);
    ctl.stop();
    app.exit(1);
  });
}

app.whenReady().then(main);
