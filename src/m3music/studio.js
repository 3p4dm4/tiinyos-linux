/* M3 music — studio: writer ✨, form, generation queue, takes player. */
window.M3 = window.M3 || {};
M3.studio = (function () {
  const $ = id => document.getElementById(id);
  const esc = M3.esc;
  let takeNo = 0;

  async function write() {
    const idea = $('idea').value.trim();
    if (!idea) return;
    const ref = $('refs').selectedOptions[0];
    $('btn-write').disabled = true;
    $('writer-note').textContent = 'writing…';
    try {
      const r = await window.m3.invoke('m3:music:writer', { idea, refName: ref ? ref.value : '' });
      $('caption').value = r.caption;
      $('lyrics').value = r.lyrics;
      $('writer-note').textContent = `ok — ${M3.short(r.writer)}`;
    } catch (e) {
      $('writer-note').textContent = `error: ${e.message}`;
    } finally { $('btn-write').disabled = false; }
  }

  async function generate() {
    const caption = $('caption').value.trim();
    if (!caption) { setNote('caption is empty — write one, or press Write prompt'); return; }
    const refPath = $('refs').value;
    let refBase64 = '';
    if (refPath) {
      setNote('reading reference…');
      refBase64 = await window.m3.invoke('m3:music:refb64', refPath);
    }
    const c = { caption, lyrics: $('lyrics').value.trim(), seconds: +$('seconds').value || 180, refBase64 };
    cfg = c;
    takeTotal = Math.max(1, +$('takes').value || 1);
    takeIdx = 0;
    runTake();
  }

  let cfg = null, pending = 0;
  let takeIdx = 0, takeTotal = 1, genStart = 0, lastP = null, tick = null;

  function runTake() {
    takeIdx += 1;
    genStart = Date.now();
    $('progress').classList.remove('hidden');
    $('btn-gen').disabled = true;
    if (!tick) tick = setInterval(() => renderProgress(lastP || {}), 1000);
    window.m3.invoke('m3:music:generate', cfg)
      .catch(e => showProgress({ phase: 'error', note: e.message }));
  }

  function mmss(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderProgress(p) {
    $('pbar').style.width = Math.round((p.progress || 0) * 100) + '%';
    const bits = [`Take ${takeIdx}/${takeTotal}`];
    if (p.phase) bits.push(p.phase);
    if (p.note) bits.push(p.note);
    bits.push(`elapsed ${mmss(Date.now() - genStart)}`);
    if (p.seed) bits.push(`seed ${p.seed}`);
    $('pnote').textContent = bits.join(' · ');
  }

  function showProgress(p) {
    lastP = p;
    renderProgress(p);
    if (p.phase === 'error') { clearInterval(tick); tick = null; $('btn-gen').disabled = false; }
  }

  function setNote(msg) { $('progress').classList.remove('hidden'); $('pnote').textContent = msg; }

  function addTake(t) {
    takeNo += 1;
    const div = document.createElement('div');
    div.className = 'take';
    const src = (t.mp3 || t.wav).replace(/\\/g, '/');
    div.innerHTML = `<audio controls preload="none" src="file://${encodeURI(src)}"></audio>` +
      `<div class="meta">#${takeNo} · ${t.seconds}s audio · ${t.elapsedSec}s gen · seed ${t.seed} · ${esc(t.mp3 || t.wav)}</div>`;
    const list = $('takes-list');
    if (list.classList.contains('empty')) { list.textContent = ''; list.classList.remove('empty'); }
    list.prepend(div);
  }

  async function changeOut() {
    const c = await window.m3.invoke('m3:music:setout');
    if (c) $('takes-hint').textContent = c.outDir;
  }

  async function addRef() {
    try {
      const r = await window.m3.invoke('m3:music:addref');
      if (!r) return;
      await loadRefs();
      $('refs').value = r.path;
    } catch (e) { setNote(`reference: ${e.message}`); }
  }

  async function loadRefs() {
    const refs = await window.m3.invoke('m3:music:refs');
    const sel = $('refs');
    sel.innerHTML = '<option value="">— none —</option>';
    for (const r of refs) {
      const o = document.createElement('option');
      o.value = r.path; o.textContent = r.name;
      sel.appendChild(o);
    }
  }

  function init() {
    $('btn-write').addEventListener('click', write);
    $('btn-gen').addEventListener('click', generate);
    $('btn-out').addEventListener('click', () => changeOut().catch(e => setNote(`output: ${e.message}`)));
    $('btn-addref').addEventListener('click', () => addRef().catch(e => setNote(`reference: ${e.message}`)));
    window.m3.on('m3:music:progress', showProgress);
    window.m3.on('m3:music:done', t => {
      addTake(t);
      if (takeIdx < takeTotal) runTake();
      else {
        clearInterval(tick); tick = null;
        $('btn-gen').disabled = false;
        setNote(`${takeTotal} take(s) done in ${mmss(Date.now() - genStart)} — saved in ${'\u00A0'}${$('takes-hint').textContent}`);
        M3.status.refresh();
      }
    });
    loadRefs();
  }

  return { init };
})();
