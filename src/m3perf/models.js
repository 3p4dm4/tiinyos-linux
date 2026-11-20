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
      .catch(function (e) {
        if (btn) btn.disabled = false;
        var n = document.getElementById('models-note');
        if (n) n.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      });
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
    var sh = el('div', 'sec-head');
    var h2 = el('h3'); h2.id = 'h-inst'; h2.textContent = 'Installed on device (0)'; sh.appendChild(h2);
    sh.appendChild(el('span', 'spacer'));
    var ua = el('button', null, 'Update all'); ua.type = 'button'; ua.id = 'update-all'; ua.hidden = true; sh.appendChild(ua);
    s2.appendChild(sh);
    var mn = el('p', 'note'); mn.id = 'models-note'; mn.setAttribute('aria-live', 'polite'); s2.appendChild(mn);
    var t2 = el('table'); t2.setAttribute('aria-labelledby', 'h-inst');
    t2.appendChild(thead([{ t: 'Model' }, { t: 'Size', right: 1 }, { t: 'Use' }, { t: 'Version' }, { t: 'Status' }, { t: '', right: 1 }]));
    t2.appendChild(el('tbody'));
    t2.querySelector('tbody').id = 'inst-m';
    s2.appendChild(t2); p.appendChild(s2);

    // update confirmation (native dialog: Escape cancels, focus returns to the opener)
    var d = el('dialog'); d.id = 'update-dialog'; d.setAttribute('aria-labelledby', 'update-title');
    var dt = el('h2'); dt.id = 'update-title'; d.appendChild(dt);
    var db = el('div'); db.id = 'update-body'; d.appendChild(db);
    var acts = el('div', 'actions');
    var cancel = el('button', null, 'Cancel'); cancel.type = 'button'; cancel.id = 'update-cancel'; acts.appendChild(cancel);
    var ok = el('button', 'primary', 'Delete and download'); ok.type = 'button'; ok.id = 'update-ok'; acts.appendChild(ok);
    d.appendChild(acts);
    p.appendChild(d);

    built = true;
    return p;
  }
  function oneRow(tbody, colspan, text, cls) {
    var tr = document.createElement('tr');
    var td = el('td', cls || 'note'); td.setAttribute('colspan', colspan); td.textContent = text;
    tr.appendChild(td); tbody.appendChild(tr); return tr;
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

  /* ---- Installed on device ----
   * Names, sizes and types from m3:store; version, update and download state
   * from m3:device:models (InstalledModel, docs/design/device-contract.md). */
  function renderInstalled() {
    build();
    var tb = document.getElementById('inst-m');
    var head = document.getElementById('h-inst');
    tb.textContent = '';
    var care = last.careModels && Array.isArray(last.careModels.models) ? last.careModels.models : null;
    var byId = {}; (care || []).forEach(function (a) { byId[a.id] = a; });
    var base = last.store && last.store.ok ? last.store.models : (care || []).map(function (a) {
      return { id: a.id, name: a.display_name, type: a.type, status: a.status, size: a.total_size };
    });
    var updatable = (care || []).filter(function (a) { return a.need_update; });
    head.textContent = 'Installed on device (' + base.length + (updatable.length ? ' · ' + updatable.length + ' with an update' : '') + ')';
    var all = document.getElementById('update-all');
    all.hidden = updatable.length < 2;
    all.textContent = 'Update all (' + updatable.length + ')';

    if (!base.length) {
      tb.appendChild(oneRow(tb, 6, (last.store && last.store.error) ? 'not available — the store is read from the device' : 'no models on the device'));
      return;
    }
    var tasks = (last.careState && last.careState.tasks) || [];
    base.forEach(function (m) {
      var a = byId[m.id] || null;
      var task = tasks.filter(function (t) { return t.kind === 'update' && t.label === h.shortName(m.id) && (t.state === 'running' || t.state === 'queued' || t.state === 'waiting'); })[0];
      var downloading = a && a.status === 'downloading';
      var running = m.status === 'running' || (a && a.inMemory);
      var tr = document.createElement('tr');
      var name = el('td', 'name'); name.textContent = m.name || h.shortName(m.id); name.title = m.id; tr.appendChild(name);
      var sz = m.size || (a && a.total_size);
      tr.appendChild(el('td', 'right num', sz ? h.fmtBytes(sz) : '—'));
      var use = el('td'); h.useTags(m).forEach(function (t) { use.appendChild(el('span', 'tag', t)); }); tr.appendChild(use);
      var ver = el('td', 'num', a && a.version ? h.fmtVersion(a.version) + (a.need_update && a.version_label ? ' → ' + h.fmtVersion(a.version_label) : '') : '—');
      tr.appendChild(ver);
      var status = el('td', 'state');
      if (task) {
        status.appendChild(st(task.state === 'running' ? 'Updating' : 'Queued', 'warn'));
        if (task.step && task.steps) status.appendChild(document.createTextNode(' step ' + task.step + ' of ' + task.steps));
      } else if (downloading) {
        status.appendChild(st('Downloading', 'warn'));
        status.appendChild(document.createTextNode(' ' + Math.round(a.progress || 0) + '%'));
      } else status.appendChild(st(running ? 'In memory' : 'Installed', running ? 'ok' : 'idle'));
      tr.appendChild(status);
      var act = el('td', 'right');
      if (a && a.need_update && !task) {
        var ub = el('button', null, 'Update'); ub.type = 'button'; ub.className = 'primary';
        ub.addEventListener('click', function () { askUpdate([a], running ? [a.id] : [], ub); });
        act.appendChild(ub);
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    });
    if (!care) tb.appendChild(oneRow(tb, 6, 'Versions and updates come from the device-care engine, which is not available in this build.'));
  }

  /* ---- update confirmation (design §4 "Update one model", §5 copy) ---- */
  function askUpdate(list, inMemoryIds, opener) {
    var d = document.getElementById('update-dialog');
    var body = document.getElementById('update-body');
    body.textContent = '';
    var many = list.length > 1;
    document.getElementById('update-title').textContent = many ? 'Update ' + list.length + ' models, one at a time?' : h.updateQuestion(list[0]);
    body.appendChild(el('p', null, 'Tiiny ships an update as a new model: the installed version is deleted first, then the new one is downloaded. Until the download ends the model cannot be used.'));
    list.forEach(function (m) {
      if (many) body.appendChild(el('h3', null, (m.display_name || h.shortName(m.id)) + ' · ' + h.fmtVersion(m.version) + ' → ' + h.fmtVersion(m.version_label)));
      if (m.update_title || m.update_desc) {
        var q = el('blockquote', 'note', (m.update_title ? m.update_title + ' — ' : '') + (m.update_desc || ''));
        body.appendChild(q);
      }
      var ol = el('ol');
      h.updateSteps(m, inMemoryIds.indexOf(m.id) >= 0).forEach(function (s) {
        ol.appendChild(el('li', s.skip ? 'note' : null, s.text + (s.skip ? ' (skipped: not in memory)' : '')));
      });
      body.appendChild(ol);
    });
    var outs = ((last.careState && last.careState.outages) || []).filter(function (o) { return o.lost > Date.now() - 864e5; }).length;
    body.appendChild(el('p', 'note', 'Keep the Pocket on wall power. If the power drops during the update, it continues from the same step when the device answers again' + (outs ? ' (' + outs + ' outage' + (outs > 1 ? 's' : '') + ' in the last 24 h).' : '.')));
    var ok = document.getElementById('update-ok');
    ok.onclick = function () {
      d.close();
      if (many) fire('m3:device:updateAll', {}, opener);
      else fire('m3:device:update', { id: list[0].id }, opener);
    };
    d.onclose = function () { if (opener && opener.focus) opener.focus(); };
    d.showModal();
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
    M3.bus.on('care', function (c) { last.careState = c; renderInmem(); renderInstalled(); });
    document.getElementById('update-all').addEventListener('click', function () {
      var care = (last.careModels && last.careModels.models) || [];
      var run = ((last.careState && last.careState.running) || []).map(function (r) { return r.id; });
      askUpdate(care.filter(function (a) { return a.need_update; }), run, this);
    });
    document.getElementById('update-cancel').addEventListener('click', function () { document.getElementById('update-dialog').close(); });
    M3.bus.on('tab', function (id) { if (id === 'tab-models') pollAll(); });
  }

  return { init: init, _last: last };
})();
