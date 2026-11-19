/* M3 music — status: device line + NPU memory split in the header, the two model nodes of
 * the chain (writer, composer: pick + live state), and the swap plan before generating. */
window.M3 = window.M3 || {};
M3.status = (function () {
  const $ = id => document.getElementById(id);
  let st = null;
  let cfg = {};
  let catalogKey = '';
  let planFor = '', planText = '';

  async function init() {
    try {
      cfg = await window.m3.invoke('m3:music:config');
      $('refs-hint').textContent = cfg.refsDir;
      $('takes-hint').textContent = cfg.outDir;
    } catch { /* hints stay empty */ }
    for (const role of ['writer', 'composer']) {
      $(`${role}-model`).addEventListener('change', async e => {
        cfg = await window.m3.invoke('m3:music:choose', { role, id: e.target.value });
        planFor = '';
        refresh();
      });
    }
    window.m3.on('m3:music:writerload', p => {
      $('writer-note').textContent = `loading ${short(p.model)}${p.progress == null ? '' : ` ${Math.round(p.progress)}%`}…`;
    });
    refresh();
  }

  async function refresh() {
    try { st = await window.m3.invoke('m3:music:status'); }
    catch { st = { ok: false }; }
    const el = $('status');
    if (!st.ok) {
      el.innerHTML = '<span class="dot down"></span><b>Device unreachable</b>';
      // a foreign holder still blocks the device: disable only, never re-enable
      // (our own in-flight job keeps the button disabled until its done/error)
      if (st.lockedBy) $('btn-gen').disabled = true;
      M3.studio && M3.studio.syncFlow();
      return;
    }
    el.innerHTML =
      `<span><span class="dot ${st.busy ? 'busy' : 'idle'}"></span><b>${esc(st.state)}</b></span>` +
      (st.generating ? '<span class="note"><b>generation running</b></span>' : '') +
      (st.lockedBy ? `<span class="note"><b>generating in another window (pid ${esc(st.lockedBy)})</b></span>` : '');
    // a foreign holder blocks the device (and our own job, while it runs):
    // keep Generate out of the hands of both until it releases
    $('btn-gen').disabled = !!(st.lockedBy || st.generating);
    renderNpu();
    renderPickers();
    renderNode('writer', writerId());
    renderNode('composer', composerId());
    renderPlan();
    M3.studio && M3.studio.syncFlow();
  }

  /* header: one segment per model on the chip, width = its share of NPU memory */
  function renderNpu() {
    const on = (st.models || []).filter(m => m.running || m.loading);
    const free = Math.max(0, 100 - on.reduce((s, m) => s + m.npu, 0)); // loading counts: it is reserving room
    $('npu-bar').innerHTML = on.map(m =>
      `<i class="seg-${m.role}${m.loading ? ' loading' : ''}" style="width:${m.npu}%" title="${esc(short(m.id))} · ${m.npu}% of NPU memory"></i>`
    ).join('');
    $('npu-legend').textContent = on.length
      ? on.map(m => `${short(m.id)} ${m.npu}%${m.loading ? ' (loading)' : ''}`).join(' · ') + ` · free ${free}%`
      : `nothing in memory · free ${free}%`;
  }

  /* fill each select once per catalog change; keep the user's choice */
  function renderPickers() {
    const ms = st.models || [];
    const key = ms.map(m => m.id).join('|');
    if (key === catalogKey) return;
    catalogKey = key;
    const opt = m => `<option value="${esc(m.id)}">${esc(short(m.id))} · ${m.npu}%</option>`;
    $('writer-model').innerHTML = '<option value="">automatic — chat model in memory</option>' +
      ms.filter(m => m.role === 'writer').map(opt).join('');
    $('composer-model').innerHTML = ms.filter(m => m.role === 'composer').map(opt).join('') ||
      '<option value="">no music model installed</option>';
    $('writer-model').value = cfg.writer || '';
    if (cfg.composer) $('composer-model').value = cfg.composer;
  }

  function writerId() {
    if ($('writer-model').value) return $('writer-model').value;
    return (st && st.writer) || ''; // st is null before the first refresh lands
  }
  function composerId() { return $('composer-model').value || ''; }

  function renderNode(role, id) {
    const m = (st.models || []).find(x => x.id === id);
    const node = $(`${role}-state`);
    let cls = 'off', txt = 'not loaded — loads when needed';
    if (!id) { txt = 'no model in memory — pick one'; cls = 'warn'; }
    else if (m && m.running) { txt = `in memory · ${m.npu}% NPU`; cls = 'ok'; }
    else if (m && m.loading) { txt = `loading${typeof m.progress === 'number' ? ` ${Math.round(m.progress)}%` : ''}…`; cls = 'busy'; }
    node.className = `mstate ${cls}`;
    node.innerHTML = `<span class="dot ${cls === 'ok' ? 'idle' : cls === 'busy' ? 'busy' : 'off'}"></span>${esc(txt)}`;
    node.closest('.model').classList.toggle('working', !!(st.generating && role === 'composer'));
  }

  /* before Generate: what loading the composer will do, asked to the device */
  async function renderPlan() {
    const id = composerId();
    const m = (st.models || []).find(x => x.id === id);
    const box = $('swap-plan');
    if (!id || !m) { box.textContent = ''; return; }
    if (m.running) { box.innerHTML = `<b>${esc(short(id))}</b> is in memory: generation starts right away.`; return; }
    const key = `${id}|${(st.models || []).filter(x => x.running).map(x => x.id).join(',')}`;
    if (key !== planFor) {
      planFor = key;
      try {
        const p = await window.m3.invoke('m3:music:plan', id);
        planText = p.evicts.length
          ? `Generate first loads <b>${esc(short(id))}</b> (${m.npu}%): the Pocket <b>unloads ${p.evicts.map(x => esc(short(x))).join(', ')}</b> to make room.`
          : `Generate first loads <b>${esc(short(id))}</b> (${m.npu}%): it fits next to what is in memory, nothing is unloaded.`;
      } catch { planText = `Generate first loads <b>${esc(short(id))}</b> (${m.npu}%).`; }
    }
    box.innerHTML = planText;
  }

  function short(id) { return (id || '').split('/').pop(); }
  function esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  M3.esc = esc; M3.short = short;

  return { init, refresh, get: () => st, writerId, composerId };
})();
