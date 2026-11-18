/* M3 music — status: device bar + model panel + folder paths. */
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
    if (!st.ok) { el.innerHTML = '<span class="dot down"></span><b>Device unreachable</b>'; return; }
    el.innerHTML =
      `<span><span class="dot ${st.busy ? 'busy' : 'idle'}"></span><b>${esc(st.state)}</b></span>` +
      (st.generating ? '<span class="note"><b>generation running</b></span>' : '');

    const ace = (st.loaded || []).find(id => /acestep/i.test(id));
    const rows = [
      modelRow(st.writer, 'Writer · writes caption + lyrics from your idea',
        st.writer ? 'in memory' : 'no chat model in memory — load one from the Performance window'),
      modelRow(ace, 'Composer · turns caption + lyrics into audio',
        ace ? 'in memory' : 'not loaded — the first take triggers the load (~45s)'),
    ];
    for (const l of st.loading || []) {
      rows.push(`<div class="mrow"><span class="dot busy"></span><span class="mname"><b>${esc(short(l.id))}</b> <span class="note">loading into memory</span></span>` +
        `<span class="mbar"><span class="bar"><i style="width:${Math.round(l.progress || 0)}%"></i></span>${Math.round(l.progress || 0)}%</span></div>`);
    }
    $('models').innerHTML = rows.join('');
  }

  function modelRow(name, role, note) {
    return `<div class="mrow"><span class="dot ${name ? 'idle' : 'off'}"></span>` +
      `<span class="mname">${name ? `<b>${esc(short(name))}</b>` : '<b>—</b>'} <span class="note">${esc(role)}</span></span>` +
      `<span class="note">${esc(note)}</span></div>`;
  }

  function short(id) { return (id || '').split('/').pop(); }
  function esc(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
  M3.esc = esc; M3.short = short;

  return { init, refresh, get: () => st };
})();
