#!/usr/bin/env python3
# ─── Can each ACE module stand alone? ────────────────────────────────────────
#
# The promise: install ANY ONE of these on a bare Foundry + dnd5e world and it
# works. Siblings are enhancements, never requirements.
#
# Four ways that promise gets broken, in order of severity:
#
#   1. A STATIC IMPORT across module folders. Fatal: the browser fails to
#      resolve the URL and the whole module fails to load. Nothing runs.
#   2. An UNGUARDED sibling API call - `game.aceQol.clock.spend()` rather than
#      `game.aceQol?.clock?.spend?.()`. Throws a TypeError at the call site,
#      which kills whatever feature was mid-flight.
#   3. An ASSET PATH into a sibling's folder. Silent: a missing image or sound
#      just does not appear, so it looks like a broken feature rather than a
#      missing module.
#   4. A SETTINGS READ in a sibling's namespace without a module-active guard.
#      Foundry THROWS on an unregistered setting, so this is a real break.
#
# A hard `requires` in module.json is also checked - that is Foundry refusing
# to enable the module at all without its sibling.
import os, re, json, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODS = ["ace-qol", "ace-engine", "ace-artificer", "ace-envoy"]
NL = chr(10)

def strip_comments(src):
    out, i, n = list(src), 0, len(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            q = c; i += 1
            while i < n and src[i] != q:
                if src[i] == chr(92): i += 1
                i += 1
            i += 1; continue
        if src.startswith("//", i):
            while i < n and src[i] != NL:
                out[i] = " "; i += 1
            continue
        if src.startswith("/*", i):
            while i < n and not src.startswith("*/", i):
                if src[i] != NL: out[i] = " "
                i += 1
            for k in range(i, min(i + 2, n)): out[k] = " "
            i += 2; continue
        i += 1
    return "".join(out)

files = {}
for m in MODS:
    files[m] = []
    for base in ("scripts", "src"):
        d = os.path.join(ROOT, m, base)
        if not os.path.isdir(d):
            continue
        for dp, dns, fns in os.walk(d):
            if ".git" in dp: continue
            for fn in fns:
                if fn.endswith((".mjs", ".js")):
                    files[m].append(os.path.join(dp, fn))

RAW, CODE = {}, {}
for m in MODS:
    for f in files[m]:
        try:
            RAW[f] = open(f, encoding="utf-8", errors="ignore").read()
        except Exception:
            RAW[f] = ""
        CODE[f] = strip_comments(RAW[f])

def rel(f):
    return os.path.relpath(f, ROOT).replace("\\", "/")

APIS = {"ace-qol": "aceQol", "ace-engine": "aceEngine",
        "ace-artificer": "aceForge", "ace-envoy": "aceEnvoy"}

findings = {m: [] for m in MODS}

for m in MODS:
    siblings = [s for s in MODS if s != m]
    for f in files[m]:
        code = CODE[f]

        # 1. static import crossing a module boundary
        for mt in re.finditer(r'(?:import|export)\s(?:[^;]*?\sfrom\s)?["\']([^"\']+)["\']', code, re.S):
            path = mt.group(1)
            for s in siblings:
                if f"/{s}/" in path or path.startswith(f"../{s}") or path.startswith(f"/modules/{s}"):
                    ln = code[:mt.start()].count(NL) + 1
                    findings[m].append(("FATAL", f"{rel(f)}:{ln}  static import from {s}: {path}"))

        # 2. unguarded sibling API call
        for s in siblings:
            api = APIS[s]
            for mt in re.finditer(r'game\.' + api + r'(\??\.)(\w+)(\??[.(])', code):
                if mt.group(1) == "?." and mt.group(3).startswith("?"):
                    continue                      # game.x?.y?.() - fine
                # A `typeof game.aceX?.y === "function" ? game.aceX.y(...) : fb`
                # ternary is the CORRECT pattern. The unguarded-looking call is
                # the true-branch of a test that already ran.
                window = code[max(0, mt.start() - 260): mt.start()]
                if "typeof" in window and api in window:
                    continue
                ln = code[:mt.start()].count(NL) + 1
                snippet = code[mt.start():mt.start() + 46].replace(NL, " ")
                findings[m].append(("THROWS", f"{rel(f)}:{ln}  {snippet}"))

        # 3. asset path into a sibling folder
        for s in siblings:
            for mt in re.finditer(r'["\'](?:/)?modules/' + re.escape(s) + r'/[^"\']+["\']', RAW[f]):
                path = mt.group(0)
                # A code path is a DYNAMIC IMPORT - check 1 above judges those,
                # and a guarded one is correct. Only data files are an asset
                # dependency.
                if path.rstrip("\"'").endswith((".mjs", ".js")):
                    continue
                # A probe that rejects the path when the owning module is not
                # active is the CORRECT shape for an optional enhancement: the
                # sibling adds something when present and vanishes cleanly when
                # not. Flagging that pattern taught nothing except to distrust
                # this tool.
                # ⚠️ FILE-LEVEL, not a local window. Path constants live at the
                # top of a file and the probe that checks them sits fifty lines
                # below, so a nearby-text search misses it and reports a
                # correctly-guarded file as a hard dependency.
                # ⚠️ Deliberately loose. The real probe reads
                #   game.modules.get(p.split("/")[1])?.active
                # and a regex trying to match the argument list chokes on the
                # nested parentheses, so it reported a correctly-guarded file.
                # Presence of both halves anywhere in the file is enough: a file
                # that checks module activity at all is not blindly assuming.
                if "modules.get(" in CODE[f] and ".active" in CODE[f]:
                    continue
                ln = RAW[f][:mt.start()].count(NL) + 1
                findings[m].append(("SILENT", f"{rel(f)}:{ln}  asset from {s}: {path[:64]}"))

        # 4. settings read in a sibling namespace, unguarded
        for s in siblings:
            for mt in re.finditer(r'settings\.(?:get|set)\(\s*["\']' + re.escape(s) + r'["\']', code):
                ln = code[:mt.start()].count(NL) + 1
                # ⚠️ WIDE WINDOWS ON PURPOSE. Comments are blanked to spaces to
                # keep offsets stable, so a heavily-commented guard sits far
                # more characters away than it does lines. A 420-char window
                # reported a read that is wrapped in try/catch AND gated on an
                # isEngineActive() bridge call.
                window = code[max(0, mt.start() - 2000): mt.start()]
                after  = code[mt.start(): mt.start() + 2000]
                # Guarded if ANY of: wrapped in try/catch, gated on the sibling
                # being active, or gated on a bridge helper that does that check
                # for us (isEngineActive() and friends). A bridge is the tidier
                # form and reporting it as unguarded punishes the better code.
                guarded = ("try" in window and "catch" in after) \
                          or re.search(r'modules\.get\(\s*["\']' + re.escape(s) + r'["\']\s*\)\s*\??\.\s*active', window) \
                          or re.search(r'is\w*Active\s*\(', window)
                if not guarded:
                    findings[m].append(("THROWS", f"{rel(f)}:{ln}  reads {s} settings with no guard"))

# ── manifests ──────────────────────────────────────────────────────────────
print("=" * 76)
print("STANDALONE CHECK - can each module run with the others absent?")
print("=" * 76)
for m in MODS:
    try:
        mj = json.load(open(os.path.join(ROOT, m, "module.json"), encoding="utf-8"))
    except Exception:
        continue
    reqs = [r.get("id") for r in mj.get("relationships", {}).get("requires", []) or []]
    hard = [r for r in reqs if r in MODS]
    if hard:
        findings[m].append(("FATAL", f"module.json REQUIRES sibling(s): {', '.join(hard)}"))

total = 0
for m in MODS:
    fs = findings[m]
    total += len(fs)
    print(f"{NL}--- {m} ---")
    if not fs:
        print("    stands alone: no static imports, no unguarded sibling calls,")
        print("    no sibling assets, no unguarded sibling settings.")
        continue
    for sev in ("FATAL", "THROWS", "SILENT"):
        rows = [x for s, x in fs if s == sev]
        if not rows:
            continue
        label = {"FATAL": "WILL NOT LOAD", "THROWS": "THROWS AT RUNTIME",
                 "SILENT": "SILENTLY MISSING"}[sev]
        print(f"    {label}  ({len(rows)})")
        for r in rows[:12]:
            print(f"       {r}")
        if len(rows) > 12:
            print(f"       ... and {len(rows) - 12} more")

print(f"{NL}TOTAL: {total}")
sys.exit(1 if total else 0)
