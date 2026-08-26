# ─── Nothing waits on a clock. It waits on the thing that has to happen. ─────
#
# ⚠️ JOHNNY'S RULE, GIVEN REPEATEDLY AND BROKEN REPEATEDLY (2026-08-24, after a
# session collapsed mid-play):
#
#   "I told you I did not want anything on a timer. I don't want things on a
#    timer. I want them to react because something has happened already. Not
#    'we'll time it and then just wait 15,000 ms and then go'."
#
# He is right, and not as a style preference. A timer encodes a GUESS about how
# long somebody else's code takes. The guess holds on the machine it was written
# on, with two tokens on an empty map, and stops holding on a full battlefield
# with Dice So Nice, Sequencer and forty tokens — which is to say it holds in
# testing and fails at the table. Every one of these is a bug that has not
# happened yet.
#
# ═══ THE FOUR KINDS, AND ONLY ONE IS DEFENSIBLE ══════════════════════════════
#
#   WAIT     `await new Promise(r => setTimeout(r, N))` — the pipeline STOPS for
#            N ms and then continues regardless of whether the thing it was
#            waiting for happened. This is the poison. There is always a real
#            signal: a hook, a promise, an event. Use it.
#
#   POLL     a timer that re-arms itself to check a condition again. Replace
#            with the event that changes the condition.
#
#   DEFER    `setTimeout(fn, 0)` or a single frame — yielding to let Foundry
#            finish painting before reading the DOM. Legitimate, but say so.
#
#   BACKSTOP a cap that RACES a real signal and only fires if that signal never
#            comes. Defensible ONLY when a real signal is also being awaited —
#            it catches a broken dependency, it is not the plan. If there is no
#            real signal beside it, it is a WAIT wearing a disguise.
#
# The pass condition is zero WAITs and zero POLLs in the pipelines listed below.
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules\ace-qol\scripts"

# The paths a roll actually travels. A timer here is felt at the table.
PIPELINE = [
    "attack-pipeline.mjs", "save-engine.mjs", "damage-card-renderer.mjs",
    "damage-engine.mjs", "damage-calculator.mjs", "damage-applicator.mjs",
    "spell-auto-damage.mjs", "dsn-utils.mjs", "combat-state.mjs",
    "multiattack-engine.mjs", "reaction-engine.mjs",
    "magic-missile-picker.mjs", "spell-target-picker.mjs",
    "heal-pipeline.mjs", "heal-target-picker.mjs", "attack-prompt.mjs",
]

TIMER = re.compile(r"setTimeout\s*\(|setInterval\s*\(|requestAnimationFrame\s*\(")
AWAITED = re.compile(r"await\s+new\s+Promise|await\s+\w*[Ss]leep|await\s+delay")
DELAY = re.compile(r",\s*(\d+)\s*\)")


# ⚠️ COSMETIC TIMERS ARE NOT PIPELINE TIMERS, and calling them one makes this
# tool cry wolf. Removing a flash class after 350ms, fading a toast, cleaning up
# an animation: none of these gate a roll. v1 of this check reported 37 problems
# when a third of them were CSS housekeeping, which is exactly the kind of noisy
# result nobody runs twice.
COSMETIC = re.compile(
    r"classList\.(?:remove|add|toggle)|\.remove\(\)|\.style\.|"
    r"opacity|transition|flash|toast|fade|highlight|blink|pulse")


# ⚠️🔴 v2, AFTER THE TOOL CRIED WOLF THIRTY-ONE TIMES OUT OF THIRTY-THREE.
#
# On 2026-08-26 this reported "33 timers the pipeline STOPS on". Reading all
# 33 by hand found TWO. The rest were cache expiry, fire-and-forget UI updates,
# and user-configurable pacing that is documented and deliberate. A check that
# is wrong 94% of the time does not get run twice, and then the two real ones
# live forever.
#
# Two things were wrong. It searched a multi-line WINDOW for `await`, so any
# plain setTimeout sitting near an awaited one was called a blocking wait. And
# its fallback was `return "WAIT"`, so every setTimeout it could not otherwise
# explain became a pipeline stall by default.
TTL = re.compile(r"setTimeout\(\s*\(\)\s*=>\s*[\w.$]*\.?"
                 r"(?:delete|clear|unset|remove|revoke)\(")

