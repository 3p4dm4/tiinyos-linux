/* M3 Device — data layer: the only place that talks to the main process.
 *
 * Polls the existing device IPC (m3:sysstatus + m3:npustatus + m3:store) and
 * subscribes to the m3:device:* contract channels, then republishes on M3.bus so
 * views stay dumb. Every m3:device:* call fails soft: the engine may be absent
 * (m3_care.js is not wired yet), and when it is we emit nothing and the views
 * show their "not available" state. No fake data is ever produced here.
 */
window.M3 = window.M3 || {};
M3.data = (function () {
  var h = M3.h;
  var timers = [];
  var careOk = false; // did any m3:device:* channel answer at least once?

  function invoke(ch, args) {
    if (!window.m3 || !window.m3.invoke) return Promise.reject(new Error('ipc unavailable'));
    return window.m3.invoke(ch, args);
  }
  function on(ch, cb) {
    if (window.m3 && window.m3.on) window.m3.on(ch, cb);
  }

  // soft care call: swallow "no handler" (engine absent) and report only success.
  function care(ch, args) {
    return invoke(ch, args).then(function (r) { careOk = true; return r; })
      .catch(function () { return null; });
  }

  /* ---- metrics: sysstatus (CPU/RAM/disk/NPU0) + npustatus (NPU state) ---- */
  function pollMetrics() {
    if (!window.m3 || !window.m3.invoke) return;
    Promise.all([
      invoke('m3:sysstatus').catch(function (e) { return { error: String(e.message || e) }; }),
      invoke('m3:npustatus').catch(function (e) { return { error: String(e.message || e) }; })
    ]).then(function (r) {
      M3.bus.emit('metrics', { sys: r[0], npu: r[1], at: Date.now() });
    });
  }

  /* ---- store: total bytes of installed models (for the Disk KPI detail).
   * m3:store returns an ARRAY of {id,name,type,status,size,...}. ---- */
  function pollStore() {
    invoke('m3:store').then(function (arr) {
      if (!Array.isArray(arr)) return;
      M3.storeBytes = arr.reduce(function (a, m) { return a + (m.size || 0); }, 0);
      M3.bus.emit('store', arr);
    }).catch(function () { /* store is best-effort */ });
  }

  /* ---- care state (the single source for the strip + Status + Power) ---- */
  function pollCare() {
    care('m3:device:state').then(function (s) { M3.bus.emit(s ? 'care' : 'care-missing', s); });
  }
  function pollLog() {
    care('m3:device:log').then(function (l) { if (l) M3.bus.emit('log', l); });
  }

  /* ---- header ---- */
  function renderHeader(careState) {
    var dv = document.getElementById('dev-ver');
    if (careState && careState.device) {
      dv.textContent = 'p8800 \u00b7 firmware ' + (careState.device.firmware || '?');
    } else if (window.m3 && window.m3.device) {
      window.m3.device().then(function (d) {
        if (d && d.firmware) dv.textContent = 'p8800 \u00b7 firmware ' + d.firmware;
      }).catch(function () { /* leave the default label */ });
    }
  }

  function onCare(s) { M3.bus.emit('care', s); }

  function start() {
    pollMetrics(); pollStore(); pollCare(); pollLog();
    timers.push(setInterval(pollMetrics, 2000));
    timers.push(setInterval(pollCare, 5000));   // contract section 2.5: every 5 s
    timers.push(setInterval(pollLog, 15000));
    timers.push(setInterval(pollStore, 60000));
    on('m3:device:state', onCare);               // main may push, not only be polled
    on('m3:device:changed', pollCare);
    M3.bus.on('care', renderHeader);
    M3.bus.on('tab', function (id) { if (id === 'tab-status') { pollMetrics(); pollCare(); } });
    M3.bus.on('readnow', pollCare);
  }

  return { start: start, careOk: function () { return careOk; }, invoke: invoke };
})();
