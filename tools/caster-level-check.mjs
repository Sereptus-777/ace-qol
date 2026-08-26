// ─── A CR 21 Lich is not a first-level caster ────────────────────────────────
//
// ⚠️🔴 WHAT THIS IS PROVING. Eldritch Blast's beam count comes from the
// CASTER'S level — 1 beam, 2 at 5th, 3 at 11th, 4 at 17th. ACE looked in three
// places for that number and every one of them is empty on Johnny's Lich:
//
//     details.level        undefined
//     details.spellLevel   undefined
//     attributes.spell     { level: 0 }
//     cr                   21
//
// It read 0, the caller turned that into 1, and a CR 21 spellcaster threw ONE
// beam at a Flameskull. Silently. Nothing said "I could not work this out".
//
// The reader now climbs a ladder and names the rung that answered:
//   1. a PC's own class levels
//   2. the declared caster-level fields
//   3. the HIGHEST SPELL SLOT the creature owns, read backwards through RAW's
//      own progression table
//   4. challenge rating, as a rough floor
//
// ⚠️ SLOTS BEFORE CR, DELIBERATELY. Slots are what the statblock actually
// grants. CR is a difficulty rating that happens to correlate.
//
// ⚠️ THE READER IS LIFTED FROM THE SHIPPED FILE, never retyped — a bench
// carrying its own copy of the rule passes forever while the code rots.
//
// Run:  node tools/caster-level-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "scripts", "profiles", "attacker-profile.mjs");
const src = fs.readFileSync(SRC, "utf8");

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const lineEnd = src.indexOf(NL, start);
  let i = src.lastIndexOf("{", lineEnd);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { end = i + 1; break; } }
  }
  return end < 0 ? null : src.slice(start, end);
}

const body = lift("_casterLevel");
if (!body) {
  console.error("FAIL — could not lift _casterLevel out of attacker-profile.mjs.");
  console.error("       Fix this extractor; do not delete it, or the ladder goes untested.");
  process.exit(1);
}
const _casterLevel = new Function(`${body}${NL}return _casterLevel;`)();

const npc = (details, spells = {}) => ({ type: "npc", system: { details, spells } });

const CASES = [
  {
    title: "Johnny's Lich — CR 21, every level field empty, 9th-level slots",
    actor: npc({ cr: 21 }, {
      spell1: { max: 4 }, spell5: { max: 3 }, spell8: { max: 1 }, spell9: { max: 1 },
    }),
    classLevels: {}, charLevel: 0,
    wantAtLeast: 17,
    why: "a 9th-level slot cannot exist below caster level 17 — that is RAW's own table",
  },
  {
    title: "The same Lich with NO slots recorded at all",
    actor: npc({ cr: 21 }),
    classLevels: {}, charLevel: 0,
    wantAtLeast: 21,
    why: "falls to challenge rating rather than to 1",
  },
  {
    title: "An NPC whose importer DID set a caster level",
    actor: npc({ cr: 9, spellLevel: 12 }),
    classLevels: {}, charLevel: 0,
    wantExact: 12,
    why: "a declared value beats every guess below it",
  },
  {
    title: "A 5th-level PC warlock",
    actor: { type: "character", system: { details: { level: 5 }, spells: {} } },
    classLevels: { warlock: 5 }, charLevel: 5,
    wantExact: 5,
    why: "a PC casts at their character level",
  },
  {
    title: "A goblin with a sword and no magic whatsoever",
    actor: npc({ cr: 0.25 }),
    classLevels: {}, charLevel: 0,
    wantExact: 0,
    why: "0 with a reason, never a silent 1",
  },
  {
    title: "A CR 1/2 acolyte with 1st-level slots",
    actor: npc({ cr: 0.5 }, { spell1: { max: 3 } }),
    classLevels: {}, charLevel: 0,
    wantExact: 1,
    why: "slots say 1, and slots outrank a fractional CR",
  },
];

// The beam table Eldritch Blast actually uses.
const beams = (L) => (L >= 17 ? 4 : L >= 11 ? 3 : L >= 5 ? 2 : 1);

let ok = true;
console.log("");
console.log("CASTER LEVEL — WHAT DOES THE LADDER ANSWER?");
console.log("=".repeat(78));

for (const c of CASES) {
  let got;
  try {
    got = _casterLevel(c.actor, c.classLevels, c.charLevel);
  } catch (err) {
    got = { level: NaN, source: `THREW: ${err?.message ?? err}` };
  }
  const pass = c.wantExact !== undefined
    ? got.level === c.wantExact
    : got.level >= c.wantAtLeast;
  if (!pass) ok = false;
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${c.title}`);
  console.log(`        level ${got.level} from ${got.source}`);
  console.log(`        ${beams(got.level)} Eldritch Blast beam(s)`);
  console.log(`        ${c.why}`);
  if (!pass) {
    console.log(`        EXPECTED ${c.wantExact !== undefined ? c.wantExact : `${c.wantAtLeast} or more`}`);
  }
}

// The headline: the exact creature and the exact spell that went wrong.
const lich = _casterLevel(CASES[0].actor, {}, 0);
console.log("");
console.log("=".repeat(78));
const fixed = beams(lich.level) === 4;
if (!fixed) ok = false;
console.log(`  ${fixed ? "PASS" : "FAIL"}  the Lich now fires ${beams(lich.level)} beams, not 1`);
console.log("");
console.log(ok
  ? "ALL PASS — an empty field is treated as a question, not as level 1."
  : "FAILURES ABOVE");
process.exit(ok ? 0 : 1);
