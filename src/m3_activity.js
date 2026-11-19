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

/* Floating Ball injection: define once, then push state.
 * The ball sits inside a much larger transparent window (room for its menu), so
 * the dot is attached to the ball element itself (the box around the logo img),
 * never to the window: anchored to the window it showed up far from the ball
 * and lit up whenever the cursor entered the invisible rectangle. */
const BALL_JS = `(() => {
  if (!window.__m3set) {
    const d = document.createElement('div');
    d.id = 'm3-act';
    d.style.cssText = 'position:absolute;top:0;right:0;width:10px;height:10px;border-radius:50%;' +
      'border:1px solid rgba(255,255,255,.7);display:none;z-index:99999;pointer-events:none;';
    const st = document.createElement('style');
    st.textContent = '@keyframes m3pulse{0%,100%{opacity:1}50%{opacity:.25}}';
    document.head.appendChild(st);
    let hover = false;
    const ball = () => { const img = document.querySelector('img[alt="logo"]'); return img && img.parentElement; };
    const attach = () => {
      const b = ball();
      if (!b) return null;
      if (d.parentElement !== b) {
        if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
        b.appendChild(d);
        b.addEventListener('mouseenter', () => { hover = true; paint(); });
        b.addEventListener('mouseleave', () => { hover = false; paint(); });
      }
      return b;
    };
    const paint = () => {
      const b = attach();
      if (b) b.title = window.__m3label || '';
      // busy: always visible; idle: only while the cursor is on the ball
      d.style.display = (window.__m3busy || hover) ? 'block' : 'none';
    };
    window.__m3set = (label, busy) => {
      window.__m3busy = busy;
      window.__m3label = label;
      d.style.background = busy ? '#ffb020' : '#3fbf6f';
      d.style.animation = busy ? 'm3pulse 1s infinite' : 'none';
      paint();
    };
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
