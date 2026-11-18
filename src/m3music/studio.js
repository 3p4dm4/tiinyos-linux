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
    if (!caption) { $('pnote').textContent = 'caption is empty (use ✨ or write one)'; return; }
    const refPath = $('refs').value;
    let refBase64 = '';
    if (refPath) {
      $('pnote').textContent = 'reading reference…';
      refBase64 = await window.m3.invoke('m3:music:refb64', refPath);
    }
    const cfg = { caption, lyrics: $('lyrics').value.trim(), seconds: +$('seconds').value || 180, refBase64 };
    pending = Math.max(1, +$('takes').value || 1) - 1;
    runTake(cfg);
  }

  let pending = 0;
  let cfg = null;
  function runTake(c) {
    cfg = c;
    $('progress').classList.remove('hidden');
    $('btn-gen').disabled = true;
    window.m3.invoke('m3:music:generate', c)
      .catch(e => showProgress({ phase: 'error', note: e.message }));
  }

  function showProgress(p) {
    $('pbar').style.width = Math.round((p.progress || 0) * 100) + '%';
    $('pnote').textContent = `${p.phase}${p.note ? ' — ' + p.note : ''}`;
    if (p.phase === 'error') { $('btn-gen').disabled = false; }
  }

  function addTake(t) {
    takeNo += 1;
    const div = document.createElement('div');
    div.className = 'take';
    const src = (t.mp3 || t.wav).replace(/\\/g, '/');
    div.innerHTML = `<audio controls preload="none" src="file://${encodeURI(src)}"></audio>` +
      `<div class="meta">#${takeNo} · ${t.seconds}s · ${t.elapsedSec}s gen · ${esc(t.mp3 || t.wav)}</div>`;
    const list = $('takes-list');
    if (list.classList.contains('note')) { list.textContent = ''; list.classList.remove('note'); }
    list.prepend(div);
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
    window.m3.on('m3:music:progress', showProgress);
    window.m3.on('m3:music:done', t => {
      addTake(t);
      if (pending > 0) { pending -= 1; runTake(cfg); }
      else { $('btn-gen').disabled = false; M3.status.refresh(); }
    });
    loadRefs();
  }

  return { init };
})();
