/* M3 perf — shared formatters. */
window.M3 = window.M3 || {};
M3.fmt = {
  pct: x => (x == null ? '—' : Math.round(x) + '%'),
  gb: b => (b / 1073741824).toFixed(1) + ' GB',
  mbToGb: mb => (mb ? (mb / 1024).toFixed(1) : '?'),
  num: x => (x == null ? '—' : x),
};
