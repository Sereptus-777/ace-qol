# ─── A profile field nobody reads is decoration ───────────────────────────────
#
# ⚠️ WHY THIS EXISTS. On 2026-08-25, in a single day, three features turned out
# to be described perfectly in code and consulted by absolutely nothing:
#
#   • `isAuraOfWarding` — written by the aura engine, read by zero files. A
#     9th-level paladin's Aura of Warding had never once halved spell damage
#     for anyone standing beside him.
#   • `special.uncannyDodge` — declared in the class-features registry, read by
#     zero files. Every rogue had taken full damage from every hit, for months.
#   • The whole attacker profile — built on every attack since 2026-07-28,
#     carrying the liveness gate and every condition, and asked for exactly
#     three numbers: proficiency and two ability modifiers.
#
# Johnny: "ACE declares it in two places and it never gets read? ... The very
# foundation of this whole thing is the attacker profile, the environment
# profile, and the target profile."
#
# He is right, and the reason it keeps happening is that nothing catches it.
# Writing a field feels like finishing the job; the wiring is invisible when it
# is missing. Reviews do not catch it, lint cannot see it, and the code reads
# perfectly either way.
#
# ═══ SO THIS IS THE CHECK ════════════════════════════════════════════════════
#
# Every field the profile exposes must be READ off an actual profile variable
# somewhere outside the profile file. A field with zero readers fails.
#
# ⚠️ IT COUNTS READS OFF A PROFILE, NOT THE WORD ANYWHERE. v1 of this check
# matched the field name against whole files and reported 8 of 17 fields
# "consulted" — most of those hits were unrelated code touching `.size` on a
# token or `.equipped` on an item. A check that over-reports is worse than no
# check, because its green is trusted. It now finds the variables actually
# assigned from a profile builder and looks only at what is read off those.
#
# ⚠️ RED IS THE HONEST STATE WHILE THE GATE IS PART-ADOPTED. The attack
# pipeline consults it today; save, damage, spell and heal do not yet. Red is
# what stops "the Gate is built" being said before it is true.
#
# Run:  python tools/profile-consumers-check.py
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
PROFILE = os.path.join(ROOT, "ace-qol", "scripts", "profiles", "attacker-profile.mjs")
BUILDERS = ["buildAttackerProfile", "_aceAttackerProfile"]
MODULES = ["ace-qol", "ace-engine", "ace-artificer"]
SKIP = {"node_modules", ".git", "packs", "assets", "sounds", "icons", "tools"}

# Plumbing rather than findings — nothing needs to consume these.
PLUMBING = {"kind", "schema", "ref", "token", "actorId", "actorUuid", "tokenId", "name"}


def profile_fields():
    """Every key the profile promises, from the object it returns."""
    src = io.open(PROFILE, encoding="utf-8", errors="ignore").read()
    i = src.find("  return {\n    kind: \"attacker-profile\"")
    if i < 0:
        print("FAIL — could not find the returned profile object.")
        print("       Fix this extractor; do not delete it, or the contract goes untested.")
        sys.exit(1)
    body = src[i:src.find("\n  };", i)]
    # ⚠️ SHORTHAND COUNTS. v2 of this check only matched `name:` and missed every
    # `canAct,` / `projectedAuras,` — eleven fields, including the liveness gate
    # and the auras, were never even tested, and it printed a confident 17.
    keys = set(re.findall(r"^    ([a-zA-Z][\w]*)\s*[:(]", body, re.M))
    keys |= set(re.findall(r"^    get ([a-zA-Z][\w]*)\s*\(", body, re.M))
    keys |= set(re.findall(r"^    ([a-zA-Z][\w]*),\s*$", body, re.M))
    return sorted(keys - PLUMBING)


