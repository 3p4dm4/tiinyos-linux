/* M3 Device — Status tab: "how is it now", from seconds to the last hours.
 *
 *   · KPI row  — live CPU/RAM/NPU/disk/NPU-state from the existing m3:sysstatus
 *                + m3:npustatus IPC (works without the care engine).
 *   · Right now — In memory (models on the NPU, with their current activity) and
 *                Tasks (what the device and this PC are working on), from
 *                m3:device:state (+ the p8800 in-memory list for model type).
 *   · Activity log — m3:device:log (PC-side journal, 7 days).
 *   · Benchmark runs — this session's runs (M3.bench), last 9.
 *
 * Everything m3:device:* fails soft: if the engine is absent the In-memory/Tasks/
 * log sections say so and the KPI row keeps working. All DOM is built with
 * createElement (no innerHTML of model data): names can't break layout or the
 * CSP, and the design checker only sees real tags.
 */
window.M3 = window.M3 || {};
M3.status = (function () {
  var h = M3.h;
  var last = { metrics: null, care: null, log: null, inmem: null };
  var built = false;

  /* ---------- DOM helpers ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function st(word, cls) { return el('span', 'st ' + (cls || 'idle'), word); }
  function meterBar(p, warn) {
    var m = el('div', 'meter' + (warn === 'bad' ? ' bad' : warn === 'warn' ? ' warn' : ''));
    m.setAttribute('aria-hidden', 'true');
    var i = el('i'); i.style.width = Math.max(0, Math.min(100, Math.round(p || 0))) + '%';
    m.appendChild(i); return m;
  }
  function oneRow(colspan, text, cls) {
    var tr = document.createElement('tr');
    var td = el('td', cls || 'note'); td.setAttribute('colspan', colspan); td.textContent = text;
    tr.appendChild(td); return tr;
  }
  function section(headId, title) {
    var s = el('section');
    var sh = el('div', 'sec-head');
    var h2 = el('h2'); h2.id = headId; h2.textContent = title;
    sh.appendChild(h2);
    s.appendChild(sh);
    return { sec: s, head: sh };
  }
  function table(headers, labelledBy) {
    var t = el('table');
    if (labelledBy) t.setAttribute('aria-labelledby', labelledBy);
    var thead = el('thead');
    var hr = document.createElement('tr');
    headers.forEach(function (hd) {
      var th = el('th', hd.right ? 'right' : ''); th.textContent = hd.t;
      hr.appendChild(th);
    });
    thead.appendChild(hr); t.appendChild(thead);
    t.appendChild(el('tbody'));
    return t;
  }

  /* ---------- scaffold (built once) ---------- */
  function build() {
    var p = document.getElementById('p-status');
    if (built) return p;
    p.textContent = '';

    // KPI row
    var kpiSec = el('section'); kpiSec.setAttribute('aria-label', 'Live metrics');
    var dl = el('dl', 'kpi');
    [['CPU', 'k-cpu'], ['RAM', 'k-ram'], ['NPU load', 'k-npuload'],
      ['NPU memory', 'k-npumem'], ['Disk', 'k-disk'], ['NPU state', 'k-npustate']].forEach(function (kv, i) {
      var cell = el('div');
      cell.appendChild(el('dt', null, kv[0]));
      var dd = el('dd'); dd.id = kv[1]; dd.textContent = '—';
      cell.appendChild(dd);
      if (i < 5) { var bar = el('div', 'meter'); bar.id = 'm-' + kv[1]; bar.setAttribute('aria-hidden', 'true'); bar.appendChild(el('i')); cell.appendChild(bar); }
      dl.appendChild(cell);
    });
    kpiSec.appendChild(dl);
    p.appendChild(kpiSec);

    // Right now: summary + In memory + Tasks
    var now = section('h-now', 'Right now');
    now.head.appendChild(el('span', 'note', 'one request at a time on the device')).id = 'now-summary';
    now.head.appendChild(el('span', 'spacer'));
    now.head.appendChild(el('span', 'note', '')); now.head.lastChild.id = 'now-readat';

    var memH3 = el('h3'); memH3.id = 'h-mem'; memH3.textContent = 'In memory'; now.sec.appendChild(memH3);
    var memT = table([{ t: 'Model' }, { t: 'Use' }, { t: 'Now' }, { t: 'Last used' }, { t: 'NPU', right: 1 }, { t: 'Last benchmark' }, { t: '' }], 'h-mem');
    memT.querySelector('tbody').id = 'inmem';
    now.sec.appendChild(memT);

    var taskH3 = el('h3'); taskH3.id = 'h-tasks'; taskH3.textContent = 'Tasks · what the device and this PC are working on'; now.sec.appendChild(taskH3);
    var taskT = table([{ t: 'Task' }, { t: 'Where' }, { t: 'Progress' }, { t: 'Started' }, { t: 'Left', right: 1 }, { t: '' }], 'h-tasks');
    taskT.querySelector('tbody').id = 'tasks';
    now.sec.appendChild(taskT);
    p.appendChild(now.sec);

    // Activity log
    var log = section('h-act', 'Activity log');
    log.head.appendChild(el('span', 'note', 'today · newest first · kept 7 days on this PC'));
    p.appendChild(log.sec);
    var logT = table([{ t: 'When' }, { t: 'Event' }, { t: 'Detail' }, { t: 'Seen by' }]);
    logT.querySelector('tbody').id = 'actlog';
    log.sec.appendChild(logT);

    // Benchmark runs
    var bench = section('h-bench', 'Benchmark runs');
    bench.head.appendChild(el('span', 'note', 'this session · chat: 256 tokens streamed · decision: 3 typed questions in one forward pass · embedding: fixed text'));
    var benchT = table([{ t: 'When' }, { t: 'Model' }, { t: 'Kind' }, { t: 'TTFT ms', right: 1 }, { t: 'Total ms', right: 1 }, { t: 'Tok/s', right: 1 }, { t: 'Result' }]);
    benchT.querySelector('tbody').id = 'benchr';
    bench.sec.appendChild(benchT);
    p.appendChild(bench.sec);

    // Connection check: the device names the app uses, /etc/hosts and one GET each
    var conn = section('h-conn', 'Connection');
    conn.head.appendChild(el('span', 'note', 'the 14 device names the TiinyOS app uses: where each resolves, and whether it answers'));
    conn.head.appendChild(el('span', 'spacer'));
    var connBtn = el('button', null, 'Check connection'); connBtn.type = 'button'; connBtn.id = 'conn-run';
    connBtn.addEventListener('click', runCheck);
    conn.head.appendChild(connBtn);
    var connSum = el('p', 'note', 'Not checked yet.'); connSum.id = 'conn-sum'; connSum.setAttribute('aria-live', 'polite');
    conn.sec.appendChild(connSum);
    var connT = table([{ t: 'Name' }, { t: 'Address' }, { t: 'Answer' }, { t: 'What to do' }], 'h-conn');
    connT.querySelector('tbody').id = 'conn-rows'; connT.hidden = true;
    conn.sec.appendChild(connT);
    var fix = el('div', 'conn-fix'); fix.id = 'conn-fix'; fix.hidden = true;
    fix.appendChild(el('p', 'note', 'Add this line to /etc/hosts (as root), then check again:'));
    var line = el('code', 'mono'); line.id = 'conn-line'; fix.appendChild(line);
    var copy = el('button', null, 'Copy'); copy.type = 'button'; copy.id = 'conn-copy';
    copy.addEventListener('click', function () {
      if (navigator.clipboard) navigator.clipboard.writeText(line.textContent).then(function () { copy.textContent = 'Copied'; });
    });
    fix.appendChild(copy);
    conn.sec.appendChild(fix);
    p.appendChild(conn.sec);

    built = true;
    return p;
  }

  function short(msg) { return String(msg || '').replace(/^HTTP \d+ /, '').slice(0, 60); }

  /* ---------- KPI row ---------- */
  function setKpi(id, value, detail, warn) {
    var dd = document.getElementById(id);
    dd.className = warn === 'bad' ? 'bad' : '';
    dd.textContent = value;
    if (detail) { var s = el('small'); s.textContent = detail; dd.appendChild(s); }
    var bar = document.getElementById('m-' + id);
    if (bar) {
      bar.className = 'meter' + (warn === 'bad' ? ' bad' : warn === 'warn' ? ' warn' : '');
      var num = parseInt(value, 10);
      bar.querySelector('i').style.width = Math.max(0, Math.min(100, isNaN(num) ? 0 : num)) + '%';
    }
  }
  function renderKpi() {
    var m = last.metrics;
    if (!m || m.error) {
      ['k-cpu', 'k-ram', 'k-npuload', 'k-npumem', 'k-disk'].forEach(function (id) {
        var dd = document.getElementById(id); dd.textContent = '✕'; dd.className = 'bad';
      });
      var ns = document.getElementById('k-npustate');
      ns.className = 'bad'; ns.textContent = (m && m.error) ? '✕ ' + short(m.error) : '—';
      return;
    }
    var sys = m.sys || {}, npu = m.npu || {}, n0 = (sys.npus && sys.npus[0]) || {};
    setKpi('k-cpu', h.pct(sys.cpu && sys.cpu.total_percent),
      (sys.cpu && (sys.cpu.per_core_percent || []).length) + ' cores');
    setKpi('k-ram', h.pct(sys.memory && sys.memory.usage_percent),
      sys.memory ? h.fmtBytes(sys.memory.used_bytes) + ' / ' + h.fmtBytes(sys.memory.total_bytes) : '');
    setKpi('k-npuload', h.pct(n0.utilization_percent), 'inference');
    var mu = n0.memory_used_mb, mt = n0.memory_total_mb;
    var mp = mt ? (mu / mt) * 100 : 0;
    var MB = 1048576;
    setKpi('k-npumem', h.pct(mp),
      mu ? h.fmtBytes(mu * MB) + ' / ' + h.fmtBytes(mt * MB) + (mt - mu > 0 ? ' · ' + h.fmtBytes((mt - mu) * MB) + ' free' : '') : '',
      mp >= 95 ? 'bad' : mp >= 85 ? 'warn' : null);
    var d = sys.disk || {};
    if (d.total_bytes) {
      var dp = (d.used_bytes / d.total_bytes) * 100;
      setKpi('k-disk', Math.round(dp) + '%',
        h.fmtBytes(d.used_bytes) + ' / ' + h.fmtBytes(d.total_bytes) + (M3.storeBytes ? ' · models ' + h.fmtBytes(M3.storeBytes) : ''));
    } else setKpi('k-disk', '—', '');
    var status = (npu.npu && npu.npu.status) || '?';
    var ns = document.getElementById('k-npustate');
    ns.className = '';
    ns.textContent = '';
    ns.appendChild(st(status, status === 'ready' ? 'ok' : 'warn'));
    var dev = (npu.devices || [])[0], ex = [];
    if (dev) { if (dev.model) ex.push(dev.model); if (dev.temp_c != null) ex.push(dev.temp_c + ' °C'); if (dev.power_w != null) ex.push(dev.power_w + ' W'); }
    if (npu.npu && npu.npu.status_message) ex.push(npu.npu.status_message);
    if (ex.length) { var sm = el('small'); sm.textContent = ex.join(' · '); ns.appendChild(sm); }
  }

  /* ---------- In memory ---------- */
  function useTags(m) { return h.useTags(m); }
  function restoreSrc(care, id) {
    if (!care) return '';
    var t = (care.tasks || []).some(function (x) { return x.kind === 'restore' && x.label === id; });
    return t ? 'restore' : '';
  }
  function renderInMemory(care) {
    var tb = document.getElementById('inmem');
    tb.textContent = '';
    var list = last.inmem && last.inmem.ok ? last.inmem.models : [];
    var running = (care && care.running) || [];
    var pending = (care && care.pending) || [];
    var now = Date.now();
    var byId = {}; running.forEach(function (r) { byId[r.id] = r; });

    if (!list.length) {
      tb.appendChild(oneRow('7', (care || last.inmem && last.inmem.error)
        ? 'not available — the in-memory list is read from the device'
        : 'no models in memory'));
      return;
    }
    list.forEach(function (m) {
      var r = byId[m.id] || {};
      var kind = M3.bench.kindOf(m);
      var loading = r.status === 'loading' && (r.progress || 0) < 100;
      var queued = pending.indexOf(m.id) >= 0 && !r.activeRequests && !loading;
      var row = document.createElement('tr');

      var name = el('td', 'name'); name.textContent = h.shortName(m.id); name.title = m.id;
      var use = el('td'); useTags(m).forEach(function (t) { use.appendChild(el('span', 'tag', t)); });
      var nc = el('td', 'state');
      if (loading) {
        nc.appendChild(st('Loading', 'warn'));
        nc.appendChild(meterBar(r.progress, 'warn'));
        nc.appendChild(document.createTextNode(' ' + Math.round(r.progress || 0) + '%' + (restoreSrc(care, m.id) ? ' · restore' : '')));
      } else if (r.activeRequests > 0) {
        var secs = r.lastInference ? Math.max(0, Math.round((now - r.lastInference) / 1000)) : null;
        nc.appendChild(st('Answering', 'ok'));
        nc.appendChild(document.createTextNode(' ' + r.activeRequests + ' request' + (r.activeRequests > 1 ? 's' : '') + (secs != null ? ' · ' + secs + ' s' : '')));
      } else if (queued) {
        nc.appendChild(st('Queued', 'idle'));
        var after = pending.filter(function (x) { return x !== m.id; })[0];
        if (after) nc.appendChild(document.createTextNode(' · after ' + h.shortName(after)));
      } else {
        nc.appendChild(st(r.status === 'ready' ? 'Ready' : 'Idle', r.status === 'ready' ? 'ok' : 'idle'));
      }

      row.appendChild(name); row.appendChild(use); row.appendChild(nc);
      row.appendChild(el('td', 'num', r.lastInference ? h.fmtTime(r.lastInference) : '—'));
      row.appendChild(el('td', 'right num', r.npu != null ? h.pct(r.npu) : '—'));

      var lb = el('td');
      var lbRun = M3.bench.lastFor(m.id);
      if (lbRun) lb.appendChild(document.createTextNode(h.fmtTimeShort(lbRun.at) + ' · ' + lbRun.total_ms + ' ms · ' + (lbRun.tok_per_s == null ? '—' : h.fmtInt(lbRun.tok_per_s)) + ' tok/s'));
      else if (!kind) lb.appendChild(el('span', 'note', 'no benchmark for ' + (useTags(m)[0] || 'this type')));
      row.appendChild(lb);

      var act = el('td', 'right');
      if (kind) {
        var b = el('button', null, 'Benchmark'); b.type = 'button';
        b.addEventListener('click', function () { M3.bench.run(m.id, kind, b); });
        act.appendChild(b);
      } else if (loading) {
        var sb = el('button', null, 'Stop'); sb.type = 'button';
        sb.addEventListener('click', function () { stopModel(care, m.id); });
        act.appendChild(sb);
      }
      row.appendChild(act);
      tb.appendChild(row);
    });
  }
  function stopModel(care, id) {
    if (!care) return;
    var task = (care.tasks || []).find(function (x) { return (x.kind === 'restore' || x.kind === 'update' || x.kind === 'download') && x.label === id; });
    if (task) invoke('m3:device:stopTask', { taskId: task.id });
    else invoke('m3:device:unload', { id: id });
  }
  function invoke(ch, args) {
    if (!window.m3 || !window.m3.invoke) return;
    window.m3.invoke(ch, args).catch(function (e) { console.warn('[M3]', ch, e.message || e); });
  }

  /* ---------- Tasks ---------- */
  var KIND_LABEL = { restore: 'Restore', update: 'Update', download: 'Download', benchmark: 'Benchmark' };
  function taskProgress(t) {
    var s = el('span');
    if (t.kind === 'benchmark') {
      s.appendChild(st(t.state === 'running' ? 'Running' : 'Waiting', 'warn'));
      s.appendChild(el('span', 'note', (t.note || '') ? ' ' + t.note : ' · one request at a time'));
      return s;
    }
    var word = t.state === 'running' ? 'Running' : (t.state === 'waiting' ? 'Waiting' : (t.state === 'queued' ? 'Queued' : (t.state || 'Running').replace(/\b\w/g, function (c) { return c.toUpperCase(); })));
    s.appendChild(st(word, t.state === 'running' ? 'warn' : 'idle'));
    if (t.label) s.appendChild(document.createTextNode(' ' + h.shortName(t.label)));
    if (t.kind === 'restore' && t.steps) s.appendChild(document.createTextNode(' ' + Math.round((t.progress || 0) * 100) + '% · ' + t.step + ' of ' + t.steps + ' to load'));
    else if (typeof t.progress === 'number') { s.appendChild(meterBar(t.progress * 100, 'warn')); s.appendChild(document.createTextNode(' ' + Math.round(t.progress * 100) + '%')); }
    if (t.kind === 'update' && t.steps) s.appendChild(document.createTextNode(' · step ' + (t.step || 1) + ' of ' + t.steps + (typeof t.progress === 'number' ? ' · downloading ' + Math.round(t.progress * 100) + '%' : '')));
    if (t.kind === 'download' && t.note) s.appendChild(el('span', 'note', ' · ' + t.note));
    return s;
  }
  function renderTasks(care) {
    var tb = document.getElementById('tasks');
    tb.textContent = '';
    if (!care) { tb.appendChild(oneRow('6', 'not available — tasks are tracked by the device-care engine')); return; }
    var tasks = care.tasks || [];
    if (!tasks.length) { tb.appendChild(oneRow('6', 'nothing in flight')); return; }
    tasks.forEach(function (t) {
      var row = document.createElement('tr');
      row.appendChild(el('td', null, (KIND_LABEL[t.kind] || t.kind) + ' · ' + (t.label ? h.shortName(t.label) : '')));
      row.appendChild(el('td', null, t.where === 'device' ? 'device' : 'this PC'));
      var p = el('td', 'state'); p.appendChild(taskProgress(t)); row.appendChild(p);
      row.appendChild(el('td', 'num', t.startedAt ? h.fmtTime(t.startedAt) : '—'));
      row.appendChild(el('td', 'right num', /~|\d+ (min|s|h)\b/.test(t.note || '') ? t.note : '—'));
      var act = el('td', 'right');
      var verb = t.kind === 'benchmark' ? 'Cancel' : (t.kind === 'download' ? 'Pause' : 'Stop');
      var b = el('button', null, verb); b.type = 'button';
      if (t.state !== 'running' && t.state !== 'waiting') b.disabled = true;
      b.addEventListener('click', function () { invoke('m3:device:stopTask', { taskId: t.id }); });
      act.appendChild(b);
      if (t.kind === 'restore') {
        var dt = el('button', null, 'Details'); dt.type = 'button';
        dt.addEventListener('click', function () { var tab = document.getElementById('tab-power'); if (tab) tab.click(); });
        act.appendChild(dt);
      }
      row.appendChild(act);
      tb.appendChild(row);
    });
  }

  /* ---------- Activity log ---------- */
  var OUTAGE_OK = /answers again|back on|loaded/i, OUTAGE_BAD = /stopped answering|link down|unreachable/i;
  function renderLog(log) {
    var tb = document.getElementById('actlog');
    tb.textContent = '';
    if (!log) { tb.appendChild(oneRow('4', 'the activity log is kept by the device-care engine (not available in this build)')); return; }
    var entries = log.entries || [];
    if (!entries.length) { tb.appendChild(oneRow('4', 'no activity yet today · kept 7 days on this PC')); return; }
    entries.slice(0, 50).forEach(function (e) {
      var row = document.createElement('tr');
      row.appendChild(el('td', 'when num', h.fmtTime(e.t)));
      var ev = el('td');
      if (OUTAGE_OK.test(e.event || '')) ev.appendChild(st(e.event, 'ok'));
      else if (OUTAGE_BAD.test(e.event || '')) ev.appendChild(st(e.event, 'bad'));
      else ev.appendChild(document.createTextNode(e.event || ''));
      row.appendChild(ev);
      row.appendChild(el('td', null, e.detail || ''));
      row.appendChild(el('td', null, e.by === 'device' ? 'device' : 'this PC'));
      tb.appendChild(row);
    });
  }

  /* ---------- Benchmark runs (this session) ---------- */
  function renderRuns() {
    var tb = document.getElementById('benchr');
    tb.textContent = '';
    var runs = M3.bench.history;
    if (!runs.length) { tb.appendChild(oneRow('7', 'no benchmark run yet · press Benchmark on a model in memory')); return; }
    runs.forEach(function (r) {
      var row = document.createElement('tr');
      row.appendChild(el('td', 'num', h.fmtTime(r.at)));
      row.appendChild(el('td', 'name', r.model));
      row.appendChild(el('td', null, r.kind || ''));
      row.appendChild(el('td', 'right num', r.tok_per_s == null ? '—' : h.fmtInt(r.tok_per_s)));
      row.appendChild(el('td', 'right num', r.total_ms == null ? '—' : h.fmtInt(r.total_ms)));
      row.appendChild(el('td', 'right num', r.tok_per_s == null ? '—' : h.fmtInt(r.tok_per_s)));
      row.appendChild(el('td', r.ok ? 'note' : 'bad', r.ok ? (r.summary || '') : (r.error || 'failed')));
      tb.appendChild(row);
    });
  }

  /* ---------- summary line ---------- */
  function renderSummary(care) {
    var n = document.getElementById('now-summary');
    var ra = document.getElementById('now-readat');
    ra.textContent = care && care.reach && care.reach.lastRead ? 'read ' + h.fmtTime(care.reach.lastRead) + ' · every 5 s' : '';
    if (!care) { n.textContent = 'one request at a time on the device'; return; }
    var running = care.running || [], tasks = care.tasks || [];
    var reqs = 0; running.forEach(function (r) { reqs += r.activeRequests || 0; });
    var loads = running.filter(function (r) { return r.status === 'loading' && (r.progress || 0) < 100; }).length;
    var dls = tasks.filter(function (t) { return t.kind === 'download'; }).length;
    var bens = tasks.filter(function (t) { return t.kind === 'benchmark'; }).length;
    var rest = tasks.find(function (t) { return t.kind === 'restore'; });
    var parts = [reqs + ' request' + (reqs === 1 ? '' : 's') + ' in flight',
      loads + ' load' + (loads === 1 ? '' : 's'), dls + ' download' + (dls === 1 ? '' : 's')];
    if (rest && rest.steps) parts.push('restore ' + (rest.step || 1) + ' of ' + rest.steps);
    if (bens) parts.push(bens + ' benchmark');
    parts.push('one request at a time on the device');
    n.textContent = parts.join(' · ');
  }

  /* ---------- orchestration ---------- */
  function render() {
    build();
    renderKpi();
    renderInMemory(last.care);
    renderTasks(last.care);
    renderLog(last.log);
    renderRuns();
    renderSummary(last.care);
  }
  function refreshInmem() {
    if (!window.m3 || !window.m3.invoke) { last.inmem = { ok: false }; render(); return; }
    window.m3.invoke('m3:models').then(function (models) {
      last.inmem = { ok: true, models: models || [] };
      render();
    }).catch(function (e) {
      last.inmem = { ok: false, error: String(e.message || e) };
      render();
    });
  }

  /* ---------- connection check (on demand) ---------- */
  var VERDICT = { ok: ['Answers', 'ok'], 'service-down': ['Service down', 'warn'], 'no-answer': ['No answer', 'bad'],
    missing: ['Not set', 'bad'], elsewhere: ['Wrong address', 'bad'] };
  function runCheck() {
    var btn = document.getElementById('conn-run'), sum = document.getElementById('conn-sum');
    if (!window.m3 || !window.m3.invoke) { sum.textContent = 'Not available in this build.'; return; }
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); sum.textContent = 'Checking 14 names…';
    window.m3.invoke('m3:device:netcheck').then(renderCheck).catch(function (e) {
      sum.textContent = 'Check failed: ' + short(e.message || e);
    }).then(function () { btn.disabled = false; btn.removeAttribute('aria-busy'); });
  }
  function renderCheck(r) {
    var sum = document.getElementById('conn-sum'), rows = document.getElementById('conn-rows');
    sum.textContent = r.ok + ' of ' + r.total + ' names answer' +
      (r.deviceIp ? ' · device at ' + r.deviceIp : ' · api.tiiny does not resolve') + ' · checked ' + h.fmtTime(r.readAt);
    rows.textContent = '';
    r.hosts.forEach(function (x) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'mono', x.host));
      tr.appendChild(el('td', 'mono', x.address ? x.address + (x.inHosts ? '' : ' (DNS)') : '—'));
      var v = VERDICT[x.verdict] || [x.verdict, 'idle'];
      var ans = el('td', 'state'); ans.appendChild(st(v[0] + (x.http ? ' · ' + x.http : ''), v[1])); tr.appendChild(ans);
      tr.appendChild(el('td', null, x.remedy || ''));
      rows.appendChild(tr);
    });
    rows.parentNode.hidden = false;
    var fix = document.getElementById('conn-fix');
    fix.hidden = !r.hostsLine;
    document.getElementById('conn-line').textContent = r.hostsLine || '';
    document.getElementById('conn-copy').textContent = 'Copy';
  }

  function init() {
    render();
    M3.bus.on('metrics', function (m) { last.metrics = m; render(); });
    M3.bus.on('care', function (c) { last.care = c; render(); });
    M3.bus.on('log', function (l) { last.log = l; render(); });
    M3.bus.on('bench', renderRuns);
    refreshInmem();
    setInterval(refreshInmem, 30000);
  }

  return { init: init, _render: render, _last: last, _renderCheck: renderCheck };
})();
