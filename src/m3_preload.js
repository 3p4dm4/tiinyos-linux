/* M3 — preload bridge for the feature windows (Device, Music Lab, …).
 * Only our own channels pass, both ways: a page (or something injected into it)
 * must not reach the vendor app's IPC handlers through this bridge. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ours = channel => typeof channel === 'string' && channel.startsWith('m3:');

contextBridge.exposeInMainWorld('m3', {
  invoke: (channel, ...args) => {
    if (!ours(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  // main→renderer events
  on: (channel, cb) => {
    if (!ours(channel)) throw new Error(`channel not allowed: ${channel}`);
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
