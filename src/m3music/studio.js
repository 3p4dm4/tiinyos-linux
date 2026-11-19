/* M3 music — studio: workflow stepper, writer ✨, generation with phases, takes + waveforms. */
window.M3 = window.M3 || {};
M3.studio = (function () {
  const $ = id => document.getElementById(id);
  const esc = M3.esc;
  let takeNo = 0;

  /* ---------- workflow stepper ---------- */
  // Soft workflow: nothing is locked, the stepper just shows where you are.
  function syncFlow() {
    const idea = $('idea').value.trim();
    const caption = $('caption').value.trim();
    const generating = !!tick;
    const states = [
      idea ? 'done' : 'active',
      caption ? 'done' : (idea ? 'active' : ''),
      generating ? 'active' : (caption ? 'active' : ''),
      takeNo ? 'done' : '',
    ];
    if (takeNo && !generating && caption) states[2] = 'done';
    document.querySelectorAll('#flow li[data-s]').forEach((li, i) => {
      li.className = states[i] || '';
    });
    // the numbered badge on each card mirrors the stepper (same number, same state)
    document.querySelectorAll('.step-n').forEach((n, i) => {
      n.className = 'step-n ' + (states[i] || '');
    });
    // step ② chip: prompt readiness
    const pc = $('prompt-chip');
    if (caption) { pc.textContent = 'prompt ready'; pc.className = 'chip ok'; }
    else if (idea) { pc.textContent = 'waiting for step 1'; pc.className = 'chip'; }
    else { pc.textContent = 'waiting for step 1'; pc.className = 'chip'; }
  }
  M3.syncFlow = syncFlow;

  function wireFlowClicks() {
    const targets = { 1: 'idea', 2: 'caption', 3: 'btn-gen', 4: 'takes-list' };
    document.querySelectorAll('#flow li[data-s]').forEach(li => {
      li.addEventListener('click', () => {
        const el = $(targets[li.dataset.s]);
        if (el) { el.scrollIntoView({ block: 'center' }); if (el.focus) el.focus(); }
      });
    });
  }

  /* ---------- step 1: writer ---------- */
  async function write() {
    const idea = $('idea').value.trim();
    if (!idea) return;
    const ref = $('refs').selectedOptions[0];
    $('btn-write').disabled = true;
    $('writer-note').textContent = 'writing…';
    try {
      const r = await window.m3.invoke('m3:music:writer', { idea, refName: ref ? ref.value : '', model: $('writer-model').value });
      $('caption').value = r.caption;
      $('lyrics').value = r.lyrics;
      $('writer-note').textContent = `ok — ${M3.short(r.writer)}`;
    } catch (e) {
      $('writer-note').textContent = `error: ${e.message}`;
    } finally { $('btn-write').disabled = false; syncFlow(); }
  }

  /* ---------- step 3: generation ---------- */
  let cfg = null;
  let takeIdx = 0, takeTotal = 1, genStart = 0, lastP = null, tick = null;

  const PHASE_ORDER = ['queued', 'loading', 'generating', 'saving', 'restoring', 'done'];
  function renderPhases(p) {
    const idx = PHASE_ORDER.indexOf(p.phase);
    document.querySelectorAll('#phases li').forEach(li => {
      const i = PHASE_ORDER.indexOf(li.dataset.p);
      li.className = i === idx ? 'on' : (i < idx ? 'past' : '');
    });
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
    cfg = {
      caption, lyrics: $('lyrics').value.trim(), seconds: +$('seconds').value || 180, refBase64,
      // the sidecar records how this take was made: which writer wrote the
      // prompt and which reference anchored it (name only, never a path)
      composer: M3.status.composerId(), writer: M3.status.writerId(),
      refName: refPath ? refPath.split(/[\\/]/).pop() : '', restore: false,
      // models in memory now: reloaded after the LAST take only (no swap back-and-forth between takes)
      restoreIds: $('restore').checked
        ? ((M3.status.get() || {}).models || []).filter(m => m.running).map(m => m.id) : [],
    };
    takeTotal = Math.max(1, +$('takes').value || 1);
    takeIdx = 0;
    runTake();
  }

  function runTake() {
    takeIdx += 1;
    cfg.restore = cfg.restoreIds.length > 0 && takeIdx === takeTotal;
    genStart = Date.now();
    $('progress').classList.remove('hidden');
    $('btn-gen').disabled = true;
    if (!tick) tick = setInterval(() => renderProgress(lastP || {}), 1000);
    window.m3.invoke('m3:music:generate', cfg)
      .catch(e => showProgress({ phase: 'error', note: e.message }));
    syncFlow();
  }

  function mmss(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderProgress(p) {
    $('pbar').style.width = Math.round((p.progress || 0) * 100) + '%';
    const bits = [`Take ${takeIdx}/${takeTotal}`];
    if (p.note) bits.push(p.note);
    bits.push(`elapsed ${mmss(Date.now() - genStart)}`);
    if (p.seed) bits.push(`seed ${p.seed}`);
    $('pnote').textContent = bits.join(' · ');
    renderPhases(p.phase ? p : { phase: 'queued' });
  }

  function showProgress(p) {
    lastP = p;
    renderProgress(p);
    if (p.phase === 'error') { clearInterval(tick); tick = null; $('btn-gen').disabled = false; syncFlow(); }
  }

  function setNote(msg) { $('progress').classList.remove('hidden'); $('pnote').textContent = msg; }

  /* ---------- step 4: takes + waveform ---------- */
  // A take row comes from two sources: the `done` payload (just generated,
  // richer fields) or a stored sidecar meta (rebuild after a restart, or a
  // take made in another window). Same file = one row: the newer row wins.
  function addTake(t, stored) {
    const src = (t.mp3 || t.wav).replace(/\\/g, '/');
    if (src) for (const d of [...document.querySelectorAll('#takes-list .take')])
      if (d.dataset.src === src) d.remove();
    takeNo += 1;
    const div = document.createElement('div');
    div.className = 'take';
    div.dataset.src = src;
    const m = stored || null;
    const bits = [];
    if (m && m.caption) bits.push(`“${esc(m.caption.slice(0, 80))}${m.caption.length > 80 ? '…' : ''}”`);
    if (t.seconds != null) bits.push(`${t.seconds}s`);
    const elapsed = m && m.elapsedSec != null ? m.elapsedSec : t.elapsedSec;
    if (elapsed != null) bits.push(`${elapsed}s gen`);
    if (t.seed != null) bits.push(`seed ${t.seed}`);
    const composer = m ? m.composer : t.composer;
    if (composer) bits.push(M3.short(composer));
    const writer = m ? m.writer : t.writer;
    if (writer) bits.push(M3.short(writer));
    const ref = m ? m.reference : t.refName;
    if (ref) bits.push(`ref ${esc(ref)}`);
    if (m && m.createdAt) {
      const d = new Date(m.createdAt);
      if (!isNaN(d)) bits.push(d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }));
    }
    bits.push(esc(src.split('/').pop()));
    div.innerHTML = `<canvas class="wave" height="44"></canvas>` +
      `<audio controls preload="none" src="file://${encodeURI(src)}"></audio>` +
      `<div class="meta">#${takeNo} · ${bits.join(' · ')}</div>`;
    const list = $('takes-list');
    if (list.classList.contains('empty')) { list.textContent = ''; list.classList.remove('empty'); }
    list.prepend(div);
    drawWave(div.querySelector('.wave'), div.querySelector('audio'), src);
    syncFlow();
  }

  const audioCtx = () => (audioCtx.ctx ||= new AudioContext());
  async function drawWave(canvas, audio, file) {
    try {
      const b64 = await window.m3.invoke('m3:music:peaks', file);
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const buf = await audioCtx().decodeAudioData(bytes.buffer);
      const N = 140, ch = buf.getChannelData(0), step = Math.floor(ch.length / N) || 1;
      const peaks = [];
      for (let i = 0; i < N; i++) {
        let mx = 0;
        for (let j = 0; j < step; j += 16) { const v = Math.abs(ch[i * step + j] || 0); if (v > mx) mx = v; }
        peaks.push(mx);
      }
      wave.peaks.set(canvas, peaks);
      paintWave(canvas, 0);
      canvas.onclick = e => {
        const r = canvas.getBoundingClientRect();
        audio.currentTime = ((e.clientX - r.left) / r.width) * buf.duration;
      };
      audio.addEventListener('timeupdate', () => {
        if (audio.duration) paintWave(canvas, audio.currentTime / audio.duration);
      });
    } catch { /* soft: the audio element still works without the wave */ }
  }
  const wave = { peaks: new Map() };

  function paintWave(canvas, ratio) {
    const peaks = wave.peaks.get(canvas); if (!peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr, h = 44 * dpr;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    const cs = getComputedStyle(document.documentElement);
    const dim = cs.getPropertyValue('--line').trim() || '#333';
    const hot = cs.getPropertyValue('--accent').trim() || '#fe8019';
    g.clearRect(0, 0, canvas.width, canvas.height);
    const bw = canvas.width / peaks.length;
    peaks.forEach((p, i) => {
      const bh = Math.max(2, p * canvas.height * 0.9);
      g.fillStyle = (i / peaks.length) <= ratio ? hot : dim;
      g.fillRect(i * bw + bw * 0.15, (canvas.height - bh) / 2, bw * 0.7, bh);
    });
  }

  /* ---------- folders / references ---------- */
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

  // rebuild the list from the output folder (newest first): takes survive
  // restarts and show up here even when they were made in another window
  async function loadTakes() {
    let takes = [];
    try { takes = await window.m3.invoke('m3:music:takes'); }
    catch { $('takes-list').classList.add('empty'); return; }
    // server returns newest first; addTake prepends, so walk oldest first and
    // the newest lands on top (new generations prepend above it later)
    for (let i = takes.length - 1; i >= 0; i--) addTake(takes[i], takes[i].meta);
    if (!takes.length) $('takes-list').classList.add('empty');
  }

  function init() {
    $('btn-write').addEventListener('click', write);
    $('btn-gen').addEventListener('click', generate);
    $('btn-out').addEventListener('click', () => changeOut().catch(e => setNote(`output: ${e.message}`)));
    $('btn-addref').addEventListener('click', () => addRef().catch(e => setNote(`reference: ${e.message}`)));
    $('idea').addEventListener('input', syncFlow);
    $('caption').addEventListener('input', syncFlow);
    wireFlowClicks();
    window.m3.on('m3:music:progress', showProgress);
    window.m3.on('m3:music:done', t => {
      addTake(t);
      if (takeIdx < takeTotal) runTake();
      else {
        clearInterval(tick); tick = null;
        $('btn-gen').disabled = false;
        setNote(`${takeTotal} take(s) done in ${mmss(Date.now() - genStart)} — saved in ${'\u00A0'}${$('takes-hint').textContent}`);
        M3.status.refresh();
        syncFlow();
      }
    });
    loadRefs();
    loadTakes();
    syncFlow();
  }

  return { init, syncFlow, addTake, loadTakes };
})();
