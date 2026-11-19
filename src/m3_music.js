/* M3 — Music Lab: window + IPC (thin by design; device I/O via m3_device).
 *
 * Renderer never touches the network or the file[NEUTRALIZED: system: ]every call goes through
 * these handlers. Generation is fire-and-forget with progress events:
 *   'm3:music:progress' {phase: queued|loading|generating|saving|done|error, progress 0..1, note}
 *   'm3:music:done'     {wav, mp3, seconds, elapsedSec, session}
 * The Pocket refuses loads silently when the NPU budget is full, so status
 * explicitly reports what is loaded and what AceStep would evict.
 */
'use strict';
const { BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { BASE, P8800, jget, jpost, authKey } = require('./m3_device');
const { classify } = require('./m3_activity');

const GEN_TIMEOUT_MS = 30 * 60 * 1000;
const NOT_CHAT = /music|acestep|embed|rerank|ocr|asr|tts|whisper|bge|clip/i;

/* ---------- user config: ~/.config/music-lab/config.json ----------
 * { "outDir": "…", "refsDir": "…" } — defaults below; read once per window open
 * so editing the file needs no code change (restart of the window is enough). */
const CONFIG_PATH = path.join(os.homedir(), '.config', 'music-lab', 'config.json');
function labCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* defaults */ }
  return {
    outDir: c.outDir || path.join(os.homedir(), 'Musica', 'tiiny'),
    refsDir: c.refsDir || path.join(os.homedir(), 'Musica', 'references'),
    writer: c.writer || '', composer: c.composer || '', // chosen models, '' = automatic
  };
}
function saveCfg(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* fresh */ }
  Object.assign(cur, patch);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2) + '\n');
}

let win = null;
let job = null; // { startedAt, session, phase, progress, note } — single generation at a time

function open() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 860, minHeight: 560,
    title: 'Music Lab',
    icon: path.join(__dirname, '..', 'renderer', 'music-lab.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#eef0f4', // = music.css --bg, no flash
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'm3_preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'music.html'));
  win.on('closed', () => { win = null; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ---------- model management: one model per role, loads and swaps made visible ----------
 * The NPU holds a few models at a time (npu_usage = % of the chip). Loading one may evict
 * another: the device answers that up front (unload_candidate) and we show it before acting.
 * Roles come from the store `type`, so this works on any Pocket, whatever is installed. */
const ROLE_OF = (type) => /music/i.test(type || '') ? 'composer'
  : /^(text generation|image-text-to-text)$/i.test(type || '') ? 'writer' : null;
const LOAD_TIMEOUT_MS = 15 * 60 * 1000; // as the tested callers: a cold big model can take minutes

async function catalog() {
  const s = await jget(`${BASE}/api/v1/models/?including_downloading=false`);
  return (s.data || s || []).map(m => ({
    id: m.id || m.model_id, status: m.status || '', type: m.type || '',
    npu: m.npu_usage || 0, progress: m.progress, role: ROLE_OF(m.type),
    running: /running/i.test(m.status || ''), loading: /loading/i.test(m.status || ''),
  }));
}

// model ids carry a '/', kept as a path separator (same quoting as the tested callers)
const mpath = (id) => String(id).split('/').map(encodeURIComponent).join('/');
const runningIds = async () => new Set(((await jget(`${BASE}/v1/models`)).data || []).map(x => x.id));

// what loading `id` would do: fits as is, or which running models the device unloads
async function swapPlan(id) {
  const u = await jget(`${BASE}/api/v1/models/${mpath(id)}/unload_candidate`);
  return { id, evicts: u.model_id || [], npuRequired: u.npu_required, npuAvailable: u.npu_available };
}

// load and wait until it serves requests; onTick(progress 0..100) while loading.
// Same sequence the 18/11 writer analysis and the Control Panel's ensure_loaded ran
// against the Pocket: POST …/start, poll /v1/models, progress + failure from …/get_progress.
async function ensureLoaded(id, onTick) {
  if (!id || (await runningIds()).has(id)) return;
  await jpost(`${BASE}/api/v1/models/${mpath(id)}/start`, {}, 180000);
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 1500));
    if ((await runningIds()).has(id)) return;
    const g = await jget(`${BASE}/api/v1/models/${mpath(id)}/get_progress`, 20000).catch(() => ({}));
    const st = String(g.status || '');
    if (/fail|error/i.test(st)) throw new Error(`the Pocket could not load ${short(id)}: ${st}`);
    if (onTick) onTick(typeof g.progress === 'number' && /load/i.test(st) ? g.progress : null);
    if (Date.now() - t0 > LOAD_TIMEOUT_MS) throw new Error(`${short(id)} did not load in ${LOAD_TIMEOUT_MS / 60000} min`);
  }
}

