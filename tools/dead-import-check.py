# -*- coding: utf-8 -*-
# --- An import nobody uses still pulls a module into the graph --------------
#
# WHY THIS EXISTS. On 2026-08-26 two dead imports were created and caught in
# one session: `cannotDo` in attack-pipeline.mjs and `cannotDo` in
# damage-engine.mjs, both left behind when a later edit removed their only
# call. Nothing complains about those - eslint's no-unused-vars is off here,
# and no-undef only fires the other way round.
#
# They matter more in this codebase than in most, because ace-qol already has
# 130+ static import cycles and an unused import still creates an edge. A
# binding used at evaluation time inside a cycle is what took large parts of
# the suite down mid-session on 2026-08-24.
#
# =========================================================================
#  READ THIS BEFORE DELETING ANYTHING THIS REPORTS
# =========================================================================
#
# AN UNUSED IMPORT IS NOT ALWAYS A SAFE DELETE. `import { X } from "./m.mjs"`
# loads m.mjs and runs its top-level code even when X is never referenced. If
# m.mjs registers hooks, patches a class, or publishes an API at module scope,
# removing the import can stop that module loading AT ALL - and the symptom is
# a feature that silently never registers, which is the single most expensive
# failure shape in this project's history.
#
# So for each row: check whether that module is imported anywhere ELSE, or has
# no top-level side effects, BEFORE removing the line. The check below reports;
# it does not decide.
#
# Run:  python tools/dead-import-check.py
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-token-art"]
SKIP = {"node_modules", ".git", "packs", "assets", "sounds", "icons", "lang",
        "fonts", "images", "templates", "tools"}


def used(name, text):
    """Is `name` referenced as an identifier rather than a property access?

    WARNING. Version one wrote the boundary as `(?<![\\w$.])` to skip `obj.NAME`
    and thereby also rejected `...NAME` - so every spread-only re-export came
    back dead. One registry file produced eleven false positives, and the
    headline number was 82 when the truth was 63. Spread IS a use.
    """
    for m in re.finditer(r"(?<![\w$])" + re.escape(name) + r"(?![\w$])", text):
        before = text[:m.start()]
        if before.endswith("...") or not before.endswith("."):
            return True
    return False


def strip_noise(src):
    """Comments out. A name mentioned only in prose is not a use.

    `GazeEngine` in ace-qol.mjs is exactly this: imported, and its only other
    appearance is a commented-out `// GazeEngine.init();`.
    """
    code = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"^\s*//.*$", "", code, flags=re.M)


rows = []
for mod in MODULES:
    base = os.path.join(ROOT, mod)
    if not os.path.isdir(base):
        continue
    for dp, dn, fns in os.walk(base):
        dn[:] = [d for d in dn if d not in SKIP]
        for fn in fns:
            if not fn.endswith(".mjs"):
                continue
            full = os.path.join(dp, fn)
            try:
                code = strip_noise(io.open(full, encoding="utf-8", errors="ignore").read())
            except OSError:
                continue
            rel = os.path.relpath(full, base).replace("\\", "/")
            for m in re.finditer(r"^import\s*\{([^}]*)\}\s*from\s*[\"']([^\"']+)[\"'];",
                                 code, re.M):
                after = code[:m.start()] + code[m.end():]
                source = m.group(2)
                for part in m.group(1).split(","):
                    part = part.strip()
                    if not part:
                        continue
                    name = part.split(" as ")[-1].strip()
                    if not re.match(r"^[A-Za-z_$][\w$]*$", name):
                        continue
                    if not used(name, after):
                        rows.append((mod, rel, name, source))

print("")
print("IMPORTED AND NEVER USED")
print("=" * 78)
by_mod = {}
for r in rows:
    by_mod.setdefault(r[0], []).append(r)

for mod in MODULES:
    got = by_mod.get(mod, [])
    if not got:
        continue
    print("")
    print("  %s  (%d)" % (mod, len(got)))
    last = None
    for _m, rel, name, source in got:
        if rel != last:
            print("     %s" % rel)
            last = rel
        print("        %-28s from %s" % (name, source))

print("")
print("=" * 78)
if rows:
    print("%d import(s) bound to a name nothing reads." % len(rows))
    print("")
    print("NOT AUTOMATICALLY SAFE TO DELETE. Importing a module runs its")
    print("top-level code even when the binding is unused, so removing the line")
    print("can stop that module loading and silently unregister its hooks.")
    print("Check each source module for side effects, or for another importer,")
    print("before removing the line.")
    sys.exit(1)

print("Every imported name is read.")
sys.exit(0)
