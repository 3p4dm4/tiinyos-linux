// Boot smoke test (stand-in for the Playwright render check, which is not
// installed in this environment). Loads the Device-window modules against a
// minimal DOM shim with a stub IPC bridge:
//   · the EXISTING metrics channels (sysstatus/npustatus/models/store) RESOLVE,
//   · every m3:device:* channel REJECTS  ("not installed").
// Then asserts the shipped fail-soft behaviour:
//   · boot runs without throwing (tabs + all four tabs + data owner),
//   · the care-engine surfaces report "not available",
//   · no fake data appears in the Usage tab,
//   · the one-metric KPIs DO populate (the existing IPC works).
//
// This is the closest deterministic substitute for a headless render in this
// environment. It exercises the real code paths (createElement builds, event
// wiring, promise resolution, bus emission), not a reimplementation.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const M3 = path.join(__dirname, '..', '..', 'src', 'm3perf');

/* ---------- minimal DOM ---------- */
function makeEl(tag, ns) {
  const el = {
    tagName: tag, namespaceURI: ns || null,
    children: [], parentNode: null, attributes: {},
    style: {}, _listeners: {}, _className: '', _id: '', _text: '', _hidden: false,
    tabIndex: 0, checked: false, disabled: false, value: '', title: '',
  };
  Object.defineProperty(el, 'className', { get() { return el._className; }, set(v) { el._className = v == null ? '' : String(v); } });
  Object.defineProperty(el, 'id', {
    get() { return el._id; },
    set(v) { el._id = v == null ? '' : String(v); }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = v == null ? '' : String(v); el.children = []; }
  });
  Object.defineProperty(el, 'hidden', { get() { return el._hidden; }, set(v) { el._hidden = !!v; } });
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
  Object.defineProperty(el, 'lastChild', { get() { return el.children[el.children.length - 1] || null; } });
  el.setAttribute = function (n, v) { this.attributes[n] = String(v); if (n === 'id') this.id = String(v); };
  el.setAttributeNS = function (ns, n, v) { this.attributes[n] = String(v); };
  el.getAttribute = function (n) { return (n in this.attributes) ? this.attributes[n] : null; };
  el.removeAttribute = function (n) { delete this.attributes[n]; };
  el.appendChild = function (c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; c._detached = false; this.children.push(c); return c; };
  el.removeChild = function (c) { this.children = this.children.filter(x => x !== c); if (c) { c.parentNode = null; c._detached = true; } return c; };
  el.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  el.addEventListener = function (t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.match = function (s) { return matchSel(el, s); };
  el.matches = function (s) { return matchSel(el, s); };
  el.querySelector = function (s) { return firstIn(el.children, s); };
  el.querySelectorAll = function (s) { return allIn(el.children, s); };
  el.focus = function () {};
  el.getBoundingClientRect = function () { return { width: 640, height: 220, top: 0, left: 0 }; };
  el.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  return el;
}
function matchSimple(el, s) {
  // compound selector: optional tag + any .class / #id / [attr] parts, e.g. "td.name", ".st", '[role="tab"]'
  const m = s.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1]) return false;
  const parts = (m[2] || '').match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
  for (const p of parts) {
    if (p[0] === '.') { if ((' ' + el.className + ' ').indexOf(' ' + p.slice(1) + ' ') === -1) return false; }
    else if (p[0] === '#') { if (el.id !== p.slice(1)) return false; }
    else { const a = p.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/); if (!a) return false;
      if (a[2] == null) { if (!(a[1] in el.attributes)) return false; } else if (el.attributes[a[1]] !== a[2]) return false; }
  }
  return true;
}
function matchSel(el, sel) {
  sel = sel.trim();
  if (sel.indexOf(' ') > -1) {
    const parts = sel.split(/\s+/);
    const last = parts[parts.length - 1];
    const rest = parts.slice(0, -1).join(' ');
    if (!matchSimple(el, last)) return false;
    let p = el.parentNode;
    while (p) { if (p.matches && p.matches(rest)) return true; p = p.parentNode; }
    return false;
  }
  return matchSimple(el, sel);
}
function walk(nodes, out) { nodes.forEach(n => { out.push(n); if (n.children) walk(n.children, out); }); return out; }
function firstIn(nodes, sel) { for (const n of nodes) { if (matchSel(n, sel)) return n; const d = firstIn(n.children || [], sel); if (d) return d; } return null; }
function allIn(nodes, sel) { const out = []; for (const n of nodes) { if (matchSel(n, sel)) out.push(n); allIn(n.children || [], sel).forEach(x => out.push(x)); } return out; }

