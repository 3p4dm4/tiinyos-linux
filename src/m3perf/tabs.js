/* M3 Device — shell: tab navigation, theme toggle, and the persistent strip.
 * Also hosts the tiny event bus the tab modules subscribe to.
 * Loaded as a classic script after helpers.js (window.M3.h).
 *
 * The strip carries exactly two facts (design §2.1): reach + last read, and the
 * one request + the one running task. It is visible from every tab and the same
 * line is mirrored to the Floating Ball tooltip and the tray, so the three
 * surfaces never disagree.
 */
window.M3 = window.M3 || {};

/* tiny event bus: M3.bus.on(evt, fn) / M3.bus.emit(evt, payload) */
M3.bus = (function () {
  var sub = {};
  return {
    on: function (evt, fn) { (sub[evt] = sub[evt] || []).push(fn); return fn; },
    emit: function (evt, payload) {
      (sub[evt] || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[M3]', evt, e); }
      });
    }
  };
})();

/* ---- persistent strip: reach + the one request + the one running task ---- */
M3.strip = (function () {
  var h = M3.h;
  var DETAILS_TAB = { restore: 'tab-power', update: 'tab-models', download: 'tab-status', benchmark: 'tab-status' };
  return {
    render: function (s) {
      s = s || {};
      var now = s.now || Date.now();
      // reach word + detail (word is the only thing that carries severity colour)
      var reachEl = document.getElementById('strip-reach');
      var rt = h.stripReach(s.reach, now, s.firstPaint);
      reachEl.textContent = '';
      var w = document.createElement('span');
      w.className = 'st ' + rt.state;
      w.textContent = rt.word;
      reachEl.appendChild(w);
      reachEl.appendChild(document.createTextNode(' · ' + rt.detail));

      // the one request: "N request(s) · <model>"
      var req = h.requestsLine(s.running || []);
      document.getElementById('strip-req').textContent = req.count > 0
        ? req.count + ' request' + (req.count > 1 ? 's' : '') + (req.model ? ' · ' + req.model : '')
        : '';

      // the one running task + its meter
      var task = h.topTask(s.tasks || []);
      var taskEl = document.getElementById('strip-task');
      var meterWrap = document.getElementById('strip-meter');
      var meterBar = meterWrap.querySelector('i');
      if (task) {
        taskEl.textContent = h.taskLine(task);
        if (typeof task.progress === 'number') {
          meterBar.style.width = Math.round(task.progress * 100) + '%';
          meterWrap.style.display = '';
        } else {
          meterWrap.style.display = 'none';
        }
        var dt = document.getElementById('strip-details');
        if (dt) dt.setAttribute('data-tab', DETAILS_TAB[task.kind] || 'tab-status');
      } else {
        taskEl.textContent = 'idle';
        meterWrap.style.display = 'none';
      }
    }
  };
})();

/* ---- tabs + theme: wired on init() (called by main.js after the DOM is ready) ---- */
M3.tabs = (function () {
  var order = ['system', 'light', 'dark'], cur = 0;
  var themeBtn = document.getElementById('theme');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));

  function applyTheme() {
    var root = document.documentElement;
    if (order[cur] === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', order[cur]);
    themeBtn.textContent = 'Theme: ' + order[cur];
    themeBtn.setAttribute('aria-label', 'Theme: ' + order[cur] + '. Press to change');
  }

  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
    M3.bus.emit('tab', tab.id);
  }

  function init() {
    themeBtn.addEventListener('click', function () { cur = (cur + 1) % order.length; applyTheme(); });
    applyTheme();

    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { select(tabs[(i + 1) % tabs.length], true); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { select(tabs[(i - 1 + tabs.length) % tabs.length], true); e.preventDefault(); }
      });
    });
    // any button that names a tab jumps to it (the strip "Details" button, etc.)
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.addEventListener('click', function () {
        var t = document.getElementById(b.getAttribute('data-tab'));
        if (t) select(t);
      });
    });

    // first paint: the reach is unknown until the first read lands; then every
    // CareState (poll or push) redraws it, and a failed read says the engine is missing
    M3.strip.render({ firstPaint: true, running: [], tasks: [] });
    M3.bus.on('care', M3.strip.render);
    M3.bus.on('care-missing', function () { M3.strip.render({ reach: null, running: [], tasks: [] }); });
  }

  return { init: init };
})();
