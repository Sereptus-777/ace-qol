#!/usr/bin/env python3
# Run me:  python ace-qol/tools/suite-audit.py
#
# ─── ACE full-suite audit ────────────────────────────────────────────────────
# ⚠️ A WRONG AUDIT IS WORSE THAN NONE. v1 of this file reported 291 duplicate
# keys and 34 orphaned socket actions, and every one was a false positive:
#   - it compared keys across a whole nested map, so 85 conditions each having
#     a `name` read as "name appears 85x"
#   - it matched `action:` in DialogV2 button definitions as socket emits
#   - its import regex could not span newlines, so every multi-line
#     `import {\n ... \n} from "./x.mjs"` looked like x.mjs was never imported
# All three are fixed here. Each check now either resolves a real path on disk
# or matches inside a real call site.
import os, re, json
from collections import defaultdict, Counter

ROOT = r"D:\FoundryVTT\Data\modules"
MODS = ["ace-qol", "ace-engine", "ace-artificer"]

def srcfiles(mod):
    out = []
    for base in ("scripts", "src"):
        d = os.path.join(ROOT, mod, base)
        if not os.path.isdir(d):
            continue
        for dp, dns, fns in os.walk(d):
            if ".git" in dp:
                continue
            for fn in fns:
                if fn.endswith((".mjs", ".js")):
                    out.append(os.path.join(dp, fn))
    return out

FILES = {m: srcfiles(m) for m in MODS}
TEXT = {}
for m in MODS:
    for f in FILES[m]:
        try:
            TEXT[f] = open(f, encoding="utf-8", errors="ignore").read()
        except Exception:
            TEXT[f] = ""

problems = defaultdict(list)
def flag(cat, msg):
    problems[cat].append(msg)

def rel(f):
    return os.path.relpath(f, ROOT).replace("\\", "/")

# ── 1. every relative import resolves (DOTALL: imports span newlines) ───────
IMP = re.compile(
    r'(?:import|export)\s(?:[^;]*?\sfrom\s)?["\'](\.[^"\']+)["\']'
    r'|import\(\s*["\'](\.[^"\']+)["\']',
    re.S)

def import_targets(f):
    for mt in IMP.finditer(TEXT[f]):
        rel_p = mt.group(1) or mt.group(2)
        if rel_p:
            yield rel_p

for m in MODS:
    for f in FILES[m]:
        for rp in import_targets(f):
            tgt = os.path.normpath(os.path.join(os.path.dirname(f), rp))
            if not any(os.path.isfile(c) for c in (tgt, tgt + ".mjs", tgt + ".js")):
                flag("BROKEN IMPORT", f"{rel(f)} -> {rp}")

# ── 2. dead files ───────────────────────────────────────────────────────────
entries = {}
for m in MODS:
    try:
        mj = json.load(open(os.path.join(ROOT, m, "module.json"), encoding="utf-8"))
        entries[m] = {os.path.normpath(os.path.join(ROOT, m, e)) for e in mj.get("esmodules", [])}
    except Exception:
        entries[m] = set()

imported = set()
for m in MODS:
    for f in FILES[m]:
        for rp in import_targets(f):
            base = os.path.normpath(os.path.join(os.path.dirname(f), rp))
            for cand in (base, base + ".mjs", base + ".js"):
                if os.path.isfile(cand):
                    imported.add(os.path.normpath(cand))

for m in MODS:
    for f in FILES[m]:
        nf = os.path.normpath(f)
        if nf in imported or nf in entries[m]:
            continue
        flag("NEVER IMPORTED", f"{rel(f)}  ({len(TEXT[f].splitlines())} lines)")

# ── 3. duplicate keys at the SAME nesting level of the SAME literal ─────────
def dup_keys(txt, fname):
    # Walk the text tracking brace depth; collect keys per (depth, block-id).
    depth = 0
    block_stack = []        # (start_line, {key: count})
    i, n = 0, len(txt)
    line = 1
    in_s = None
    while i < n:
        c = txt[i]
        if c == "\n":
            line += 1
        if in_s:
            if c == "\\":
                i += 2
                continue
            if c == in_s:
                in_s = None
            i += 1
            continue
        if c in "\"'`":
            in_s = c
            i += 1
            continue
        if txt.startswith("//", i):
            j = txt.find("\n", i)
            i = n if j < 0 else j
            continue
        if txt.startswith("/*", i):
            j = txt.find("*/", i)
            line += txt[i:(n if j < 0 else j)].count("\n")
            i = n if j < 0 else j + 2
            continue
        if c == "{":
            block_stack.append([line, {}])
            i += 1
            continue
        if c == "}":
            if block_stack:
                start_line, keys = block_stack.pop()
                for k, cnt in keys.items():
                    if cnt > 1:
                        flag("DUPLICATE KEY",
                             f"{fname}:{start_line}  '{k}' defined {cnt}x in the SAME object literal "
                             f"(JS keeps the LAST - this is how Haste granted only +2 AC)")
            i += 1
            continue
        # a key at this level
        mt = re.match(r'([A-Za-z_$][\w$]*|"[^"]+"|\'[^\']+\')\s*:', txt[i:])
        if mt and block_stack:
            prev = txt[max(0, i - 1)]
            if prev in "{,\n \t":
                k = mt.group(1).strip("\"'")
                block_stack[-1][1][k] = block_stack[-1][1].get(k, 0) + 1
                i += mt.end()
                continue
        i += 1

