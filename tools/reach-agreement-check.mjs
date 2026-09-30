// ─── Every place that says how far a weapon reaches must say the same thing ───
//
// ⚠️🔴 WHAT THIS IS PROVING. Reach was being worked out in FOUR places, each
// reading a different subset of the item:
//
//   • the attack gate      — activity, item, description, reach property
//   • the attacker profile — the range slot, and nothing else
//   • the chat card tag    — the item only, no activity, no description
//   • the action-bar hover — the activity only, no item, no description
//
// So Johnny's Spiked Chain, whose reach lives in its description, could be
// swung at 10 ft by the gate while the hover text said nothing, the card
// printed no REACH tag, and the profile's console line claimed 0. Four answers
// to one question, and the log was the least trustworthy of them.
//
// They all call `resolveReach` now. This bench drives that one function with
// the item shapes that actually caused trouble, and asserts the answer AND the
// stated source, because "5 ft because the item says so" and "5 ft because
// nothing said anything" are different facts.
//
// ⚠️ LIFTED FROM THE SHIPPED FILE, NEVER RETYPED. A bench carrying its own copy
// of the rule passes forever while the real code rots. It is lifted rather than
// imported because `reach-reader.mjs` pulls MODULE_ID from the module entry
// point, which drags in the whole of Foundry and cannot load under bare node.
//
// Run:  node tools/reach-agreement-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "scripts", "reach-reader.mjs");
const src = fs.readFileSync(SRC, "utf8");

function lift(name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  // ⚠️ START AT THE BODY BRACE, NOT THE FIRST ONE. `resolveReach` destructures
  // its options in the parameter list, so counting from the first brace closed
  // the function at its own signature and lifted a stub.
  const lineEnd = src.indexOf(NL, start);
  let i = src.lastIndexOf("{", lineEnd);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { end = i + 1; break; } }
  }
  return end < 0 ? null : src.slice(start, end).replace(/^export\s+/, "");
}

const parts = ["toFeet", "reachFromDescription", "resolveReach"].map(lift);
if (parts.some(p => !p)) {
  console.error("FAIL — could not lift the resolver out of reach-reader.mjs.");
  console.error("       Fix this extractor; do not delete it, or reach goes untested.");
  process.exit(1);
}

// The only world it touches: a log tag, and a dynamic import it must not make.
const { resolveReach } = new Function("MODULE_ID", "console", `
  ${parts.join(NL)}
  return { resolveReach };
`)("ace-qol", { log() {}, warn() {}, error() {} });

const item = (system) => ({ name: "bench item", system });

const CASES = [
  {
    title: "Spiked Chain — reach only in the description (Johnny's, 2026-08-23)",
    item: item({
      range: { units: "ft" },
      description: { value: "<p>Melee Attack Roll: +9, reach 10 ft., one target.</p>" },
    }),
    activity: null,
    want: 10,
    wantSource: "the item's description",
  },
  {
    title: "Glaive — reach in its own slot, where dnd5e's migration moved it",
    item: item({ range: { reach: 10, units: "ft" } }),
    activity: null,
    want: 10,
    wantSource: "the item's reach field",
  },
  {
    title: "Longsword — nothing declared anywhere",
    item: item({ range: { units: "ft" } }),
    activity: null,
    want: 5,
    wantSource: "the 5 feet default (nothing declared it)",
  },
  {
    title: "Whip — the reach property and nothing else",
    item: item({ range: { units: "ft" }, properties: ["rch"] }),
    activity: null,
    want: 10,
    wantSource: "the reach property",
  },
  {
    title: "Activity overrides the item",
    item: item({ range: { reach: 5, units: "ft" } }),
    activity: { range: { reach: 15, units: "ft" } },
    want: 15,
    wantSource: "the activity's reach field",
  },
  {
    title: "Produce Flame — a melee spell attack that legitimately throws 30 ft",
    item: item({ range: { value: 30, units: "ft" } }),
    activity: { range: { value: 30, units: "ft" } },
    want: 30,
    // ⚠️ ONE SLOT, ONE NAME (0.69.0). An activity has no `reach` field at all in
    // dnd5e 5.x — only the weapon data model has one — so an activity's range
    // VALUE is the only place a feature's reach can live, and it is what the
    // Attack tab's Targeting box holds. The reader names that field the same way
    // wherever it reads it from.
    wantSource: "the attack activity's range value",
  },
  {
    title: "A thrown weapon must NOT have its long range mistaken for reach",
    item: item({ range: { reach: 5, value: 20, long: 60, units: "ft" } }),
    activity: null,
    want: 5,
    wantSource: "the item's reach field",
  },
  {
    title: "Metric table — 3 m is 10 ft by D&D's convention, not 9.8",
    item: item({ range: { reach: 3, units: "m" } }),
    activity: null,
    want: 10,
    wantSource: "the item's reach field",
  },
  {
    title: "A description naming two reaches takes the first, and says where from",
    item: item({
      range: { units: "ft" },
      description: { value: "<p>reach 15 ft. with the tail, reach 5 ft. with the claw</p>" },
    }),
    activity: null,
    want: 15,
    wantSource: "the item's description",
  },
];

