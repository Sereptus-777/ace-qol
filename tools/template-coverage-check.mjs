// ─── Does a creature standing in the area actually get caught? ───────────────
//
// ⚠️ WHY THIS EXISTS. `_getTokensInTemplate` used to test ONE point per square:
// the exact centre. That is the strictest reading of "is the creature in the
// area" that exists, and it fails in ways a person watching the table can see:
// a goblin three-quarters inside a cone takes nothing because the middle pixel
// fell outside the edge (Johnny, 2026-08-24: "The Goblin is inside the
// template, well within the 15 ft").
//
// The 2014 DMG (p.251, Areas of Effect on a Grid) gives the rule: an area
// affects a square when it covers AT LEAST HALF of it. The shipped code samples
// a 3x3 lattice per square and requires five of nine.
//
// This bench lifts the sampling constants OUT OF THE SHIPPED FILE and runs them
// against a real 5e cone so the rule is demonstrated rather than asserted.
//
// Run:  node tools/template-coverage-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The geometry moved out of save-engine.mjs on 2026-08-27, because ACE had
// TWO of them: the save engine used half-coverage and the concentration
// tracker used a single centre point, so a creature half inside a Moonbeam
// was caught on the cast and took nothing walking back in. One function now.
//
// This bench FAILED LOUDLY when the constants vanished rather than passing
// on an empty extraction, which is the only reason the move was noticed at
// all. Keep it that way.
const SRC = path.join(here, "..", "scripts", "template-geometry.mjs");
const src = fs.readFileSync(SRC, "utf8");

// Lift, never retype.
const sampleLine = src.split("\n").find(l => l.includes("const SAMPLES = ["));
const thresholdLine = src.split("\n").find(l => l.includes("covered >= "));
if (!sampleLine || !thresholdLine) {
  console.error("FAIL — could not find the sampling constants in template-geometry.mjs.");
  console.error("       Fix this extractor; do not delete it, or the rule goes untested.");
  process.exit(1);
}
const SAMPLES = eval(sampleLine.replace(/^\s*const\s+SAMPLES\s*=\s*/, "").replace(/;\s*$/, ""));
const THRESHOLD = Number(/covered >= (\d+)/.exec(thresholdLine)[1]);
console.log(`lifted from template-geometry.mjs: SAMPLES=${JSON.stringify(SAMPLES)} threshold=${THRESHOLD} of ${SAMPLES.length ** 2}\n`);

// A 5e cone: apex at the origin, 53.13 degrees wide, pointing along +x.
// (dnd5e uses a cone whose width at distance L equals L.)
const GRID = 100;          // px per square
const FT_PER_SQ = 5;
const CONE_FT = 15;
const CONE_PX = (CONE_FT / FT_PER_SQ) * GRID;
const HALF_ANGLE = Math.atan(0.5);   // width == length  ->  half-width == L/2

function inCone(localX, localY) {
  const r = Math.hypot(localX, localY);
  if (r > CONE_PX || r === 0) return false;
  return Math.abs(Math.atan2(localY, localX)) <= HALF_ANGLE;
}

// The shipped algorithm, same shape: centre fast path, then the lattice.
function squareIsInside(sqX, sqY) {
  if (inCone(sqX + GRID / 2, sqY + GRID / 2)) return true;
  let covered = 0;
  for (const fx of SAMPLES) for (const fy of SAMPLES) {
    if (inCone(sqX + fx * GRID, sqY + fy * GRID)) covered++;
  }
  return covered >= THRESHOLD;
}

// Centre-point-only, for the before/after comparison.
function centreOnly(sqX, sqY) {
  return inCone(sqX + GRID / 2, sqY + GRID / 2);
}

const cases = [
  // [label, square top-left x, y, expected]
  ["dead on the centre line, one square out",   100,  -50, true],
  ["dead on the centre line, two squares out",  200,  -50, true],
  ["clipped by the cone edge, mostly inside",   200,   40, true],
  ["barely nicked by the edge, mostly outside", 200,  135, false],
  ["behind the caster",                        -150,  -50, false],
  ["past the end of the cone",                  400,  -50, false],
];

let ok = true;
console.log("square                                   half-square   centre-only");
for (const [label, x, y, want] of cases) {
  const got = squareIsInside(x, y);
  const old = centreOnly(x, y);
  if (got !== want) ok = false;
  const mark = got === want ? "PASS" : "FAIL";
  console.log(`  ${label.padEnd(38)} ${String(got).padEnd(13)} ${String(old).padEnd(6)} ${mark}`);
}

const changed = cases.filter(([, x, y]) => squareIsInside(x, y) !== centreOnly(x, y));
console.log(`\n${changed.length} of ${cases.length} squares change answer under the new rule:`);
for (const [label] of changed) console.log(`   ${label}`);

console.log("\n" + (ok ? "ALL PASS" : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
