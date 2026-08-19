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

def strip_comments(src):
    """Blank comments while preserving offsets. Without this the audit matches
    its OWN warning text: several files document these exact bugs by name."""
    out, i, n_, NL = list(src), 0, len(src), chr(10)
    while i < n_:
        c = src[i]
        if c in "\"'`":
            q = c; i += 1
            while i < n_ and src[i] != q:
                if src[i] == chr(92): i += 1
                i += 1
            i += 1; continue
        if src.startswith("//", i):
            while i < n_ and src[i] != NL:
                out[i] = " "; i += 1
            continue
        if src.startswith("/*", i):
            while i < n_ and not src.startswith("*/", i):
                if src[i] != NL: out[i] = " "
                i += 1
            for k in range(i, min(i + 2, n_)): out[k] = " "
            i += 2; continue
        i += 1
    return "".join(out)

FILES = {m: srcfiles(m) for m in MODS}
TEXT = {}
for m in MODS:
    for f in FILES[m]:
        try:
            TEXT[f] = strip_comments(open(f, encoding="utf-8", errors="ignore").read())
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

# ── 3. duplicate keys — DELEGATED TO ESLINT, deliberately ──────────────────
# A hand-rolled brace-tracking scanner lived here and produced 26 false
# positives against 2 real hits: it could not tell one object literal from a
# nested one, so 85 conditions each having a `name` read as "name defined 85x".
# ESLint's `no-dupe-keys` uses a real parser, gets it right for free, and is now
# an ERROR in all four eslint configs. Run the lint; do not re-add a scanner.

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
        # ⚠️ `!==` COUNTS AS HANDLING. The common shape is an early-return
        # guard: `if (data?.action !== "aiResponse") return;`. Matching only
        # `===` reported three live, correctly-handled relay replies as
        # orphans.
        for mt in re.finditer(r'action\s*[=!]==\s*["\']([\w]+)["\']', txt):
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

# ── 5. ready reachability — SEE tools/ready-hook-check.py ─────────────────
# An indentation test lived here. It used `^\s+`, and `\s` matches a NEWLINE,
# so every top-level hook following a blank line was flagged: eight false
# positives, and it missed all four real ones. Indentation was never the
# question — what matters is whether the enclosing code runs during `ready`.
# ready-hook-check.py answers that properly, and is verified to go red when a
# guard is deliberately removed.

# ── 6. removed dnd5e APIs ──────────────────────────────────────────────────
for api in ["rollAbilitySave", "rollAbilityTest", "rollSkillV2"]:
    for m in MODS:
        for f in FILES[m]:
            for mt in re.finditer(r'\b' + api + r'\s*\??\.?\(', TEXT[f]):
                # ⚠️ A `typeof x.api === "function"` fallback is the CORRECT
                # way to support two dnd5e majors at once - it is not a defect,
                # and flagging it trains people to ignore this whole category.
                window = TEXT[f][max(0, mt.start() - 400): mt.start() + 120]
                if "typeof" in window and api in window:
                    continue
                # platform-contract.mjs NAMES these on purpose: it is the
                # inventory of every platform call ACE depends on, not a caller.
                if "platform-contract" in rel(f):
                    continue
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
            elif ("??" not in ln_txt and "=" in ln_txt
                  and not re.search(r'\.preparation[\w.]*\s*=', ln_txt)):
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
