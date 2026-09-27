# -*- coding: utf-8 -*-
# --- ACE-ONE-ROAD.md section 9: the side doors, as a check -------------------
#
# Johnny, 2026-09-27: "Build only the section 9 release check. Print every hit
# with file and line." Section 9 of ACE-ONE-ROAD.md says it out loud: "must be a
# release check, not prose."
#
# WHY IT IS A TOOL AND NOT A RULE IN A FILE. Every line in section 9 was already
# written down somewhere before it was broken. "No ChatMessage.create outside the
# card door" is in the header of road/doors.mjs. "Never apply from the card's
# HTML" is in the road doc itself. I wrote the pill rule and broke it the same
# night. A rule nobody runs is a rule I break, so this runs in release-check.py
# beside the others.
#
# THE SEVEN DOORS IT WATCHES, in his words:
#   1. ChatMessage.create / createDocuments outside the card door
#   2. hit points written outside the hit-point door
#   3. APPLY reading totals out of card HTML
#   4. an attack path that never asks the activity damage config at roll time
#   5. a save card armed with no plan
#   6. Forge FX playing a spell
#   7. promote-to-named-actor when the token's world actor already exists
#
# The eighth bullet in section 9, a golden-record accept nobody read, is not in
# the code, so it is not in here. It is a rule about me.
#
# SCOPE IS HIS SCOPE. The road is ace-qol combat. Rules 1 to 5 read ace-qol only:
# a Forge trap is a Forge press with a Forge card and is not on this executor.
# Rules 6 and 7 read ONE file each in Forge and Engine, because those two rules
# are about a sibling reaching where it should not, and the sibling is the only
# place that shape can be seen.
#
# A LINE THAT IS RIGHT TO BE THERE SAYS SO, the same way card-wrap-check and
# dice-check take theirs:
#
#     road-ok: <reason>
#
# on the line or the line directly above it. No reason, no exemption.
#
# Run:  python tools/one-road-check.py
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODULES = os.path.abspath(os.path.join(HERE, "..", ".."))
QOL = os.path.join(MODULES, "ace-qol", "scripts")
FORGE_FX = os.path.join(MODULES, "ace-artificer", "scripts", "forge-fx-runtime.mjs")
PROMOTION = os.path.join(MODULES, "ace-engine", "scripts", "npc", "actor-promotion.mjs")

# The doors themselves, and the one file that is the hit-point door's interior.
# damage-applicator.mjs is where HpDoor.damage does its write; it is the door,
# not a way round it.
CARD_DOOR = ("road/doors.mjs",)
HP_DOOR = ("road/doors.mjs", "damage-applicator.mjs")

OK_MARK = re.compile(r"road-ok\s*:\s*\S")


# ── reading the source ─────────────────────────────────────────────────────

def strip_comments(src):
    """Comments blanked, line count and column count untouched.

    A rule must not be able to pass by being mentioned in prose:
    condition-raw-hooks.mjs names applyHPDamage in a comment, and
    ace-qol.mjs names system.attributes.hp.value in four of them.
    """
    out = []
    i, n = 0, len(src)
    quote = None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "\"'`":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            out.append("  ")
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def read(path):
    raw = io.open(path, encoding="utf-8", errors="ignore").read()
    return raw.split("\n"), strip_comments(raw).split("\n")


def qol_files():
    found = []
    for root, dirs, names in os.walk(QOL):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__")]
        for name in sorted(names):
            if name.endswith(".mjs"):
                found.append(os.path.join(root, name))
    return found


def rel(path):
    return os.path.relpath(path, os.path.join(MODULES, "ace-qol")).replace("\\", "/")


def allowed(raw_lines, idx):
    """road-ok on this line or the one above it."""
    if OK_MARK.search(raw_lines[idx]):
        return True
    return idx > 0 and OK_MARK.search(raw_lines[idx - 1]) is not None


HITS = {}


def hit(rule, path, lineno, text, note=""):
    HITS.setdefault(rule, []).append((path, lineno, text.strip()[:118], note))


# ── 1. a card posted outside the card door ────────────────────────────────

CARD = re.compile(r"\bChatMessage(?:\.implementation)?\s*\.\s*create(?:Documents)?\s*\(")


def rule_card(files):
    for path in files:
        r = rel(path)
        if any(r.endswith(d) for d in CARD_DOOR):
            continue
        raw, code = read(path)
        for i, line in enumerate(code):
            if CARD.search(line) and not allowed(raw, i):
                hit("1. a card posted outside the card door", r, i + 1, raw[i])


# ── 2. hit points written outside the hit-point door ──────────────────────

HP_KEY = r"system\.attributes\.hp\.(?:value|temp|tempmax)"
# A key in an object literal handed to update(): the string, then a colon.
HP_UPDATE = re.compile(r"[\"']" + HP_KEY + r"[\"']\s*:")
# An assignment into an update object by name.
HP_ASSIGN = re.compile(r"\[\s*[\"']" + HP_KEY + r"[\"']\s*\]\s*=(?!=)")
# dnd5e's own writer, which skips the door's resistances, its lock, its signal
# and Heavy Armor Master's reading of what dealt the damage.
HP_SYSTEM = re.compile(r"([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)"
                       r"\s*\??\.\s*(applyDamage|applyTempHP)\s*\(")


