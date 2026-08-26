# -*- coding: utf-8 -*-
# --- An abandoned attack must say so, or its animation is lost -------------
#
# THE CONTRACT. ace-artificer's FX runtime holds a weapon's effects from
# `dnd5e.postCreateUsageMessage` until ace-qol emits ONE of two hooks:
#
#     ace-qol.attackCommitted   every prompt is closed, the swing is real
#     ace-qol.attackCancelled   it is not happening; drop the hold
#
# Between those two points, EVERY path that abandons the attack has to emit
# the cancel. Miss one and that use's animation never plays.
#
# WHY A TOOL AND NOT A COMMENT. attack-pipeline.mjs already carried the
# sentence "EVERY GIVE-UP PATH CALLS THIS" - written on 2026-08-26, in the
# same change that missed five of them:
#
#   1. the target picker closed without picking
#   2. the Gate refusing an attacker who cannot act
#   3. autoCheckHit switched off
#   4. _pickTargetThenRefire's catch  - and its own log said "attack cancelled"
#   5. _promptThenRefire's catch      - same
#
# Four and five are the nastiest: both callers deliberately `return false` to
# kill the original roll, betting on a re-fire that the helper is supposed to
# start. Neither is awaited. If the helper throws, no roll ever happens, and
# nothing anywhere commits or cancels.
#
# A comment cannot count. This can.
#
# Run:  python tools/attack-handoff-check.py
import io
import os
import re
import sys

PIPE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "scripts", "attack-pipeline.mjs")

# The helpers that a `return false` hands off to. If one of these is started
# and then throws, the roll it cancelled never comes back.
REFIRE = ("_pickTargetThenRefire", "_promptThenRefire")

src = io.open(PIPE, encoding="utf-8", errors="ignore").read()
code = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
lines = code.split(chr(10))


def enclosing(idx):
    """Name of the method containing this line."""
    for i in range(idx, -1, -1):
        m = re.match(r"^  (?:static\s+)?(?:async\s+)?([_a-zA-Z][\w$]*)\s*\(", lines[i])
        if m:
            return m.group(1)
    return "(top level)"


def announces_near(idx):
    """Is a cancel announced in THIS exit's own block?

    WARNING. Version three asked "within 14 lines above", and its own
    self-test caught it out: the `if (!roll)` exit sat a few lines below an
    UNRELATED announce for the autoCheckHit gate, so deleting its own announce
    changed nothing and the check stayed green.

    Proximity is not coverage. Walk up by brace depth instead and stop at the
    line that opened this block, so only an announce genuinely guarding THIS
    exit counts.
    """
    depth = 0
    for i in range(idx, -1, -1):
        line = lines[i]
        if "_announceAttackCancelled" in line and depth <= 0:
            return True
        # Walking upward, a closing brace goes deeper and an opening brace
        # comes back out. Leaving this block means we are done looking.
        depth += line.count("}") - line.count("{")
        if depth < 0:
            return False
    return False


problems = []


