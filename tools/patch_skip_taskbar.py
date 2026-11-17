#!/usr/bin/env python3
"""Keep the Floating Ball / Tray Panel / mini window out of the Linux taskbar.

Root cause (observed 2026-11-17, GNOME 46 + XWayland, Electron 37.4.0): on
Linux/X11 Electron's skipTaskbar does nothing — neither the constructor option
nor setSkipTaskbar() ever puts _NET_WM_STATE_SKIP_TASKBAR on the window
(verified with a standalone electron 37.4.0 harness + xprop: state stays
ABOVE only, with or without type:'panel', before or after show). So the dock
lists the Floating Ball as an extra, icon-less window. Setting the state from
outside with `wmctrl -i -r <xid> -b add,skip_taskbar` works and survives
hide/show (same harness).

Fix: a tiny helper (prepended once) that, for those three windows, runs wmctrl
on every `show` (+150 ms, +600 ms, to land after the WM manages the window).
Linux only; without wmctrl it logs once and does nothing else. Idempotent;
fails loudly if an anchor is not unique (bundle drifted upstream).
"""
import sys

F = sys.argv[1] if len(sys.argv) > 1 else "out/main/index.js"
MARK = "/*M3-SKIPTB*/"
HELPER = (MARK + 'globalThis.__m3SkipTb=function(w){if(process.platform!=="linux"||!w)return;'
          'const cp=require("child_process");'
          'const f=()=>{try{if(w.isDestroyed()||!w.isVisible())return;'
          'const id="0x"+w.getNativeWindowHandle().readUInt32LE(0).toString(16);'
          'cp.execFile("wmctrl",["-i","-r",id,"-b","add,skip_taskbar"],e=>{if(e&&!globalThis.__m3SkipTbWarned){globalThis.__m3SkipTbWarned=1;'
          'console.log("[M3-skiptb] wmctrl failed (install wmctrl to hide panels from the taskbar):",e.message)}})}catch(e){}};'
          'w.on("show",()=>{f();setTimeout(f,150);setTimeout(f,600)});setTimeout(f,1000)};\n')

# (anchor, replacement) — each anchor sits right after the window is constructed
SITES = [
    # Tray Panel (const i=new ge.BrowserWindow(...))
    ('if(console.log("[TrayPanel] ensureWindow: BrowserWindow created, id:",i.id)',
     'if(globalThis.__m3SkipTb?.(i),console.log("[TrayPanel] ensureWindow: BrowserWindow created, id:",i.id)'),
    # Floating Ball (createWindow(t){const r=new ge.BrowserWindow(...)})
    ('return r.__isFloatingBallWindow=!0,',
     'return globalThis.__m3SkipTb?.(r),r.__isFloatingBallWindow=!0,'),
    # Quick-assistant mini window (this.miniWindow=new ge.BrowserWindow(...))
    ('this.miniWindow.setAlwaysOnTop(!0,"floating"),',
     'globalThis.__m3SkipTb?.(this.miniWindow),this.miniWindow.setAlwaysOnTop(!0,"floating"),'),
]

s = open(F).read()
if s.startswith(MARK):
    print("patch_skip_taskbar: already patched")
    sys.exit(0)
for old, _ in SITES:
    n = s.count(old)
    if n != 1:
        sys.exit(f"patch_skip_taskbar: anchor occurrences = {n} (expected 1) for {old[:50]!r} — bundle drifted, review manually")
for old, new in SITES:
    s = s.replace(old, new)
open(F, "w").write(HELPER + s)
print(f"patch_skip_taskbar: applied ({len(SITES)} windows re-assert skipTaskbar on show)")
