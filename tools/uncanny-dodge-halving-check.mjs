// ─── Uncanny Dodge halves the ATTACK, not each damage type ───────────────────
//
// ⚠️ WHY THIS EXISTS. "Halve the attack's damage" is one number, but a hit
// arrives as several components — 7 slashing plus 3 fire. Halving each of them
// on its own and flooring gives 3 + 1 = 4, when half of 10 is 5. The rogue
// loses a point on every multi-type hit, for ever, and nobody ever notices
// because the number still looks plausible.
//
// The shipped code halves the TOTAL and then distributes it. This bench lifts
// that distribution out of `reaction-engine.mjs` and checks two things on every
// case: the parts add up to the halved total, and no part is negative.
//
// Run:  node tools/uncanny-dodge-halving-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "scripts", "reaction-engine.mjs");
const src = fs.readFileSync(SRC, "utf8");

const start = src.indexOf("      let remaining = halved;");
const end = src.indexOf("});", start);
if (start < 0 || end < 0) {
  console.error("FAIL — could not find the halving logic in reaction-engine.mjs.");
  console.error("       Fix this extractor; do not delete it, or the maths goes untested.");
  process.exit(1);
}
const body = src.slice(start, end + 3);

const distribute = new Function("damageComponents", "halved", "total", `${body}\nreturn modifiedComponents;`);

const cases = [
  ["single type, even",        [{ type: "slashing", total: 10 }]],
  ["single type, odd",         [{ type: "slashing", total: 7 }]],
  ["two types, the classic",   [{ type: "slashing", total: 7 }, { type: "fire", total: 3 }]],
  ["three types",              [{ type: "piercing", total: 9 }, { type: "cold", total: 4 }, { type: "necrotic", total: 2 }]],
  ["a zero component",         [{ type: "bludgeoning", total: 5 }, { type: "poison", total: 0 }]],
  ["one point of damage",      [{ type: "slashing", total: 1 }]],
  ["big multi-type crit",      [{ type: "slashing", total: 23 }, { type: "radiant", total: 11 }, { type: "fire", total: 7 }]],
];

let ok = true;
console.log("case                          before  ->  after                     total  want");
for (const [label, comps] of cases) {
  const total = comps.reduce((s, c) => s + c.total, 0);
  const halved = Math.floor(total / 2);
  const out = distribute(comps, halved, total);
  const sum = out.reduce((s, c) => s + c.total, 0);
  const negative = out.some(c => c.total < 0);
  const pass = sum === halved && !negative;
  if (!pass) ok = false;

  const before = comps.map(c => `${c.total} ${c.type}`).join(" + ");
  const after = out.map(c => `${c.total} ${c.type}`).join(" + ");
  console.log(`  ${label.padEnd(28)} ${before.padEnd(24)} -> ${after.padEnd(24)} ${String(sum).padStart(3)}   ${String(halved).padStart(3)}  ${pass ? "PASS" : "FAIL"}`);

  // The naive approach, for contrast — this is the bug being avoided.
  const naive = comps.reduce((s, c) => s + Math.floor(c.total / 2), 0);
  if (naive !== halved) {
    console.log(`      ${" ".repeat(26)}halving each type separately would give ${naive}, robbing the rogue of ${halved - naive}`);
  }
}

console.log("\n" + (ok ? "ALL PASS — the parts always add up to half the attack." : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
