/* M3 Device — Usage tab: "what the device did", per week (design §3 "Usage").
 *
 *   · Week nav   — This week / Previous week (Next is future → disabled).
 *   · Week totals — 5 KPI cells (tokens, prompt, completion, requests, busiest
 *                  day) from h.usageTotals + h.busiestDay.
 *   · Chart       — M3.chart stacked "tokens per day by model" (one color per
 *                  model, stable across weeks) + legend + a table twin inside
 *                  <details>.
 *   · By model    — per-model table (top 10) with a color swatch.
 *   · By app      — per-app table with a column per top model.
 *
 * Data comes from m3:device:usage ({weekStart}) and FAILS SOFT: the engine is not
 * wired yet, so this build shows the "read failed / engine not available"
 * state. No fake usage numbers are ever shown. The chart only draws when the
 * tab is visible (a hidden panel has zero width) and on resize.
 */
window.M3 = window.M3 || {};
M3.usage = (function () {
  var h = M3.h, C = M3.chart;
  var todayStr = h.fmtDate(Date.now());
  var thisMonday = h.mondayOf(todayStr);
  var offset = 0; // 0 = this week, 1 = previous week, ...
  var last = { usage: null, error: null, readAt: null };
  var built = false;
  var R = {};

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function weekStart() { return h.addDays(thisMonday, -7 * offset); }
  function week() { return h.weekRange(weekStart(), offset === 0 ? todayStr : null); }

  /* ---------- scaffold (built once) ---------- */
  function build() {
    var p = document.getElementById('p-usage');
    if (built) return p;
    p.textContent = '';

    var nav = el('section'); nav.setAttribute('aria-label', 'Week');
    var wn = el('div', 'weeknav');
    var prev = el('button', null, 'Previous week'); prev.type = 'button'; prev.id = 'wk-prev';
    var thisBtn = el('button', null, 'This week'); thisBtn.type = 'button'; thisBtn.id = 'wk-this'; thisBtn.setAttribute('aria-pressed', 'true');
    var next = el('button', null, 'Next week'); next.type = 'button'; next.id = 'wk-next'; next.disabled = true; next.setAttribute('aria-disabled', 'true');
    wn.appendChild(prev); wn.appendChild(thisBtn); wn.appendChild(next);
    var label = el('span', null, ''); label.id = 'wk-label'; wn.appendChild(label);
    wn.appendChild(el('span', 'spacer'));
    wn.appendChild(el('span', 'note', 'counted on the device, every client included'));
    nav.appendChild(wn); p.appendChild(nav);

    var kpi = el('dl', 'kpi five'); kpi.setAttribute('aria-label', 'Week totals'); p.appendChild(kpi);

    var cs = el('section');
    var ch = el('div', 'sec-head'); var h2 = el('h2'); h2.id = 'h-chart'; h2.textContent = 'Tokens per day by model'; ch.appendChild(h2);
    ch.appendChild(el('span', 'note', 'stacked by model · one color per model, kept across weeks · values in the table below'));
    cs.appendChild(ch);
    var fig = el('figure'); fig.setAttribute('aria-labelledby', 'h-chart');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'chart'; svg.setAttribute('aria-labelledby', 'h-chart'); svg.setAttribute('aria-describedby', 'chart-desc');
    fig.appendChild(svg);
    var desc = el('p', 'sr-only'); desc.id = 'chart-desc'; fig.appendChild(desc);
    var leg = el('div', 'legend'); leg.id = 'legend'; leg.setAttribute('aria-label', 'Models in the chart'); fig.appendChild(leg);
    cs.appendChild(fig);
    var det = el('details'); var sum = el('summary'); sum.textContent = 'Table view of the chart · tokens per day by model'; det.appendChild(sum);
    var bt = el('table'); bt.id = 'byday';
    var cap = el('caption', 'sr-only'); cap.textContent = 'Tokens per day by model, table view'; bt.appendChild(cap);
    bt.appendChild(el('thead')); bt.appendChild(el('tbody')); det.appendChild(bt); cs.appendChild(det);
    p.appendChild(cs);

    var bm = el('section');
    var bh = el('div', 'sec-head'); var b2 = el('h2'); b2.id = 'h-bymodel'; b2.textContent = 'By model'; bh.appendChild(b2);
    bh.appendChild(el('span', 'note', 'sorted by total · prompt + completion = total'));
    bm.appendChild(bh);
    var bmt = el('table'); bmt.setAttribute('aria-labelledby', 'h-bymodel');
    bmt.appendChild(thead([{ t: 'Model' }, { t: 'Prompt', right: 1 }, { t: 'Completion', right: 1 }, { t: 'Total', right: 1 }, { t: 'Share', right: 1 }, { t: 'Requests', right: 1 }, { t: 'Tokens / request', right: 1 }]));
    bmt.appendChild(el('tbody')); bmt.appendChild(el('tfoot'));
    bm.appendChild(bmt); p.appendChild(bm);

    var ba = el('section');
    var ah = el('div', 'sec-head'); var a2 = el('h2'); a2.id = 'h-byapp'; a2.textContent = 'By app'; ah.appendChild(a2);
    ah.appendChild(el('span', 'note', 'the device reports totals per app, not per day · "default" = requests that name no app'));
    ba.appendChild(ah);
    var bat = el('table'); bat.setAttribute('aria-labelledby', 'h-byapp');
    bat.appendChild(el('thead')); bat.appendChild(el('tbody')); bat.appendChild(el('tfoot'));
    ba.appendChild(bat); p.appendChild(ba);

    R = { p: p, kpi: kpi, label: label, prev: prev, thisBtn: thisBtn, next: next,
      svg: svg, desc: desc, legend: leg, bydayT: bt.querySelector('thead'), bydayB: bt.querySelector('tbody'),
      bmT: bmt.querySelector('thead'), bmB: bmt.querySelector('tbody'), bmF: bmt.querySelector('tfoot'),
      baT: bat.querySelector('thead'), baB: bat.querySelector('tbody'), baF: bat.querySelector('tfoot') };
    built = true;
    return p;
  }
  function thead(cols) {
    var t = el('thead'), tr = document.createElement('tr');
    cols.forEach(function (c) { var th = el('th', c.right ? 'right' : ''); th.textContent = c.t; tr.appendChild(th); });
    t.appendChild(tr); return t;
  }

  /* ---------- data transforms ---------- */
  function seriesOf(byModel) {
    var slots = h.seriesSlots(byModel.map(function (m) { return m.id; }));
    var chart = byModel.slice(0, 8).map(function (m) { return { id: m.id, name: h.shortName(m.id), slot: slots.map[m.id], other: false }; });
    if (byModel.length > 8) chart.push({ id: '__other__', name: 'Other', other: true });
    var all = byModel.map(function (m) { var s = slots.map[m.id]; return { id: m.id, name: h.shortName(m.id), slot: s, other: !s }; });
    return { chart: chart, all: all, slots: slots };
  }
  function dayAgg(rawDays, dates, chartSeries) {
    var colored = {}; chartSeries.forEach(function (s) { if (!s.other) colored[s.id] = 1; });
    var perDay = {}, totals = [];
    dates.forEach(function (d) {
      var day = rawDays[d] || {}, o = {};
      chartSeries.forEach(function (s) {
        if (s.other) { var sum = 0; Object.keys(day).forEach(function (id) { if (!colored[id]) sum += day[id].total || 0; }); o[s.id] = sum; }
        else o[s.id] = day[s.id] ? (day[s.id].total || 0) : 0;
      });
      perDay[d] = o;
      var t = 0; chartSeries.forEach(function (s) { t += o[s.id] || 0; }); totals.push(t);
    });
    return { perDay: perDay, totals: totals };
  }

  /* ---------- week label + KPI ---------- */
  function renderWeekLabel() {
    var w = week(), ws = weekStart();
    var ds = offset === 0 ? (w.daysSoFar != null ? w.daysSoFar + ' days so far' : '') : 'full week';
    R.label.textContent = '';
    R.label.appendChild(el('strong', null, 'Week of ' + ws));
    R.label.appendChild(el('span', 'note', ' ' + h.fmtDateShort(w.dates[0]) + ' – ' + h.fmtDateShort(w.dates[6]) + (ds ? ' · ' + ds : '')));
    R.prev.disabled = offset >= 26;
    R.thisBtn.setAttribute('aria-pressed', offset === 0 ? 'true' : 'false');
    var old = R.p.querySelector('#wk-read'); if (old) old.remove();
  }
  function renderKpi() {
    R.kpi.textContent = '';
    var u = last.usage;
    function add(dt, big, small) { var c = el('div'); c.appendChild(el('dt', null, dt)); var dd = el('dd', big === '—' ? 'note' : ''); dd.appendChild(document.createTextNode(big)); if (small) { var s = el('small'); s.textContent = small; dd.appendChild(s); } c.appendChild(dd); R.kpi.appendChild(c); }
    if (!u) { add('Tokens this week', '—'); add('Prompt', '—'); add('Completion', '—'); add('Requests', '—'); add('Busiest day', '—'); return; }
    var t = h.usageTotals(u.days);
    var busiest = h.busiestDay(u.days);
    add('Tokens this week', C.compact(t.total), C.fmtInt(t.total));
    add('Prompt', C.compact(t.prompt), (t.total ? Math.round(100 * t.prompt / t.total) : 0) + '% of the total');
    add('Completion', C.compact(t.completion), (t.total ? Math.round(100 * t.completion / t.total) : 0) + '% of the total');
    add('Requests', C.fmtInt(t.requests), t.requests ? C.fmtInt(Math.round(t.total / t.requests)) + ' tokens per request' : '');
    if (busiest) add('Busiest day', h.dow(busiest.date) + ' ' + busiest.date.slice(8), C.compact(busiest.total) + ' tokens · ' + C.fmtInt(busiest.requests) + ' requests');
    else add('Busiest day', '—', 'no usage');
  }

  /* ---------- chart ---------- */
  function drawChart() {
    if (R.p.hidden) return;
    var u = last.usage;
    var w = week();
    if (!u) { R.svg.textContent = ''; R.legend.textContent = ''; return; }
    var byModel = h.usageByModel(u.days);
    var s = seriesOf(byModel);
    var agg = dayAgg(u.days, w.dates, s.chart);
    var ok = C.draw(R.svg, { days: w.dates, perDay: agg.perDay, series: s.chart, totals: agg.totals, today: offset === 0 ? todayStr : null });
    C.legend(R.legend, s.chart);
    C.table(R.bydayT, R.bydayB, w.dates, s.chart, agg.perDay, agg.totals);
    R.desc.textContent = 'Stacked columns, one per day from Monday ' + w.dates[0] + ' to Sunday ' + w.dates[6] +
      '. The same numbers are in the table "Tokens per day by model, table view" below.';
    return ok;
  }

  /* ---------- by model ---------- */
  function renderByModel() {
    R.bmB.textContent = ''; R.bmF.textContent = '';
    var u = last.usage;
    if (!u) { R.bmB.appendChild(emptyRow(7, 'no usage data (device-care engine not available in this build)')); return; }
    var byModel = h.usageByModel(u.days);
    var s = seriesOf(byModel);
    var map = {}; s.all.forEach(function (m) { map[m.id] = m; });
    var top = byModel.slice(0, 10);
    var tot = h.usageTotals(u.days);
    top.forEach(function (m) {
      var tr = document.createElement('tr');
      var nm = el('td', 'name'); nm.title = m.id;
      var sw = el('span', 'sw', null); sw.setAttribute('aria-hidden', 'true');
      var mm = map[m.id] || {}; sw.style.background = 'var(--series-' + (mm.other ? 'other' : mm.slot) + ')';
      nm.appendChild(sw); nm.appendChild(document.createTextNode(m.id));
      tr.appendChild(nm);
      tr.appendChild(el('td', 'right num', C.fmtInt(m.prompt)));
      tr.appendChild(el('td', 'right num', C.fmtInt(m.completion)));
      tr.appendChild(el('td', 'right num', C.fmtInt(m.total)));
      tr.appendChild(el('td', 'right num', h.pct(m.share * 100)));
      tr.appendChild(el('td', 'right num', C.fmtInt(m.requests)));
      tr.appendChild(el('td', 'right num', m.requests ? C.fmtInt(m.perReq) : '—'));
      R.bmB.appendChild(tr);
    });
    if (byModel.length > 10) R.bmB.appendChild(emptyRow(7, 'and ' + (byModel.length - 10) + ' more models'));
    var ft = document.createElement('tr');
    ft.appendChild(el('td', null, byModel.length + ' models'));
    ft.appendChild(el('td', 'right num', C.fmtInt(tot.prompt)));
    ft.appendChild(el('td', 'right num', C.fmtInt(tot.completion)));
    ft.appendChild(el('td', 'right num', C.fmtInt(tot.total)));
    ft.appendChild(el('td', 'right num', '100%'));
    ft.appendChild(el('td', 'right num', C.fmtInt(tot.requests)));
    ft.appendChild(el('td', 'right num', tot.requests ? C.fmtInt(Math.round(tot.total / tot.requests)) : '—'));
    R.bmF.appendChild(ft);
  }

  /* ---------- by app ---------- */
  function renderByApp() {
    R.baT.textContent = ''; R.baB.textContent = ''; R.baF.textContent = '';
    var u = last.usage;
    if (!u) { R.baB.appendChild(emptyRow(3, 'no usage data (device-care engine not available in this build)')); R.baT.appendChild(thead([{ t: 'App' }, { t: 'Tokens', right: 1 }, { t: 'Share', right: 1 }])); return; }
    var byModel = h.usageByModel(u.days);
    var cols = byModel.slice(0, 8);
    var apps = h.usageByApp(u.apps || {});
    // header
    var tr = document.createElement('tr');
    tr.appendChild(el('th', null, 'App')); tr.appendChild(el('th', 'right', 'Tokens')); tr.appendChild(el('th', 'right', 'Share'));
    cols.forEach(function (m) { var th = el('th', 'right', h.shortName(m.id)); th.title = m.id; tr.appendChild(th); });
    R.baT.appendChild(tr);
    // rows
    apps.forEach(function (a) {
      var r = document.createElement('tr');
      r.appendChild(el('td', null, a.app));
      r.appendChild(el('td', 'right num', C.fmtInt(a.total)));
      r.appendChild(el('td', 'right num', h.pct(a.share * 100)));
      cols.forEach(function (m) { r.appendChild(el('td', 'right num', C.fmtInt((a.models && a.models[m.id]) || 0))); });
      R.baB.appendChild(r);
    });
    // totals
    var ft = document.createElement('tr');
    ft.appendChild(el('td', null, apps.length + ' apps'));
    var totTok = 0; apps.forEach(function (a) { totTok += a.total; });
    ft.appendChild(el('td', 'right num', C.fmtInt(totTok)));
    ft.appendChild(el('td', 'right num', '100%'));
    cols.forEach(function (m) { var sum = 0; apps.forEach(function (a) { sum += (a.models && a.models[m.id]) || 0; }); ft.appendChild(el('td', 'right num', C.fmtInt(sum))); });
    R.baF.appendChild(ft);
  }
  function emptyRow(colspan, text) {
    var tr = document.createElement('tr');
    var td = el('td', 'note'); td.setAttribute('colspan', colspan); td.textContent = text;
    tr.appendChild(td); return tr;
  }

  /* ---------- fail-soft state ---------- */
  function renderState() {
    var note = R.p.querySelector('#usage-state');
    if (note) note.remove();
    var u = last.usage;
    if (u) {
      var readAt = u.readAt ? el('span', 'note', ' · read ' + h.fmtTime(u.readAt) + ' · every 60 s') : null;
      if (readAt) { readAt.id = 'wk-read'; R.label.parentElement.appendChild(readAt); }
      return;
    }
    R.svg.textContent = ''; R.legend.textContent = '';
    var s = el('p', 'note'); s.id = 'usage-state';
    s.textContent = last.error
      ? String(last.error).replace(/^HTTP \d+ /, '') + ' — usage counters are kept by the device-care engine, which is not available in this build' + (last.readAt ? ' · last read ' + h.fmtTime(last.readAt) : '')
      : 'Loading the week…';
    R.svg.parentNode.appendChild(s);
  }

  function render() {
    build();
    renderWeekLabel();
    renderKpi();
    renderState();
    renderByModel();
    renderByApp();
    drawChart();
  }

  /* ---------- polling ---------- */
  function poll() {
    R.prev.disabled = offset >= 26;
    if (!window.m3 || !window.m3.invoke) { last.usage = null; last.error = 'IPC unavailable'; render(); return; }
    window.m3.invoke('m3:device:usage', { weekStart: weekStart() }).then(function (u) {
      last.usage = u || null; last.error = null;
      if (u && u.readAt) last.readAt = u.readAt;
      render();
    }).catch(function (e) {
      last.usage = null; last.error = String(e.message || e);
      render();
    });
  }

  function init() {
    build();
    R.prev.addEventListener('click', function () { if (offset < 26) { offset++; poll(); } });
    R.thisBtn.addEventListener('click', function () { offset = 0; poll(); });
    render();
    poll();
    setInterval(poll, 60000);
    M3.bus.on('tab', function (id) { if (id === 'tab-usage') { poll(); setTimeout(drawChart, 0); } });
    if (typeof window !== 'undefined') window.addEventListener('resize', function () { if (!R.p.hidden) drawChart(); });
  }

  return { init: init };
})();
