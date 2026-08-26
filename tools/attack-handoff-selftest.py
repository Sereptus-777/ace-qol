# -*- coding: utf-8 -*-
# --- Prove attack-handoff-check.py can still see -----------------------------
#
# WHY THIS EXISTS. `attack-handoff-check.py` reported "Every path that abandons
# an attack announces it" while being structurally incapable of noticing four
# of the five known paths. It only inspected `return false` and `catch`; the
# target-picker path is a bare `return;` inside a helper. It was green because
# it was not looking.
#
# That is the same shape as every other bad audit of 2026-08-26, and the reason
# a green light from a checker is worth nothing until the checker has been made
# to go red on purpose.
#
# HOW IT WORKS. For each known give-up path, delete that path's announce call
# from a COPY of the pipeline, run the checker, and require it to fail. The
# original is restored in `finally` - a self-test that can leave the source
# damaged is worse than no self-test.
#
# ADD A CASE whenever a new give-up path is announced in attack-pipeline.mjs.
# A path the self-test does not cover is a path the checker may be blind to.
#
# Run:  python tools/attack-handoff-selftest.py
import io
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PIPE = os.path.join(HERE, "..", "scripts", "attack-pipeline.mjs")
CHECK = os.path.join(HERE, "attack-handoff-check.py")
BACKUP = PIPE + ".selftest-backup"

CASES = [
    ("the target picker closed (a bare return inside a helper)",
     '      _announceAttackCancelled(item, actor, "the target picker was closed without picking");'),
    ("the target-picker re-fire threw (path four)",
     '      _announceAttackCancelled(item, actor, `the target picker or re-fire threw: ${err?.message ?? err}`);'),
    ("the advantage-prompt re-fire threw (path five)",
     '      _announceAttackCancelled(item, actor, `the advantage prompt or re-fire threw: ${err?.message ?? err}`);'),
    ("the Gate refusing an attacker who cannot act",
     '      _announceAttackCancelled(item, actor, `${attacker.name} cannot act: ${attacker.cannotActBecause}`);'),
    ("autoCheckHit switched off inside the roll handler",
     '      _announceAttackCancelled(item, actor, "ACE is not checking hits, so it resolves nothing");'),
    ("a roll that carried no dice",
     '      _announceAttackCancelled(item, actor, "the roll carried no dice");'),
]

print("")
print("CAN THE HAND-OFF CHECK ACTUALLY SEE EACH PATH?")
print("=" * 78)

shutil.copy2(PIPE, BACKUP)
blind, missing = [], []
try:
    original = io.open(PIPE, encoding="utf-8", newline="").read()

    # Baseline: it must be GREEN before any case, or every result below is noise.
    base = subprocess.run([sys.executable, CHECK], capture_output=True, text=True)
    if base.returncode != 0:
        print("")
        print("  The pipeline already fails the check, so nothing here proves")
        print("  anything. Fix the real finding first:")
        print("")
        print(base.stdout)
        sys.exit(2)

    for label, line in CASES:
        if line not in original:
            missing.append(label)
            print("  MISSING  %s" % label)
            print("           the announce call this case removes no longer exists;")
            print("           the path was renamed, moved, or is genuinely gone.")
            continue
        io.open(PIPE, "w", encoding="utf-8", newline="").write(
            original.replace(line, "      // REMOVED BY SELF-TEST", 1))
        r = subprocess.run([sys.executable, CHECK], capture_output=True, text=True)
        caught = r.returncode != 0 and "UNANNOUNCED" in r.stdout
        if not caught:
            blind.append(label)
        print("  %-8s %s" % ("caught" if caught else "BLIND", label))
finally:
    shutil.move(BACKUP, PIPE)

print("")
print("=" * 78)
if blind or missing:
    if blind:
        print("The check CANNOT see %d path(s):" % len(blind))
        for b in blind:
            print("  - %s" % b)
        print("")
        print("A checker that passes because it is not looking is worse than no")
        print("checker: it converts an unknown risk into a false assurance.")
    if missing:
        print("%d case(s) reference an announce call that no longer exists." % len(missing))
        print("Update this file, or the coverage it claims is imaginary.")
    sys.exit(1)

print("The check goes red on every known give-up path. Its green means something.")
sys.exit(0)
