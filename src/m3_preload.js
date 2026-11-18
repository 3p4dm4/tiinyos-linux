/* M3 — preload bridge for the feature windows (Performance, Music Studio). */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('m3', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // main→renderer events, whitelisted to our own channels
  on: (channel, cb) => {
    if (!channel.startsWith('m3:')) throw new Error('channel not allowed');
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
