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


def main():
    fields = profile_fields()
    found = consumers(fields)
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
        print("This is the exact shape of the Aura of Warding bug: the information")
        print("is gathered correctly and then thrown away. Either wire a pipeline to")
        print("read the field, or drop it from the returned object so the profile")
        print("stops promising something it does not deliver.")
        sys.exit(1)

    print("Every field the attacker profile reports is read by a pipeline.")
    sys.exit(0)


if __name__ == "__main__":
    main()
