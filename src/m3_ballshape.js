/* M3 — Floating Ball input area on Linux (wired by tools/patch_ball_click.py).
 *
 * The ball sits in a transparent window much larger than the ball (room for its
 * menu). Upstream makes that window click-through with setIgnoreMouseEvents(true)
 * and relies on forwarded mouse moves to notice the cursor reaching the ball;
 * forwarding does not exist on Linux, and under Wayland (XWayland) a
 * click-through X window does not even learn where the cursor is (observed
 * 2026-11-19: getPointerState frozen at the last position while hovering).
 *
 * So on Linux "ignore" becomes "shape the window to the ball": setShape() clips
 * the window to the ball's box, the X server routes the pointer only there, the
 * ball gets real mouseenter/clicks, and the renderer's own logic then asks for
 * "not ignore" (menu, drag) -> full window. Verified with Electron 37.4 on X11:
 * setShape sets the bounding shape, and input is effective only inside it.
 * Outside the ball nothing is drawn while shaped — there is nothing to draw
 * there until the menu opens, and the menu opens with the full window. */

const RECT_JS = `(() => {
  const img = document.querySelector('img[alt="logo"]');
  const b = img && img.parentElement;
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height].map(Math.round);
})()`;

const seq = new WeakMap(); // latest request per window: older async answers are dropped

function full(win) {
  const [width, height] = win.getContentSize();
  win.setShape([{ x: 0, y: 0, width, height }]);
}

async function ballRect(win) {
  // the renderer may still be mounting: retry for ~5 s
  for (let i = 0; i < 25; i++) {
    try {
      const r = await win.webContents.executeJavaScript(RECT_JS, true);
      if (r && r[2] > 0 && r[3] > 0) return r;
    } catch { /* page not ready */ }
    await new Promise(res => setTimeout(res, 200));
  }
  return null;
}

/* apply(win, ignore): Linux replacement for win.setIgnoreMouseEvents(ignore). */
function apply(win, ignore) {
  if (!win || win.isDestroyed()) return;
  const n = (seq.get(win) || 0) + 1;
  seq.set(win, n);
  win.setIgnoreMouseEvents(false); // input is limited by the shape, never switched off
  if (!ignore) { full(win); return; }
  const go = async () => {
    const r = await ballRect(win);
    if (seq.get(win) !== n || win.isDestroyed()) return;
    if (r) win.setShape([{ x: r[0], y: r[1], width: r[2], height: r[3] }]);
    else full(win); // ball not found: usable ball beats a dead one
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go);
  else go();
}

module.exports = { apply };
