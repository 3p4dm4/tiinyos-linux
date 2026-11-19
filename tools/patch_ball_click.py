#!/usr/bin/env python3
"""Make the Floating Ball clickable on Linux — only the ball, not its window.

Root cause (observed 2026-11-17): the ball window starts with
`setIgnoreMouseEvents(true,{forward:true})` and the renderer toggles that via
IPC. `forward` is macOS/Windows-only: on Linux the whole window stayed
click-through and the ball never got a click.

First fix (2026-11-17, retired): keep the whole window interactive on Linux.
The ball worked, but its transparent 462x300 window swallowed every click
meant for what is underneath (reported 2026-11-19). Enabling the renderer's
pointer-polling fallback does not help under Wayland: a click-through XWayland
window does not learn the cursor position (observed: frozen while hovering).

This fix: on Linux both calls go to src/m3_ballshape.js, which turns "ignore"
into "window shaped to the ball" and "not ignore" into "full window". Checked
live (2026-11-19) by emulating it on the running app: clicks next to the ball
reach the window below, hover and the ball menu work.

Idempotent; fails loudly if an anchor is not unique (bundle drifted upstream).
"""
import sys

F = sys.argv[1] if len(sys.argv) > 1 else "out/main/index.js"
SHAPE = 'require("./m3_ballshape").apply'
PAIRS = [
    # initial state of the ball window
    ('t.setIgnoreMouseEvents(!0,{forward:!0})',
     f'("linux"===process.platform?{SHAPE}(t,!0):t.setIgnoreMouseEvents(!0,{{forward:!0}}))'),
    # renderer IPC passthrough
    ('n.setIgnoreMouseEvents(r,{forward:i?.forward})',
     f'("linux"===process.platform?{SHAPE}(n,r):n.setIgnoreMouseEvents(r,{{forward:i?.forward}}))'),
]

s = open(F).read()
if all(new in s for _, new in PAIRS):
    print("patch_ball_click: already patched")
else:
    for old, new in PAIRS:
        n = s.count(old)
        if n != 1:
            sys.exit(f"patch_ball_click: anchor {n} occurrences (expected 1) for: {old[:50]}… — bundle drifted, review manually")
    for old, new in PAIRS:
        s = s.replace(old, new)
    open(F, "w").write(s)
    print("patch_ball_click: applied (ball window shaped to the ball on linux)")
