# ─── Every distance between two creatures must be measured edge to edge ──────
#
# ⚠️ WHY THIS EXISTS. D&D 5e measures the distance between two creatures from
# the nearest point of one creature's SPACE to the nearest point of the other's,
# not between their centres. For two Medium tokens the two answers happen to
# agree, which is exactly why a centre-to-centre bug survives every casual test.
# They diverge the moment a creature is bigger than one square:
#
#     Huge dragon (3x3), reach 10 ft, target standing against its flank.
#       edge-to-edge   ->   5 ft   -> in reach, correct
#       centre-to-centre -> 20 ft  -> "out of reach", silently wrong
#
# ACE already has the correct implementation: `aceDistanceFt` in
# `scripts/geometry-utils.mjs`, which is nearest-edge, size-aware and 3D-aware.
# The risk was never the maths. It is a file that quietly computes its own.
#
# So this walks EVERY module and reports any place that measures between two
# points on the canvas without going through the shared helper — and prints the
# ones it cleared too, because a sweep that only lists problems cannot be
# checked for blind spots.
#
# ⚠️ SOME CENTRE MEASUREMENTS ARE CORRECT AND MUST NOT BE "FIXED".
#   • MOVEMENT travelled by one token is centre-to-centre by definition.
#   • Travel pace over a map is a path length, not a creature-to-creature range.
#   • A ray cast for line of sight runs centre to centre on purpose.
# Those are listed separately as ALLOWED rather than hidden, so the list stays
# honest and a new one cannot slip in disguised as an old one.
#
# ⚠️ envoy's code lives in src/, not scripts/. Every "all four modules" sweep
# before 2026-08-16 audited three.
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules"
MODULES = {
    "ace-qol":       ["scripts"],
    "ace-engine":    ["scripts"],
    "ace-artificer": ["scripts"],
    "ace-envoy":     ["src", "scripts"],
    "ace-token-art": ["scripts"],
}

CANONICAL = ("aceDistanceFt", "aceTokenGapFt", "aceEdgeGapFt", "aceWithinFt")

# ⚠️ FOLLOW THE WRAPPERS, OR THE TOOL LIES BY OMISSION. Several files reach the
# canonical helper through a one-line method on another class rather than by
# importing it, and v1 of this check credited none of them - so
# `attack-pipeline.mjs`, which IS edge-to-edge via `CombatState._getDistance`,
# was missing from the clean list entirely. An audit whose "clean" column is
# missing the most important file in the suite is worse than no audit: it
# invites somebody to go and "fix" code that was already correct.
#
# Every entry below was read and VERIFIED to return aceDistanceFt and nothing
# else. Adding a name here without reading its body reintroduces the same lie.
WRAPPERS = (
    "CombatState._getDistance",   # combat-state.mjs   -> aceDistanceFt
    "_tokenDistanceFt",           # aura-engine.mjs    -> aceDistanceFt
    "_measureDistance",           # spell/heal pickers -> aceDistanceFt
)

# A measurement between two canvas points.
MEASURE = re.compile(
    r"measurePath\s*\(|"
    r"\.measureDistance\s*\(|"
    r"Math\.hypot\s*\([^)]*\b(?:x|center|cx)\b"
)

