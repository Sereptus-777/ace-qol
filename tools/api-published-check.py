# -*- coding: utf-8 -*-
# --- An API name that nothing publishes is a feature that never runs --------
#
# WHY THIS EXISTS. On 2026-08-26 `game.aceQol.reactionEngine` turned out never
# to be assigned. It is a module-local variable in ace-qol.mjs, and six other
# files read it through optional chaining. A missing binding did nothing and
# said nothing.
#
# Dead from those paths: Cutting Words, Silvery Barbs, Absorb Elements,
# Uncanny Dodge, the post-hit save reactions, and the spell damage resolver's
# reaction pass. It surfaced only because Uncanny Dodge produced no prompt AND
# no warning after being moved to the post-roll path.
#
# NOTHING WE OWN COULD SEE IT. The syntax is valid. `no-undef` sees a property
# access, not a missing binding. Optional chaining turns the failure into a
# shrug. Same family as the renamed-method drift of 08-12.
#
# THE CHECK: every API name that is READ must be ASSIGNED somewhere, in ANY
# module. A name with readers and no writer fails.
#
# WARNING TO WHOEVER EDITS THIS. Version one of this file was WRONG, and a
# wrong audit is worse than no audit. It used a regex that demanded a comma
# straight after the API object and stopped at the first closing brace. ACE
# actually publishes through an Object.assign whose first argument is
# `game.aceQol ?? {}` and whose body is 200 lines long, so the regex matched
# nothing and reported ten live names as dead. If you change the write
# detection, run it against a name you KNOW is published and confirm green.
#
# --- NOT A DUPLICATE OF api-surface-check.py ---------------------------------
# That one asks "does this MEMBER exist on the object?" - it caught api.memory
# when the getter was memoryManager. This one asks "is this name ever ASSIGNED
# onto the API at all?" reactionEngine PASSED the surface check and failed this
# one, which is the whole reason both exist. Keep both.
#
# Run:  python tools/api-published-check.py
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = ["ace-qol", "ace-engine", "ace-artificer", "ace-envoy", "ace-token-art"]
NAMESPACES = {"aceQol": "ace-qol", "aceEngine": "ace-engine", "aceForge": "ace-artificer"}
SKIP = {"node_modules", ".git", "packs", "assets", "sounds", "icons", "fonts", "templates"}

DQ = chr(34)
SQ = chr(39)
BT = chr(96)
QUOTES = DQ + SQ + BT