def rule_hp(files):
    rule = "2. hit points written outside the hit-point door"
    for path in files:
        r = rel(path)
        if any(r.endswith(d) for d in HP_DOOR):
            continue
        raw, code = read(path)
        for i, line in enumerate(code):
            if allowed(raw, i):
                continue
            if HP_UPDATE.search(line) or HP_ASSIGN.search(line):
                hit(rule, r, i + 1, raw[i], "writes hit points directly")
                continue
            m = HP_SYSTEM.search(line)
            # DamageApplicator.applyDamage IS the door's own front desk.
            if m and "DamageApplicator" not in m.group(1):
                hit(rule, r, i + 1, raw[i], "dnd5e's own applier, not the door")


# ── 3. APPLY reading a total out of card HTML ─────────────────────────────

# An index off a row is how a card says WHICH row. A total off a row is the card
# telling APPLY what to land, which is the road running backwards.
AMOUNT = re.compile(r"(?:total|amount|damage|dmg|heal|hp\b|dc\b|multiplier|dice|overkill|excess)", re.I)
FROM_MARKUP = re.compile(r"\b(?:parseInt|parseFloat|Number)\s*\(\s*[^;)]*?"
                         r"(?:dataset\s*\.\s*(\w+)|(textContent|innerText|innerHTML))")


def rule_card_html(files):
    rule = "3. APPLY reading a total out of card HTML"
    for path in files:
        r = rel(path)
        raw, code = read(path)
        for i, line in enumerate(code):
            if allowed(raw, i):
                continue
            for m in FROM_MARKUP.finditer(line):
                key = m.group(1) or m.group(2) or ""
                if AMOUNT.search(key):
                    hit(rule, r, i + 1, raw[i], f"reads {key} out of the markup")


# ── 4. an attack path that never asks the activity damage config ──────────

ASKS = re.compile(r"\bgetDamageConfig\s*\(")
# ⚠️ THE SHAPE THE ROAD DOC NAMES BY HAND (section 7): "If ACE walks parts.length
# and bails to a homemade fallback, the whip goes to +0 again." A dnd5e 5.x weapon
# keeps its dice in damage.base and carries parts: [] — so a falsy test on
# parts.length skips the ask for every ordinary weapon in the world.
PARTS_GATE = re.compile(r"!\s*\w+\s*\??\.\s*damage\s*\??\.\s*parts\s*\??\.\s*length")
SKIPS = re.compile(r"\b(continue|return|break)\b")


def rule_activity_config(files):
    rule = "4. an attack path that never asks the activity damage config at roll time"
    asked_anywhere = False
    for path in files:
        r = rel(path)
        raw, code = read(path)
        ask_lines = [i for i, line in enumerate(code) if ASKS.search(line)]
        if not ask_lines:
            continue
        asked_anywhere = True
        for i, line in enumerate(code):
            if allowed(raw, i):
                continue
            if PARTS_GATE.search(line) and SKIPS.search(line):
                note = ("this stands in front of the ask, so the ask never runs for one"
                        if i < min(ask_lines) else
                        "the homemade fallback below needs parts too, so it builds nothing either")
                hit(rule, r, i + 1, raw[i],
                    f"a 5.x weapon carries parts: [] with its dice in damage.base, and {note}")
    if not asked_anywhere:
        hit(rule, "(ace-qol/scripts)", 0, "no file asks getDamageConfig",
            "nothing anywhere asks the activity for its damage at roll time")


# ── 5. a save card armed with no plan ─────────────────────────────────────

# whatLands with a recipe that may be absent: it falls through to "it is not
# decided by a save", returns an empty verdict, and lands nothing without a word.
NO_PLAN = re.compile(r"\bwhatLands\s*\(\s*(?:null\b|[^,()]*?(?:\?\?|\|\|)\s*null\b)")


def rule_save_plan(files):
    rule = "5. a save card armed with no plan"
    for path in files:
        r = rel(path)
        raw, code = read(path)
        for i, line in enumerate(code):
            if NO_PLAN.search(line) and not allowed(raw, i):
                hit(rule, r, i + 1, raw[i], "a missing recipe lands nothing, silently")

    # And the plan reader itself must say so rather than return an empty verdict.
    wl = os.path.join(QOL, "road", "what-lands.mjs")
    here = "scripts/road/what-lands.mjs"
    if not os.path.exists(wl):
        hit(rule, here, 0, "the plan reader is missing", "")
        return
    raw, code = read(wl)
    start = next((i for i, line in enumerate(code)
                  if "function whatLands" in line), None)
    if start is None:
        hit(rule, here, 0, "whatLands was not found", "the plan reader cannot be proved")
        return
    seg = "\n".join(l for l in code[start:start + 60] if l.strip())
    if not re.search(r"console\.(warn|error)", seg):
        hit(rule, here, start + 1, raw[start],
            "with no recipe it returns an empty verdict and says nothing: a silent refusal")


