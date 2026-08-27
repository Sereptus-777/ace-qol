# -*- coding: utf-8 -*-
# --- A feature that promises a number and delivers nothing ------------------
#
# WHY THIS EXISTS. On 2026-08-26 a coverage sweep of Johnny's live world found
# TEN fighting-style and damage features on player characters, and every single
# one of them applied nothing at all:
#
#     Ireena Kolyana        Archery                +2 to ranged attack rolls
#     Ismark Kolyanovich    Archery, Dueling       +2 attack, +2 damage
#     Izek Strazni          Great Weapon Fighting  reroll 1s and 2s
#     Virric Vaesoldandros  Savage Attacker        reroll damage, take better
#
# No Active Effect, no flag, no dnd5e bonus. The feature sits on the sheet
# looking correct and changes no roll. Ireena had been shooting at two lower
# than she should, in a live campaign, for as long as the sheet has existed.
#
# ⚠️ THIS IS NOT A BUG IN ACE, AND THAT IS EXACTLY WHY IT MATTERS. Nothing in
# our code is wrong; the ITEM DATA is hollow, usually from an importer that
# brought the text across and not the mechanics. No module can see it, because
# a feature with no effect is indistinguishable from a feature that is only
# flavour. The GM has no way to know, and the player just rolls badly forever.
#
# So this asks a question nothing else asks: does this feature's TEXT promise a
# mechanical change, while the item carries nothing that could produce one?
#
# ⚠️ IT REPORTS, IT NEVER WRITES. Adding the missing effect automatically would
# double up with any module that already handles the feature, and would silently
# rewrite his characters. The GM decides.
#
# Usage:
#   python tools/hollow-feature-check.py <path-to-world-folder>
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

FOUNDRY_APP = r"D:\FoundryVTT\Foundry Virtual Tabletop\resources\app"
# Written where he actually looks, as text. A JSON dump is not a report.
REPORT_DIR = r"C:\Users\johnp\OneDrive\Desktop\ACE Project\Coverage Reports"

# Phrases that promise an actual mechanical change. Deliberately narrow: a
# feature saying "you have advantage on checks to climb" is not something a
# missing Active Effect breaks, and flagging it would bury the real ones.
PROMISES = [
    (r"\+\s*(\d+)\s+bonus\s+to\s+(?:the\s+)?(?:attack|damage)", "a flat attack or damage bonus"),
    (r"gain\s+a\s+\+\s*(\d+)\s+bonus\s+to\s+(?:attack|damage|ac|armor class)", "a flat bonus"),
    (r"\+\s*(\d+)\s+bonus\s+to\s+(?:ac|armor class)", "an AC bonus"),
    (r"reroll\s+(?:the\s+)?(?:damage|die|dice)", "a damage reroll"),
    (r"reroll\s+(?:a\s+)?1\s*(?:s)?\s*(?:and|or)\s*2\s*(?:s)?", "a damage reroll"),
    (r"add\s+your\s+(?:ability\s+)?modifier\s+to\s+the\s+damage", "adding a modifier to damage"),
    (r"(?:your\s+)?(?:walking\s+)?speed\s+increases\s+by\s+(\d+)", "a speed increase"),
    (r"you\s+have\s+resistance\s+to", "a damage resistance"),
    (r"maximum\s+hit\s+points\s+increase", "a hit point increase"),
]

# Text that means "the GM adjudicates this", not "a number changes".
# ⚠️ NOT ALL dnd5e FLAGS ARE MACHINERY. Version one treated ANY dnd5e flag
# as "this feature is implemented" and therefore skipped Archery entirely - the
# single clearest case in the world. Its flags are `sourceId` and
# `advancementOrigin`: pure bookkeeping written by the importer, present on
# hundreds of items, and carrying no behaviour whatsoever.
BOOKKEEPING_FLAGS = {"sourceId", "advancementOrigin", "advancementRoot",
                     "persistSourceMigration", "migratedUses", "last", "dependents"}

# ⚠️ AND AN ITEM CAN SAY OUT LOUD THAT IT IS HOLLOW. Several imports carry
# the line "This feature includes an Active Effect" in their own description
# while shipping zero effects. That is the strongest possible signal: the item
# is telling you what is missing.
CLAIMS_AN_EFFECT = re.compile(
    r"(?i)includes?\s+an?\s+active\s+effect|active\s+effect\s+(?:is|that)\s+")

NARRATIVE = re.compile(
    r"(?i)\bas an action\b|\bonce per\b.*\bshort rest\b|you can speak|you know .* language|"
    r"advantage on .*(?:checks?)\b|proficiency in")


