#!/usr/bin/env python3
# ─── Does any ACE subsystem register a ready hook that can never fire? ───────
#
# ⚠️ THE BUG (proven live 2026-08-12, and again 2026-08-19):
# `Hooks.once("ready", ...)` registered from INSIDE a ready handler waits on an
# event ALREADY IN PROGRESS. It never fires. Nothing throws, nothing logs, and
# the subsystem's own "online" message still prints, so the module looks
# healthy while the work simply never happens.
#
# ⚠️ INDENTATION IS NOT THE TEST, AND CHECKING IT IS WORSE THAN USELESS.
# The first version of this check looked for an indented `Hooks.once("ready"`.
# It used `^\s+`, and `\s` matches a NEWLINE — so every top-level hook that
# happened to follow a blank line was reported. Eight false positives, and it
# missed all four of the real ones, because the real ones are at perfectly
# ordinary indentation inside a class method. What matters is not where the
# line sits, it is WHEN the enclosing code runs.
#
# THE REAL TEST: find every class that registers a ready hook anywhere in its
# body, then find where that class is constructed. If any `new ClassName()` sits
# inside a top-level ready block, that class's ready hook is dead.
#
# The fix is always the same:
#     const run = () => { ... };
#     if (game.ready) run(); else Hooks.once("ready", run);
import os, re, sys

NL = chr(10)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODS = ["ace-qol", "ace-engine", "ace-artificer", "ace-envoy"]

files = []
for m in MODS:
    for base in ("scripts", "src"):
        d = os.path.join(ROOT, m, base)
        if not os.path.isdir(d):
            continue
        for dp, dns, fns in os.walk(d):
            if ".git" in dp:
                continue
            for fn in fns:
                if fn.endswith((".mjs", ".js")):
                    files.append(os.path.join(dp, fn))

def strip_comments(src):
    """Blank out comments, preserving length so byte offsets and line numbers
    still line up.

    ⚠️ WITHOUT THIS THE TOOL FLAGS ITS OWN DOCUMENTATION. The comments warning
    about this very bug contain the literal text Hooks.once("ready"), so the
    scan matched them and reported two files that had already been fixed.
    A checker that cannot tell code from prose about code is noise."""
    out = list(src)
    i, n_ = 0, len(src)
    while i < n_:
        c = src[i]
        if c in "\"'`":
            q = c
            i += 1
            while i < n_ and src[i] != q:
                if src[i] == "\\":
                    i += 1
                i += 1
            i += 1
            continue
        if src.startswith("//", i):
            while i < n_ and src[i] != NL:
                out[i] = " "
                i += 1
            continue
        if src.startswith("/*", i):
            while i < n_ and not src.startswith("*/", i):
                if src[i] != NL:
                    out[i] = " "
                i += 1
            for k in range(i, min(i + 2, n_)):
                out[k] = " "
            i += 2
            continue
        i += 1
    return "".join(out)

TEXT = {}
for f in files:
    try:
        TEXT[f] = strip_comments(open(f, encoding="utf-8", errors="ignore").read())
    except Exception:
        TEXT[f] = ""

def rel(f):
    return os.path.relpath(f, ROOT).replace("\\", "/")

READY = re.compile(r'Hooks\.once\(\s*["\']ready["\']')
SAFE  = re.compile(r'game\.ready\s*\)')

# ── 1. which classes register a ready hook, and is it guarded? ──────────────
#
# ⚠️ THE HOOK MUST BE INSIDE THE CLASS BODY, not merely after the class
# declaration. Attributing by "the nearest class above it" reported
# audit-app.mjs, whose ready hook sits at FILE SCOPE 50 lines below the class
# and fires perfectly well because the file is statically imported. Ownership
# is a brace range, not a line ordering.
def class_bodies(txt):
    """[(name, start, end)] for each class, by real brace matching."""
    out = []
    for m in re.finditer(r'^\s*(?:export\s+)?class\s+(\w+)', txt, re.M):
        try:
            i = txt.index("{", m.start())
        except ValueError:
            continue
        d = 0
        while i < len(txt):
            if txt[i] == "{":
                d += 1
            elif txt[i] == "}":
                d -= 1
                if d == 0:
                    break
            i += 1
        out.append((m.group(1), m.start(), i))
    return out

class_ready = {}          # ClassName -> [(file, line, guarded)]
for f in files:
    txt = TEXT[f]
    bodies = class_bodies(txt)
    for m in READY.finditer(txt):
        ln = txt[:m.start()].count(NL) + 1
        owner = next((name for name, a, b in bodies if a <= m.start() <= b), None)
        if not owner:
            continue      # file scope: runs at module load, which is fine
        # guarded if `game.ready` appears within the preceding 400 chars
        guarded = bool(SAFE.search(txt[max(0, m.start() - 400): m.start()]))
        class_ready.setdefault(owner, []).append((rel(f), ln, guarded))

