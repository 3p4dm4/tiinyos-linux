/* M3 Device — Models tab: "what the device can run" (design §3 "Models").
 *
 *   · In memory        — the p8800 in-memory list (m3:models: id/context/
 *                        capabilities/type), enriched with live status from
 *                        m3:device:state.running (ready / loading). The PC can
 *                        load / unload / benchmark these.
 *   · Installed on     — the device store. Base = m3:store (installed: size,
 *   device              type). When the care engine is present, m3:device:models
 *                        adds version, update state and the not-installed set
 *                        (Download). The PC updates and downloads; it does not
 *                        load these from here.
 *
 * Device-side actions (Update / Download / Unload / Load) go through m3:device:*
 * and fail soft when the engine is absent (button re-enables, a note explains).
 * Load/Unload also work through the care channel; no fake state is shown.
 */
window.M3 = window.M3 || {};
M3.models = (function () {
  var h = M3.h;
  var last = { inmem: null, store: null, careModels: null };
  var built = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function st(word, cls) { return el('span', 'st ' + (cls || 'idle'), word); }
  function fire(ch, args, btn) {
    if (!window.m3 || !window.m3.invoke) return;
    if (btn) btn.disabled = true;
    window.m3.invoke(ch, args).then(function () { pollAll(); })
      .catch(function (e) { if (btn) btn.disabled = false; console.warn('[M3]', ch, e.message || e); });
  }
  function ctxK(v) { if (v == null) return '—'; v = +v; return v >= 1000 ? Math.round(v / 1000) + ' K' : String(v); }

  function thead(cols) {
    var thead = el('thead'), tr = document.createElement('tr');
    cols.forEach(function (c) { var th = el('th', c.right ? 'right' : ''); th.textContent = c.t; tr.appendChild(th); });
    thead.appendChild(tr); return thead;
  }
  function build() {
    var p = document.getElementById('p-models');
    if (built) return p;
    p.textContent = '';
    p.appendChild(el('span', 'note', 'Models in memory (green dot): the PC can load, unload and benchmark them. Installed models: what is on the device disk — the PC can update them and see them load, but does not load them from here.'));

    var s1 = el('section');
    var h1 = el('h3'); h1.id = 'h-inmem'; h1.textContent = 'In memory (0)'; s1.appendChild(h1);
    var t1 = el('table'); t1.setAttribute('aria-labelledby', 'h-inmem');
    t1.appendChild(thead([{ t: 'Model' }, { t: 'Context (K)', right: 1 }, { t: 'Use' }, { t: 'Status' }, { t: 'Last benchmark' }, { t: '', right: 1 }]));
    t1.appendChild(el('tbody'));
    t1.querySelector('tbody').id = 'inmem-m';
    s1.appendChild(t1); p.appendChild(s1);

    var s2 = el('section');
    var h2 = el('h3'); h2.id = 'h-inst'; h2.textContent = 'Installed on device (0)'; s2.appendChild(h2);
    var t2 = el('table'); t2.setAttribute('aria-labelledby', 'h-inst');
    t2.appendChild(thead([{ t: 'Model' }, { t: 'Size', right: 1 }, { t: 'Use' }, { t: 'Version' }, { t: 'Status' }, { t: '', right: 1 }]));
    t2.appendChild(el('tbody'));
    t2.querySelector('tbody').id = 'inst-m';
    s2.appendChild(t2); p.appendChild(s2);

    built = true;
    return p;
  }
  function oneRow(tbody, colspan, text, cls) {
    var tr = document.createElement('tr');
    var td = el('td', cls || 'note'); td.setAttribute('colspan', colspan); td.textContent = text;
    tbody.appendChild(tr); return tr;
  }

  /* ---- In memory ---- */
  function renderInmem() {
    build();
    var tb = document.getElementById('inmem-m');
    var head = document.getElementById('h-inmem');
    tb.textContent = '';
    var care = last.careState;
    var running = (care && care.running) || [];
    var byId = {}; running.forEach(function (r) { byId[r.id] = r; });
    var list = last.inmem && last.inmem.ok ? last.inmem.models : [];
    head.textContent = 'In memory (' + list.length + ')';

    if (!list.length) {
      tb.appendChild(oneRow(tb, 6, (last.inmem && last.inmem.error) ? 'not available — the in-memory list is read from the device' : 'no models in memory'));
      return;
    }
    list.forEach(function (m) {
      var r = byId[m.id] || {};
      var kind = M3.bench.kindOf(m);
      var loading = r.status === 'loading' && (r.progress || 0) < 100;
      var tr = document.createElement('tr');
      var name = el('td', 'name'); name.textContent = h.shortName(m.id); name.title = m.id; tr.appendChild(name);
      tr.appendChild(el('td', 'right num', ctxK(m.context)));
      var use = el('td'); h.useTags(m).forEach(function (t) { use.appendChild(el('span', 'tag', t)); }); tr.appendChild(use);
      var status = el('td', 'state');
      if (loading) status.appendChild(st('Loading', 'warn'));
      else status.appendChild(st(r.status === 'ready' ? 'Ready' : 'Idle', r.status === 'ready' ? 'ok' : 'idle'));
      tr.appendChild(status);
      var lb = el('td');
      var run = M3.bench.lastFor(m.id);
      if (run) lb.appendChild(document.createTextNode(h.fmtTimeShort(run.at) + ' · ' + run.total_ms + ' ms · ' + (run.tok_per_s == null ? '—' : h.fmtInt(run.tok_per_s)) + ' tok/s'));
      else lb.appendChild(document.createTextNode('—'));
      tr.appendChild(lb);

      var act = el('td', 'right');
      if (loading) {
        var sb = el('button', null, 'Stop'); sb.type = 'button';
        sb.addEventListener('click', function () { fire('m3:device:unload', { id: m.id }, sb); });
        act.appendChild(sb);
      } else {
        var ub = el('button', null, 'Unload'); ub.type = 'button';
        ub.addEventListener('click', function () { fire('m3:device:unload', { id: m.id }, ub); });
        act.appendChild(ub);
        if (kind) {
          var bb = el('button', null, 'Benchmark'); bb.type = 'button'; bb.className = 'primary';
          bb.addEventListener('click', function () { M3.bench.run(m.id, kind, bb); });
          act.appendChild(bb);
        }
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }

  /* ---- Installed on device ---- */
  function renderInstalled() {
    build();
    var tb = document.getElementById('inst-m');
    var head = document.getElementById('h-inst');
    tb.textContent = '';
    var care = last.careModels;
    var useCare = !!(care && (care.available || care.not_installed));
    var byId = {}; if (useCare) (care.available || []).forEach(function (a) { byId[a.id] = a; });

    // base list: care.available (has version/update) when present, else m3:store
    var base = useCare ? (care.available || [])
      : (last.store && last.store.ok ? last.store.models : []);
    var extra = useCare ? (care.not_installed || []) : [];
    head.textContent = 'Installed on device (' + base.length + (extra.length ? ' · ' + extra.length + ' available' : '') + ')';

    if (!base.length && !extra.length) {
      tb.appendChild(oneRow(tb, 6, (last.store && last.store.error) ? 'not available — the store is read from the device' : 'no models on the device'));
      return;
    }
    base.forEach(function (m) {
      var a = byId[m.id] || {};
      var updating = a.update_state === 'updating' || (a.download_progress != null && a.installed);
      var running = m.status === 'running';
      var tr = document.createElement('tr');
      var name = el('td', 'name'); name.textContent = m.name || h.shortName(m.id); name.title = m.id; tr.appendChild(name);
      var sz = m.size || m.size_bytes;
      tr.appendChild(el('td', 'right num', sz ? h.fmtBytes(sz) : '—'));
      var use = el('td'); h.useTags(m).forEach(function (t) { use.appendChild(el('span', 'tag', t)); }); tr.appendChild(use);
      tr.appendChild(el('td', 'num', a.version ? 'v' + a.version : '—'));
      var status = el('td', 'state');
      status.appendChild(st(updating ? 'Updating' : running ? 'In memory' : 'Installed', updating ? 'warn' : running ? 'ok' : 'idle'));
      if (updating && a.download_progress != null) status.appendChild(document.createTextNode(' ' + Math.round(a.download_progress * 100) + '%'));
      tr.appendChild(status);
      var act = el('td', 'right');
      var ub = el('button', null, 'Update'); ub.type = 'button'; ub.className = 'primary';
      if (!useCare) { ub.disabled = true; ub.title = 'device-care engine not available'; }
      else if (a.update_state !== 'none' && a.update_state !== 'available') ub.disabled = true;
      ub.addEventListener('click', function () { fire('m3:device:update', { id: m.id }, ub); });
      act.appendChild(ub);
      tr.appendChild(act);
      tb.appendChild(tr);
    });
    // available but not installed
    extra.forEach(function (m) {
      if (byId[m.id]) return;
      var tr = document.createElement('tr');
      var name = el('td', 'name'); name.textContent = h.shortName(m.id); name.title = m.id; tr.appendChild(name);
      tr.appendChild(el('td', 'right num', m.size_bytes ? h.fmtBytes(m.size_bytes) : '—'));
      var use = el('td'); h.useTags(m).forEach(function (t) { use.appendChild(el('span', 'tag', t)); }); tr.appendChild(use);
      tr.appendChild(el('td', 'num', '—'));
      var status = el('td', 'state'); status.appendChild(st('Available', 'idle')); tr.appendChild(status);
      var act = el('td', 'right');
      var db = el('button', null, 'Download'); db.type = 'button'; db.className = 'primary';
      if (!useCare) { db.disabled = true; db.title = 'device-care engine not available'; }
      db.addEventListener('click', function () { fire('m3:device:download', { id: m.id }, db); });
      act.appendChild(db);
      tr.appendChild(act);
      tb.appendChild(tr);
    });
    if (!useCare && base.length) tb.appendChild(oneRow(tb, 6, 'Update / Download run through the device-care engine, which is not available in this build.'));
  }

  function render() { renderInmem(); renderInstalled(); }

  function pollAll() {
    if (window.m3 && window.m3.invoke) {
      window.m3.invoke('m3:models').then(function (models) {
        last.inmem = { ok: true, models: models || [] }; render();
      }).catch(function (e) { last.inmem = { ok: false, error: String(e.message || e) }; render(); });
      window.m3.invoke('m3:store').then(function (r) {
        last.store = { ok: true, models: Array.isArray(r) ? r : [] }; render();
      }).catch(function (e) { last.store = { ok: false, error: String(e.message || e) }; render(); });
      window.m3.invoke('m3:device:models').then(function (m) {
        last.careModels = m || null; render();
      }).catch(function () { last.careModels = null; render(); });
    }
  }

  function init() {
    build(); render();
    pollAll();
    setInterval(pollAll, 60000);
    M3.bus.on('care', function (c) { last.careState = c; renderInmem(); });
    M3.bus.on('tab', function (id) { if (id === 'tab-models') pollAll(); });
  }

  return { init: init, _last: last };
})();