let ok = true;
console.log("");
console.log("REACH — DOES EVERY CALLER GET THE SAME ANSWER?");
console.log("=".repeat(78));

for (const c of CASES) {
  let got;
  try {
    got = resolveReach(c.item, c.activity, { repair: false });
  } catch (err) {
    got = { reachFt: NaN, source: `THREW: ${err?.message ?? err}` };
  }
  const pass = got.reachFt === c.want && got.source === c.wantSource;
  if (!pass) ok = false;
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.title}`);
  console.log(`        ${got.reachFt} ft from ${got.source}`);
  if (!pass) console.log(`        EXPECTED ${c.want} ft from ${c.wantSource}`);
}

/* ══ AND THE REPAIR WRITES WHERE THE READER LOOKS ═══════════════════════

   His table, 2026-09-30: *"Console says it wrote 10. The Attack activity
   Targeting range value is still empty. It is writing the old item.system.range
   field."*

   ⚠️🔴 THE WRITE WENT INTO A FIELD THE SCHEMA DOES NOT HAVE. Only dnd5e's
   WEAPON data model carries `range.reach`; a feat has no `system.range` at all,
   and Spiked Chain is a feat. `item.update` with an undefined key resolves
   without a word, so the log said "Wrote reach 10" over a write that did nothing,
   and the reader proposed the same repair on every swing for the rest of the
   session. These pins are on the SOURCE, because the source is the file — there
   is no live document here to write to.
   ══════════════════════════════════════════════════════════════════════ */
const repair = fs.readFileSync(
  "D:/FoundryVTT/Data/modules/ace-qol/scripts/reach-repair.mjs", "utf8");
const reader = fs.readFileSync(
  "D:/FoundryVTT/Data/modules/ace-qol/scripts/reach-reader.mjs", "utf8");

const pins = [
  ["the destination is asked of the schema, not guessed from the type",
    /item\?\.system\?\.schema\?\.getField\?\.\("range\.reach"\)/.test(repair)
      && /activity\.schema\?\.getField\?\.\("range\.value"\)/.test(repair)],
  ["a feat's reach goes on the attack activity's range, in feet",
    /await where\.activity\.update\(\{ "range\.value": String\(ft\), "range\.units": "ft" \}\);/.test(repair)],
  ["a weapon's still goes in its own reach field, which dnd5e reads",
    /await item\.update\(\{ "system\.range\.reach": ft \}\);/.test(repair)],
  ["one attack activity only — two is a guess and it refuses",
    /it has \$\{all\.length\} attack activities/.test(repair)],
  ["it cannot be written → his words, and NOT a success line",
    /could not write reach on \$\{item\.name\} — \$\{done\.why\}/.test(repair)
      && /no activity range field/.test(repair)],
  ["a success line only after a write that took",
    /if \(!done\.ok\) \{/.test(repair) && /Wrote reach \$\{ft\} feet onto/.test(repair)],
  ["said once, so the console is quiet on the next swing",
    /_refused\.add\(uuid\);/.test(repair) && /if \(_refused\.has\(uuid\)\) return;/.test(repair)],
  ["\"already has it\" is asked of the field that will hold it",
    /const where = reachDestination\(item\);/.test(repair)
      && /if \(where\.current > 0\) return 0;/.test(repair)],
  ["the bulk pass writes to the same place",
    /const w = await writeReach\(r\.item, r\.ft\);/.test(repair)],
  ["and the reader reads the activity's range value, so the repair sticks",
    /activityReach = toFeet\(activityRange\.value, activityRange\.units \|\| units\);/.test(reader)],
  ["a long range is still a range, never a reach",
    /if \(!activityReach && activityRange && longRange === 0\) \{/.test(reader)],
];

console.log("");
console.log("THE REPAIR WRITES WHERE THE READER LOOKS");
console.log("=".repeat(78));
for (const [label, got] of pins) {
  if (!got) ok = false;
  console.log(`  ${got ? "PASS" : "FAIL"}  ${label}`);
}

console.log("");
console.log("=".repeat(78));
console.log(ok
  ? "ALL PASS — one resolver, and it names where every number came from."
  : "FAILURES ABOVE — the gate, the card, the tooltip and the profile would disagree.");
process.exit(ok ? 0 : 1);
