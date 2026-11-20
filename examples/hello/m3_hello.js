/* M3 — Hello Pocket: example tool (framework reference, not installed).
 * Shows the device address, the models in memory and the NPU status on request.
 * No `require('electron')` at module top level: the handlers must run under bare
 * node against the fake device (tests set TIINY_BASE and call wire(stub)). */
'use strict';
const fs = require('fs');
const path = require('path');

/* This example lives in examples/hello/, the SDK it uses lives in src/. A
 * contributor copies this folder into src/, so resolve each dependency as
 * "sibling first, then ../../src" and the same file works in both places. */
function sdk(name) {
  const local = path.join(__dirname, name);
  return require(fs.existsSync(local) ? local : path.join(__dirname, '..', '..', 'src', name));
}

const { BASE, P8800, jget } = sdk('m3_device.js');
const { shortName } = sdk('m3_models.js');

let win = null;
let wired = false;

/* One plain JSON object for the page: where the device is, whether it answers,
 * what it holds in memory, and when this was read (epoch ms). */
async function summary() {
  const [sys, mem] = await Promise.all([
    jget(`${P8800}/api/v1/sys/status`)
      .then(s => ({ ok: true, status: s.status || 'ok' }))
      .catch(e => ({ ok: false, error: e.message })),
    jget(`${BASE}/v1/models`),
  ]);
  const inMemory = (mem.data || []).map(x => ({ id: x.id, name: shortName(x.id) }));
  return { base: BASE, sys, inMemory, readAt: Date.now() };
}

async function npu() {
  const r = await jget(`${P8800}/api/v1/npu/status`);
  const d = (r.devices || [])[0] || {};
  return {
    util: d.util_percent ?? null,
    memUsedMb: d.mem_used_mb ?? null,
    memTotalMb: d.mem_total_mb ?? null,
    readAt: Date.now(),
  };
}

/* Idempotent and injectable: tests pass a stub ({handle}), the app passes
 * nothing and Electron's ipcMain is required lazily. */
function wire(ipc) {
  if (wired) return;
  wired = true;
  const bus = ipc || require('electron').ipcMain;
  bus.handle('m3:hello:summary', () => summary());
  bus.handle('m3:hello:npu', () => npu());
  bus.handle('m3:hello:version', () => ({ tool: 'hello', version: '0.1.0' }));
}

/* Bundle layout: out/main/m3_hello.js with the page in out/renderer/ (same
 * rule as m3_performance.js htmlPath); repo layout: everything in one folder. */
function pagePath() {
  const inBundle = path.join(__dirname, '..', 'renderer', 'hello.html');
  return fs.existsSync(inBundle) ? inBundle : path.join(__dirname, 'hello.html');
}

function preloadPath() {
  const local = path.join(__dirname, 'm3_preload.js');
  return fs.existsSync(local) ? local : path.join(__dirname, '..', '..', 'src', 'm3_preload.js');
}

function open() {
  const { BrowserWindow, nativeTheme } = require('electron');
  wire();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 640, height: 480, minWidth: 480, minHeight: 360,
    title: 'Hello Pocket',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f5f6f8', // = --bg tokens
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(pagePath());
  win.on('closed', () => { win = null; });
}

/* Adopt a window created elsewhere (the generic standalone launcher). */
function attach(w) {
  win = w;
  win.on('closed', () => { win = null; });
}

module.exports = { open, wire, attach, _summary: summary, _npu: npu };
