#!/usr/bin/env python3
"""M3 — inject the tray menu items (Performance + Control Panel + Music Lab) into the minified
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
         '{label:"Music Lab",'
         'click:()=>{try{require("./m3_music").open()}catch(e){console.error("[M3] music:",e)}}},'
         '{label:t.quit,click:()=>this.quit()}].filter(Boolean)')

s = open(F).read()
if "m3_music" in s:  # idempotency marker: the require() path, not the label
    print("patch_main: already patched (music)")
elif "m3_cp" in s:  # extend the cp patch with the Music Lab item
    cp_end = 'require("./m3_cp").open()}catch(e){console.error("[M3] cp:",e)}}}'
    if s.count(cp_end) == 1:
        open(F, "w").write(s.replace(cp_end, cp_end +
            ',{label:"Music Lab",click:()=>{try{require("./m3_music").open()}'
            'catch(e){console.error("[M3] music:",e)}}}'))
        print("patch_main: applied (music appended to cp patch)")
    else:
        sys.exit("patch_main: cp patch marker not unique — review manually")
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
    print("patch_main: applied (all items)")
else:
    sys.exit(f"patch_main: anchor occurrences = {s.count(ANCHOR)} (expected 1) — bundle drifted, review manually")
