// The preload bridge lets the page reach only our own m3:* channels, both ways.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

function loadBridge() {
  const calls = { invoke: [], on: [] };
  let exposed = null;
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: {
      invoke: (ch, ...a) => { calls.invoke.push([ch, ...a]); return Promise.resolve('ok'); },
      on: (ch, fn) => { calls.on.push([ch, fn]); },
    },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : orig.call(this, req, ...rest); };
  try {
    const p = require.resolve(path.join(__dirname, '..', '..', 'src', 'm3_preload.js'));
    delete require.cache[p];
    require(p);
  } finally { Module._load = orig; }
  return { api: exposed, calls };
}

test('invoke passes m3:* channels', async () => {
  const { api, calls } = loadBridge();
  assert.equal(await api.invoke('m3:device:state', 1), 'ok');
  assert.deepEqual(calls.invoke[0], ['m3:device:state', 1]);
});

test('invoke refuses any other channel without calling ipcRenderer', async () => {
  const { api, calls } = loadBridge();
  await assert.rejects(api.invoke('floating-ball-refactor:set-ignore-mouse-events', false), /not allowed/);
  await assert.rejects(api.invoke(undefined), /not allowed/);
  assert.equal(calls.invoke.length, 0);
});

test('on accepts m3:* and refuses the rest', () => {
  const { api, calls } = loadBridge();
  api.on('m3:device:changed', () => {});
  assert.equal(calls.on.length, 1);
  assert.throws(() => api.on('account:update', () => {}), /not allowed/);
  assert.equal(calls.on.length, 1);
});
