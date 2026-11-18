/* M3 music — status: device line in the header, per-step model chips. */
window.M3 = window.M3 || {};
M3.status = (function () {
  const $ = id => document.getElementById(id);
  let st = null;

  async function init() {
    try {
      const c = await window.m3.invoke('m3:music:config');
      $('refs-hint').textContent = c.refsDir;
      $('takes-hint').textContent = c.outDir;
    } catch { /* hints stay empty */ }
    refresh();
  }

  async function refresh() {
    try { st = await window.m3.invoke('m3:music:status'); }
    catch { st = { ok: false, state: 'Device unreachable', loaded: [], loading: [] }; }
    const el = $('status');
    if (!st.ok) {
      el.innerHTML = '<span class="dot down"></span><b>Device unreachable</b>';
      M3.studio && M3.studio.syncFlow();
      return;
    }
    el.innerHTML =
      `<span><span class="dot ${st.busy ? 'busy' : 'idle'}"></span><b>${esc(st.state)}</b></span>` +
      (st.generating ? '<span class="note"><b>generation running</b></span>' : '');

    const ace = (st.loaded || []).find(id => /acestep/i.test(id));
    const aceLoading = (st.loading || []).find(l => /acestep/i.test(l.id));

    // step ① chip: the writer needs a chat model already in memory
    const wc = $('writer-chip');
    if (st.writer) { wc.textContent = `writer: ${short(st.writer)}`; wc.className = 'chip ok'; }
    else { wc.textContent = 'no chat model in memory'; wc.className = 'chip warn'; }

    // step ③ chip: the composer (ACE-Step) loads on demand at first generate
    const cc = $('composer-chip');
    if (ace) { cc.textContent = `composer: ${short(ace)} · in memory`; cc.className = 'chip ok'; }
    else if (aceLoading) { cc.textContent = `composer loading ${Math.round(aceLoading.progress || 0)}%`; cc.className = 'chip load'; }
    else { cc.textContent = 'composer not loaded — first take loads it (~45s)'; cc.className = 'chip warn'; }

    // header: the writer/composer are named in their steps; here only other models loading
    const other = (st.loading || []).filter(l => !/acestep/i.test(l.id));
    if (other.length) {
      el.insertAdjacentHTML('beforeend', other.map(l =>
        `<span class="note">loading ${esc(short(l.id))} ${Math.round(l.progress || 0)}%</span>`).join(''));
    }

    M3.studio && M3.studio.syncFlow();
  }

  function short(id) { return (id || '').split('/').pop(); }
  function esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  M3.esc = esc; M3.short = short;

  return { init, refresh, get: () => st };
})();
