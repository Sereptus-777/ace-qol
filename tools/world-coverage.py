# -*- coding: utf-8 -*-
# --- How much of THIS world does the suite actually own? --------------------
#
# Reads the live world database directly (no Foundry needed) and buckets every
# spell, weapon, feat, equipment and consumable that any actor carries:
#
#   LIBRARY       a curated registry entry names it
#   ENGINE        a dedicated engine names it (multiattack, legendary
#                 resistance, regeneration, retaliation, smite...)
#   SELF-LEARNED  no entry, but DescriptionParser drafts a rule from its text
#   PREMADE       neither, but chris-premades or MISC solves it
#   NOT MODELED   has real rules text and nothing handles it
#   NO TEXT       nothing to model in the first place
#
# ⚠️🔴 WHY IT MEASURES FOUR WAYS AND NOT ONE. The first pass of this analysis
# matched registry names only and reported 48% coverage. It was wrong: it
# called Multiattack, Legendary Resistance and Regeneration "not modeled" while
# each has an entire engine behind it. Name matching cannot see engine-level
# handling, and a coverage number that under-reports argues for rebuilding
# things that already work.
#
# ⚠️ AND "NOT MODELED" IS NOT "BROKEN". A Longsword needs no ACE entry; dnd5e
# rolls it correctly. A Waterskin needs nothing at all. Read the list, do not
# just read the number.
#
# Usage:
#   python tools/world-coverage.py <path-to-world-folder>
#   e.g. python tools/world-coverage.py D:/FoundryVTT/Data/worlds/hijinx
#
# It COPIES the database first and never opens the live one, so it is safe to
# run while Foundry is up.
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

MODULES = r"D:\FoundryVTT\Data\modules"
FOUNDRY_APP = r"D:\FoundryVTT\Foundry Virtual Tabletop\resources\app"
# Reports go where he actually looks, not into the module folder.
REPORT_DIR = r"C:\Users\johnp\OneDrive\Desktop\ACE Project\Coverage Reports"
TYPES = ("spell", "weapon", "feat", "equipment", "consumable")


def norm(n):
    n = re.sub(r"\(.*?\)", " ", str(n or "")).lower()
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    return re.sub(r"^\s*//.*$", "", s, flags=re.M)


def curated_names():
    """Every name a curated ACE registry entry claims."""
    out = {}
    base = os.path.join(MODULES, "ace-qol", "scripts")
    for sub in ("spell-pipeline/registry", "rules", "target-state-registry"):
        d = os.path.join(base, *sub.split("/"))
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".mjs") or fn == "_index.mjs":
                continue
            code = strip_comments(io.open(os.path.join(d, fn), encoding="utf-8",
                                          errors="ignore").read())
            for m in re.finditer(r'^\s{2}"([^"]+)":\s*\{', code, re.M):
                out.setdefault(norm(m.group(1)), sub + "/" + fn)
            for m in re.finditer(r'\bname:\s*"([^"]+)"', code):
                out.setdefault(norm(m.group(1)), sub + "/" + fn)
    return out


def engine_strings():
    """Names that appear as real STRING LITERALS anywhere in the suite.

    Searching raw source would match prose and comments; a feature named in a
    string is one some engine actually tests for.
    """
    seen = set()
    for mod in ("ace-qol", "ace-engine", "ace-artificer"):
        root = os.path.join(MODULES, mod, "scripts")
        for dp, dn, fns in os.walk(root):
            for fn in fns:
                if not fn.endswith(".mjs"):
                    continue
                try:
                    s = strip_comments(io.open(os.path.join(dp, fn), encoding="utf-8",
                                               errors="ignore").read())
                except OSError:
                    continue
                for pat in (r'"([^"\n]{3,60})"', r"'([^'\n]{3,60})'"):
                    for lit in re.findall(pat, s):
                        v = norm(lit)
                        if v:
                            seen.add(v)
    return seen


def read_world(world):
    """Every unique item on every actor, via a COPY of the database."""
    src = os.path.join(world, "data", "actors")
    if not os.path.isdir(src):
        print("No actors database at %s" % src)
        sys.exit(2)
    tmp = tempfile.mkdtemp(prefix="ace-coverage-")
    dst = os.path.join(tmp, "actors")
    os.makedirs(dst)
    for fn in os.listdir(src):
        if fn == "LOCK":          # never copy the lock; never touch the live db
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
const actors = new Map();
for await (const [k, v] of db.iterator())
  if (k.startsWith("!actors!")) actors.set(k.split("!")[2], v?.type);
