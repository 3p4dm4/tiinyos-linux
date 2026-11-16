/* M3 perf — model table: one row per loaded model, usage pills from capabilities. */
window.M3 = window.M3 || {};
M3.models = (function () {
  const USE_LABELS = { main: 'chat', systemone: 'decisione', embedding: 'embedding' };

  function pills(m) {
    const seen = new Set();
    (m.capabilities || []).forEach(c => { if (USE_LABELS[c]) seen.add(USE_LABELS[c]); });
    if (m.supports_vision) seen.add('visione');
    if (!seen.size) seen.add(m.type || 'n/a');
    return [...seen].map(l => `<span class="pill">${l}</span>`).join('');
  }

  async function refresh() {
    const tb = document.querySelector('#t-models tbody');
    try {
      const ms = await window.m3.invoke('m3:models');
      if (!ms.length) { tb.innerHTML = '<tr><td colspan="4" class="note">no models loaded</td></tr>'; return; }
      tb.innerHTML = '';
      for (const m of ms) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="mono"></td><td class="mono">' + M3.fmt.num(m.context) + '</td>'
          + '<td>' + pills(m) + '</td><td class="right"></td>';
        tr.querySelector('td').textContent = m.id;
        const btn = document.createElement('button');
        btn.textContent = 'Benchmark';
        btn.onclick = () => M3.bench.run(m.id, btn);
        tr.querySelector('td:last-child').appendChild(btn);
        tb.appendChild(tr);
      }
    } catch (e) {
      tb.innerHTML = '<tr><td colspan="4" class="note err"></td></tr>';
      tb.querySelector('td').textContent = 'error: ' + (e.message || e);
    }
  }
  return { refresh };
})();
