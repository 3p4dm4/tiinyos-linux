/* M3 perf — model tables. Two views:
 *  - "In memory": models loaded on the NPU right now (p8800 /v1/models) — benchmarkable.
 *  - "Model store": everything on disk (/api/v1/models/), grouped by category
 *    with size subtotals. Categories come from the device `type` field. */
window.M3 = window.M3 || {};
M3.models = (function () {
  const USE_LABELS = { main: 'chat', systemone: 'decisione', embedding: 'embedding' };
  // device `type` -> display group (order = render order)
  const GROUPS = [
    ['Chat & vision', ['Image-Text-to-Text', 'Text Generation']],
    ['Decision', ['Text Classification']],
    ['Embedding', ['Text Embedding']],
    ['Speech', ['Text-to-Speech', 'ASR']],
    ['Media', ['Music Generation', 'Text-to-Video']],
  ];
  function groupOf(t) {
    for (const [label, types] of GROUPS) if (types.includes(t)) return label;
    return 'Other';
  }

  function pills(m) {
    const seen = new Set();
    (m.capabilities || []).forEach(c => { if (USE_LABELS[c]) seen.add(USE_LABELS[c]); });
    if (m.supports_vision) seen.add('visione');
    if (!seen.size) seen.add(m.type || 'n/a');
    return [...seen].map(l => `<span class="pill">${l}</span>`).join('');
  }

  async function refresh() {
    const tb = document.querySelector('#t-models tbody');
    const ts = document.querySelector('#t-store tbody');
    try {
      const [loaded, store] = await Promise.all([
        window.m3.invoke('m3:models'), window.m3.invoke('m3:store')]);
      renderLoaded(tb, loaded);
      renderStore(ts, store);
    } catch (e) {
      const msg = '<tr><td colspan="4" class="note err"></td></tr>';
      tb.innerHTML = msg; ts.innerHTML = msg;
      tb.querySelector('td').textContent = 'error: ' + (e.message || e);
      ts.querySelector('td').textContent = 'error: ' + (e.message || e);
    }
  }

  function renderLoaded(tb, ms) {
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
  }

  function renderStore(tb, store) {
    if (!store.length) { tb.innerHTML = '<tr><td colspan="4" class="note">store unreachable</td></tr>'; return; }
    const byGroup = new Map();
    for (const m of store) {
      const g = groupOf(m.type);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(m);
    }
    tb.innerHTML = '';
    const order = [...GROUPS.map(g => g[0]), 'Other'];
    let totalBytes = 0, totalCount = 0;
    for (const g of order) {
      const ms = byGroup.get(g);
      if (!ms || !ms.length) continue;
      const gBytes = ms.reduce((a, m) => a + m.size, 0);
      totalBytes += gBytes; totalCount += ms.length;
      const head = document.createElement('tr');
      head.className = 'grp';
      head.innerHTML = `<td colspan="4"></td>`;
      head.querySelector('td').textContent = `${g} — ${ms.length} model${ms.length > 1 ? 's' : ''}, ${M3.fmt.gb(gBytes)}`;
      tb.appendChild(head);
      for (const m of ms) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="mono"></td>'
          + `<td class="mono">${M3.fmt.gb(m.size)}</td>`
          + `<td class="mono">${M3.fmt.num(m.context || '')}</td>`
          + `<td><span class="pill ${m.status === 'running' ? 'run' : ''}">${m.status}</span></td>`;
        tr.querySelector('td').textContent = m.id;
        tb.appendChild(tr);
      }
    }
    const foot = document.createElement('tr');
    foot.className = 'grp';
    foot.innerHTML = `<td colspan="4"></td>`;
    foot.querySelector('td').textContent = `Total on disk — ${totalCount} models, ${M3.fmt.gb(totalBytes)}`;
    tb.appendChild(foot);
    M3.storeBytes = totalBytes; // consumed by gauges for the Disk card
  }
  return { refresh };
})();