/* writer: the chosen model, else the chat model already in memory (no swap) */
async function writerModel(wanted) {
  if (wanted) return wanted;
  const m = await jget(`${BASE}/v1/models`);
  const c = (m.data || []).find(x =>
    !NOT_CHAT.test(x.id) && (x.supports_chat || /text-generation|image-text/i.test(x.type || '')));
  return c ? c.id : null;
}

const WRITER_SYSTEM = (refName) => `You write prompts for ACE-Step XL Turbo (music generation). Reply with STRICT JSON only: {"caption": "...", "lyrics": "..."}.
caption: English, up to 200 words: genre, mood, instruments (specific names), tempo/BPM, dynamics arc, production/reverb. Describe what to HEAR, no artist-name-to-copy (style references like "Lisa Gerrard style vocalise" are allowed).
lyrics: section tags [intro] [verse] [build] [chorus] [bridge] [outro] then [stop]; max 600 chars.
RULES: if the user wants no words or non-lexical vocals: every lyric line must contain ONLY vocalise syllables (aia, ooh, hmm, la la, ru na, aya) and the caption MUST state "vocals are NON-LEXICAL VOCALISE ONLY, no intelligible words in any language". Never invent real words/sentences for non-lexical vocals. If fully instrumental: lyrics = "(instrumental)".
If the user asks for crescendo/accelerando: caption must describe the entry order of instruments and a strict dynamics/tempo increase.${refName ? `\nReference track the user picked (mood/genre anchor, mention it in the caption): ${refName}` : ''}`;

