/* M3 S1 — Performance window: factory + IPC wiring only (thin by design).
 * Device I/O lives in m3_device.js, benchmark logic in m3_bench.js.
 * The auth key never reaches the renderer: every call goes through main. */
'use strict';
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { BASE, P8800, jget } = require('./m3_device');
const { runBenchmark } = require('./m3_bench');

let win = null;

/* Where the renderer html lives. Inside the installed bundle this file is at
 * out/main/ and the page at out/renderer/performance.html (a sibling of main's
 * parent). In this checkout the module sits in src/ next to performance.html.
 * Resolve whichever exists so the SAME module works in-app and standalone
 * (standalone/main.js requires it straight from src/). The preload path is
 * already correct in both (m3_preload.js is next to this file either way). */
function htmlPath() {
  const inBundle = path.join(__dirname, '..', 'renderer', 'performance.html');
  return fs.existsSync(inBundle) ? inBundle : path.join(__dirname, 'performance.html');
}

function open() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 800, minHeight: 500,
    title: 'Performance',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'm3_preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.setMenu(null); // no File/Edit window menu (Linux default menu bar)
  win.setMenuBarVisibility(false);
  win.loadFile(htmlPath());
  win.on('closed', () => { win = null; });
}

let ipcWired = false;
function wire() {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.handle('m3:models', async () => {
    const m = await jget(`${BASE}/v1/models`);
    return (m.data || []).map(x => ({
      id: x.id, context: x.context_window || x.context,
      capabilities: x.capabilities || [], type: x.type || '',
      supports_chat: !!x.supports_chat, supports_vision: !!x.supports_vision,
    }));
  });
  ipcMain.handle('m3:sysstatus', () => jget(`${P8800}/api/v1/sys/status`));
  ipcMain.handle('m3:npustatus', () => jget(`${P8800}/api/v1/npu/status`));
  ipcMain.handle('m3:store', async () => {
    const m = await jget(`${BASE}/api/v1/models/`);
    return (m.data || []).map(x => ({
      id: x.id || x.model_id, name: x.display_name || x.name,
      type: x.type || '', status: x.status || '', size: x.total_size || 0,
      params: x.params || '', context: x.context_window || x.context,
      capabilities: x.capabilities || [], supports_chat: !!x.supports_chat,
      supports_vision: !!x.supports_vision,
    }));
  });
  ipcMain.handle('m3:benchmark', (_e, model) => runBenchmark(String(model || '')));
}

module.exports = { open, wire };
wire();
