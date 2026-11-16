/* M3 S1 — preload bridge for the Performance window. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('m3', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