# ── 6. Forge FX playing a spell ───────────────────────────────────────────

def rule_forge_fx():
    rule = "6. Forge FX playing a spell"
    if not os.path.exists(FORGE_FX):
        hit(rule, "ace-artificer/scripts/forge-fx-runtime.mjs", 0,
            "the FX runtime is missing", "sibling absent: bridge skipped, not failed")
        return
    raw, code = read(FORGE_FX)
    # ⚠️ THE WINDOW IS COUNTED IN CODE LINES, NOT CHARACTERS. Measured in
    # characters this said both gates were missing, because strip_comments blanks
    # a comment to spaces of the same width to keep the line numbers honest, and
    # the seventeen-line sentence of his above the spell guard ate the whole
    # budget. The fx-ownership self-test, which deletes its comments outright,
    # has been green on the same two gates since 2026-09-17.
    gates = []
    for name in ("_playFx", "_readItemFx"):
        at = next((i for i, line in enumerate(code) if re.search(rf"\bfunction\s+{name}\s*\(", line)), None)
        if at is None:
            hit(rule, "ace-artificer/scripts/forge-fx-runtime.mjs", 0,
                f"{name} was not found", "the gate cannot be proved")
            continue
        seg = "\n".join(l for l in code[at:at + 80] if l.strip())
        if re.search(r'type\s*===\s*"spell"', seg) and re.search(r"\breturn\b", seg):
            gates.append(name)
        else:
            hit(rule, "ace-artificer/scripts/forge-fx-runtime.mjs", at + 1,
                f"{name} does not refuse a spell", "Forge plays traps and secret doors only")
    return gates


# ── 7. promote when the token's world actor already exists ────────────────

def rule_promotion():
    rule = "7. promote-to-named-actor when the token's world actor already exists"
    if not os.path.exists(PROMOTION):
        hit(rule, "ace-engine/scripts/npc/actor-promotion.mjs", 0,
            "the promotion file is missing", "sibling absent: bridge skipped, not failed")
        return
    raw, code = read(PROMOTION)
    look = None
    create = None
    for i, line in enumerate(code):
        if look is None and re.search(r"game\.actors\s*\??\.\s*get\s*\(", line):
            look = i
        if create is None and re.search(r"\bActor\s*\.\s*create\w*\s*\(", line):
            create = i
    if look is None:
        hit(rule, "ace-engine/scripts/npc/actor-promotion.mjs", create + 1 if create else 0,
            "nothing looks the token's world actor up at all",
            "it creates a second actor without asking whether one exists")
        return
    if create is None:
        return
    # The lookup must be able to REFUSE, not merely supply data: a refusal
    # between the lookup and the create that reads what the lookup found.
    between = "\n".join(code[look:create])
    var = re.search(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*game\.actors", code[look])
    name = var.group(1) if var else None
    refuses = bool(re.search(r"promoted\s*:\s*false", between)) and (
        name is None or re.search(rf"\b{re.escape(name)}\b[^\n]*\breturn\b|\breturn\b[^\n]*\b{re.escape(name)}\b", between))
    if not refuses:
        hit(rule, "ace-engine/scripts/npc/actor-promotion.mjs", look + 1, raw[look],
            f"looked up but never asked to refuse; Actor.create runs at line {create + 1}")


# ── the report ────────────────────────────────────────────────────────────

RULES = [
    "1. a card posted outside the card door",
    "2. hit points written outside the hit-point door",
    "3. APPLY reading a total out of card HTML",
    "4. an attack path that never asks the activity damage config at roll time",
    "5. a save card armed with no plan",
    "6. Forge FX playing a spell",
    "7. promote-to-named-actor when the token's world actor already exists",
]


def main():
    files = qol_files()
    print(f"ONE ROAD, SECTION 9: the side doors")
    print(f"  ace-qol/scripts: {len(files)} files read\n")

    rule_card(files)
    rule_hp(files)
    rule_card_html(files)
    rule_activity_config(files)
    rule_save_plan(files)
    gates = rule_forge_fx()
    rule_promotion()

    total = 0
    for rule in RULES:
        rows = HITS.get(rule, [])
        total += len(rows)
        if not rows:
            extra = ""
            if rule.startswith("6.") and gates:
                extra = f"  ({', '.join(gates)} each refuse a spell)"
            print(f"  ok    {rule}{extra}")
            continue
        print(f"  FAIL  {rule}  -  {len(rows)} hit(s)")
        for path, lineno, text, note in rows:
            where = f"{path}:{lineno}" if lineno else path
            print(f"          {where}")
            print(f"            {text}")
            if note:
                print(f"            ^ {note}")
        print()

    print(f"\n{len(RULES) - sum(1 for r in RULES if HITS.get(r))} of {len(RULES)} doors shut, "
          f"{total} hit(s) open.")
    if total:
        print("A line that belongs where it is says  road-ok: <reason>  on it or above it.")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
