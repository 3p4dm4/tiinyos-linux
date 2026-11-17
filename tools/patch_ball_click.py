#!/usr/bin/env python3
"""Make the Floating Ball receive real mouse events on Linux.

Root cause (observed 2026-11-17): the ball window starts with
`setIgnoreMouseEvents(true,{forward:true})` and the renderer toggles that via
IPC. The `forward` option is documented as macOS/Windows-only — on Linux the
whole ball window is click-through, so left/right clicks never reach it and
"nothing happens" (the renderer's hover logic can't self-heal either, since
without forwarding it receives no mouse events to react to).

Fix: on Linux, keep the ball window interactive (initial state and IPC
passthrough). Trade-off, documented: the transparent ball window keeps its
rectangular input area — clicks inside that rectangle are consumed by the ball
window instead of whatever is underneath. There is no per-pixel input shape
available through Electron on X11.

Idempotent; fails loudly if an anchor is not unique (bundle drifted upstream).
"""
import sys

F = sys.argv[1] if len(sys.argv) > 1 else "out/main/index.js"
PAIRS = [
    # initial state: interactive on linux, click-through elsewhere (upstream behavior)
    ('t.setIgnoreMouseEvents(!0,{forward:!0})',
     't.setIgnoreMouseEvents("linux"!==process.platform,{forward:!0})'),
    # renderer IPC passthrough: force interactive on linux
    ('n.setIgnoreMouseEvents(r,{forward:i?.forward})',
     'n.setIgnoreMouseEvents("linux"===process.platform?!1:r,{forward:i?.forward})'),
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
    print("patch_ball_click: applied (ball interactive on linux)")
