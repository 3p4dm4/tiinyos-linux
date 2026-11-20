/* M3 Device — Power tab: "what happens when power returns" (design §3 "Power").
 *
 *   · When power returns  — AC-power switch (device setting, m3:care:setAcPower)
 *                           + the restore policy radios (m3:care:setPolicy:
 *                           off / kept / all).
 *   · Keep loaded         — which models to reload after an outage
 *                           (m3:care:keep).
 *   · Restore in progress — the live restore (per model), with Stop.
 *   · Outages seen from   — the last-30-days outage history + a plain-language
 *   this PC                 advice line.
 *
 * Every control goes through an m3:care:* channel and FAILS SOFT: the engine is
 * not wired yet, so this build shows the controls in their default state,
 * disabled, with a "not available" note. When a care state arrives the controls
 * become live. No fake values are shown.
 */
window.M3 = window.M3 || {};
M3.power = (function () {
  var h = M3.h;
  var last = { care: null };
  var built = false;
  var R = {};
  var DEF = { acPower: false, reload: 'kept', kept: [], lastInMemory: 0, restore: null, outages: [] };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fire(ch, args, revert) {
    if (!window.m3 || !window.m3.invoke) { softFail(revert); return; }
    window.m3.invoke(ch, args).then(function () {
      M3.bus.emit('readnow'); // re-pull care state so the control reflects the device
    }).catch(function (e) {
      softFail(revert);
      R.note.textContent = (ch === 'm3:care:setAcPower' ? 'AC power' : ch === 'm3:care:setPolicy' ? 'Restore policy' : 'Keep loaded') +
        ' needs the device-care engine, which is not available in this build (' + String(e.message || e) + ').';
      console.warn('[M3]', ch, e.message || e);
    });
  }
  function softFail(revert) { if (typeof revert === 'function') revert(); }

  /* ---------- scaffold ---------- */
  function build() {
    var p = document.getElementById('p-power');
    if (built) return p;
    p.textContent = '';

    // 1) When power returns
    var s1 = el('section', 'panel');
    var h1 = el('h2'); h1.id = 'h-ret'; h1.textContent = 'When power returns'; s1.appendChild(h1);
    var cols = el('div', 'cols');

    var sw = el('div', 'switchrow');
    var acWrap = el('label', 'tgt'); acWrap.setAttribute('for', 'ac');
    var ac = el('input'); ac.type = 'checkbox'; ac.setAttribute('role', 'switch'); ac.id = 'ac'; ac.setAttribute('aria-describedby', 'ac-help');
    acWrap.appendChild(ac);
    sw.appendChild(acWrap);
    var acLbl = el('label', null, 'Power on automatically'); acLbl.setAttribute('for', 'ac'); sw.appendChild(acLbl);
    var acState = el('span', 'note', 'Off · device setting'); acState.id = 'ac-state'; sw.appendChild(acState);
    var acHelp = el('span', 'help', 'Device setting (AC power). Off: after a power cut the Pocket stays off until its button is pressed. Takes effect at the next cut.'); acHelp.id = 'ac-help'; sw.appendChild(acHelp);
    cols.appendChild(sw);

    var fs = el('fieldset');
    fs.appendChild(el('legend', null, 'Reload missing models from this PC'));
    var opts = [
      ['off', 'Nothing', 'No models are reloaded after an outage.'],
      ['kept', 'Models marked Keep loaded', 'Only the ones not in memory when the device answers again, in the order they were last loaded. A model that no longer fits the NPU memory is reported, never forced in.'],
      ['all', 'Everything that was in memory', 'Uses the last reading before the outage.']
    ];
    opts.forEach(function (o, i) {
      var row = el('div', 'opt');
      var w = el('label', 'tgt'); w.setAttribute('for', 'pr' + i);
      var inp = el('input'); inp.type = 'radio'; inp.name = 'power-restore'; inp.id = 'pr' + i; inp.value = o[0]; inp.setAttribute('aria-describedby', 'prh' + i);
      w.appendChild(inp);
      row.appendChild(w);
      var lb = el('label', null, o[1]); lb.setAttribute('for', 'pr' + i); lb.id = 'prl' + i; row.appendChild(lb);
      var hp = el('span', 'help', o[2]); hp.id = 'prh' + i; row.appendChild(hp);
      fs.appendChild(row);
    });
    cols.appendChild(fs);
    s1.appendChild(cols);
    s1.appendChild(el('p', 'note', 'The device may bring a model back on its own after a restart. The restore never unloads what the device brought back; it loads what is missing, and needs this app open.'));
    p.appendChild(s1);

    // 2) Keep loaded
    var s2 = el('section');
    var kh = el('div', 'sec-head'); var k2 = el('h2'); k2.id = 'h-keep'; k2.textContent = 'Keep loaded'; kh.appendChild(k2);
    kh.appendChild(el('span', 'note', 'reloaded after an outage when the policy above allows it · the order is the last-load order'));
    s2.appendChild(kh);
    var kt = el('table'); kt.setAttribute('aria-labelledby', 'h-keep');
    kt.appendChild(thead([{ t: 'Model' }, { t: 'In memory' }, { t: 'Keep loaded' }]));
    kt.appendChild(el('tbody'));
    s2.appendChild(kt); p.appendChild(s2);

    // 3) Restore in progress
    var s3 = el('section');
    var rh = el('div', 'sec-head'); var r2 = el('h2'); r2.id = 'h-restore'; r2.textContent = 'Restore in progress'; rh.appendChild(r2);
    var rn = el('span', 'note', ''); rn.id = 'restore-note'; rh.appendChild(rn);
    rh.appendChild(el('span', 'spacer'));
    var stop = el('button', null, 'Stop'); stop.type = 'button'; stop.id = 'restore-stop'; stop.disabled = true; rh.appendChild(stop);
    s3.appendChild(rh);
    var rt = el('table'); rt.setAttribute('aria-labelledby', 'h-restore');
    rt.appendChild(thead([{ t: 'Model' }, { t: 'Size', right: 1 }, { t: 'State' }, { t: '', right: 1 }]));
    rt.appendChild(el('tbody'));
    s3.appendChild(rt); p.appendChild(s3);

    // 4) Outages seen from this PC
    var s4 = el('section');
    var oh = el('div', 'sec-head'); var o2 = el('h2'); o2.id = 'h-out'; o2.textContent = 'Outages seen from this PC'; oh.appendChild(o2);
    oh.appendChild(el('span', 'note', 'last 30 days · an outage = the device stopped answering and the USB link dropped, then it answered again'));
    oh.appendChild(el('span', 'spacer'));
    var on = el('span', 'note', ''); on.id = 'out-count'; oh.appendChild(on);
    s4.appendChild(oh);
    var adv = el('div', 'advice'); adv.setAttribute('role', 'status'); adv.id = 'out-advice'; s4.appendChild(adv);
    var ot = el('table'); ot.setAttribute('aria-labelledby', 'h-out');
    ot.appendChild(thead([{ t: 'Stopped answering' }, { t: 'Answered again' }, { t: 'No answer for', right: 1 }, { t: 'In memory before', right: 1 }, { t: 'Back on its own', right: 1 }, { t: 'Restore' }]));
    ot.appendChild(el('tbody'));
    s4.appendChild(ot); p.appendChild(s4);

    // fail-soft note (shown when the engine is absent)
    var note = el('p', 'note'); note.id = 'power-note'; note.hidden = true; p.appendChild(note);

    R = { p: p, note: note, ac: ac, acState: acState, radios: [0, 1, 2].map(function (i) { return document.getElementById('pr' + i); }),
      keepB: kt.querySelector('tbody'), keepH: k2,
      restoreNote: rn, restoreStop: stop, restoreB: rt.querySelector('tbody'),
      outCount: on, outAdvice: adv, outB: ot.querySelector('tbody') };
    built = true;
    return p;
  }
  function thead(cols) { var t = el('thead'), tr = document.createElement('tr'); cols.forEach(function (c) { var th = el('th', c.right ? 'right' : ''); th.textContent = c.t; tr.appendChild(th); }); t.appendChild(tr); return t; }

  /* ---------- which engine fields are present ---------- */
  function power() {
    var c = last.care || {};
    var available = !!last.care && (c.acPower != null || c.reload != null || c.kept != null);
    return {
      available: available,
      acPower: c.acPower != null ? c.acPower : DEF.acPower,
      reload: c.reload || DEF.reload,
      kept: c.kept || [],
      lastInMemory: c.lastInMemory != null ? c.lastInMemory : 0,
      restore: c.restore || null,
      outages: c.outages || [],
      models: c.models || []
    };
  }
  function keptSet() { var s = {}; power().kept.forEach(function (id) { s[id] = 1; }); return s; }

  /* ---------- render ---------- */
  function renderControls() {
    var pw = power();
    var en = pw.available;
    R.ac.checked = pw.acPower; R.ac.disabled = !en;
    R.acState.textContent = (pw.acPower ? 'On' : 'Off') + ' · device setting';
    R.radios.forEach(function (inp) {
      inp.checked = inp.value === pw.reload;
      inp.disabled = !en;
    });
    // reflect counts in the radio labels
    var keptCount = pw.kept.length;
    var keptLabel = document.getElementById('prl1');
    if (keptLabel) keptLabel.textContent = 'Models marked Keep loaded' + (keptCount ? ' (' + keptCount + ')' : '');
    var allLabel = document.getElementById('prl2');
    if (allLabel) allLabel.textContent = 'Everything that was in memory' + (pw.lastInMemory ? ' (' + pw.lastInMemory + ' at the last reading)' : '');
    R.note.hidden = en;
    if (!en) R.note.textContent = 'Power settings live on the device-care engine, which is not available in this build. The controls are shown in their default state.';
  }
  function renderKeep() {
    var pw = power(), ks = keptSet();
    R.keepB.textContent = '';
    if (!pw.available) { R.keepB.appendChild(emptyRow(3, 'not available — the engine tracks which models to keep loaded')); return; }
    if (!pw.models.length) { R.keepB.appendChild(emptyRow(3, 'no models known to the engine yet')); return; }
    pw.models.forEach(function (m) {
      var tr = document.createElement('tr');
      var nm = el('td', 'name'); nm.textContent = h.shortName(m.id); nm.title = m.id; tr.appendChild(nm);
      tr.appendChild(el('td', null, m.inMemory ? 'in memory' : '—'));
      var cell = el('td');
      var w = el('label', 'tgt'); w.setAttribute('for', 'k' + safeId(m.id));
      var inp = el('input'); inp.type = 'checkbox'; inp.id = 'k' + safeId(m.id); inp.checked = !!ks[m.id]; inp.disabled = !pw.available;
      var sr = el('span', 'sr-only', 'Keep ' + m.id + ' loaded'); sr.id = 'k' + safeId(m.id) + 'd';
      inp.setAttribute('aria-describedby', 'k' + safeId(m.id) + 'd');
      w.appendChild(inp); w.appendChild(sr);
      inp.addEventListener('change', function () { fire('m3:care:keep', { id: m.id, on: inp.checked }, function () { inp.checked = !inp.checked; }); });
      cell.appendChild(w);
      tr.appendChild(cell);
      R.keepB.appendChild(tr);
    });
  }
  function safeId(id) { return String(id).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40); }
  function emptyRow(colspan, text) { var tr = document.createElement('tr'); var td = el('td', 'note'); td.setAttribute('colspan', colspan); td.textContent = text; tr.appendChild(td); return tr; }

  function renderRestore() {
    var pw = power();
    var r = pw.restore;
    R.restoreB.textContent = '';
    if (r && r.models && r.models.length) {
      R.restoreNote.textContent = 'started ' + (r.startedAt ? h.fmtTime(r.startedAt) : '') + ' · ' + (r.policy || '');
      R.restoreStop.disabled = false;
      r.models.forEach(function (m) {
        var tr = document.createElement('tr');
        var nm = el('td', 'name'); nm.textContent = h.shortName(m.id); nm.title = m.id; tr.appendChild(nm);
        tr.appendChild(el('td', 'right num', m.size ? h.fmtBytes(m.size) : '—'));
        var st = el('td', 'state');
        st.appendChild(el('span', 'st ' + (m.stateCls || 'idle'), m.state || ''));
        if (m.note) st.appendChild(el('span', 'note', ' ' + m.note));
        tr.appendChild(st);
        var act = el('td', 'right');
        if (m.canSkip) { var b = el('button', null, 'Skip'); b.type = 'button'; b.addEventListener('click', function () { fire('m3:care:stopTask', { taskId: m.taskId, skip: m.id }); }); act.appendChild(b); }
        if (m.canForce) { var fb = el('button', null, 'Load anyway'); fb.type = 'button'; fb.className = 'primary'; fb.addEventListener('click', function () { fire('m3:care:load', { id: m.id }); }); act.appendChild(fb); }
        tr.appendChild(act);
        R.restoreB.appendChild(tr);
      });
    } else {
      R.restoreStop.disabled = true;
      if (pw.available) R.restoreNote.textContent = 'no restore in progress right now';
      else R.restoreNote.textContent = 'a restore would appear here (device-care engine not available in this build)';
      R.restoreB.appendChild(emptyRow(4, R.restoreNote.textContent));
    }
  }

  function renderOutages() {
    var pw = power();
    R.outB.textContent = '';
    if (!pw.available) { R.outAdvice.textContent = 'Outage history is kept by the device-care engine, which is not available in this build.'; R.outCount.textContent = ''; return; }
    if (!pw.outages.length) { R.outAdvice.textContent = 'No outages in the last 30 days while this app was running.'; R.outCount.textContent = '0'; return; }
    R.outCount.textContent = pw.outages.length + ' in the last 30 days';
    R.outAdvice.textContent = pw.advice || '';
    pw.outages.forEach(function (o) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'num', o.stoppedAt ? (h.fmtDate(o.stoppedAt) === h.fmtDate(Date.now()) ? 'today ' : h.fmtDate(o.stoppedAt) + ' ') + h.fmtTime(o.stoppedAt) : '—'));
      tr.appendChild(el('td', 'num', o.answeredAt ? h.fmtTime(o.answeredAt) : '—'));
      tr.appendChild(el('td', 'right num', o.noAnswerSec != null ? h.fmtDur(o.noAnswerSec) : '—'));
      tr.appendChild(el('td', 'right num', o.inMemoryBefore != null ? String(o.inMemoryBefore) : '—'));
      tr.appendChild(el('td', 'right num', o.backOnItsOwn != null ? String(o.backOnItsOwn) : '—'));
      var rc = el('td');
      if (o.restore) {
        rc.appendChild(el('span', 'st ' + (o.restore.cls || 'idle'), o.restore.state || ''));
        if (o.restore.detail) rc.appendChild(el('span', 'note', ' ' + o.restore.detail));
      } else rc.appendChild(el('span', 'note', '—'));
      tr.appendChild(rc);
      R.outB.appendChild(tr);
    });
  }

  function render() { build(); renderControls(); renderKeep(); renderRestore(); renderOutages(); }

  /* ---------- wiring ---------- */
  function init() {
    build();
    R.ac.addEventListener('change', function () {
      var next = R.ac.checked;
      fire('m3:care:setAcPower', { on: next }, function () { R.ac.checked = !next; });
    });
    R.radios.forEach(function (inp) {
      inp.addEventListener('change', function () {
        var v = inp.value;
        fire('m3:care:setPolicy', { reload: v }, function () { /* radio can't be un-checked; leave as-is and note */ });
      });
    });
    R.restoreStop.addEventListener('click', function () {
      var c = last.care || {};
      var t = (c.tasks || []).filter(function (x) { return x.kind === 'restore'; })[0];
      if (t) fire('m3:care:stopTask', { taskId: t.id });
    });
    render();
    M3.bus.on('care', function (c) { last.care = c; render(); });
  }

  return { init: init };
})();
