/* M3 — device activity indicator.
 * Polls the Pocket and surfaces "is it working?" where the vendor is silent:
 * tray tooltip + Floating Ball badge (pulsing dot when busy, hover = status).
 * Signals (all observed on a live device):
 *   p8800 /api/v1/npu/status  -> devices[0].util_percent (inference/load %)
 *   store  /api/v1/models/    -> per-model status + progress (loading/downloading)
 *   p8800 /v1/models          -> models currently in memory
 * Pure classification in classify() (testable without Electron). */
const { BASE, P8800, jget } = require('./m3_device');

const BUSY_UTIL = 25; // % NPU utilization that counts as "working"

function shortName(id) { return String(id || '?').split('/').pop(); }

/* classify({util, models, loadedCount}) -> {label, busy} — pure. */
function classify({ util, models, loadedCount }) {
  const dl = (models || []).find(m => /downloading/i.test(m.status || ''));
  if (dl) return { label: `Downloading ${shortName(dl.id)} · ${Math.round(dl.progress ?? 0)}%`, busy: true };
  const loading = (models || []).find(m => /loading/i.test(m.status || '') && (m.progress ?? 0) < 100);
  if (loading) return { label: `Loading ${shortName(loading.id)} · ${Math.round(loading.progress)}%`, busy: true };
  if (typeof util === 'number' && util >= BUSY_UTIL)
    return { label: `Working · NPU ${Math.round(util)}%`, busy: true };
  if (typeof util === 'number')
    return { label: `Idle · ${loadedCount ?? '?'} model(s) in memory`, busy: false };
  return { label: 'Device unreachable', busy: false };
}

/* Floating Ball injection: define once, then push state. */
const BALL_JS = `(() => {
  if (!window.__m3set) {
    const d = document.createElement('div');
    d.id = 'm3-act';
    d.style.cssText = 'position:fixed;top:2px;right:2px;width:10px;height:10px;border-radius:50%;' +
      'border:1px solid rgba(255,255,255,.7);display:none;z-index:99999;pointer-events:auto;';
    const st = document.createElement('style');
    st.textContent = '@keyframes m3pulse{0%,100%{opacity:1}50%{opacity:.25}}';
    document.head.appendChild(st);
    const put = (label, busy) => {
      window.__m3busy = busy;
      d.title = label;
      d.style.background = busy ? '#ffb020' : '#3fbf6f';
      d.style.animation = busy ? 'm3pulse 1s infinite' : 'none';
      // busy: always visible; idle: only on hover
      d.style.display = busy ? 'block' : 'none';
    };
    window.__m3set = put;
    document.body.appendChild(d);
    const show = () => { d.style.display = 'block'; };
    const hide = () => { if (!window.__m3busy) d.style.display = 'none'; };
    document.addEventListener('mouseenter', show, true);
    document.addEventListener('mouseleave', hide, true);
    d.addEventListener('mouseenter', show);
    d.addEventListener('mouseleave', hide);
  }
})()`;

let started = false;
let lastLabel = null;

async function tick(tray) {
  let state;
  try {
    const [npu, store, loaded] = await Promise.all([
      jget(`${P8800}/api/v1/npu/status`),
      jget(`${BASE}/api/v1/models/`),
      jget(`${P8800}/v1/models`),
    ]);
    const util = npu?.devices?.[0]?.util_percent;
    state = classify({ util, models: store?.data, loadedCount: (loaded?.data || []).length });
  } catch (e) {
    state = { label: 'Device unreachable', busy: false };
  }
  if (state.label === lastLabel) return;
  lastLabel = state.label;
  try { tray.setToolTip(`TiinyOS — ${state.label}`); } catch (e) {}
  try {
    const ball = globalThis.__m3Ball;
    if (ball && !ball.isDestroyed()) {
      await ball.webContents.executeJavaScript(BALL_JS);
      await ball.webContents.executeJavaScript(
        `window.__m3set(${JSON.stringify(state.label)}, ${state.busy})`);
    }
  } catch (e) {}
}

function start(tray) {
  if (started) return;
  started = true;
  tick(tray);
  setInterval(() => tick(tray), 5000);
  console.log('[M3] activity indicator started');
}

module.exports = { start, classify, shortName };
