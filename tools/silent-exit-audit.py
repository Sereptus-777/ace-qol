# ─── Where can a roll die without saying a word? ─────────────────────────────
#
# ⚠️ WHY THIS EXISTS. On 2026-08-24 Jeth swung twice, with advantage, rolling two
# natural 20s, and NOTHING appeared in chat. No hit card, no damage card, no
# error. The roll went into the pipeline and never came out, and there was
# nothing anywhere to say which gate closed.
#
# That is not one bug. It is a property of the pipelines: they are built out of
# hook handlers that `return` on a condition, and a bare `return` inside a hook
# is indistinguishable from "nothing to do here". Dozens of them are correct and
# necessary. The problem is that a BROKEN one looks exactly like a correct one,
# from the outside and from the console.
#
# ═══ WHAT THIS FINDS ═════════════════════════════════════════════════════════
#
# Every early return inside a hook handler in the roll path that:
#   • tests something that could plausibly be a FAILURE, not just a no-op, and
#   • prints nothing before giving up.
#
# It deliberately does NOT flag the obvious no-ops (`if (!item) return` on a
# hook that fires for everything), because a check that shouts on every mouse
# move is a check nobody keeps. It flags returns whose CONDITION mentions the
# things that actually go wrong: users, GMs, sockets, targets, combat, flags,
# settings, permissions, activeGM.
#
# ⚠️ A FINDING HERE IS NOT AUTOMATICALLY A BUG. It is a place where, when
# something does go wrong, you will get silence instead of a reason. Fixing it
# usually means one `console.log` naming the gate — not restructuring the code.
# That is the difference between "we spent a session guessing" and "the console
# told us in one line".
import io
import os
import re
import sys

ROOT = r"D:\FoundryVTT\Data\modules\ace-qol\scripts"

PIPELINE = [
    "attack-pipeline.mjs", "save-engine.mjs", "damage-card-renderer.mjs",
    "damage-engine.mjs", "spell-auto-damage.mjs", "combat-state.mjs",
    "multiattack-engine.mjs", "reaction-engine.mjs", "attack-prompt.mjs",
]

# Conditions that describe a way the world can be WRONG, not merely absent.
RISKY = re.compile(
    r"\bisGM\b|activeGM|game\.user\b|\buser\b|socket|permission|isOwner|"
    r"\bcombat\b|combatant|targets?\b|settings\.get|getFlag|"
    r"\bpending\b|\bcanvas\b|\btoken\b", re.I)

# A gate that already explains itself.
SPEAKS = re.compile(r"console\.(log|warn|error|debug)|ui\.notifications|"
                    r"_gateOff\(|_cannotCheck\(|decline\(")

# ⚠️ AN AUDIT WITH NO WAY TO SAY "CORRECT AS IT IS" BECOMES AN AUDIT NOBODY
# RUNS. Roughly half the early returns in reaction-engine.mjs are "this event
# is not mine to handle" - wrong client, not the active GM, not the addressed
# user. Those fire on EVERY client for EVERY event, and making them speak
# would bury every player's console in noise. Noise gets logging switched
# off, and then nothing is reported at all.
#
# So a deliberately silent gate is marked in the source:
#
#     // SILENT-OK: not this client's event; every client sees every hook
#     if (game.users?.activeGM !== game.user) return;
#
# The reason is REQUIRED. A bare marker would let anyone silence a real
# finding by typing eight characters, which is how a check becomes a rubber
# stamp. Marked gates are counted and shown separately, never hidden.
SILENT_OK = re.compile(r"//\s*SILENT-OK:\s*(?P<why>\S.*)")

RETURN = re.compile(r"^\s*(?:if\s*\((?P<cond>[^{]*?)\)\s*)?return\s*;?\s*$")
IF_RETURN = re.compile(r"^\s*if\s*\((?P<cond>.+?)\)\s*return\b")


def main():
    print("SILENT EXITS IN THE ROLL PIPELINES")
    print("=" * 78)
    total = 0
    allowed_total = 0
    for name in PIPELINE:
        path = os.path.join(ROOT, name)
        if not os.path.isfile(path):
            continue
        lines = io.open(path, encoding="utf-8", errors="ignore").read().split("\n")
        hits, allowed = [], []
        for i, line in enumerate(lines):
            m = IF_RETURN.match(line) or RETURN.match(line)
            if not m:
                continue
            cond = (m.groupdict().get("cond") or "").strip()
            if not cond or not RISKY.search(cond):
                continue
            # Marked as deliberately silent, with a stated reason?
            marker = (SILENT_OK.search(line)
                      or (i > 0 and SILENT_OK.search(lines[i - 1])))
            if marker:
                allowed.append((i + 1, marker.group("why").strip()[:70]))
                continue
            # Does anything in the three lines above explain the refusal?
            window = "\n".join(lines[max(0, i - 3):i + 1])
            if SPEAKS.search(window):
                continue
            hits.append((i + 1, cond[:84]))
        allowed_total += len(allowed)
        if hits:
            total += len(hits)
            print(f"\n  {name}  ({len(hits)})")
            for ln, cond in hits:
                print(f"     :{ln:<6} if ({cond}) return;")

    print("\n" + "=" * 78)
    if allowed_total:
        print(f"{allowed_total} gate(s) marked SILENT-OK with a stated reason "
              f"- deliberately quiet, counted, not hidden.")
    print(f"{total} early return(s) in the roll path that give up without a word.")
    print()
    print("Each is a place where a real failure is indistinguishable from a normal")
    print("no-op. When a roll vanishes, these are the doors it went out of, and none")
    print("of them will tell you which. One line naming the gate turns a lost")
    print("session into a one-line console answer.")
    sys.exit(0)


if __name__ == "__main__":
    main()
