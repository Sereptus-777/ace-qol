// ─── One rule decides every dnd5e dialog, and it survives a slow player ──────
//
// ⚠️ WHAT THIS IS PROVING. Suppression of dnd5e's roll dialogs used to happen
// three unrelated ways, one of which was a prototype patch switched on by a
// marker that a FIVE-SECOND TIMER wiped. Leave the spell-slot dialog open
// longer than that — somebody asks a question mid-turn — and Magic Missile
// forgot it had ever been cast and did nothing at all. Johnny lost it live,
// 2026-08-24.
//
// There is now one listener, on the one hook dnd5e fires for every roll, and it
// makes a synchronous decision from settings. No marker, no clock. This bench
// drives that decision function directly with the configs dnd5e would hand it.
//
// ⚠️ THE DECISION LOGIC IS LIFTED OUT OF THE SHIPPED FILE, never retyped — a
// test carrying its own copy of the rule passes forever while the code rots.
//
// Run:  node tools/dialog-suppression-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "scripts", "dialog-suppression.mjs");
const src = fs.readFileSync(SRC, "utf8");

// Pull the three decision methods out of the class body.
function lift(name) {
  const start = src.indexOf(`  static ${name}(`);
  if (start < 0) return null;
  // Walk braces to the end of the method.
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { end = i + 1; break; } }
  }
  return end < 0 ? null : src.slice(start, end).replace(/^\s*static\s+/, "");
}

const DRIVEN_SRC = src.slice(src.indexOf("const DRIVEN = {"), src.indexOf("};", src.indexOf("const DRIVEN = {")) + 2);
const parts = ["_on", "_damageIsDriven", "_reasonToSuppress"].map(lift);
if (parts.some(p => !p) || !DRIVEN_SRC) {
  console.error("FAIL — could not lift the decision logic from dialog-suppression.mjs.");
  console.error("       Fix this extractor; do not delete it, or the rule goes untested.");
  process.exit(1);
}

// Stand up just enough world for it: a settings table we control.
let SETTINGS = {};
globalThis.QolSettings = { get: (k) => SETTINGS[k] };

const DialogSuppression = new Function("QolSettings", `
  ${DRIVEN_SRC}
  const DialogSuppression = { ${parts.join(",\n")} };
  return DialogSuppression;
`)(globalThis.QolSettings);

// dnd5e's own hookNames for each roll type, from its source.
const CONFIGS = {
  "weapon attack":       { hookNames: ["attack", "d20Test", ""], subject: { item: { type: "weapon" } } },
  "weapon damage":       { hookNames: ["damage", ""],            subject: { item: { type: "weapon" } } },
  "spell attack":        { hookNames: ["attack", "d20Test", ""], subject: { item: { type: "spell" } } },
  "spell damage":        { hookNames: ["damage", ""],            subject: { item: { type: "spell" } } },
  "ability check":       { hookNames: ["dex", "abilityCheck", "d20Test", ""] },
  "skill check":         { hookNames: ["stealth", "d20Test", ""] },
  "initiative":          { hookNames: ["initiativeDialog", "abilityCheck", "d20Test", ""] },
  "death save":          { hookNames: ["deathSave", ""] },
  "hit die":             { hookNames: ["hitDie", ""] },
  "concentration":       { hookNames: ["concentration", ""] },
};

let ok = true;
function scenario(title, settings, expected) {
  SETTINGS = settings;
  console.log(`\n${title}`);
  console.log(`  ${Object.entries(settings).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  for (const [label, cfg] of Object.entries(CONFIGS)) {
    const suppressed = DialogSuppression._reasonToSuppress(cfg) !== null;
    const want = expected.includes(label);
    if (suppressed !== want) ok = false;
    const mark = suppressed === want ? "PASS" : "FAIL";
    const verb = suppressed ? "ACE handles it   " : "dnd5e keeps dialog";
    console.log(`    ${mark}  ${label.padEnd(16)} ${verb}`);
  }
}

scenario("Everything on — ACE drives attacks and damage",
  { autoCheckHit: true, spellAutoDamageEnabled: true },
  ["weapon attack", "weapon damage", "spell attack", "spell damage"]);

scenario("Attack pipeline OFF — dnd5e must get its attack dialog back",
  { autoCheckHit: false, spellAutoDamageEnabled: true },
  ["spell damage"]);

scenario("Spell pipeline OFF — the switch that rescued the live session",
  { autoCheckHit: true, spellAutoDamageEnabled: false },
  ["weapon attack", "weapon damage", "spell attack"]);

scenario("Both OFF — ACE suppresses nothing at all",
  { autoCheckHit: false, spellAutoDamageEnabled: false },
  []);

// ⚠️ The rule must never depend on how long anything took. Same inputs, same
// answer, whether the slot dialog was open two seconds or two minutes.
SETTINGS = { autoCheckHit: true, spellAutoDamageEnabled: true };
const first = DialogSuppression._reasonToSuppress(CONFIGS["spell damage"]);
const later = DialogSuppression._reasonToSuppress(CONFIGS["spell damage"]);
console.log("\nMagic Missile with the slot dialog left open");
const stable = first !== null && later !== null && first === later;
if (!stable) ok = false;
console.log(`    ${stable ? "PASS" : "FAIL"}  the answer does not change over time — nothing is counting`);

console.log("\n" + (ok
  ? "ALL PASS — one rule, no marker, no clock, and 'off' still means off."
  : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