def span_of(name):
    """(first, last) line indices of a method body, by brace depth."""
    m = re.search(r"^  (?:static\s+)?(?:async\s+)?" + name + r"\s*\(", code, re.M)
    if not m:
        return None
    start = code[:m.start()].count(chr(10))
    depth = 0
    for i in range(start, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        if i > start and depth <= 0:
            return (start, i)
    return (start, len(lines) - 1)


# ---- 1. `return false` in the pre-roll handler CANCELS the dnd5e roll ------
#
# WARNING. Version one flagged four predicates - `_isMeleeAttack` and friends,
# whose entire job is to return false. Counting an ANSWER as a give-up is the
# same mistake the silent-exit and timer audits both made on 2026-08-26.
CANCELS_THE_ROLL = "_onPreAttackRoll"
for i, line in enumerate(lines):
    if not re.search(r"\breturn\s+false\s*;", line):
        continue
    if enclosing(i) != CANCELS_THE_ROLL:
        continue
    if announces_near(i):
        continue
    lo = max(0, i - 6)
    if any(h in chr(10).join(lines[lo:i + 1]) for h in REFIRE):
        continue   # hands off to a re-fire; that helper is checked below
    problems.append((i + 1, CANCELS_THE_ROLL,
                     "cancels the roll and announces nothing", line.strip()[:70]))

# ---- 2. EVERY exit from a re-fire helper ----------------------------------
#
# WARNING. Version two of this check only looked at `return false` and at
# `catch`, went green, and was PROVEN BLIND by its own self-test: deleting the
# announce from the target-picker path changed nothing, because that exit is a
# bare `return;` inside a helper. A checker that passes because it is not
# looking is worse than no checker.
#
# These helpers are the end of the line: their caller already returned false to
# kill the original roll, betting on a re-fire that is never awaited. Any way
# out of here that is not "a new roll was started" must announce.
for name in REFIRE:
    span = span_of(name)
    if not span:
        problems.append((0, name, "helper not found - renamed?", ""))
        continue
    first, last = span
    started_a_roll = False
    for i in range(first, last + 1):
        line = lines[i]
        if "rollAttack(" in line:
            started_a_roll = True
        if re.search(r"\breturn\b", line) and not announces_near(i):
            problems.append((i + 1, name,
                             "leaves the helper without announcing; the original roll "
                             "was already cancelled", line.strip()[:70]))
        if re.search(r"\}\s*catch\s*\(", line):
            if "_announceAttackCancelled" not in chr(10).join(lines[i:last + 1]):
                problems.append((i + 1, name,
                                 "a catch here ends an attack whose roll was already "
                                 "cancelled, and announces nothing", line.strip()[:70]))
    if not started_a_roll:
        problems.append((first + 1, name,
                         "never calls rollAttack - the cancelled roll is never replaced", ""))

# ---- 3. Every exit from the roll handler BEFORE the commit -----------------
#
# `attackCommitted` is what releases the hold. Anything that leaves this
# function above that line abandons the attack.
span = span_of("_onAttackRoll")
if not span:
    problems.append((0, "_onAttackRoll", "handler not found - renamed?", ""))
else:
    first, last = span
    commit = None
    for i in range(first, last + 1):
        if "attackCommitted" in lines[i]:
            commit = i
            break
    if commit is None:
        problems.append((first + 1, "_onAttackRoll",
                         "emits no attackCommitted - nothing would ever release a hold", ""))
    else:
        for i in range(first, commit):
            line = lines[i]
            if not re.search(r"\breturn\s*;", line):
                continue
            # The handler's own front door: these run before `item`/`actor`
            # exist, so there is nothing to announce about yet.
            if re.search(r"!game\.user\.isGM|!subject|!item \|\| !actor", line):
                continue
            if announces_near(i):
                continue
            problems.append((i + 1, "_onAttackRoll",
                             "leaves before attackCommitted without announcing",
                             line.strip()[:70]))

print("")
print("ATTACK HAND-OFF: DOES EVERY ABANDONED SWING RELEASE ITS FX HOLD?")
print("=" * 78)
commits = len(re.findall(r"attackCommitted", code))
cancels = len(re.findall(r"_announceAttackCancelled\s*\(", code)) - 1
print("  %d commit emission(s) - %d cancel call site(s)" % (commits, cancels))

if problems:
    print("")
    for ln, fn, why, snippet in problems:
        print("  UNANNOUNCED  %s:%s" % (fn, ln))
        print("      %s" % why)
        if snippet:
            print("      %s" % snippet)
    print("")
    print("=" * 78)
    print("%d path(s) abandon an attack without telling Forge." % len(problems))
    print("Each one silently loses that use's animation. Call")
    print("_announceAttackCancelled(item, actor, why) before the exit.")
    sys.exit(1)

print("")
print("=" * 78)
print("Every path that abandons an attack announces it.")
sys.exit(0)
