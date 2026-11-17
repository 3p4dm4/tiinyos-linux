#!/usr/bin/env python3
"""Fix the Floating Ball panel closing instantly on Linux/X11.

Root cause (observed 2026-11-17 via CDP on a live app): clicking the ball opens
the TrayPanel (`[FloatingBallPanel] showAnchored`), but on X11 `show()` does not
take window-manager focus, so the app-level `browser-window-blur` listener hides
the panel within milliseconds — the click appears dead. The bundle already has a
post-show grace period, `shouldIgnoreTransientHide()` (600 ms), but it starts
with `if(process.platform!=="darwin")return!1;` — macOS only.

Fix: extend the existing guard to Linux. Same minified shape, one condition.
Idempotent; fails loudly if the anchor is not unique (bundle drifted upstream).
"""
import sys

F = sys.argv[1] if len(sys.argv) > 1 else "out/main/index.js"
OLD = 'shouldIgnoreTransientHide(t){if(process.platform!=="darwin")return!1;'
NEW = 'shouldIgnoreTransientHide(t){if(process.platform!=="darwin"&&process.platform!=="linux")return!1;'

s = open(F).read()
if NEW in s:
    print("patch_ball_blur: already patched")
elif s.count(OLD) == 1:
    open(F, "w").write(s.replace(OLD, NEW))
    print("patch_ball_blur: applied (grace period extended to linux)")
else:
    sys.exit(f"patch_ball_blur: anchor occurrences = {s.count(OLD)} (expected 1) — bundle drifted, review manually")