def norm(n):
    n = re.sub(r"\(.*?\)", " ", str(n or "")).lower()
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def curated_names():
    """Names ACE already implements by name. Not hollow, whatever the item holds.

    ⚠️ WITHOUT THIS THE REPORT LEADS WITH THINGS THAT WORK. Version one put
    Chudd's Brooch of Shielding at the top of the list - an item proven working
    the night before, when it nullified a Magic Missile. ACE's nullification
    registry implements it; the item needs no Active Effect at all.
    """
    out = set()
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts")
    for sub in ("spell-pipeline/registry", "rules", "target-state-registry"):
        d = os.path.join(base, *sub.split("/"))
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if not fn.endswith(".mjs"):
                continue
            try:
                code = io.open(os.path.join(d, fn), encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
            code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
            for m in re.finditer(r'^\s{2}"([^"]+)":\s*\{', code, re.M):
                out.add(norm(m.group(1)))
            for m in re.finditer(r'\bname:\s*"([^"]+)"', code):
                out.add(norm(m.group(1)))
    return out


def read_world(world):
    src = os.path.join(world, "data", "actors")
    if not os.path.isdir(src):
        print("No actors database at %s" % src)
        sys.exit(2)
    tmp = tempfile.mkdtemp(prefix="ace-hollow-")
    dst = os.path.join(tmp, "actors")
    os.makedirs(dst)
    for fn in os.listdir(src):
        if fn == "LOCK":
            continue
        try:
            shutil.copy2(os.path.join(src, fn), os.path.join(dst, fn))
        except OSError:
            pass
    script = os.path.join(tmp, "read.mjs")
    io.open(script, "w", encoding="utf-8").write("""
import { ClassicLevel } from "file:///%s/node_modules/classic-level/index.js";
import fs from "node:fs";
const db = new ClassicLevel(process.argv[2], { valueEncoding: "json" });
await db.open();
const actors = new Map(), fx = new Map();
for await (const [k, v] of db.iterator()) {
  if (k.startsWith("!actors!")) actors.set(k.split("!")[2], { name: v?.name, type: v?.type });
  else if (k.startsWith("!actors.items.effects!")) {
    const id = k.split("!")[2].split(".")[1];
    if (!fx.has(id)) fx.set(id, []);
    fx.get(id).push(v);
  }
}
const out = [];
for await (const [k, v] of db.iterator()) {
  if (!k.startsWith("!actors.items!")) continue;
  if (!["feat", "equipment"].includes(v?.type)) continue;
  const parts = k.split("!")[2].split(".");
  const a = actors.get(parts[0]);
  const inline = Array.isArray(v.effects) ? v.effects : [];
  const sep = fx.get(parts[1]) ?? [];
  const changes = [...inline, ...sep].flatMap(e => e?.changes ?? []);
  out.push({
    actor: a?.name ?? "?", actorType: a?.type ?? "?",
    name: v.name, type: v.type,
    desc: v?.system?.description?.value ?? "",
    changes: changes.length,
    // dnd5e also implements some features through flags or its own bonus
    // fields rather than an Active Effect. Those are NOT hollow.
    flagNames: Object.keys(v?.flags?.dnd5e ?? {}),
    activities: Object.keys(v?.system?.activities ?? {}).length,
    // dnd5e computes AC from the armour item ITSELF. A +1 Leather reading 12
    // needs no Active Effect at all, so an "AC bonus" promise on a piece of
    // armour that already carries a value is not hollow.
    armorValue: v?.system?.armor?.value ?? null,
  });
}
await db.close();
fs.writeFileSync(process.argv[3], JSON.stringify(out));
""" % FOUNDRY_APP.replace("\\", "/"))
    out = os.path.join(tmp, "o.json")
    r = subprocess.run(["node", script, dst, out], capture_output=True, text=True)
    if r.returncode != 0:
        print("Could not read the world database:")
        print(r.stderr[:800])
        sys.exit(2)
    rows = json.load(open(out, encoding="utf-8"))
    shutil.rmtree(tmp, ignore_errors=True)
    return rows


def main():
    if len(sys.argv) < 2:
        print("Usage: python tools/hollow-feature-check.py <path-to-world-folder>")
        sys.exit(2)
    rows = read_world(sys.argv[1])
    curated = curated_names()

    hollow = {}
    for r in rows:
        # Anything that already carries machinery is not hollow.
        real_flags = [x for x in (r.get("flagNames") or []) if x not in BOOKKEEPING_FLAGS]
        if r["changes"] or real_flags or r["activities"]:
            continue
        if norm(r["name"]) in curated:
            continue   # ACE already implements this by name; not hollow
        text = re.sub(r"<[^>]*>", " ", r["desc"] or "")
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < 20 or NARRATIVE.search(text):
            continue
        checks = list(PROMISES)
        if CLAIMS_AN_EFFECT.search(text):
            checks = [(r".", "its own text says it includes an Active Effect, and it has none")] + checks
        for pat, why in checks:
            if re.search(pat, text, re.I):
                # ⚠️ ARMOUR AC IS NATIVE, AND FLAGGING IT BURIES THE REAL ONES.
                # Dwarven Plate reads 18 and +1 Leather reads 12 straight off the
                # item; dnd5e needs nothing else. Version one led its report with
                # three of these, above the genuinely dead Archery.
                # A worn piece of armour carrying its own AC value already
                # delivers every flat/AC bonus its text describes. Only its
                # RESISTANCE claims can be hollow.
                if r.get("armorValue") and "resistance" not in why.lower():
                    continue
                key = (r["name"], why)
                e = hollow.setdefault(key, {"name": r["name"], "why": why,
                                            "pcs": [], "npcs": 0})
                if r["actorType"] == "character":
                    if r["actor"] not in e["pcs"]:
                        e["pcs"].append(r["actor"])
                else:
                    e["npcs"] += 1
                break

    print("")
    print("FEATURES THAT PROMISE A NUMBER AND CARRY NOTHING TO PRODUCE IT")
    print("=" * 78)
    print("  %d items scanned" % len(rows))

    on_pcs = sorted([e for e in hollow.values() if e["pcs"]],
                    key=lambda e: (-len(e["pcs"]), e["name"]))
    others = sorted([e for e in hollow.values() if not e["pcs"]],
                    key=lambda e: (-e["npcs"], e["name"]))

    if on_pcs:
        print("")
        print("  ON PLAYER CHARACTERS - these change rolls at your table right now")
        for e in on_pcs:
            print("    %-30s %s" % (e["name"][:30], e["why"]))
            print("        %s" % ", ".join(sorted(e["pcs"])))
    if others:
        print("")
        print("  ON NPCs ONLY (%d)" % len(others))
        for e in others[:15]:
            print("    %-30s %-38s %d actors" % (e["name"][:30], e["why"], e["npcs"]))
        if len(others) > 15:
            print("    ... and %d more" % (len(others) - 15))

    # Same list, as a file he can read at camp.
    try:
        os.makedirs(REPORT_DIR, exist_ok=True)
        path = os.path.join(REPORT_DIR, "ACE HOLLOW FEATURES - %s.txt"
                            % os.path.basename(sys.argv[1].rstrip("/" + chr(92))))
        with io.open(path, "w", encoding="utf-8") as fh:
            w = lambda t="": fh.write(t + chr(10))
            w("=" * 78)
            w("FEATURES THAT PROMISE A NUMBER AND CARRY NOTHING TO PRODUCE IT")
            w("=" * 78)
            w("")
            w("These items have rules text describing a mechanical change and no")
            w("Active Effect, flag or activity that could produce it. The text came")
            w("across from the importer; the mechanics did not.")
            w("")
            w("ACE has not altered anything. It cannot safely: writing the missing")
            w("effect would double up with anything else that handles the feature,")
            w("and would rewrite your characters without asking.")
            w("")
            w("%d items scanned." % len(rows))
            w("")
            w("-" * 78)
            w("ON PLAYER CHARACTERS - these change rolls at your table right now")
            w("-" * 78)
            w("")
            for e in on_pcs:
                w("  %s" % e["name"])
                w("      should give: %s" % e["why"])
                w("      carried by : %s" % ", ".join(sorted(e["pcs"])))
                w("")
            w("-" * 78)
            w("ON NPCs ONLY (%d) - lower priority" % len(others))
            w("-" * 78)
            w("")
            for e in others:
                w("  %-34s %-40s %d actors" % (e["name"][:34], e["why"][:40], e["npcs"]))
        print("")
        print("  written: %s" % path)
    except OSError as err:
        print("  (could not write the report file: %s)" % err)

    print("")
    print("=" * 78)
    if on_pcs:
        print("%d feature(s) on player characters promise a mechanical change and" % len(on_pcs))
        print("deliver nothing. This is item DATA, not a module bug: no module can")
        print("see it, because a feature with no effect looks exactly like one that")
        print("is pure flavour. Fix them on the sheet, or give ACE a rule for them.")
        sys.exit(1)
    print("Nothing on a player character promises a number it cannot deliver.")
    sys.exit(0)


if __name__ == "__main__":
    main()