def profile_vars(src):
    """Names of variables in this file that hold an attacker profile."""
    names = set()
    # A profile is often assigned through a fallback:
    #   const profile = attacker ?? _aceAttackerProfile(...)
    # v3 of this check required the builder to sit immediately after the equals
    # sign, so it missed those and reported a field as unread while a pipeline
    # was reading it two lines down. Under-reporting is the same sin as
    # over-reporting: the number stops meaning anything.
    # ⚠️ NO WORD-BOUNDARY OR NEWLINE ESCAPES IN THESE PATTERNS.
    # Written through a shell heredoc they reach Python as real escapes, so a
    # word boundary silently becomes a BACKSPACE character and the pattern then
    # matches nothing, forever, while reading perfectly correctly. That is what
    # happened to v3 of this function on 2026-08-25 -- the same trap as the nine
    # control characters found across the suite on 2026-08-22. Boundaries are
    # spelled out as lookarounds. tools/control-char-check.py already scans
    # every .mjs and .py in the suite for exactly this and would have caught it
    # in one second -- the tool existed and simply was not run.
    EDGE_L, EDGE_R = r"(?<![\w$])", r"(?![\w$])"
    for b in BUILDERS:
        head = r"(?:const|let|var)\s+([\w$]+)\s*=\s*[^;]*?"
        tail = r"\s*\("
        names |= set(re.findall(head + b + tail, src))
        loose = r"^\s*([\w$]+)\s*=\s*[^;]*?"
        names |= set(re.findall(loose + b + tail, src, re.M))
    # ...and then handed to a function, where it arrives under another name.
    # Any parameter a known profile variable is passed into counts too.
    for v in list(names):
        pat = r"([\w$]+)\s*\(([^)]*" + EDGE_L + re.escape(v) + EDGE_R + r"[^)]*)\)"
        for call in re.findall(pat, src):
            fn = call[0]
            sig = EDGE_L + re.escape(fn) + r"\s*\(([^)]*)\)\s*\{"
            m = re.search(sig, src)
            if not m:
                continue
            params = [x.strip().split("=")[0].strip() for x in m.group(1).split(",")]
            args = [x.strip() for x in call[1].split(",")]
            for i, a in enumerate(args):
                if a == v and i < len(params) and re.fullmatch(r"[\w$]+", params[i]):
                    names.add(params[i])

    # ⚠️🔴 A FILE CAN CONSUME A PROFILE WITHOUT EVER BUILDING ONE, and
    # v2 of this check could not see those files at all. profiles/resolver.mjs
    # takes the profile as a DESTRUCTURED PARAMETER - resolveAttack({ attacker,
    # attack, environment, target }) - so no `const x = buildAttackerProfile(`
    # line exists, the variable list came back empty, and the whole file was
    # skipped. It reads FOURTEEN fields. The check reported five of those as
    # "read by nothing" on 2026-08-26 and I nearly deleted them.
    #
    # ⚠️ AN AUDIT THAT UNDER-REPORTS CONSUMERS IS THE DANGEROUS DIRECTION.
    # Over-reporting wastes a look; under-reporting argues for deleting live
    # code. Both of this tool's earlier versions were wrong, in both
    # directions, and each time the number looked authoritative.
    #
    # A parameter DOCUMENTED as coming from a builder is a profile. The
    # documentation is the contract; if it lies, that is a separate bug.
    for b in BUILDERS:
        doc = (r"@param\s+\{[^}]*\}\s+(?:\[)?(?:[\w$]+\.)?([\w$]+)\]?\s+(?:from|built by)\s+" + re.escape(b))
        names |= set(re.findall(doc, src))
    return names


def consumers(fields):
    """Who reads each field off a variable that actually holds a profile."""
    found = {f: [] for f in fields}
    for mod in MODULES:
        for dp, dn, fns in os.walk(os.path.join(ROOT, mod)):
            dn[:] = [d for d in dn if d not in SKIP]
            for fn in fns:
                if not fn.endswith(".mjs"):
                    continue
                full = os.path.join(dp, fn)
                if os.path.abspath(full) == os.path.abspath(PROFILE):
                    continue
                try:
                    src = io.open(full, encoding="utf-8", errors="ignore").read()
                except OSError:
                    continue
                if not any(b in src for b in BUILDERS):
                    continue
                variables = profile_vars(src)
                if not variables:
                    continue
                rel = os.path.relpath(full, ROOT).replace("\\", "/")
                # Strip comments so a field named only in a comment never counts.
                code = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
                code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
                for v in variables:
                    for f in fields:
                        if re.search(re.escape(v) + r"\s*(?:\?\.|\.)" + re.escape(f) + r"\b", code):
                            found[f].append(rel)
    return found


