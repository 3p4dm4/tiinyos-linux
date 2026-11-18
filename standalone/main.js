/* Music Lab standalone — the music window without the TiinyOS app.
 * Reuses the feature source from ../src (single source of truth): IPC handlers
 * come from m3_music.js, the window registers itself via attach() so progress
 * events land here too. Requires the Pocket reachable (see docs/network.md). */
'use strict';
const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
require(path.join(SRC, 'm3_music.js')); // registers the m3:music:* IPC handlers

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 860, minHeight: 560,
    title: 'Music Lab',
    icon: path.join(SRC, 'music-lab.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#eef0f4', // = music.css --bg, no flash
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(SRC, 'm3_preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(SRC, 'music.html'));
  require(path.join(SRC, 'm3_music.js')).attach(win);
});

app.on('window-all-closed', () => app.quit());