function buildDocument() {
  const doc = {
    _byId: {}, _all: [],
    createElement: (t) => { const e = makeEl(t); doc._all.push(e); return e; },
    createElementNS: (ns, t) => { const e = makeEl(t, ns); doc._all.push(e); return e; },
    createTextNode: (t) => ({ nodeType: 3, data: String(t), parentNode: null, remove() {} }),
    // like the real DOM: a removed node is no longer found by id
    getElementById: (id) => doc._all.find(n => n._id === id && !n._detached) || null,
    querySelectorAll: (sel) => doc._all.filter(n => matchSel(n, sel)),
    querySelector: (sel) => firstIn(doc._all, sel),
    addEventListener: () => {},
    documentElement: makeEl('html'),
    readyState: 'complete',
  };
  doc.documentElement._listeners = {};
  return doc;
}

// The static shell elements the modules expect (mirrors performance.html).
function buildStatic(document) {
  const id = (tag, idv, extra) => {
    const e = document.createElement(tag); e.id = idv;
    if (extra) Object.assign(e.attributes, extra);
    document._byId[idv] = e;
    return e;
  };
  ['status', 'models', 'usage', 'power'].forEach(function (k, i) {
    const li = document.createElement('li');
    li.setAttribute('role', 'tab'); li.setAttribute('aria-controls', 'p-' + k);
    li.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
    li.id = 'tab-' + k; li.tabIndex = i === 0 ? 0 : -1;
    document._byId[li.id] = li; document._all.push(li);
    const p = document.createElement('div'); p.id = 'p-' + k; p.hidden = i !== 0;
    p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', 'tab-' + k);
    document._byId[p.id] = p; document._all.push(p);
  });
  const theme = id('button', 'theme', {});
  const sr = id('span', 'strip-reach', {});
  const req = id('span', 'strip-req', {});
  const task = id('span', 'strip-task', {});
  const meter = id('span', 'strip-meter', {}); meter.appendChild(document.createElement('i'));
  const details = id('button', 'strip-details', { 'data-tab': 'tab-status' });
  const devver = id('span', 'dev-ver', {}); devver.textContent = 'Tiiny Pocket';
}

/* ---------- payloads in the EXACT shape the main-process handlers return ----------
 * m3:sysstatus  -> p8800 /api/v1/sys/status  (cpu, memory, npus[], disk)
 * m3:npustatus  -> p8800 /api/v1/npu/status  (npu.status, devices[])
 * m3:models     -> array {id, context, capabilities[], type, supports_chat}
 * m3:store      -> array {id, name, type, status, size, context, capabilities}
 * (verified against src/m3_performance.js handlers + the baseline gauges.js)
 */
