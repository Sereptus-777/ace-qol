// ─── Which ability does a character rule grant, and on which weapon? ─────────
//
// ⚠️🔴 WHAT THIS IS PROVING. dnd5e resolves an attack's ability from the WEAPON
// — a finesse weapon offers Strength and Dexterity, a longsword offers Strength
// alone. Every rule below is a CHARACTER feature the system cannot see, so
// deferring to dnd5e means a Charisma 20 warlock swings at their Strength and a
// monk's quarterstaff rolls Strength too.
//
// Johnny, 2026-08-26: "does that include when the warlock is using his, and it
// should be picking charisma and other cases that you know of?" — and then
// "add shillelagh, monk martial arts, and kensei to the rule table".
//
// ⚠️ EVERY CASE ASSERTS THE WEAPON AS WELL AS THE ABILITY. A rule that grants
// Dexterity on a greataxe is worse than no rule, because it is wrong in the
// player's favour and nobody reports it.
//
// ⚠️ THE RULE IS LIFTED FROM THE SHIPPED FILE, never retyped.
//
// Run:  node tools/ability-rules-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NL = String.fromCharCode(10);
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "scripts", "attack-ability-resolver.mjs");
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

const parts = ["_isMonkWeapon", "_shillelaghActive", "_findFeat", "_resolveAbilityOverride"].map(lift);
if (parts.some(p => !p)) {
  console.error("FAIL — could not lift the ability rules out of attack-ability-resolver.mjs.");
  console.error("       Fix this extractor; do not delete it, or the rule table goes untested.");
  process.exit(1);
}

// Just enough world: a log tag, a settings table, and the edition reader.
let EDITION = "2014";
const { _resolveAbilityOverride, _isMonkWeapon } = new Function(
  "MODULE_ID", "CombatState", "game", "console",
  `${parts.join(NL)}${NL}return { _resolveAbilityOverride, _isMonkWeapon };`
)(
  "ace-qol",
  { getActiveEdition: () => EDITION },
  { settings: { get: () => true } },
  { debug() {}, warn() {}, log() {} }
);

/** A weapon, in dnd5e's real shape. */
const weapon = (name, type, props = [], baseItem = "") => ({
  name, type: "weapon",
  system: { type: { value: type, baseItem }, properties: props },
});

/** An actor with the named features and the given ability modifiers. */
const actor = (feats, mods, effects = []) => ({
  name: "Test",
  items: feats.map(n => ({ type: "feat", name: n, system: {} })),
  effects: effects.map(n => ({ name: n, disabled: false, isSuppressed: false })),
  system: {
    abilities: Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, { mod: v }])),
    attributes: { spellcasting: mods._sc ?? "wis" },
  },
});

let ok = true;
const check = (title, got, want, why) => {
  const pass = want === null
    ? got === null
    : got !== null && got.ability === want.ability && got.mod === want.mod
      && String(got.why).includes(want.why);
  if (!pass) ok = false;
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${title}`);
  console.log(`        ${got ? `${got.ability.toUpperCase()} ${got.mod >= 0 ? "+" : ""}${got.mod} — ${got.why}` : "no override (the weapon's own ability stands)"}`);
  console.log(`        ${why}`);
  if (!pass) console.log(`        EXPECTED ${want ? `${want.ability} ${want.mod} ${want.why}` : "no override"}`);
};

console.log("");
console.log("SHILLELAGH");
console.log("=".repeat(78));

check("A druid with Shillelagh running, holding a quarterstaff",
  _resolveAbilityOverride(actor([], { str: 0, wis: 4, _sc: "wis" }, ["Shillelagh"]),
    weapon("Quarterstaff", "simpleM", ["ver"], "quarterstaff")),
  { ability: "wis", mod: 4, why: "Shillelagh" },
  "the spell says spellcasting ability instead of Strength");

check("The same druid swinging a LONGSWORD with Shillelagh up",
  _resolveAbilityOverride(actor([], { str: 0, wis: 4, _sc: "wis" }, ["Shillelagh"]),
    weapon("Longsword", "martialM", [], "longsword")),
  null,
  "club and quarterstaff only — the effect does not travel to other weapons");

check("A druid holding a quarterstaff who has NOT cast it",
  _resolveAbilityOverride(actor([], { str: 0, wis: 4, _sc: "wis" }, []),
    weapon("Quarterstaff", "simpleM", ["ver"], "quarterstaff")),
  null,
  "it is an EFFECT, not a feature — no effect, no Wisdom");

console.log("");
console.log("MARTIAL ARTS");
console.log("=".repeat(78));

check("A monk's quarterstaff — the case dnd5e cannot see",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Quarterstaff", "simpleM", ["ver"], "quarterstaff")),
  { ability: "dex", mod: 4, why: "Martial Arts" },
  "simple melee, not two-handed, not heavy, and NOT finesse — so dnd5e offers Strength alone");

check("A monk's greataxe",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Greataxe", "martialM", ["hvy", "two"], "greataxe")),
  null,
  "martial, heavy and two-handed — not a monk weapon in any edition");

check("A monk's shortsword",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Shortsword", "martialM", ["fin", "lgt"], "shortsword")),
  { ability: "dex", mod: 4, why: "Martial Arts" },
  "named as a monk weapon in both editions");

check("2014: a monk's spear is two-handed-capable but not two-handed",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Spear", "simpleM", ["ver", "thr"], "spear")),
  { ability: "dex", mod: 4, why: "Martial Arts" },
  "versatile is not the two-handed property — a spear qualifies");

EDITION = "2024";
check("2024: a monk's LIGHT martial weapon (scimitar)",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Scimitar", "martialM", ["fin", "lgt"], "scimitar")),
  { ability: "dex", mod: 4, why: "Martial Arts" },
  "2024 admits martial melee weapons with the Light property");

check("2024: a monk's heavy simple weapon",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Greatclub", "simpleM", ["two"], "greatclub")),
  { ability: "dex", mod: 4, why: "Martial Arts" },
  "2024 dropped the two-handed exclusion for SIMPLE melee weapons");

EDITION = "2014";
check("2014: the same greatclub is NOT a monk weapon",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Greatclub", "simpleM", ["two"], "greatclub")),
  null,
  "2014 excludes two-handed — the editions genuinely differ here");

console.log("");
console.log("KENSEI");
console.log("=".repeat(78));

check("A Kensei monk's longsword",
  _resolveAbilityOverride(actor(["Martial Arts", "Way of the Kensei"], { str: 0, dex: 4 }),
    weapon("Longsword", "martialM", ["ver"], "longsword")),
  { ability: "dex", mod: 4, why: "Kensei weapon" },
  "Kensei makes chosen weapons COUNT as monk weapons; the Dexterity still comes from Martial Arts");

check("A Kensei monk's greataxe",
  _resolveAbilityOverride(actor(["Martial Arts", "Way of the Kensei"], { str: 0, dex: 4 }),
    weapon("Greataxe", "martialM", ["hvy", "two"], "greataxe")),
  null,
  "Kensei weapons may not be heavy — the widening has a limit");

check("A NON-Kensei monk's longsword",
  _resolveAbilityOverride(actor(["Martial Arts"], { str: 0, dex: 4 }),
    weapon("Longsword", "martialM", ["ver"], "longsword")),
  null,
  "without Kensei a martial longsword is not a monk weapon");

console.log("");
console.log("=".repeat(78));
console.log(ok
  ? "ALL PASS — each rule grants its ability on its own weapons and no others."
  : "FAILURES ABOVE — a rule is granting an ability on the wrong weapon.");
process.exit(ok ? 0 : 1);
