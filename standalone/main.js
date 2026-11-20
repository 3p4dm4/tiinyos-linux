/* TiinyOS tools — standalone host (one tiny app per tool).
 *
 * This is the tiny Electron main process that lives in the farm's
 * resources/app. It does almost nothing:
 *   1. reads which tool to run from the TIINY_TOOL env var (set by launch.sh —
 *      env, not argv, because a packaged Electron ignores an app path on argv);
 *   2. gives THIS process its own name + userData BEFORE requesting the
 *      single-instance lock, so two different tools can run side by side but
 *      each tool only once;
 *   3. requires the tool's feature module straight from ../src (single source
 *      of truth with the in-app window) and calls its open();
 *   4. quits when its window closes.
 *
 * Which call decides the single-instance lock? Electron's
 * app.requestSingleInstanceLock() places a SingletonLock inside
 * app.getPath('userData'); the lock is keyed on that directory, not on argv.
 * So the per-tool isolation comes from giving each tool a distinct userData
 * (and app name) BEFORE the first requestSingleInstanceLock() call — once the
 * name is read, the default userData path is fixed, so it must be set before
 * the app is ready. (Verified against electron.d.ts / Electron docs.)
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');

// tools.json lists the enabled tool ids; everything else about a tool comes
// from its manifest src/<id>.tool.json (docs/framework/MANIFEST.md).
const { tools: TOOLS } = require(path.join(__dirname, 'tools.json'));
const manifest = id => require(path.join(__dirname, '..', 'src', id + '.tool.json'));

// The tool comes from the environment (launch.sh exports TIINY_TOOL). Failing
// here early with a readable message is better than Electron starting blank.
const tool = process.env.TIINY_TOOL || '';
if (!tool || !TOOLS.includes(tool)) {
  console.error(`[tiiny-tools] TIINY_TOOL is '${tool}' — not a registered tool (${TOOLS.join(', ')}). Re-run launch.sh <tool>.`);
  app.exit(1);
}

// Per-tool identity, set BEFORE requestSingleInstanceLock (see the note above).
// userData: ~/.config/tiinyos-linux/standalone-<tool> — its own dir so a
// concurrent Device and Music Lab standalone never share a lock or a profile.
app.setName('tiiny-' + tool);
app.setPath('userData', path.join(os.homedir(), '.config', 'tiinyos-linux', 'standalone-' + tool));

if (!app.requestSingleInstanceLock()) {
  // another instance of THIS tool already runs: focus it and exit.
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w || w.isDestroyed()) return;   // window not up yet: just exit
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  app.quit();
} else {
  app.whenReady().then(() => {
    // The tool's module knows its own window title/icon; we just require it
    // straight from src/ and let it open. Its IPC handlers register on load.
    const mod = require(path.join(__dirname, '..', 'src', manifest(tool).main.module));
    mod.open();
  });
  app.on('window-all-closed', () => app.quit());
}
