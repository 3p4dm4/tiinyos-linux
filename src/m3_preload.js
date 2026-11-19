/* M3 S1 — preload bridge for the Performance window. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('m3', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // Only the care engine pushes, and only this one channel: refuse anything
  // else at the bridge so a future caller cannot widen the surface.
  on: (channel, fn) => {
    if (channel !== 'm3:care:changed') throw new Error('channel not allowed: ' + channel);
    const l = (_e, p) => fn(p);
    ipcRenderer.on(channel, l);
    return () => ipcRenderer.removeListener(channel, l);
  },
});
