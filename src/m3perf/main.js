/* M3 Device — entry point. Boots the tabs, the data layer and the Status tab.
 * Each later tab (models/usage/power) plugs in here with its own init().
 */
(function () {
  function boot() {
    M3.tabs.init();
    M3.status.init();
    M3.models.init();
    M3.usage.init();
    M3.power.init();
    M3.data.start();
    if (window.m3 && window.m3.ready) window.m3.ready();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