def strip_noise(src):
    """Blank out comments and string bodies so prose never counts as code.

    The header of this very file names the reactionEngine API a dozen times.
    Counting that as a reader would make the check lie about its own evidence.
    """
    out = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        two = src[i:i + 2]
        if two == "//":
            j = src.find(chr(10), i)
            i = n if j < 0 else j
            continue
        if two == "/*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
            continue
        if ch in QUOTES:
            j = i + 1
            while j < n:
                if src[j] == chr(92):
                    j += 2
                    continue
                if src[j] == ch:
                    break
                j += 1
            out.append(ch + ch)  # keep the quotes, drop the body
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def match_brace(src, start):
    """Index just past the brace pair that opens at `start`. -1 if unbalanced."""
    depth = 0
    for i in range(start, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return i + 1
    return -1


def split_args(src, open_paren):
    """The argument list of a call whose open paren is at `open_paren`.

    Returns each argument as source text, split on commas that are genuinely
    between arguments rather than inside a nested object, array or call.
    """
    depth, args, cur = 0, [], []
    for i in range(open_paren, len(src)):
        ch = src[i]
        if ch in "([{":
            depth += 1
            if depth == 1:
                continue  # the call's own paren is not part of any argument
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                tail = "".join(cur).strip()
                if tail:
                    args.append(tail)
                return args
        if depth == 1 and ch == ",":
            args.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    return []


def top_level_keys(body):
    """Property names at depth ONE of an object literal body.

    Depth matters. A nested entry whose value is itself an object must
    contribute its own name and NOT the names inside it, or the check quietly
    starts believing in names that were never published at the top level.
    """
    segs, depth, cur = [], 0, []
    for ch in body:
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
        if depth == 0 and ch == ",":
            s = "".join(cur).strip()
            if s:
                segs.append(s)
            cur = []
        else:
            cur.append(ch)
    tail = "".join(cur).strip()
    if tail:
        segs.append(tail)

    out, spread = [], False
    for s in segs:
        if s.startswith("..."):
            # A spread publishes names this check cannot name. Only a
            # TOP-LEVEL one matters: a rest parameter or an array spread deep
            # inside a method body is not publishing anything, and a plain
            # substring search for three dots flags the whole 500-line API
            # literal every time.
            spread = True
            continue
        m = re.match(r"^\[?\s*([A-Za-z_$][\w$]*)\s*\]?\s*(?::|$)", s)
        if m:
            out.append(m.group(1))
    return out, spread


read_res = {a: re.compile(r"game\s*\.\s*" + a + r"\s*\??\s*\.\s*([A-Za-z_$][\w$]*)")
            for a in NAMESPACES}
write_res = {a: re.compile(r"game\s*\.\s*" + a + r"\s*\??\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\?|\|\|)?=(?!=)")
             for a in NAMESPACES}
obj_res = {a: re.compile(r"game\s*\.\s*" + a + r"\s*=\s*\{") for a in NAMESPACES}


def scan_source(raw, api):
    """Names READ and names PUBLISHED for one namespace in one file's source.

    Both the tree walk and the self-test go through here, so the self-test
    exercises the same code that audits the suite. A self-test with its own
    private copy of the logic proves nothing.
    """
    code = strip_noise(raw)
    r, w, spread = set(), set(), False

    for m in read_res[api].finditer(code):
        r.add(m.group(1))
    for m in write_res[api].finditer(code):
        w.add(m.group(1))

    # Object.assign(<anything naming game.<api>>, { ... }, ...)
    #
    # WARNING. Take the ARGUMENTS apart; do not grab the first brace you see.
    # ACE publishes through `Object.assign(game.aceQol ?? {}, { ...200 lines
    # ... })` and the `{}` in that fallback is the FIRST brace in the call.
    # Version two of this file matched it, found an empty body, and reported
    # ten live names as dead.
    for m in re.finditer(r"Object\s*\.\s*assign\s*\(", code):
        args = split_args(code, m.end() - 1)
        if not args:
            continue
        if ("game." + api) not in args[0].replace(" ", ""):
            continue
        for arg in args[1:]:
            arg = arg.strip()
            if not arg.startswith("{"):
                continue  # a variable, not a literal we can read
            body = arg[1:-1] if arg.endswith("}") else arg[1:]
            keys, had_spread = top_level_keys(body)
            for k in keys:
                w.add(k)
            spread = spread or had_spread

    # game.<api> = { ... }   (the pre-2026-07-28 shape, still legal)
    for m in obj_res[api].finditer(code):
        brace = code.rindex("{", m.start(), m.end())
        close = match_brace(code, brace)
        if close < 0:
            continue
        body = code[brace + 1:close - 1]
        keys, had_spread = top_level_keys(body)
        for k in keys:
            w.add(k)
        spread = spread or had_spread

    return r, w, spread


# --- Prove the checker before trusting the checker --------------------------
#
# This file has been wrong TWICE. Version one demanded a comma straight after
# the API object; version two grabbed the empty braces out of a `?? {}`
# fallback. Both printed a confident list of dead names that were all alive.
# So the cases below run the real extractor over the real shapes ACE uses, and
# nothing gets audited until they pass.
SELFTEST = [
    ("the reactionEngine bug, exactly as it was",
     "const reactionEngine = new ReactionEngine();"
     "\nawait game.aceQol?.reactionEngine?.check(x);",
     "reactionEngine", False),
    ("the reactionEngine fix, exactly as it now is",
     "Object.assign(game.aceQol, { reactionEngine });"
     "\nawait game.aceQol?.reactionEngine?.check(x);",
     "reactionEngine", True),
    ("ACE's real publish shape, with the empty-brace fallback first",
     "game.aceQol = Object.assign(game.aceQol ?? {}, {"
     "\n  debugHooks: setHookDebug,"
     "\n  dice: { show: safeShowForRoll, settle: (ms) => 0 },"
     "\n  distanceFt,"
     "\n});"
     "\ngame.aceQol?.dice?.show(); game.aceQol?.distanceFt?.();",
     "dice", True),
    ("a name nested INSIDE another entry is not published at the top level",
     "Object.assign(game.aceQol ?? {}, { dice: { settle: f } });"
     "\ngame.aceQol?.settle?.();",
     "settle", False),
    ("a name that only ever appears in a comment is not published",
     "// game.aceQol.ghost = something"
     "\ngame.aceQol?.ghost?.();",
     "ghost", False),
    ("a name that only ever appears in a string is not published",
     "log(" + DQ + "game.aceQol.ghost2 = x" + DQ + ");"
     "\ngame.aceQol?.ghost2?.();",
     "ghost2", False),
    ("a plain property assignment publishes",
     "game.aceQol.repairTokenNames = fn;"
     "\ngame.aceQol?.repairTokenNames?.();",
     "repairTokenNames", True),
]

# Always. A gate you can skip is a gate that gets skipped.
if True:
    bad = []
    for title, src, name, want_published in SELFTEST:
        _r, _w, _s = scan_source(src, "aceQol")
        got = name in _w
        if got != want_published or name not in _r:
            bad.append((title, name, want_published, got, name in _r))
    if bad:
        print("")
        print("THE CHECKER ITSELF IS BROKEN - refusing to audit anything.")
        for title, name, want, got, was_read in bad:
            print("  FAIL  " + title)
            print("        %s: published=%s expected=%s, seen as a read=%s"
                  % (name, got, want, was_read))
        sys.exit(2)

reads, writes, spreads = {}, {}, {}
for _api in NAMESPACES:
    reads[_api], writes[_api], spreads[_api] = {}, {}, set()

files_seen = 0
for mod in MODULES:
    base = os.path.join(ROOT, mod)
    if not os.path.isdir(base):
        continue
    for dp, dn, fns in os.walk(base):
        dn[:] = [d for d in dn if d not in SKIP]
        for fn in fns:
            if not (fn.endswith(".mjs") or fn.endswith(".js")):
                continue
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, ROOT).replace("\\", "/")
            try:
                raw = io.open(full, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            files_seen += 1
            for api in NAMESPACES:
                r, w, spread = scan_source(raw, api)
                for n in r:
                    reads[api].setdefault(n, set()).add(rel)
                for n in w:
                    writes[api].setdefault(n, set()).add(rel)
                if spread:
                    spreads[api].add(rel)

total_dead = 0
print("")
print("ACE API - IS EVERY NAME THAT IS READ ACTUALLY PUBLISHED?")
print("=" * 78)
print("  %d source files across %d modules" % (files_seen, len(MODULES)))

for api, home in NAMESPACES.items():
    r, w = reads[api], writes[api]
    if not r and not w:
        continue
    dead = dict((n, v) for n, v in r.items() if n not in w)
    print("")
    print("  game.%s   (published from %s)" % (api, home))
    print("     %d name(s) read - %d published - %d read by somebody, published by nobody"
          % (len(r), len(w), len(dead)))
    if spreads[api]:
        print("     note: a spread hides names from this check, in "
              + ", ".join(sorted(spreads[api])))
    for n in sorted(dead):
        total_dead += 1
        readers = sorted(dead[n])
        print("")
        print("     DEAD  game.%s.%s" % (api, n))
        print("           read in %d file(s), assigned in none:" % len(readers))
        for f in readers:
            print("             " + f)

print("")
print("=" * 78)
if total_dead:
    print("%d API name(s) that nothing ever assigns." % total_dead)
    print("")
    print("Every reader of these is doing nothing, silently, because optional")
    print("chaining turns a missing binding into a shrug. Publish it, or delete")
    print("the readers - but do not leave a feature wired to a name that does")
    print("not exist.")
    sys.exit(1)

print("Every API name that is read is published somewhere.")
sys.exit(0)
