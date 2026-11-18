/* M3 perf — live gauges (CPU / RAM / NPU / NPU state) from sys+npu status. */
window.M3 = window.M3 || {};
M3.gauges = (function () {
  const $ = id => document.getElementById(id);
  const { pct, gb, mbToGb } = M3.fmt;

  function paint(sys, npu) {
    $('g-cpu').textContent = pct(sys.cpu && sys.cpu.total_percent);
    $('b-cpu').style.width = Math.min(100, sys.cpu ? sys.cpu.total_percent : 0) + '%';
    $('d-cpu').textContent = (sys.cpu && sys.cpu.per_core_percent || []).length + ' core';
    $('g-ram').textContent = pct(sys.memory && sys.memory.usage_percent);
    $('b-ram').style.width = Math.min(100, sys.memory ? sys.memory.usage_percent : 0) + '%';
    $('d-ram').textContent = sys.memory ? gb(sys.memory.used_bytes) + ' / ' + gb(sys.memory.total_bytes) : '';
    const n0 = (sys.npus && sys.npus[0]) || {};
    $('g-npu').textContent = pct(n0.utilization_percent);
    $('b-npu').style.width = Math.min(100, n0.utilization_percent || 0) + '%';
    $('d-npu').textContent = mbToGb(n0.memory_used_mb) + ' / ' + mbToGb(n0.memory_total_mb) + ' GB';
    // Disk: physical usage from sys/status; model footprint from the store view
    // (set by models.refresh; absent until the first store load — degrades to sys only).
    const d = sys.disk || {};
    if (d.total_bytes) {
      const dp = d.used_bytes / d.total_bytes * 100;
      $('g-disk').textContent = Math.round(dp) + '%';
      $('b-disk').style.width = Math.min(100, dp) + '%';
      $('d-disk').textContent = gb(d.used_bytes) + ' / ' + gb(d.total_bytes)
        + (M3.storeBytes ? '  ·  models ' + gb(M3.storeBytes) : '');
    }
    const st = (npu.npu && npu.npu.status) || '?';
    $('g-state').textContent = st;
    $('g-state').className = 'v ' + (st === 'ready' ? 'ok' : 'warn');
    const r = (npu.npu && npu.npu.reason) || null;
    $('d-state').textContent = r ? (r.code + ': ' + r.message) : (npu.npu && npu.npu.status_message) || '';
    const hbm = (npu.devices || [])[0];
    if (hbm) {
      $('d-state').textContent += '  ·  HBM ' + mbToGb(hbm.mem_used_mb) + '/' + mbToGb(hbm.mem_total_mb) + ' GB';
      const extras = [];
      if (hbm.temp_c != null) extras.push(hbm.temp_c + '°C');
      if (hbm.power_w != null) extras.push(hbm.power_w + ' W');
      if (hbm.model) extras.push(hbm.model);
      if (extras.length) $('d-state').textContent += ' · ' + extras.join(' · ');
    }
  }

  function fail(e) {
    ['g-cpu', 'g-ram', 'g-npu', 'g-disk', 'g-state'].forEach(i => { $(i).textContent = '✕'; $(i).className = 'v err'; });
    $('d-state').textContent = String(e.message || e);
  }

  async function refresh() {
    try {
      const [sys, npu] = await Promise.all([window.m3.invoke('m3:sysstatus'), window.m3.invoke('m3:npustatus')]);
      paint(sys, npu);
    } catch (e) { fail(e); }
  }
  return { refresh };
})();
