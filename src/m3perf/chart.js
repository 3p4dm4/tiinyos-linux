/* M3 Device — usage chart: a stacked "tokens per day by model" bar chart as
 * inline SVG, with a legend and a table twin (the design keeps the same data
 * object feeding all three, so the numbers always agree).
 *
 * Pure drawing only: the caller passes already-aggregated data
 *   { days: [date..7], perDay: {date: {key: tokens}}, series: [{id,name,slot,other}],
 *     totals: [n..7], today: date|null }
 * Colors are var(--series-N) tokens (CSP-safe, no raw literals). One color per
 * model is kept stable across weeks via the caller's series slots; models past
 * the palette are aggregated into a single "Other" series.
 */
window.M3 = window.M3 || {};
M3.chart = (function () {
  var NS = 'http://www.w3.org/2000/svg';
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function svgEl(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtInt(n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function compact(n) {
    n = +n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(n);
  }
  // a class, not a style attribute: the page CSP (style-src 'self') drops style="" on SVG
  function fillOf(s) { return 'seg s-' + (s.other ? 'other' : s.slot); }

  // Draws the stacked bars. Returns nothing; safe to call repeatedly.
  function draw(svg, o) {
    var W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H) return false;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var days = o.days, perDay = o.perDay, series = o.series, totals = o.totals, today = o.today;
    var padL = 44, padR = 8, padT = 20, padB = 24, BAR = 24;
    var maxT = Math.max.apply(null, totals.concat([0]));
    var step = maxT >= 2e6 ? 2e6 : maxT >= 1e6 ? 1e6 : maxT >= 2e5 ? 2e5 : maxT >= 2e4 ? 2e4 : 1e4;
    var top = Math.max(step, Math.ceil((maxT || step) / step) * step);
    var plotH = H - padT - padB, plotW = W - padL - padR, slot = plotW / Math.max(1, days.length);
    function y(v) { return padT + plotH - (v / top) * plotH; }

    // grid + y labels
    for (var v = 0; v <= top; v += step) {
      svg.appendChild(svgEl('line', { 'class': v === 0 ? 'axis' : 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
      svg.appendChild(svgEl('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }, v === 0 ? '0' : compact(v)));
    }

    days.forEach(function (d, i) {
      var x = padL + slot * i + slot / 2 - BAR / 2, acc = 0;
      var tip = [DOW[i] + ' ' + d + ' · ' + (totals[i] ? fmtInt(totals[i]) + ' tokens' : 'no usage')];
      var g = svgEl('g', { 'class': 'col', tabindex: '0', role: 'img' });
      g.appendChild(svgEl('rect', { 'class': 'hit', x: padL + slot * i, y: padT, width: slot, height: plotH }));
      var segs = series.filter(function (m) { return (perDay[d] && perDay[d][m.id] || 0) > 0; });
      segs.forEach(function (m, j) {
        var val = perDay[d][m.id] || 0, y1 = y(acc + val), y0 = y(acc), hgt = y0 - y1;
        tip.push(m.name + ' · ' + fmtInt(val));
        var isTop = j === segs.length - 1, r = Math.min(4, hgt / 2);
        if (isTop && hgt > 4) {
          var path = 'M' + x + ' ' + y0 + ' V' + (y1 + r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r +
            ' H' + (x + BAR - r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + ' V' + y0 + ' Z';
          g.appendChild(svgEl('path', { 'class': fillOf(m), d: path }));
        } else {
          g.appendChild(svgEl('rect', { 'class': fillOf(m), x: x, y: y1, width: BAR, height: Math.max(hgt, 0) }));
        }
        acc += val;
      });
      if (totals[i] > 0) svg.appendChild(svgEl('text', { 'class': 'cap', x: x + BAR / 2, y: y(totals[i]) - 6, 'text-anchor': 'middle' }, compact(totals[i])));
      g.setAttribute('data-top', y(totals[i]) - 20);
      var label = DOW[i] + ' ' + d.slice(8);
      svg.appendChild(svgEl('text', { x: x + BAR / 2, y: H - 6, 'text-anchor': 'middle' }, d === today ? label + ' · today' : label));
      g.setAttribute('aria-label', totals[i] ? tip.join('; ') : DOW[i] + ' ' + d + ' · no usage');
      g.appendChild(svgEl('title', {}, tip.join('\n')));
      svg.appendChild(g);
    });
    return true;
  }

  function legend(legendEl, series) {
    legendEl.textContent = '';
    series.forEach(function (m) {
      var s = document.createElement('span');
      var sw = document.createElement('i');
      sw.className = 'sw'; sw.setAttribute('aria-hidden', 'true');
      sw.style.background = 'var(--series-' + (m.other ? 'other' : m.slot) + ')';
      s.appendChild(sw); s.appendChild(document.createTextNode(m.name));
      legendEl.appendChild(s);
    });
  }

  // Table twin of the chart: one row per day, one column per series + Total.
  function table(theadEl, tbodyEl, days, series, perDay, totals) {
    theadEl.textContent = '';
    var hr = document.createElement('tr');
    var th0 = document.createElement('th'); th0.textContent = 'Day'; hr.appendChild(th0);
    series.forEach(function (m) { var th = document.createElement('th'); th.className = 'right'; th.textContent = m.name; hr.appendChild(th); });
    var thT = document.createElement('th'); thT.className = 'right'; thT.textContent = 'Total'; hr.appendChild(thT);
    theadEl.appendChild(hr);
    tbodyEl.textContent = '';
    days.forEach(function (d, i) {
      var tr = document.createElement('tr');
      var td = document.createElement('td'); td.className = 'num'; td.textContent = DOW[i] + ' ' + d; tr.appendChild(td);
      series.forEach(function (m) { var c = document.createElement('td'); c.className = 'right num'; c.textContent = fmtInt((perDay[d] && perDay[d][m.id]) || 0); tr.appendChild(c); });
      var ct = document.createElement('td'); ct.className = 'right num'; ct.textContent = fmtInt(totals[i]); tr.appendChild(ct);
      tbodyEl.appendChild(tr);
    });
  }

  return { draw: draw, legend: legend, table: table, compact: compact, fmtInt: fmtInt };
})();