def described_fields(fields):
    """Fields the profile's own describe() renders, IF anything calls it.

    ⚠️ A DESCRIBE FUNCTION IS A REAL CONSUMER WHEN SOMETHING CALLS IT.
    describeAttacker lives inside the profile file, so this check skipped it -
    but attack-pipeline.mjs calls it and logs the result on EVERY attack, so
    the fields it renders reach the GM's console every time. Calling those
    "read by nothing" argued for deleting information that is on screen.

    ⚠️ AND ONLY IF SOMETHING CALLS IT. A describe function nobody invokes
    is decoration describing decoration, and must not launder a dead field
    into a live one.
    """
    src = io.open(PROFILE, encoding="utf-8", errors="ignore").read()
    m = re.search(r"export function (describe\w+)\s*\(", src)
    if not m:
        return set(), None
    fn = m.group(1)

    called_from = []
    for mod in MODULES:
        for dp, dn, fns in os.walk(os.path.join(ROOT, mod)):
            dn[:] = [d for d in dn if d not in SKIP]
            for f in fns:
                if not f.endswith(".mjs"):
                    continue
                full = os.path.join(dp, f)
                if os.path.abspath(full) == os.path.abspath(PROFILE):
                    continue
                try:
                    t = io.open(full, encoding="utf-8", errors="ignore").read()
                except OSError:
                    continue
                if re.search(r"(?<![\w$])" + fn + r"\s*\(", t):
                    called_from.append(os.path.relpath(full, ROOT).replace("\\", "/"))
    if not called_from:
        return set(), None

    body = src[src.index("export function " + fn):]
    end = body.find(chr(10) + "}")
    body = body[:end if end > 0 else len(body)]
    seen = set(re.findall(r"(?<![\w$])p\s*\??\.\s*([A-Za-z_$][\w$]*)", body))
    return (seen & set(fields)), called_from[0]


def main():
    fields = profile_fields()
    found = consumers(fields)
    shown, describer = described_fields(fields)
    for f in shown:
        if not found[f]:
            found[f] = ["%s (via describe, logged every attack)" % describer]
    read = {f: v for f, v in found.items() if v}
    unread = [f for f, v in found.items() if not v]

    print("ATTACKER PROFILE — IS EVERY FIELD ACTUALLY CONSULTED?")
    print("=" * 78)
    print(f"\n  {len(fields)} fields promised · {len(read)} read · {len(unread)} read by nothing\n")

    if read:
        print("  CONSULTED")
        for f in sorted(read):
            print(f"     {f:<24} {', '.join(sorted(set(read[f])))}")

    if unread:
        print("\n  READ BY NOTHING — decoration until a pipeline asks")
        for f in unread:
            print(f"     {f}")

    print("\n" + "=" * 78)
    if unread:
        print(f"{len(unread)} field(s) the profile reports and nobody consults.")
        print()
        print("This is the shape of the Aura of Warding bug: information gathered")
        print("correctly and then thrown away. But READ THE LIST BEFORE ACTING ON IT,")
        print("because two different things land here and they need opposite fixes:")
        print()
        print("  1. A SECOND ANSWER TO A SOLVED QUESTION. Delete it and name the")
        print("     authority in a comment. selfAttackDisadvantage was one of these:")
        print("     a bare boolean sitting beside CombatState, which answers the same")
        print("     question with the REASON attached. Removed 2026-08-26.")
        print()
        print("  2. DECLARED SURFACE THE GATE HAS NOT REACHED YET. The attack")
        print("     pipeline consults this profile; the save, damage, spell and heal")
        print("     paths do not. Those fields are not dead - they are waiting on a")
        print("     consumer that is a DESIGN decision, not a wiring job.")
        print()
        print("  ⚠️ NEVER INVENT A CONSUMER TO TURN THIS GREEN. A fake reader is")
        print("     worse than a red number: the red is honest about how far the Gate")
        print("     has actually been adopted, and green bought with a pretend")
        print("     consumer removes the only signal that says otherwise.")
        sys.exit(1)

    print("Every field the attacker profile reports is read by a pipeline.")
    sys.exit(0)


if __name__ == "__main__":
    main()
