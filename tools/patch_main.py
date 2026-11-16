#!/usr/bin/env python3
"""M3 — inject the tray menu items (Performance + Control Panel) into the minified
main bundle. Supersedes s1-performance/patch_main.py (same anchor, two items).

Idempotent: exits 0 without touching the file if the patch is already present.
Fails loudly if the anchor string is not unique (bundle changed upstream).
"""
import sys

F = sys.argv[1] if len(sys.argv) > 1 else "out/main/index.js"
ANCHOR = ',{type:"separator"},{label:t.quit,click:()=>this.quit()}].filter(Boolean)'
PATCH = (',{type:"separator"},{label:"Performance",'
         'click:()=>{try{require("./m3_performance").open()}catch(e){console.error("[M3] performance:",e)}}},'
         '{label:"Control Panel",'
         'click:()=>{try{require("./m3_cp").open()}catch(e){console.error("[M3] cp:",e)}}},'
         '{label:t.quit,click:()=>this.quit()}].filter(Boolean)')

s = open(F).read()
if "m3_cp" in s:  # idempotency marker: the require() path, not the label
    print("patch_main: already patched (cp)")
elif "m3_performance" in s:
    # S1 patch present: extend it with the Control Panel item
    s1_end = 'require("./m3_performance").open()}catch(e){console.error("[M3] performance:",e)}}}'
    if s.count(s1_end) == 1:
        open(F, "w").write(s.replace(s1_end, s1_end +
            '{label:"Control Panel",click:()=>{try{require("./m3_cp").open()}'
            'catch(e){console.error("[M3] cp:",e)}}}'))
        print("patch_main: applied (cp appended to s1 patch)")
    else:
        sys.exit("patch_main: s1 patch marker not unique — review manually")
elif s.count(ANCHOR) == 1:
    open(F, "w").write(s.replace(ANCHOR, PATCH))
    print("patch_main: applied (both items)")
else:
    sys.exit(f"patch_main: anchor occurrences = {s.count(ANCHOR)} (expected 1) — bundle drifted, review manually")
