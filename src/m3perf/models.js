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
    const ts = document.getElementById('t-store');
    try {
      const [loaded, store] = await Promise.all([
        window.m3.invoke('m3:models'), window.m3.invoke('m3:store')]);
      renderLoaded(tb, loaded);
      renderStore(ts, store);
    } catch (e) {
      tb.innerHTML = '<tr><td colspan="4" class="note err"></td></tr>';
      tb.querySelector('td').textContent = 'error: ' + (e.message || e);
      ts.innerHTML = '<div class="note err"></div>';
      ts.querySelector('.note').textContent = 'error: ' + (e.message || e);
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

  function renderStore(el, store) {
    if (!store.length) { el.innerHTML = '<div class="note">store unreachable</div>'; return; }
    const byGroup = new Map();
    for (const m of store) {
      const g = groupOf(m.type);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(m);
    }
    el.innerHTML = '';
    const order = [...GROUPS.map(g => g[0]), 'Other'];
    let totalBytes = 0, totalCount = 0;
    for (const g of order) {
      const ms = byGroup.get(g);
      if (!ms || !ms.length) continue;
      const gBytes = ms.reduce((a, m) => a + m.size, 0);
      totalBytes += gBytes; totalCount += ms.length;
      const card = document.createElement('div');
      card.className = 'cat';
      const h = document.createElement('h3'); h.textContent = g;
      const sum = document.createElement('div'); sum.className = 'cat-sum';
      sum.textContent = `${ms.length} model${ms.length > 1 ? 's' : ''} · ${M3.fmt.gb(gBytes)}`;      card.append(h, sum);
      for (const m of ms) {
        const row = document.createElement('div'); row.className = 'cat-row';
        const nm = document.createElement('span'); nm.className = 'mono ell';
        nm.textContent = m.name || m.id; nm.title = m.id;
        const sz = document.createElement('span'); sz.className = 'mono';
        sz.textContent = M3.fmt.gb(m.size);
        row.append(nm, sz);
        if (m.status === 'running') {
          const p = document.createElement('span'); p.className = 'pill run';
          p.textContent = 'running'; row.appendChild(p);
        }
        card.appendChild(row);
      }
      el.appendChild(card);
    }
    document.getElementById('store-total').textContent =
      `Total on disk — ${totalCount} models, ${M3.fmt.gb(totalBytes)}`;
    M3.storeBytes = totalBytes; // consumed by gauges for the Disk card
  }
  return { refresh };
})();