var GB = 1024 * 1024 * 1024;
const SYS = {
  cpu: { total_percent: 48, per_core_percent: [40, 50, 45, 55] },
  memory: { usage_percent: 64, used_bytes: 20 * GB, total_bytes: 31.25 * GB },
  npus: [{ utilization_percent: 72, memory_used_mb: 6553, memory_total_mb: 8192 }],
  disk: { total_bytes: 476 * GB, used_bytes: 266 * GB, free_bytes: 210 * GB },
};
const NPU = { npu: { status: 'ready', status_message: 'idle' }, devices: [{ model: 'L50', temp_c: 45, power_w: 20 }] };
const MODELS = [
  { id: 'tiel-coder-35b', context: 32768, capabilities: ['main'], type: 'text generation', supports_chat: true },
  { id: 'qwen3.8-27b-mtp', context: 131072, capabilities: ['main'], type: 'text generation', supports_chat: true },
];
const STORE = [
  { id: 'tiel-coder-35b', name: 'TIEL Coder 35B', type: 'text generation', status: 'running', size: 21 * GB, context: 32768, capabilities: ['main'], supports_chat: true },
  { id: 'qwen3.8-27b-mtp', name: 'Qwen 3.8 27B MTP', type: 'text generation', status: 'installed', size: 17 * GB, context: 131072, capabilities: ['main'], supports_chat: true },
];
const BENCH = { kind: 'chat', inputTps: 4200, outputTps: 95, ttftMs: 130, p95Ms: 480, errorRate: 0.001 };

const NETCHECK = {
  readAt: Date.now(), deviceIp: '10.9.9.2', ok: 1, total: 2, hostsLine: '10.9.9.2 tts.api.tiiny',
  hosts: [
    { host: 'api.tiiny', inHosts: true, address: '10.9.9.2', http: 404, verdict: 'ok', remedy: '' },
    { host: 'tts.api.tiiny', inHosts: false, address: null, http: null, verdict: 'missing', remedy: 'Not in /etc/hosts: add it (line below).' },
  ],
};

function buildWindow() {
  const doc = buildDocument();
  buildStatic(doc);
  const window = {
    m3: {
      invoke(ch) {
        if (ch === 'm3:sysstatus') return Promise.resolve(SYS);
        if (ch === 'm3:npustatus') return Promise.resolve(NPU);
        if (ch === 'm3:models') return Promise.resolve(MODELS);
        if (ch === 'm3:store') return Promise.resolve(STORE);
        if (ch === 'm3:benchmark') return Promise.resolve(BENCH);
        if (ch === 'm3:device:netcheck') return Promise.resolve(NETCHECK);
        if (ch.indexOf('m3:device:') === 0) return Promise.reject(new Error('device-care: not installed'));
        return Promise.resolve(null);
      },
      listen() {},
      ready() {},
    },
  };
  window.document = doc;
  window.window = window;
  window.addEventListener = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  window.console = { log() {}, warn() {}, error() {}, debug() {} };
  window.requestAnimationFrame = (fn) => 0;
  window.setTimeout = () => 0; // no-op: keep the smoke test one-shot & deterministic
  window.setInterval = () => 0;
  window.clearTimeout = () => {};
  window.clearInterval = () => {};
  window.Date = Date;
  window.Promise = Promise;
  window.Math = Math;
  window.JSON = JSON;
  window.parseInt = parseInt;
  window.parseFloat = parseFloat;
  window.String = String;
  window.Number = Number;
  window.Object = Object;
  window.Array = Array;
  window.Error = Error;
  return { window, document: doc };
}

function tick(n) { let p = Promise.resolve(); for (let i = 0; i < (n || 6); i++) p = p.then(() => {}); return p; }

const ORDER = ['helpers.js', 'tabs.js', 'bench.js', 'status.js', 'models.js', 'chart.js', 'usage.js', 'power.js', 'data.js', 'main.js'];

function bootAll() {
  const { window, document } = buildWindow();
  const sandbox = Object.assign({}, window, { document, console: window.console });
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const f of ORDER) {
    const code = fs.readFileSync(path.join(M3, f), 'utf8');
    vm.runInContext(code, context, { filename: f });
  }
  return { window, document, context };
}