for m in MODS:
    for f in FILES[m]:
        try:
            dup_keys(TEXT[f], rel(f))
        except Exception as e:
            flag("AUDIT ERROR", f"dup-key scan failed on {rel(f)}: {e}")

# ── 4. socket actions: only inside a real socket.emit(...) ─────────────────
EMIT = re.compile(r'socket\.emit\(\s*[^,]+,\s*\{(.{0,400}?)\}', re.S)
emitted, handled = set(), set()
for m in MODS:
    for f in FILES[m]:
        txt = TEXT[f]
        for mt in EMIT.finditer(txt):
            a = re.search(r'action\s*:\s*["\']([\w]+)["\']', mt.group(1))
            if a:
                emitted.add(a.group(1))
            v = re.search(r'action\s*:\s*(?:this\.|[\w.]+\.)?([A-Z_]+)\b', mt.group(1))
            if v:
                emitted.add("<var:" + v.group(1) + ">")
        for mt in re.finditer(r'action\s*===\s*["\']([\w]+)["\']', txt):
            handled.add(mt.group(1))
        for mt in re.finditer(r'case\s+["\']([\w]+)["\']\s*:', txt):
            handled.add(mt.group(1))
        for mt in re.finditer(r'\btype\s*===\s*["\']([\w]+)["\']', txt):
            handled.add(mt.group(1))
for a in sorted(emitted):
    if a.startswith("<var:"):
        continue
    if a not in handled:
        flag("SOCKET EMITTED, NO HANDLER", a)

# ── 5. ready registered from inside ready ──────────────────────────────────
for m in MODS:
    for f in FILES[m]:
        txt = TEXT[f]
        # find top-level ready blocks and their extent
        tops = [mt.start() for mt in re.finditer(r'^Hooks\.once\(\s*["\']ready["\']', txt, re.M)]
        for mt in re.finditer(r'^\s+Hooks\.once\(\s*["\']ready["\']', txt, re.M):
            ln = txt[:mt.start()].count("\n") + 1
            inside_top = any(t < mt.start() for t in tops)
            flag("INDENTED ready HOOK",
                 f"{rel(f)}:{ln}" + ("  <-- a top-level ready exists ABOVE it in this file" if inside_top else ""))

# ── 6. removed dnd5e APIs ──────────────────────────────────────────────────
for api in ["rollAbilitySave", "rollAbilityTest", "rollSkillV2"]:
    for m in MODS:
        for f in FILES[m]:
            for mt in re.finditer(r'\b' + api + r'\s*\??\.?\(', TEXT[f]):
                ln = TEXT[f][:mt.start()].count("\n") + 1
                flag("REMOVED dnd5e API", f"{rel(f)}:{ln}  {api}")

# ── 7. deprecated preparation read BEFORE the new field ────────────────────
for m in MODS:
    for f in FILES[m]:
        txt = TEXT[f]
        for mt in re.finditer(r'.*\.preparation\s*\??\.\s*(?:mode|prepared).*', txt):
            ln_txt = mt.group(0)
            if ln_txt.lstrip().startswith(("//", "*")):
                continue
            if "??" in ln_txt and ln_txt.index("preparation") < ln_txt.index("??"):
                ln = txt[:mt.start()].count("\n") + 1
                flag("DEPRECATED FIELD READ FIRST", f"{rel(f)}:{ln}")
            elif "??" not in ln_txt and "=" in ln_txt:
                ln = txt[:mt.start()].count("\n") + 1
                flag("DEPRECATED FIELD, NO FALLBACK", f"{rel(f)}:{ln}")

# ── report ─────────────────────────────────────────────────────────────────
print("=" * 76)
print("ACE SUITE AUDIT - three modules")
print("=" * 76)
for m in MODS:
    print(f"  {m:<16} {len(FILES[m]):>3} source files, "
          f"{sum(len(TEXT[f].splitlines()) for f in FILES[m]):>7,} lines")
print()
tot = 0
for cat in sorted(problems):
    items = problems[cat]
    tot += len(items)
    print(f"--- {cat}  ({len(items)}) ---")
    for i in items[:30]:
        print(f"    {i}")
    if len(items) > 30:
        print(f"    ... and {len(items)-30} more")
    print()
if not tot:
    print("  nothing flagged")
print(f"TOTAL FLAGGED: {tot}")