# ── 2. top-level ready blocks, by byte range, per file ─────────────────────
def ready_ranges(txt):
    out = []
    for m in re.finditer(r'^Hooks\.once\(\s*["\']ready["\']', txt, re.M):
        depth, i, started = 0, m.start(), False
        while i < len(txt):
            c = txt[i]
            if c == "{":
                depth += 1
                started = True
            elif c == "}":
                depth -= 1
                if started and depth == 0:
                    out.append((m.start(), i))
                    break
            i += 1
    return out

problems = []
for f in files:
    txt = TEXT[f]
    ranges = ready_ranges(txt)
    if not ranges:
        continue
    for m in re.finditer(r'\bnew\s+(\w+)\s*\(', txt):
        cls = m.group(1)
        if cls not in class_ready:
            continue
        if not any(a <= m.start() <= b for a, b in ranges):
            continue
        for (cf, cl, guarded) in class_ready[cls]:
            if guarded:
                continue
            ln = txt[:m.start()].count("\n") + 1
            problems.append(
                f"{cls} is constructed at {rel(f)}:{ln}, INSIDE a top-level ready block\n"
                f"      -> its Hooks.once(\"ready\") at {cf}:{cl} can never fire")

print("=" * 74)
print("READY-HOOK REACHABILITY")
print("=" * 74)
if problems:
    for p in sorted(set(problems)):
        print("  !! " + p)
    print(f"\n{len(set(problems))} dead registration(s).")
    print('Fix: const run = () => {...}; if (game.ready) run(); else Hooks.once("ready", run);')
    sys.exit(1)
print("  every ready registration is reachable, or guarded with game.ready")


# ═══════════════════════════════════════════════════════════════════════════
#  canvasReady is the SAME TRAP with a different event name
# ═══════════════════════════════════════════════════════════════════════════
#
# 2026-08-27. The aura rings never drew. AuraEngine.init() registers a
# `canvasReady` listener, and init() is called from ace-qol.mjs's own `ready`
# handler - by which time Foundry has ALREADY fired canvasReady. The listener
# waited for an event in the past: the ring layer never attached, recomputeAll
# never ran, nothing threw and nothing logged. Rings appeared only if the GM
# changed scene.
#
# Identical in shape to the `Hooks.once("ready")` inside `ready` bug of
# 2026-08-12 that left thirteen condition ghosts alive. The rule is not about
# `ready` specifically: it is about ANY lifecycle event that may already have
# happened. Run it now if the world is already in that state, AND subscribe
# for next time.
#
# ⚠️ THIS SECTION REPORTS, IT DOES NOT ACCUSE. A canvasReady listener
# registered at module top level fires at import, long before canvasReady, and
# is perfectly correct. Only one registered from inside a ready handler is
# broken - and that is not decidable by reading a single line. A first sweep
# flagged 28 of these and most were fine. Treat this as a list to review.
print("")
print("canvasReady LISTENERS - review, do not mass-edit")
print("=" * 74)
_unguarded = 0
for _mod in MODS:
    _root = os.path.join(ROOT, _mod, "scripts")
    if not os.path.isdir(_root):
        continue
    for _dp, _dn, _fns in os.walk(_root):
        for _fn in _fns:
            if not _fn.endswith(".mjs"):
                continue
            _f = os.path.join(_dp, _fn)
            try:
                _src = open(_f, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            _code = re.sub(r"/\*.*?\*/", "", _src, flags=re.S)
            _code = re.sub(r"^\s*//.*$", "", _code, flags=re.M)
            for _m in re.finditer(r"Hooks\.(?:on|once)\(\s*[\"']canvasReady[\"']", _code):
                _ln = _code[:_m.start()].count(chr(10)) + 1
                _line = _code.split(chr(10))[_ln - 1]
                _toplevel = not _line.startswith(" ")
                _win = _code[max(0, _m.start() - 1500):_m.start() + 900]
                _guarded = "canvas?.ready" in _win or "canvas.ready" in _win
                if _toplevel or _guarded:
                    continue
                _unguarded += 1
                print("   %s:%d" % (os.path.relpath(_f, ROOT).replace("\\", "/"), _ln))
print("")
print("   %d nested canvasReady listener(s) with no already-ready guard." % _unguarded)
print("   Each is only a bug if its registration runs AFTER canvasReady has")
print("   fired - typically from inside a ready handler. Check the caller.")