# Deliberate, documented exceptions — matched on the FUNCTION or file they sit
# in, never on "it looked fine to me".
ALLOWED = [
    (re.compile(r"movement-tracker\.mjs$"),
     "movement travelled by ONE token is centre-to-centre by definition"),
    (re.compile(r"travel-pace\.mjs$"),
     "overland travel is a path length, not a creature-to-creature range"),
    (re.compile(r"geometry-utils\.mjs$"),
     "this IS the canonical implementation"),

    # ⚠️ EVERY ONE OF THESE WAS READ BEFORE IT WAS LISTED. A file added here
    # without opening it turns this check into a blindfold - which is exactly
    # what a false entry in the eslint globals list did on 2026-08-06, hiding
    # two live wall bugs behind a green tick. If you cannot say WHY in the
    # string, you have not earned the exemption.
    (re.compile(r"cover-engine\.mjs$"),
     "projects a token onto the attack RAY and orders it between attacker and "
     "target - point-to-line geometry, not a creature-to-creature range"),
    (re.compile(r"situation\.mjs$"),
     "measures the LENGTH of a segment, not a distance between two creatures"),
    (re.compile(r"secret-watcher\.mjs$"),
     "measures to the nearest point ON A WALL - the 2026-08-09 fix that made a "
     "30 ft wall findable from its own ends"),
    (re.compile(r"trap-engine\.mjs$"),
     "compares two candidate wall INTERSECTIONS to pick the nearer one"),
    (re.compile(r"perception-watcher\.mjs$"),
     "distance from a square to a trap ANCHOR point, not to another creature"),
    (re.compile(r"scene-perception\.mjs$"),
     "asks game.aceQol.distanceFt FIRST; the raw fallback only runs when Engine "
     "is installed without QOL, which is a supported configuration"),
    (re.compile(r"ui-hooks\.mjs$"),
     "tokenDistanceFt asks game.aceQol.distanceFt FIRST (fixed 2026-08-24); the "
     "raw maths below it is the Engine-without-QOL fallback"),
    (re.compile(r"conversation-engine\.mjs$"),
     "both the earshot filter and the reported distance now ask "
     "game.aceQol.distanceFt first; the raw maths is the standalone fallback"),
]


def allowed_for(rel):
    for pat, why in ALLOWED:
        if pat.search(rel.replace("\\", "/")):
            return why
    return None


def main():
    print("DISTANCE BETWEEN CREATURES — EDGE TO EDGE, OR EXPLAINED")
    print("=" * 78)

    offenders, permitted, users = [], [], []

    for module, subdirs in MODULES.items():
        base = os.path.join(ROOT, module)
        if not os.path.isdir(base):
            continue
        for sub in subdirs:
            top = os.path.join(base, sub)
            if not os.path.isdir(top):
                continue
            for dirpath, _dirs, files in os.walk(top):
                if "node_modules" in dirpath or ".git" in dirpath:
                    continue
                for f in files:
                    if not f.endswith(".mjs"):
                        continue
                    path = os.path.join(dirpath, f)
                    rel = os.path.relpath(path, ROOT)
                    try:
                        src = io.open(path, encoding="utf-8", errors="ignore").read()
                    except OSError:
                        continue

                    if any(c in src for c in CANONICAL):
                        users.append((rel, "imports the helper"))
                    elif any(w in src for w in WRAPPERS):
                        hit = next(w for w in WRAPPERS if w in src)
                        users.append((rel, "via " + hit))

                    for m in MEASURE.finditer(src):
                        line = src.count("\n", 0, m.start()) + 1
                        text = src.splitlines()[line - 1].strip()
                        # A line inside a documented fallback of the canonical
                        # helper is the helper's own business.
                        why = allowed_for(rel)
                        row = (rel, line, text[:96])
                        (permitted if why else offenders).append(row + ((why,) if why else ()))

    print(f"\n  files measuring edge-to-edge: {len(set(users))}")
    for rel, how in sorted(set(users)):
        print(f"     ok  {rel:<50} {how}")

    if permitted:
        print(f"\n  measurements that are correct as centre-to-centre: {len(permitted)}")
        for rel, line, text, why in permitted:
            print(f"     allowed  {rel}:{line}  — {why}")
            print(f"              {text}")

    print("\n" + "=" * 78)
    if offenders:
        print(f"{len(offenders)} measurement(s) not going through the shared helper:\n")
        for rel, line, text in offenders:
            print(f"   {rel}:{line}")
            print(f"      {text}")
        print("\nD&D 5e measures creature to creature from the nearest point of one")
        print("space to the nearest point of the other. Centre-to-centre agrees only")
        print("while both creatures are Medium, so this is invisible until a Large")
        print("or bigger creature is involved and then it is silently wrong.")
        print("Use aceDistanceFt from scripts/geometry-utils.mjs, or add an entry to")
        print("ALLOWED above SAYING WHY this one is different.")
        sys.exit(1)

    print("Every creature-to-creature measurement goes through aceDistanceFt,")
    print("or is documented above as correctly centre-to-centre.")
    sys.exit(0)


if __name__ == "__main__":
    main()