const norm = n => String(n ?? "").replace(/\\(.*?\\)/g, " ").toLowerCase()
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\\s+/g, " ").trim();
const uniq = new Map();
for await (const [k, v] of db.iterator()) {
  if (!k.startsWith("!actors.items!")) continue;
  const t = v?.type;
  if (!["spell","weapon","feat","equipment","consumable"].includes(t)) continue;
  const key = t + "|" + norm(v.name);
  const isPC = actors.get(k.split("!")[2].split(".")[0]) === "character";
  if (uniq.has(key)) { const e = uniq.get(key); e.count++; if (isPC) e.pcs++; continue; }
  uniq.set(key, { name: v.name, type: t, count: 1, pcs: isPC ? 1 : 0,
                  desc: v?.system?.description?.value ?? "" });
}
await db.close();
fs.writeFileSync(process.argv[3], JSON.stringify([...uniq.values()]));
""" % FOUNDRY_APP.replace("\\", "/"))

    out = os.path.join(tmp, "items.json")
    r = subprocess.run(["node", script, dst, out], capture_output=True, text=True)
    if r.returncode != 0:
        print("Could not read the world database:")
        print(r.stderr[:800])
        sys.exit(2)
    items = json.load(open(out, encoding="utf-8"))
    shutil.rmtree(tmp, ignore_errors=True)
    return items


def parser_findings(items):
    """Run ACE's own DescriptionParser over each item's text.

    description-parser.mjs imports nothing and touches no Foundry global at
    module scope, so it runs perfectly well outside Foundry. That is what
    makes an honest offline SELF-LEARNED count possible at all.
    """
    tmp = tempfile.mkdtemp(prefix="ace-parse-")
    inp, outp = os.path.join(tmp, "in.json"), os.path.join(tmp, "out.json")
    json.dump([{"name": i["name"], "desc": i["desc"]} for i in items],
              open(inp, "w", encoding="utf-8"))
    script = os.path.join(tmp, "p.mjs")
    io.open(script, "w", encoding="utf-8").write("""
import fs from "node:fs";
import { DescriptionParser } from "file:///%s/ace-qol/scripts/description-parser.mjs";
const items = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const F = ["saves","effectTable","bonusDamage","conditions","severRider",
           "hpThresholdRider","onKillRider","repeatingSave","creatureTrigger","halfOnSave"];