test('Device window boots against the fail-soft contract without throwing', async function () {
  const { window, document } = bootAll();
  await tick(); // let the one-shot IPC promises resolve

  // 1) all four tab panels exist and were populated
  ['p-status', 'p-models', 'p-usage', 'p-power'].forEach(function (id) {
    assert.ok(document.getElementById(id), 'panel ' + id + ' exists');
  });

  // 2) Status: the one-metric KPIs populate from the EXISTING IPC (no fake care data)
  assert.equal(document.getElementById('k-cpu').textContent, '48%');
  assert.equal(document.getElementById('k-ram').textContent, '64%');
  assert.equal(document.getElementById('k-npumem').textContent, '80%');
  assert.equal(document.getElementById('k-disk').textContent, '56%');
  // NPU state derived from npu.npu.status (rendered as a status pill)
  assert.equal(document.getElementById('k-npustate').querySelector('.st').textContent, 'ready');

  // 3) Status: care-engine surfaces report "not available" (fail-soft, no fake data)
  assert.ok(document.getElementById('h-mem'), 'In memory heading');
  const tasksNote = document.getElementById('tasks').querySelector('.note');
  assert.ok(/not available/i.test(tasksNote.textContent), 'tasks fail-soft: "' + tasksNote.textContent + '"');
  const logNote = document.getElementById('actlog').querySelector('.note');
  assert.ok(/not available/i.test(logNote.textContent), 'log fail-soft: "' + logNote.textContent + '"');

  // 4) Models: in-memory rows from m3:models (name falls back to id); installed from m3:store (has display name)
  const mm = document.getElementById('inmem-m');
  const names = Array.prototype.map.call(mm.querySelectorAll('td.name'), function (n) { return n.textContent; });
  assert.ok(names.indexOf('tiel-coder-35b') > -1, 'in-memory lists the loaded id: ' + names.join(', '));
  const inst = document.getElementById('inst-m');
  const instNames = Array.prototype.map.call(inst.querySelectorAll('td.name'), function (n) { return n.textContent; });
  assert.ok(instNames.indexOf('TIEL Coder 35B') > -1, 'installed uses the store display name: ' + instNames.join(', '));

  // 5) Usage: engine absent -> explicit "not available", and NO fake numbers
  const ufig = document.getElementById('usage-state');
  assert.ok(/not available/i.test(ufig.textContent), 'usage figure not-available: "' + ufig.textContent + '"');
  assert.ok(document.getElementById('wk-label'), 'usage week label present');

  // 6) Power: controls present, disabled + a "not available" note (engine absent)
  const ac = document.getElementById('ac');
  assert.ok(ac, 'AC switch present');
  assert.ok(ac.disabled, 'AC switch disabled when engine absent');
  const powerNote = document.getElementById('power-note');
  assert.ok(!powerNote.hidden && /not available/i.test(powerNote.textContent), 'power fail-soft note');
  const restoreNote = document.getElementById('restore-note');
  assert.ok(/not available/i.test(restoreNote.textContent), 'restore fail-soft: "' + restoreNote.textContent + '"');

  // 7) the persistent strip rendered (reach "unknown" until first read — here care is absent)
  assert.ok(document.getElementById('strip-reach').children.length >= 1, 'strip reach populated');
  // the failed m3:device:state read reaches the strip (not stuck on the first-paint "Reading")
  assert.equal(document.getElementById('strip-reach').children[0].textContent, 'Engine not available');
});

test('Connection check: the button fills the table and the /etc/hosts line', async function () {
  const { document } = bootAll();
  await tick();
  assert.equal(document.getElementById('conn-sum').textContent, 'Not checked yet.');
  assert.ok(document.getElementById('conn-fix').hidden, 'no fix line before a check');
  document.getElementById('conn-run')._listeners.click[0]();
  await tick();
  assert.match(document.getElementById('conn-sum').textContent, /^1 of 2 names answer · device at 10\.9\.9\.2/);
  const rows = document.getElementById('conn-rows').querySelectorAll('tr');
  assert.equal(rows.length, 2);
  assert.equal(document.getElementById('conn-fix').hidden, false);
  assert.equal(document.getElementById('conn-line').textContent, '10.9.9.2 tts.api.tiiny');
  assert.equal(document.getElementById('conn-run').disabled, false, 'button enabled again');
});
