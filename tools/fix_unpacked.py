#!/usr/bin/env python3
"""M3 S1 — post-process a CLI-packed asar so native modules load.

The original build keeps native modules (.node etc.) OUTSIDE the asar, in
app.asar.unpacked/, with "unpacked":true flags in the header. A plain
`asar pack` embeds everything and drops those flags: Electron would then try
to dlopen .node files from inside the asar and crash. This script re-marks,
in the freshly packed header, every entry whose path also exists under
app.asar.unpacked/, then rewrites the header (data section is untouched).

Header layout (asar v4, little-endian u32):
    [4][N+8][N+4][N][JSON of exactly N bytes][data...]
JSON is padded with trailing spaces (valid JSON whitespace) to keep N % 4 == 0.

Usage: fix_unpacked.py <packed.asar> <asar.unpacked dir> <out.asar>
"""
import json
import os
import sys


def main():
    packed, unpacked_dir, out = sys.argv[1], sys.argv[2], sys.argv[3]
    src = open(packed, "rb").read()
    n = int.from_bytes(src[12:16], "little")
    header = json.loads(src[16:16 + n])
    # The CLI packer pads the JSON region with nulls to a 4-byte boundary;
    # the data section starts AFTER that padding, not right after the JSON.
    data = src[16 + n + ((-n) % 4):]

    paths = set()
    for root, _dirs, files in os.walk(unpacked_dir):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), unpacked_dir)
            paths.add(rel.replace(os.sep, "/"))
    if not paths:
        sys.exit(f"fix_unpacked: {unpacked_dir} is empty — nothing to mark")

    marked = 0

    def mark(node, prefix=""):
        nonlocal marked
        for name, ent in node.get("files", {}).items():
            p = prefix + name
            if "files" in ent:
                mark(ent, p + "/")
            elif p in paths:
                ent["unpacked"] = True
                marked += 1

    mark(header)
    if marked != len(paths):
        print(f"fix_unpacked: warning, marked {marked} of {len(paths)} unpacked paths")

    js = json.dumps(header, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    n2 = len(js)
    out_bytes = (b"\x04\x00\x00\x00" + (n2 + 8).to_bytes(4, "little")
                 + (n2 + 4).to_bytes(4, "little") + n2.to_bytes(4, "little")
                 + js + data)
    tmp = out + ".tmp"
    open(tmp, "wb").write(out_bytes)
    os.replace(tmp, out)
    print(f"fix_unpacked: marked {marked} entries, header {n} -> {n2} bytes")


if __name__ == "__main__":
    main()