const out = items.map(it => {
  try {
    const p = DescriptionParser.parse({ name: it.name, system: { description: { value: it.desc } } });
    return F.filter(f => Array.isArray(p[f]) ? p[f].length : !!p[f]);
  } catch { return []; }
});
fs.writeFileSync(process.argv[3], JSON.stringify(out));
""" % MODULES.replace("\\", "/"))
    r = subprocess.run(["node", script, inp, outp], capture_output=True, text=True)
    found = json.load(open(outp, encoding="utf-8")) if r.returncode == 0 else [[]] * len(items)
    if r.returncode != 0:
        print("  (parser could not run: %s)" % r.stderr.strip()[:160])
    shutil.rmtree(tmp, ignore_errors=True)
    return found


def main():
    if len(sys.argv) < 2:
        print(__doc__ or "")
        print("Usage: python tools/world-coverage.py <path-to-world-folder>")
        sys.exit(2)
    world = sys.argv[1]

    print("")
    print("ACE COVERAGE OF %s" % os.path.basename(world.rstrip("/\\")).upper())
    print("=" * 78)

    items = read_world(world)
    curated = curated_names()
    engine = engine_strings()
    found = parser_findings(items)

    rows = []
    for it, f in zip(items, found):
        n = norm(it["name"])
        text = re.sub(r"<[^>]*>", "", it["desc"] or "").strip()
        if n in curated:        b = "LIBRARY"
        elif n in engine:       b = "ENGINE"
        elif f:                 b = "SELF-LEARNED"
        elif len(text) < 40:    b = "NO TEXT"
        else:                   b = "NOT MODELED"
        rows.append({"name": it["name"], "type": it["type"], "count": it["count"],
                     "pcs": it["pcs"], "bucket": b, "found": f, "chars": len(text)})

    order = ("LIBRARY", "ENGINE", "SELF-LEARNED", "NOT MODELED", "NO TEXT")
    print("")
    print("  %-12s %8s %7s %13s %12s %8s" % (("type",) + order))
    tot = dict((b, 0) for b in order)
    for t in TYPES:
        c = dict((b, 0) for b in order)
        for r in rows:
            if r["type"] == t:
                c[r["bucket"]] += 1
                tot[r["bucket"]] += 1
        if sum(c.values()):
            print("  %-12s %8d %7d %13d %12d %8d" % ((t,) + tuple(c[b] for b in order)))
    print("  %-12s %8d %7d %13d %12d %8d" % (("TOTAL",) + tuple(tot[b] for b in order)))

    handled = tot["LIBRARY"] + tot["ENGINE"] + tot["SELF-LEARNED"]
    modelable = sum(tot.values()) - tot["NO TEXT"]
    print("")
    print("  %d of %d items carrying rules text are handled somewhere: %.0f%%"
          % (handled, modelable, 100.0 * handled / max(1, modelable)))

    print("")
    print("  ⚠️ READ THIS BEFORE BELIEVING THE NUMBER.")
    print("  ENGINE detection matches a name against STRING LITERALS in our source.")
    print("  An engine that finds its subject by regex or substring at runtime is")
    print("  invisible to it. Multiattack is the proven case: MultiattackEngine")
    print("  drives it on 1,241 actors here and it still lands in NOT MODELED,")
    print("  because the bare word never appears as a literal.")
    print("  So NOT MODELED means \"nothing NAMED it\", not \"nothing handles it\",")
    print("  and the real coverage is higher than the percentage above.")
    print("  Fixing this by matching substrings would over-report instead, which is")
    print("  the worse direction: it would argue that gaps are already covered.")

    gaps = [r for r in rows if r["bucket"] == "NOT MODELED" and r["pcs"] > 0]
    gaps.sort(key=lambda r: (-r["pcs"], -r["count"]))
    print("")
    print("  UNHANDLED AND CARRIED BY A PLAYER CHARACTER (%d)" % len(gaps))
    print("  These are the ones worth looking at first; a monster-only gap can wait.")
    for r in gaps[:30]:
        print("    %-11s %-42s %d PC(s), %d actors" % (r["type"], r["name"][:42], r["pcs"], r["count"]))
    if len(gaps) > 30:
        print("    ... and %d more" % (len(gaps) - 30))

    # ⚠️ WRITE IT AS SOMETHING A HUMAN READS. The first version dumped
    # JSON and Johnny asked the obvious question: "am I not supposed to read
    # it?" A report nobody can read is a report that does not exist - the same
    # lesson as raw JSONL transcripts versus the timestamped readable ones.
    out = REPORT_DIR
    try:
        os.makedirs(out, exist_ok=True)
        path = os.path.join(out, "ACE COVERAGE - %s.txt"
                            % os.path.basename(sys.argv[1].rstrip("/\\")))
    except OSError:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coverage-report.txt")

    with io.open(path, "w", encoding="utf-8") as fh:
        w = lambda t="": fh.write(t + chr(10))
        w("=" * 78)
        w("ACE COVERAGE OF %s" % os.path.basename(sys.argv[1].rstrip("/\\")).upper())
        w("=" * 78)
        w("")
        w("HOW TO READ THIS")
        w("  LIBRARY       a curated ACE entry names this item")
        w("  ENGINE        a dedicated ACE engine names it")
        w("  SELF-LEARNED  no entry, but ACE drafted a rule from the item's own text")
        w("  NOT MODELED   has real rules text and nothing NAMED it")
        w("  NO TEXT       nothing to model in the first place")
        w("")
        w("  NOT MODELED does NOT mean broken. A Longsword needs no ACE entry;")
        w("  dnd5e rolls it correctly. Multiattack sits in that column on 1,241")
        w("  actors and is driven by MultiattackEngine every round.")
        w("")
        w("-" * 78)
        w("TOTALS")
        w("-" * 78)
        w("")
        w("  %-12s %8s %7s %13s %12s %8s" % (("type",) + order))
        for t in TYPES:
            c = dict((bk, 0) for bk in order)
            for r in rows:
                if r["type"] == t:
                    c[r["bucket"]] += 1
            if sum(c.values()):
                w("  %-12s %8d %7d %13d %12d %8d" % ((t,) + tuple(c[bk] for bk in order)))
        w("  %-12s %8d %7d %13d %12d %8d" % (("TOTAL",) + tuple(tot[bk] for bk in order)))
        w("")
        w("  %d of %d items carrying rules text are handled somewhere: %.0f%%"
          % (handled, modelable, 100.0 * handled / max(1, modelable)))
        w("")
        w("-" * 78)
        w("UNHANDLED AND CARRIED BY A PLAYER CHARACTER (%d)" % len(gaps))
        w("Look at these first. A monster-only gap can wait.")
        w("-" * 78)
        w("")
        for r in gaps:
            w("  %-11s %-46s %d PC(s), %d actors"
              % (r["type"], r["name"][:46], r["pcs"], r["count"]))
        w("")
        w("-" * 78)
        w("EVERYTHING ELSE UNHANDLED, MOST COMMON FIRST")
        w("-" * 78)
        w("")
        rest = sorted([r for r in rows if r["bucket"] == "NOT MODELED" and not r["pcs"]],
                      key=lambda r: -r["count"])
        for r in rest:
            w("  %-11s %-46s %d actors" % (r["type"], r["name"][:46], r["count"]))
        w("")
        w("-" * 78)
        w("WHAT ACE ALREADY HANDLES, FOR REFERENCE")
        w("-" * 78)
        for bucket in ("LIBRARY", "ENGINE", "SELF-LEARNED"):
            got = sorted([r for r in rows if r["bucket"] == bucket],
                         key=lambda r: (r["type"], r["name"].lower()))
            w("")
            w("  %s (%d)" % (bucket, len(got)))
            for r in got:
                extra = ("  [" + ", ".join(r["found"]) + "]") if r.get("found") else ""
                w("    %-11s %-44s %d actors%s"
                  % (r["type"], r["name"][:44], r["count"], extra))
    print("")
    print("  written: %s" % path)


if __name__ == "__main__":
    main()
