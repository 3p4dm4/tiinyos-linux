/* M3 music — entry point: status polling + studio init. */
window.M3 = window.M3 || {};
(function () {
  M3.studio.init();
  M3.status.refresh();
  setInterval(() => M3.status.refresh(), 5000);
})();
