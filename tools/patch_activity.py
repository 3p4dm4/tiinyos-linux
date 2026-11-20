#!/usr/bin/env python3
"""M3 — wire the activity indicator into the minified main bundle.

Two anchors:
1. `this.tray.setToolTip("TiinyOS")` — runs at tray construction (startup):
   capture the tray instance and auto-start the poller.
2. the ball window (post patch_ball_click anchor) — capture the ball window so
   the poller can push the busy/idle badge into it via executeJavaScript.

Idempotent; fails loudly if an anchor is not unique (bundle drifted upstream).
Requires patch_ball_click.py to have run first (anchor #2 is its output).

The tray anchor also carries an env-gated test hook: with M3_OPEN_DEVICE set,
the Device (Performance) window opens itself at startup so the end-to-end
test can exercise the m3:device:* IPC from the renderer (tests/e2e/). No
behaviour change when the variable is unset. The care engine itself starts
from m3_activity (present in every installed bundle), not from this patch.
"""
import sys

F = sys.argv[1] if len(sys.argv) > 1 else "out/main/index.js"
PAIRS = [
    ('this.tray.setToolTip("TiinyOS")',
     'this.tray.setToolTip("TiinyOS"),globalThis.__m3Tray=this.tray,'
     'setTimeout(()=>{try{require("./m3_activity").start(globalThis.__m3Tray);}'
     'catch(e){console.error("[M3] activity:",e)}},4000),'
     'process.env.M3_OPEN_DEVICE&&setTimeout(()=>{try{require("./m3_performance").open();}'
     'catch(e){console.error("[M3] open device window:",e)}},5000)'),
    ('("linux"===process.platform?require("./m3_ballshape").apply(t,!0):t.setIgnoreMouseEvents(!0,{forward:!0}))',
     '("linux"===process.platform?require("./m3_ballshape").apply(t,!0):t.setIgnoreMouseEvents(!0,{forward:!0})),'
     'globalThis.__m3Ball=t'),
]

s = open(F).read()
if "m3_activity" in s:
    print("patch_activity: already patched")
else:
    for old, _ in PAIRS:
        n = s.count(old)
        if n != 1:
            sys.exit(f"patch_activity: anchor {n} occurrences (expected 1) for: {old[:60]}… — "
                     "bundle drifted (or patch_ball_click missing), review manually")
    for old, new in PAIRS:
        s = s.replace(old, new)
    open(F, "w").write(s)
    print("patch_activity: applied (tray tooltip + ball badge)")