# A duration the USER chose is not a guess about somebody else's code. These
# are pacing for the human eye - "let players SEE the NPC save roll" - and they
# are documented, defaulted and exposed in the settings menu.
SETTING = re.compile(r"QolSettings\.get|game\.settings\.get")

# A human has read this one and signed it off, with a reason. Same contract as
# SILENT-OK in silent-exit-audit.py: the reason is REQUIRED, and signed timers
# are counted and shown, never hidden.
PACING_OK = re.compile(r"//\s*PACING-OK:\s*(?P<why>\S.*)")


def classify(window, line):
    if PACING_OK.search(window):
        return "SIGNED"
    if COSMETIC.search(line):
        return "COSMETIC"
    if TTL.search(line):
        return "TTL"
    if "setInterval" in line:
        return "POLL"
    # ⚠️ THE AWAIT MUST BE ON THIS TIMER, not merely nearby.
    if AWAITED.search(line):
        if SETTING.search(window):
            return "PACED"
        return "WAIT"
    if re.search(r"Promise\.race|_inFlight|allSettled|hookId|Hooks\.on", window):
        return "BACKSTOP"
    m = DELAY.search(line)
    if m and int(m.group(1)) <= 50:
        return "DEFER"
    # ⚠️ NOT "WAIT". A setTimeout nobody awaits does not stop anything;
    # it schedules work for later. That can still be a race, but it is a
    # different bug with a different fix, and calling it a stall is how this
    # tool lost its credibility the first time.
    return "DEFERRED-WORK"
    # A cap that races something real is a backstop, not a wait.
    if re.search(r"Promise\.race|_inFlight|allSettled|hookId|Hooks\.on", window):
        return "BACKSTOP"
    m = DELAY.search(line)
    if m and int(m.group(1)) <= 50:
        return "DEFER"
    return "WAIT"


def main():
    print("TIMERS IN THE ROLL PIPELINES")
    print("=" * 78)
    counts = {"WAIT": 0, "POLL": 0, "DEFER": 0, "BACKSTOP": 0, "COSMETIC": 0, "TTL": 0, "PACED": 0, "SIGNED": 0, "DEFERRED-WORK": 0}
    findings = []

    for name in PIPELINE:
        path = os.path.join(ROOT, name)
        if not os.path.isfile(path):
            continue
        src = io.open(path, encoding="utf-8", errors="ignore").read()
        lines = src.split("\n")
        for i, line in enumerate(lines):
            if not TIMER.search(line):
                continue
            window = "\n".join(lines[max(0, i - 6):i + 3])
            kind = classify(window, line)
            counts[kind] += 1
            ms = DELAY.search(line)
            findings.append((kind, name, i + 1, (ms.group(1) + "ms") if ms else "-", line.strip()[:88]))

    for kind in ("WAIT", "POLL", "BACKSTOP", "DEFERRED-WORK", "PACED", "TTL", "DEFER", "SIGNED", "COSMETIC"):
        rows = [f for f in findings if f[0] == kind]
        if not rows:
            continue
        print(f"\n  {kind}  ({len(rows)})")
        for _k, name, ln, ms, text in rows:
            print(f"     {name}:{ln}  [{ms}]")
            print(f"        {text}")

    print("\n" + "=" * 78)
    bad = counts["WAIT"] + counts["POLL"]
    print(f"BLOCKING: WAIT {counts['WAIT']}  ·  POLL {counts['POLL']}")
    print(f"REVIEWED: PACED {counts['PACED']} (duration comes from a setting)  ·  "
          f"SIGNED {counts['SIGNED']} (PACING-OK with a reason)")
    print(f"NOT A STALL: BACKSTOP {counts['BACKSTOP']}  ·  "
          f"DEFERRED-WORK {counts['DEFERRED-WORK']}  ·  TTL {counts['TTL']}  ·  "
          f"DEFER {counts['DEFER']}  ·  COSMETIC {counts['COSMETIC']}")
    if bad:
        print(f"\n{bad} timer(s) the pipeline STOPS on. Each one is a guess about how long")
        print("somebody else's code takes, and each one holds in testing and fails at a")
        print("full table. Replace with the signal that actually says it finished:")
        print("  a hook, a returned promise, an event, a document update.")
        sys.exit(1)
    print("\nNothing in the roll pipelines waits on a clock.")
    sys.exit(0)


if __name__ == "__main__":
    main()
