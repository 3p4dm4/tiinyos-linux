/* M3 music — status bar: device state, writer model, AceStep presence. */
window.M3 = window.M3 || {};
M3.status = (function () {
  const $ = id => document.getElementById(id);
  let st = null;

  async function refresh() {
    try { st = await window.m3.invoke('m3:music:status'); }
    catch { st = { ok: false, state: 'Device unreachable' }; }
    const el = $('status');
    if (!st.ok) { el.innerHTML = '<span class="dot down"></span><b>Device unreachable</b>'; return; }
    const ace = st.loaded.some(id => /acestep/i.test(id));
    const busyCls = st.busy ? 'busy' : 'idle';
    el.innerHTML =
      `<span><span class="dot ${busyCls}"></span><b>${esc(st.state)}</b></span>` +
      `<span class="note">writer: <b>${st.writer ? esc(short(st.writer)) : '— load a chat model (Performance window)'}</b></span>` +
      `<span class="note">ACE-Step: <b>${ace ? 'in memory' : 'not loaded — first take pays the load (~45s)'}</b></span>` +
      (st.generating ? '<span class="note"><b>generation running</b></span>' : '');
  }

  function short(id) { return (id || '').split('/').pop(); }
  function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  M3.esc = esc; M3.short = short;

  return { refresh, get: () => st };
})();