/* ---------- generation ---------- */
const authHdr = (json) => ({
  ...(authKey() ? { Authorization: `Bearer ${authKey()}` } : {}),
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

async function postMusic(body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), GEN_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/v1/music/generate/wav`, {
      method: 'POST', headers: authHdr(true),
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`device ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}

async function sessionList() {
  const r = await fetch(`${BASE}/v1/music/sessions`, { headers: authHdr() });
  return (await r.json()).sessions || [];
}

async function downloadMp3(sid) {
  const r = await fetch(`${BASE}/v1/music/sessions/${sid}/download?format=mp3`, { headers: authHdr() });
  if (!r.ok) throw new Error(`mp3 download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function slug(s) {
  return (s || 'track').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'track';
}

async function runJob(cfg) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${slug(cfg.caption.slice(0, 40))}-${stamp}`;
  const seed = cfg.seed || Math.floor(Math.random() * 1e6);
  const composer = cfg.composer || 'ACE-Step/AceStep-XL-Turbo';
  job = { startedAt: Date.now(), session: null, phase: 'queued', progress: 0, note: 'submitting', seed };
  send('m3:music:progress', { ...job });

  // models to put back at the end (sent by the renderer, captured before the first take)
  const snapshot = Array.isArray(cfg.restoreIds) ? cfg.restoreIds.map(String) : [];

  try {
    const plan = await swapPlan(composer).catch(() => ({ evicts: [] }));
    job.phase = 'loading';
    job.note = plan.evicts.length ? `loading ${short(composer)} · unloads ${plan.evicts.map(short).join(', ')}`
      : `loading ${short(composer)}`;
    send('m3:music:progress', { ...job });
    await ensureLoaded(composer, p => {
      job.progress = p == null ? job.progress : p / 100;
      send('m3:music:progress', { ...job });
    });
  } catch (e) {
    job.phase = 'error'; job.note = `composer: ${e.message || e}`;
    send('m3:music:progress', { ...job });
    job = null;
    return;
  }
  job.progress = 0;

  const before = new Set((await sessionList()).map(s => s.session_id));
  job.phase = 'generating'; job.note = 'request sent (model may need to load)';
  send('m3:music:progress', { ...job });

  const poll = setInterval(async () => {
    try {
      const news = (await sessionList()).filter(s => !before.has(s.session_id));
      if (news.length) {
        const s = news[0];
        job.session = s.session_id;
        job.progress = typeof s.progress === 'number' ? s.progress : job.progress;
        job.note = `${s.route || 'generate'} · ${s.status}`;
        send('m3:music:progress', { ...job });
      }
    } catch { /* soft: progress is cosmetic */ }
  }, 2000);

  try {
    const wav = await postMusic({
      model: composer,
      config: {
        caption: cfg.caption, lyrics: cfg.lyrics || '(instrumental)',
        reference_audio_base64: cfg.refBase64 || undefined,
        seconds_total: Math.min(600, Math.max(30, cfg.seconds || 180)),
        steps: 12, seed,
        temperature: cfg.temperature ?? 0.85,
      },
    });
    clearInterval(poll);
    job.phase = 'saving'; job.progress = 1; job.note = 'writing files';
    send('m3:music:progress', { ...job });
    fs.mkdirSync(labCfg().outDir, { recursive: true });
    const wavPath = path.join(labCfg().outDir, `${name}.wav`);
    fs.writeFileSync(wavPath, wav);
    let mp3Path = null;
    if (job.session) {
      try {
        mp3Path = path.join(labCfg().outDir, `${name}.mp3`);
        fs.writeFileSync(mp3Path, await downloadMp3(job.session));
      } catch (e) { mp3Path = null; console.error('[M3] mp3 download:', e.message); }
    }
    const done = {
      wav: wavPath, mp3: mp3Path, seconds: cfg.seconds, seed, composer,
      elapsedSec: Math.round((Date.now() - job.startedAt) / 1000), session: job.session,
    };
    await restore(cfg.restore ? snapshot : []);
    job.phase = 'done';
    send('m3:music:done', done);
  } catch (e) {
    clearInterval(poll);
    job.phase = 'error'; job.note = String(e.message || e);
    send('m3:music:progress', { ...job });
    await restore(cfg.restore ? snapshot : []).catch(() => {});
  } finally {
    job = null;
  }
}

// put back the models that were in memory before the take (the composer may have evicted them)
async function restore(ids) {
  const now = new Set((await catalog().catch(() => [])).filter(m => m.running).map(m => m.id));
  for (const id of ids.filter(i => !now.has(i))) {
    job.phase = 'restoring'; job.progress = 0; job.note = `reloading ${short(id)}`;
    send('m3:music:progress', { ...job });
    try {
      await ensureLoaded(id, p => {
        job.progress = p == null ? job.progress : p / 100;
        send('m3:music:progress', { ...job });
      });
    } catch (e) { console.error('[M3] restore', id, e.message); }
  }
}

function short(id) { return String(id || '').split('/').pop(); }

/* ---------- IPC ---------- */
let ipcWired = false;
function wire() {
  if (ipcWired) return;
  ipcWired = true;

  ipcMain.handle('m3:music:status', async () => {
    const out = { ok: false, util: 0, loaded: [], writer: null, state: 'Device unreachable', busy: false, generating: !!job };
    try {
      const [npu, models, store] = await Promise.all([
        jget(`${P8800}/api/v1/npu/status`), jget(`${BASE}/v1/models`), jget(`${BASE}/api/v1/models/`),
      ]);
      const loaded = (models.data || []).map(x => x.id);
      const storeList = (store.data || []).map(m => ({ id: m.id || m.model_id, status: m.status, progress: m.progress }));
      const cl = classify({
        util: npu.util_percent || 0,
        models: storeList,
        loadedCount: loaded.length,
      });
      const loading = storeList.filter(m => /loading/i.test(m.status || '') && (m.progress ?? 0) < 100);
      const cat = await catalog();
      Object.assign(out, {
        ok: true, util: npu.util_percent || 0, loaded, loading,
        writer: await writerModel(), state: cl.label, busy: cl.busy || !!job,
        // per role: installed models with memory share; `running` = on the chip now
        models: cat.filter(m => m.role),
        npuUsed: cat.filter(m => m.running).reduce((a, m) => a + m.npu, 0),
      });
    } catch { /* defaults above */ }
    return out;
  });

  // what loading this model would unload (asked to the device, never guessed)
  ipcMain.handle('m3:music:plan', (_e, id) => swapPlan(String(id)));

  // remember the chosen model per role (config file, like the folders)
  ipcMain.handle('m3:music:choose', (_e, { role, id }) => {
    if (!['writer', 'composer'].includes(role)) throw new Error('bad role');
    saveCfg({ [role]: String(id || '') || undefined });
    return labCfg();
  });

  ipcMain.handle('m3:music:writer', async (_e, { idea, refName, model: wanted }) => {
    const model = await writerModel(wanted);
    if (!model) throw new Error('no chat model loaded — pick a writer model');
    await ensureLoaded(model, p => send('m3:music:writerload', { model, progress: p }));
    const body = {
      model, stream: false, temperature: 0.7, max_tokens: 1200,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: WRITER_SYSTEM(refName) },
        { role: 'user', content: String(idea || '').slice(0, 2000) },
      ],
    };
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', headers: authHdr(true), body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`writer ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const txt = (await r.json()).choices[0].message.content || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('writer returned no JSON');
    const j = JSON.parse(m[0]);
    return { caption: String(j.caption || ''), lyrics: String(j.lyrics || ''), writer: model };
  });

  ipcMain.handle('m3:music:refs', () => {
    const dir = labCfg().refsDir;
    try {
      return fs.readdirSync(dir)
        .filter(f => /\.(mp3|wav|flac|m4a|ogg)$/i.test(f))
        .map(f => ({ name: f, path: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }));
    } catch { return []; }
  });

  ipcMain.handle('m3:music:config', () => ({ ...labCfg(), configPath: CONFIG_PATH }));

  // pick a different output folder (persisted in the config file)
  ipcMain.handle('m3:music:setout', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose output folder', defaultPath: labCfg().outDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    saveCfg({ outDir: r.filePaths[0] });
    return labCfg();
  });

  // copy an audio file into the references folder and return it
  ipcMain.handle('m3:music:addref', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add reference track',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const st = fs.statSync(src);
    if (st.size > 64 * 1024 * 1024) throw new Error('reference too large (max 64 MB)');
    const dir = labCfg().refsDir;
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(src);
    let dest = path.join(dir, path.basename(src));
    for (let i = 1; fs.existsSync(dest); i++) {
      dest = path.join(dir, `${path.basename(src, ext)}-${i}${ext}`);
    }
    fs.copyFileSync(src, dest);
    return { name: path.basename(dest), path: dest, size: st.size };
  });

  // path guard: only files inside the configured references dir may become references
  ipcMain.handle('m3:music:refb64', (_e, p) => {
    const real = fs.realpathSync(String(p));
    if (!real.startsWith(fs.realpathSync(labCfg().refsDir) + path.sep)) {
      throw new Error('reference must live in the references folder');
    }
    return fs.readFileSync(real).toString('base64');
  });

  // waveform bytes: only files inside the take output folder, size-capped
  ipcMain.handle('m3:music:peaks', (_e, p) => {
    const real = fs.realpathSync(String(p));
    if (!real.startsWith(fs.realpathSync(labCfg().outDir) + path.sep)) {
      throw new Error('waveform only for generated takes');
    }
    if (fs.statSync(real).size > 64 * 1024 * 1024) throw new Error('file too large');
    return fs.readFileSync(real).toString('base64');
  });

  ipcMain.handle('m3:music:generate', (_e, cfg) => {
    if (job) throw new Error('a generation is already running');
    runJob(cfg); // async, reports via events
    return { started: true };
  });

  ipcMain.handle('m3:music:job', () => job ? { ...job } : null);
}

module.exports = { open, wire, attach };
wire();

// standalone/ opens its own window on top of these IPC handlers: progress
// events must reach it, so let it register as the module window.
function attach(w) {
  win = w;
  win.on('closed', () => { win = null; });
}
