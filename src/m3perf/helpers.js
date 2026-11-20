/* M3 Device — pure formatting + aggregation helpers.
 *
 * This module is the ONLY place in the renderer that knows how to shape a number
 * or a week_usage object into display text. It touches no DOM and no IPC, so
 * node can require it and test it directly (tests/js/device_ui.test.js).
 *
 * Conventions (docs/design/device-design.md §5):
 *   - en formats: 16.5 GB, 1,102, 2026-11-19, 24-hour times.
 *   - times are epoch milliseconds; dates are "YYYY-MM-DD" strings (local days,
 *     the device reports per-day counts in local time).
 *
 * Load: browser classic script (window.M3.h) and node require (module.exports)
 * via the tiny UMD-ish wrapper below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.M3 = root.M3 || {};
    root.M3.h = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var GB = 1073741824, MB = 1048576;

  /* ---------- numbers ---------- */

  // 1102 -> "1,102"; null -> "—"
  function fmtInt(n) {
    if (n == null || n !== n) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 14615900 -> "14.6M"; 2850 -> "3K"; 850 -> "850"; null -> "—"
  function compact(n) {
    if (n == null || n !== n) return '—';
    n = Math.round(n);
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(n);
  }

  // bytes -> "16.5 GB" / "966 MB" / "512 KB"
  function fmtBytes(b) {
    if (b == null || b !== b) return '—';
    if (b >= 100 * MB) return (b / GB).toFixed(1) + ' GB';
    if (b >= 1 * MB) return (b / MB).toFixed(1) + ' MB';
    return Math.round(b / 1024) + ' KB';
  }

  // 34.4 -> "34%"; null -> "—"
  function pct(x) {
    if (x == null || x !== x) return '—';
    return Math.round(x) + '%';
  }

  /* ---------- time ---------- */

  // "YYYY-MM-DD" -> local Date (avoids UTC off-by-a-day)
  function parseDate(str) {
    var p = String(str).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  // ms | Date | "YYYY-MM-DD" -> "YYYY-MM-DD" (local)
  function fmtDate(x) {
    if (x == null) return '—';
    var d = (typeof x === 'string') ? parseDate(x) : new Date(x);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  // "YYYY-MM-DD" -> "11-19"
  function fmtDateShort(x) {
    if (x == null) return '—';
    var d = (typeof x === 'string') ? parseDate(x) : new Date(x);
    return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ms -> "16:42:18" (24 h, seconds)
  function fmtTime(ms) {
    if (ms == null) return '—';
    var d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  }

  // ms -> "16:42"
  function fmtTimeShort(ms) {
    if (ms == null) return '—';
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // "YYYY-MM-DD" -> "Mon".."Sun"
  function dow(dateStr) {
    return DOW[parseDate(dateStr).getDay()];
  }

  // seconds -> "49 s" / "3 min 10 s" / "1 h 4 min"
  function fmtDur(sec) {
    if (sec == null || sec !== sec) return '—';
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return h + ' h ' + m + ' min';
    if (m) return m + ' min ' + s + ' s';
    return s + ' s';
  }

  // seconds -> "~40 s" / "~3 min" / "~1 h" (estimates: downloads, updates)
  function fmtDurApprox(sec) {
    if (sec == null || sec !== sec) return '—';
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return '~' + sec + ' s';
    if (sec < 3600) return '~' + Math.round(sec / 60) + ' min';
    return '~' + Math.round(sec / 3600) + ' h';
  }

  // (t, now) -> "6 min ago"
  function ago(t, now) {
    if (t == null) return '';
    return fmtDur(Math.max(0, (now - t) / 1000)) + ' ago';
  }

  /* ---------- weeks (Monday-start, the device contract) ---------- */

  // "YYYY-MM-DD" -> same day + n days (local)
  function addDays(dateStr, n) {
    var d = parseDate(dateStr);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }

  // "YYYY-MM-DD" -> the Monday of its week
  function mondayOf(dateStr) {
    var d = parseDate(dateStr);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return fmtDate(d);
  }

  // mondayStr -> 7 ISO dates, Monday..Sunday
  function weekDates(mondayStr) {
    var out = [];
    for (var i = 0; i < 7; i++) out.push(addDays(mondayStr, i));
    return out;
  }

  // (mondayStr, todayStr?) -> {start, end, dates, daysSoFar}
  function weekRange(mondayStr, todayStr) {
    var dates = weekDates(mondayStr);
    var daysSoFar = null;
    if (todayStr) {
      var idx = dates.indexOf(todayStr);
      daysSoFar = (idx >= 0) ? idx + 1 : (todayStr > dates[6] ? 7 : null);
    }
    return { start: dates[0], end: dates[6], dates: dates, daysSoFar: daysSoFar };
  }

  /* ---------- usage aggregation (contract: m3:device:usage) ----------
   * days: { "YYYY-MM-DD": { "<model id>": {prompt, completion, total, requests} } }
   * apps: { "<app>": {total, models: { "<model id>": tokens }} }
   */

  function usageTotals(days) {
    var t = { prompt: 0, completion: 0, total: 0, requests: 0 };
    for (var d in days || {}) {
      var day = days[d] || {};
      for (var id in day) {
        var u = day[id] || {};
        t.prompt += u.prompt || 0;
        t.completion += u.completion || 0;
        t.total += u.total || 0;
        t.requests += u.requests || 0;
      }
    }
    return t;
  }

  // -> [{id, prompt, completion, total, requests, perReq, share}] sorted by total desc
  function usageByModel(days) {
    var map = {};
    for (var d in days || {}) {
      var day = days[d] || {};
      for (var id in day) {
        var u = day[id] || {};
        var m = map[id] || (map[id] = { id: id, prompt: 0, completion: 0, total: 0, requests: 0 });
        m.prompt += u.prompt || 0;
        m.completion += u.completion || 0;
        m.total += u.total || 0;
        m.requests += u.requests || 0;
      }
    }
    var total = 0;
    Object.keys(map).forEach(function (id) { total += map[id].total; });
    return Object.keys(map).map(function (id) {
      var m = map[id];
      return {
        id: m.id, prompt: m.prompt, completion: m.completion, total: m.total, requests: m.requests,
        perReq: m.requests ? Math.round(m.total / m.requests) : 0,
        share: total ? m.total / total : 0,
      };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  // -> [{date, dow, total, byModel:{id:tokens}}] sorted by date
  function usagePerDay(days) {
    return Object.keys(days || {}).sort().map(function (date) {
      var day = days[date] || {};
      var byModel = {}, total = 0;
      for (var id in day) { total += day[id].total || 0; byModel[id] = day[id].total || 0; }
      return { date: date, dow: dow(date), total: total, byModel: byModel };
    });
  }

  // -> {date, total, requests} of the busiest day (or null)
  function busiestDay(days) {
    var perDay = usagePerDay(days), best = null;
    perDay.forEach(function (r) {
      if (r.total > 0 && (!best || r.total > best.total)) {
        var day = days[r.date] || {};
        var reqs = 0;
        for (var id in day) reqs += day[id].requests || 0;
        best = { date: r.date, total: r.total, requests: reqs };
      }
    });
    return best;
  }

  // -> [{app, total, share, models:{id:tokens}}] sorted by total desc
  function usageByApp(apps) {
    var total = 0;
    for (var a in apps || {}) total += apps[a].total || 0;
    return Object.keys(apps || {}).map(function (app) {
      var o = apps[app] || {};
      return { app: app, total: o.total || 0, share: total ? (o.total || 0) / total : 0, models: o.models || {} };
    }).sort(function (x, y) { return y.total - x.total; });
  }

  // The TiinyOS app sends "X-App-Id: TiinyOS"; requests without that header
  // (agents and other API clients) are grouped by the device as "default".
  function appLabel(app) { return app === 'default' ? 'API clients (default)' : app; }

  /* ---------- model updates ----------
   * The device versions models by date (version "20261109"); show 2026-11-09. */
  function fmtVersion(v) {
    v = v == null ? '' : String(v);
    return /^\d{8}$/.test(v) ? v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6) : v;
  }
  // The four steps of an update (design: unload, delete, download, reload);
  // unload and reload only when the model is in memory.
  function updateSteps(m, inMemory) {
    return [
      { text: 'Unload it from memory', skip: !inMemory },
      { text: 'Delete the installed version from the device', skip: false },
      { text: 'Download ' + (m.total_size ? fmtBytes(m.total_size) : 'the new version'), skip: false },
      { text: 'Load it again', skip: !inMemory }
    ];
  }
  function updateQuestion(m) {
    var name = m.display_name || shortName(m.id);
    var to = fmtVersion(m.version_label), from = fmtVersion(m.version);
    return 'Update ' + name + (to ? ' to the ' + to + ' release' : '') + '?' + (from ? ' Installed: ' + from + '.' : '');
  }

  /* ---------- Power tab view from the contract's CareState ----------
   * care: CareState (docs/design/device-contract.md) or null when the engine
   * did not answer; store: the installed models (m3:store array) or null. */
  var LIVE = { queued: 1, running: 1, waiting: 1 };
  function restoreOf(o) {
    var ok = (o.restored || []).length, no = (o.notRestored || []).length;
    if (!ok && !no) return null;
    var names = (o.restored || []).map(shortName).concat((o.notRestored || []).map(function (x) { return shortName(x.id) + ' (' + x.reason + ')'; }));
    return { state: no ? (ok ? 'Partly restored' : 'Not restored') : 'Restored', cls: no ? 'warn' : 'ok', detail: names.join(', ') };
  }
  function powerView(care, store) {
    var c = care || {};
    var running = (c.running || []).map(function (r) { return r.id; });
    var snap = (c.lastSnapshot && c.lastSnapshot.ids) || [];
    var ids = [];
    function add(id) { if (id && ids.indexOf(id) < 0) ids.push(id); }
    (store || []).forEach(function (m) { add(m.id); });
    running.forEach(add); (c.kept || []).forEach(add); snap.forEach(add);
    var outages = (c.outages || []).map(function (o) {
      return { stoppedAt: o.lost || 0, answeredAt: o.back || 0,
        noAnswerSec: o.lost && o.back ? Math.round((o.back - o.lost) / 1000) : null,
        inMemoryBefore: (o.beforeIds || []).length, backOnItsOwn: (o.backIds || []).length, restore: restoreOf(o) };
    });
    var task = (c.tasks || []).filter(function (t) { return t.kind === 'restore' && LIVE[t.state]; })[0] || null;
    var restore = null;
    if (task) {
      var rows = [];
      var o0 = (c.outages || [])[0] || {};
      (o0.restored || []).forEach(function (id) { rows.push({ id: id, state: 'Restored', stateCls: 'ok' }); });
      (o0.notRestored || []).forEach(function (x) { rows.push({ id: x.id, state: 'Not restored', stateCls: 'bad', note: x.reason }); });
      rows.push({ id: task.label, state: 'Loading', stateCls: 'warn',
        note: (task.step && task.steps ? task.step + ' of ' + task.steps : '') + (typeof task.progress === 'number' ? ' · ' + Math.round(task.progress * 100) + '%' : '') });
      restore = { taskId: task.id, startedAt: task.startedAt, policy: (c.policy && c.policy.reload) || '', models: rows };
    }
    return {
      available: !!care,
      acPower: c.acPower === undefined ? null : c.acPower,
      reload: (c.policy && c.policy.reload) || 'kept',
      kept: c.kept || [],
      lastInMemory: snap.length,
      restore: restore,
      outages: outages,
      models: ids.map(function (id) { return { id: id, inMemory: running.indexOf(id) >= 0 }; })
    };
  }

  /* ---------- chart series slots (identity, never rank) ----------
   * Fixed order = first time a model is seen in usage; slot 1..8 map to the
   * --series-1..8 tokens. A 9th and later model folds into "Other". */
  function seriesSlots(orderedIds) {
    var map = {}, other = [];
    (orderedIds || []).forEach(function (id) {
      if (map[id] != null) return;
      var n = Object.keys(map).length;
      if (n < 8) map[id] = n + 1; else other.push(id);
    });
    return { map: map, other: other };
  }

  /* ---------- strip text (the always-visible line) ---------- */

  // "a/b/c" -> "c"
  function shortName(id) {
    var s = String(id || '?');
    var i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  // Usage tags for a model, from its type + capabilities (the "Use" pills).
  // Canonical order: decision before chat, then embedding/speech/asr/music/
  // video/vision. Falls back to the raw type when nothing matches.
  function useTags(m) {
    m = m || {};
    var caps = m.capabilities || [], t = m.type || '';
    function has(c) { return caps.indexOf(c) >= 0; }
    var seen = [];
    if (has('systemone') || /classif/i.test(t)) seen.push('decision');
    else if (/text generation|image-text/i.test(t) || m.supports_chat || has('main')) seen.push('chat');
    if (has('embedding') || /embedding/i.test(t)) seen.push('embedding');
    if (/text-to-speech/i.test(t)) seen.push('speech');
    if (/^asr$|speech to text/i.test(t)) seen.push('asr');
    if (/music/i.test(t)) seen.push('music');
    if (/text-to-video/i.test(t)) seen.push('video');
    if (m.supports_vision) seen.push('vision');
    if (!seen.length) seen.push((t || 'n/a').toLowerCase());
    return seen;
  }

  // reach {state, lastRead, since, everyMs} -> {word, state, detail}
  // firstPaint = no answer from the engine yet, not a missing engine (CareState has
  // its own `pending` array of loads, so the flag must not be called that)
  function stripReach(reach, now, firstPaint) {
    if (firstPaint === true) return { word: 'Reading', state: 'idle', detail: 'waiting for the first answer from the device-care engine' };
    if (!reach || !reach.state) {
      return { word: 'Engine not available', state: 'bad', detail: 'the device-care engine is not running in this build' };
    }
    var every = reach.everyMs ? Math.round(reach.everyMs / 1000) + ' s' : '';
    if (reach.state === 'unreachable') {
      return { word: 'Unreachable', state: 'bad', detail: 'since ' + fmtTime(reach.since) +
        ' · USB link down · retrying every ' + every + ' · numbers below are from ' + fmtTime(reach.lastRead) };
    }
    if (reach.state === 'stale') {
      return { word: 'Stale', state: 'warn', detail: 'last read ' + fmtTime(reach.lastRead) +
        ' (' + ago(reach.lastRead, now) + ') · device answers 502 until the TiinyOS app reconnects' };
    }
    return { word: 'Reachable', state: 'ok', detail: 'last read ' + fmtTime(reach.lastRead) + ' · every ' + every };
  }

  // running[] -> {count, model} for the "N request(s) · <model>" strip fact
  function requestsLine(running) {
    var count = 0, model = null, best = 0;
    (running || []).forEach(function (r) {
      var a = r.activeRequests || 0;
      count += a;
      if (a > best) { best = a; model = r.id; }
    });
    return { count: count, model: model ? shortName(model) : null };
  }

  // tasks[] -> the single task to show: restore > update > download > benchmark,
  // then running > waiting > queued. Only active states count.
  function topTask(tasks) {
    var kr = { restore: 0, update: 1, download: 2, benchmark: 3 };
    var sr = { running: 0, waiting: 1, queued: 2 };
    var best = null, bk = 99, bs = 99;
    (tasks || []).forEach(function (t) {
      if (!(t && t.state in sr)) return;
      var k = kr[t.kind] == null ? 9 : kr[t.kind];
      if (k < bk || (k === bk && sr[t.state] < bs)) { best = t; bk = k; bs = sr[t.state]; }
    });
    return best;
  }

  // one running task -> its strip line ("Restoring · X 40% · 1 of 3")
  function taskLine(t) {
    if (!t) return 'idle';
    var p = Math.round((t.progress == null ? 0 : t.progress) * 100);
    var label = t.label ? (String(t.label).indexOf('/') >= 0 ? shortName(t.label) : t.label) : '';
    switch (t.kind) {
      case 'restore': return 'Restoring · ' + label + ' ' + p + '%' + (t.steps ? ' · ' + t.step + ' of ' + t.steps : '');
      case 'update':
        var u = 'Updating ' + label + ' · step ' + (t.step || 1) + ' of ' + (t.steps || 4);
        return p > 0 ? u + ' · downloading ' + p + '%' : u;
      case 'download': return 'Downloading ' + label + ' · ' + p + '%';
      case 'benchmark': return 'Benchmark ' + label;
      default: return (t.kind || 'Task') + ' ' + label;
    }
  }

  return {
    DOW: DOW,
    fmtInt: fmtInt, compact: compact, fmtBytes: fmtBytes, pct: pct,
    parseDate: parseDate, fmtDate: fmtDate, fmtDateShort: fmtDateShort,
    fmtTime: fmtTime, fmtTimeShort: fmtTimeShort, dow: dow,
    fmtDur: fmtDur, fmtDurApprox: fmtDurApprox, ago: ago,
    addDays: addDays, mondayOf: mondayOf, weekDates: weekDates, weekRange: weekRange,
    usageTotals: usageTotals, usageByModel: usageByModel, usagePerDay: usagePerDay,
    busiestDay: busiestDay, usageByApp: usageByApp, appLabel: appLabel, powerView: powerView,
    fmtVersion: fmtVersion, updateSteps: updateSteps, updateQuestion: updateQuestion,
    seriesSlots: seriesSlots, shortName: shortName, useTags: useTags,
    stripReach: stripReach, requestsLine: requestsLine, topTask: topTask, taskLine: taskLine,
  };
});
