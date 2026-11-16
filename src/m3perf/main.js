/* M3 perf — entry point: wires the modules and the polling cadence. */
window.M3 = window.M3 || {};
(function () {
  M3.gauges.refresh();
  M3.models.refresh();
  setInterval(() => M3.gauges.refresh(), 5000);
  setInterval(() => M3.models.refresh(), 60000);
})();
