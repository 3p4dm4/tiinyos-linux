/* Hello Pocket — renderer. Talks to main only through window.m3.invoke
 * (src/m3_preload.js lets m3:* channels through, nothing else). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const hhmmss = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
  const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-GB') : '—');
  // Model ids and names are device data: escape before any innerHTML.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function refresh() {
    if (!window.m3) { fail('no preload bridge (window.m3 missing)'); return; }
    try {
      const s = await window.m3.invoke('m3:hello:summary');
      $('base').textContent = s.base;
      $('read').textContent = 'last read ' + hhmmss(s.readAt);
      $('mem').innerHTML = s.inMemory.length
        ? s.inMemory.map((m) => `<tr><td>${esc(m.name)}</td><td class="mono">${esc(m.id)}</td></tr>`).join('')
        : '<tr><td colspan="2" class="muted">No model in memory.</td></tr>';
    } catch (e) {
      fail(e.message);
    }
  }

  function fail(message) {
    $('mem').innerHTML = `<tr><td colspan="2" class="err">✕ ${esc(message)}</td></tr>`;
    $('read').textContent = 'not readable';
  }

  $('npu-btn').addEventListener('click', async () => {
    const b = $('npu-btn');
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    try {
      const n = await window.m3.invoke('m3:hello:npu');
      $('npu').textContent = `Utilization ${num(Math.round(n.util))} % · memory ${num(n.memUsedMb)} of ${num(n.memTotalMb)} MB · read ${hhmmss(n.readAt)}`;
    } catch (e) {
      $('npu').textContent = '✕ ' + e.message;
    } finally {
      b.disabled = false;
      b.removeAttribute('aria-busy');
    }
  });

  refresh();
  setInterval(refresh, 5000);
})();
