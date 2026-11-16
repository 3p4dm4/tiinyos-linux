/* M3 S2' — Control Panel embedded: supervisor for the local Tiiny Control Panel
 * (tiiny_ui.py, stdlib-only web app on 127.0.0.1) + a window inside TiinyOS.
 * Electron is required lazily so the supervisor logic is testable with plain node.
 * Security: CP binds to 127.0.0.1 only; we never pass --allow-commands (no
 * terminal until explicitly enabled). No new IPC surface. */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CP_DIR = process.env.TIINY_CP_DIR
  || path.join(os.homedir(), '.local', 'share', 'tiinyos-linux', 'control-panel');
const PY = process.env.TIINY_CP_PY || 'python3';
const PORT = Number(process.env.TIINY_CP_PORT || 8765);
const URL = `http://127.0.0.1:${PORT}/`;
const LOG = path.join(os.homedir(), '.cache', 'flowstate', 'tiiny-cp.log');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// CP gates the UI behind a per-browser credential stored by signin.js (localStorage).
// A second `tiiny_ui.py --no-browser` on a live panel prints a fresh one-time sign-in
// link (works 10 min, single use) and exits — we redeem it inside the Electron window.
async function signInLink() {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile(PY, ['tiiny_ui.py', '--port', String(PORT), '--host', '127.0.0.1', '--no-browser'],
      { cwd: CP_DIR, timeout: 20000 },
      (err, stdout) => {
        const m = String(stdout || '').match(/http:\/\/127\.0\.0\.1:\d+\/\S*code=\S+/);
        console.log('[M3-cp] signInLink:', m ? m[0].slice(0, 52) + '…' : 'NONE', err ? 'err=' + err.message : '');
        resolve(m ? m[0] : null);
      });
  });
}

async function up() {
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(1500) });
    return r.ok || r.status < 500;
  } catch { return false; }
}

let starting = null; // single-flight guard against double-click races

async function ensure() {
  if (await up()) return { ok: true, spawned: false };
  if (!starting) {
    starting = (async () => {
      if (!fs.existsSync(path.join(CP_DIR, 'tiiny_ui.py'))) {
        throw new Error(`CP not found at ${CP_DIR} (set TIINY_CP_DIR)`);
      }
      if (!fs.existsSync(PY)) throw new Error(`python not found at ${PY} (set TIINY_CP_PY)`);
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      const out = fs.openSync(LOG, 'a');
      const { spawn } = require('child_process');
      const child = spawn(PY, ['tiiny_ui.py', '--port', String(PORT), '--host', '127.0.0.1', '--no-browser'],
        { cwd: CP_DIR, detached: true, stdio: ['ignore', out, out] });
      child.unref();
      fs.appendFileSync(LOG, `\n[launcher] spawned pid=${child.pid} port=${PORT}\n`);
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (await up()) return true;
      }
      throw new Error(`CP did not answer on ${URL} within 20s (log: ${LOG})`);
    })().finally(() => { starting = null; });
  }
  await starting;
  return { ok: true, spawned: true };
}

let win = null;

async function open() {
  const { BrowserWindow } = require('electron');
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  let title = 'Control Panel', target = URL;
  try {
    await ensure();
    target = (await signInLink()) || URL; // fresh one-time link; falls back to the plain page
  } catch (e) {
    target = 'data:text/html,<h3 style="font-family:sans-serif">Control Panel did not start.<br><small>'
      + String(e.message).replace(/[<>&]/g, '') + '</small></h3>';
    title = 'Control Panel — error';
  }
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 800, minHeight: 500,
    title, backgroundColor: '#0f1115', autoHideMenuBar: true,
    show: false, // show only once content is there: no black flash
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[M3-cp] blocked window.open ->', url); return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) =>
    console.log(`[M3-cp] did-fail-load ${code} ${desc} ${url}`));
  win.webContents.on('did-finish-load', () => {
    const u = win.webContents.getURL();
    console.log('[M3-cp] did-finish-load', u);
    // signin.js saves the credential to localStorage, then location.replace('/') —
    // that in-page replace never commits under Electron here, so we drive the
    // navigation ourselves a beat later (credential is already in storage).
    if (/\/auth\?/.test(u)) setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(URL); }, 400);
  });
  win.webContents.on('render-process-gone', (e, d) =>
    console.log('[M3-cp] render-process-gone', JSON.stringify(d)));
  win.webContents.on('console-message', (e, level, message, line, src) => {
    if (level >= 2) console.log(`[M3-cp] page[${level}] ${message} (${src}:${line})`);
  });
  win.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    if (isMainFrame) console.log('[M3-cp] navigate ->', url);
  });
  win.webContents.on('did-navigate', (e, url) => console.log('[M3-cp] did-navigate', url));
  console.log('[M3-cp] loading', target);
  win.loadURL(target);
  win.on('closed', () => { win = null; });
}

module.exports = { open, ensure, up };
