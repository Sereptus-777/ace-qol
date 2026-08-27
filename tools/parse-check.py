# -*- coding: utf-8 -*-
# --- Does every shipped file still parse? -----------------------------------
#
# WHY THIS EXISTS. On 2026-08-27 a text sweep replaced "ft" with "feet" across
# 71 files. It was checked for damage to regexes, comparisons and object keys,
# and it had none. What it was NOT checked for was IDENTIFIERS, and it had hit
# one:
#
#     this._pushTarget5ft(...)   ->   this._pushTarget5 feet(...)
#
# `_pushTarget5ft` is a method name. The sweep turned it into a syntax error,
# feat-effects.mjs stopped parsing, and that shipped - every feature in that
# file dead on load, with nothing to say why.
#
# THE GATE ALREADY EXISTED AND WAS RUN WRONG. `node --check` was run on the
# four files that seemed interesting rather than on all of them. A check you
# have to remember to point at the right files is a check that eventually gets
# pointed at the wrong ones.
#
# So: every .mjs in every ACE module, every time. It takes seconds.
#
# Run:  python tools/parse-check.py
import os
import subprocess
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art"]
SKIP = {"node_modules", ".git", "packs", "assets", "sounds", "icons", "fonts",
        "images", "media", "dist", "build", "lang"}

files, failures = [], []
for mod in MODULES:
    base = os.path.join(ROOT, mod)
    if not os.path.isdir(base):
        continue
    for dp, dn, fns in os.walk(base):
        dn[:] = [d for d in dn if d not in SKIP]
        for fn in fns:
            if fn.endswith(".mjs") or fn.endswith(".js"):
                files.append(os.path.join(dp, fn))

print("")
print("DOES EVERY SHIPPED FILE STILL PARSE?")
print("=" * 78)

for f in files:
    r = subprocess.run(["node", "--check", f], capture_output=True, text=True)
    if r.returncode != 0:
        first = ""
        for line in (r.stderr or "").splitlines():
            line = line.strip()
            if line and not line.startswith("at ") and "node:internal" not in line:
                first = line
                break
        failures.append((os.path.relpath(f, ROOT).replace("\\", "/"), first))

print("  %d file(s) checked across %d module(s)" % (len(files), len(MODULES)))

if failures:
    print("")
    for rel, msg in failures:
        print("  BROKEN  %s" % rel)
        print("          %s" % msg)
    print("")
    print("=" * 78)
    print("%d file(s) do not parse. Foundry will fail to load each of them, and"
          % len(failures))
    print("every feature inside it goes silently dead.")
    sys.exit(1)

print("")
print("=" * 78)
print("Every file parses.")
sys.exit(0)
