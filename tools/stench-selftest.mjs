// ─── Stench self-test: the turn-start engine reads a save-or-condition aura ──
//
// His call, 2026-10-14: "Ghast stench first", in the turn-start engine
// (creature-triggers.mjs). The other creature's turn used to need the word
// "damage", so no stench caught anybody. This pins what the words reader must
// say about each one, from dnd5e 5.3.3's own pack text, and what it must NOT
// catch: the 2014 basilisk's gaze is the gaze engine's ("can force").
//
// Run: node tools/stench-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readTurnAura, kindOf } from "../scripts/rules/creature-words.mjs";

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}

/** An item as dnd5e hands it to ACE: owned by a creature, with its activities. */
function item(actorName, name, html, activities = {}) {
  return { name, actor: { name: actorName }, system: { description: { value: html }, activities } };
}

// dnd5e 5.3.3, packs/monsters (2014) and packs/actors24 (2024), word for word.
const GHAST_2014 = item("Ghast", "Stench",
  "<p>Any creature that starts its turn within 5 feet of the ghast must succeed on a DC 10 Constitution "
  + "saving throw or be poisoned until the start of its next turn. On a successful saving throw, the "
  + "creature is immune to the ghast's Stench for 24 hours.</p>",
  { a1: { type: "save", activation: { type: "" }, target: { template: { size: "5" } } } });

const GHAST_2024 = item("Ghast", "Stench",
  "<p><em>Constitution Saving Throw</em>: DC [[lookup @save.dc.value activity=mJbwhj3beOIB3Jgj]], any "
  + "creature (other than a [[lookup @name lowercase]]{monster}) that starts its turn in a "
  + "[[lookup @target.template.size activity=mJbwhj3beOIB3Jgj]]-foot Emanation originating from the "
  + "[[lookup @name lowercase]]{monster}. <em>Failure</em>: The target has the &amp;Reference[Poisoned "
  + "apply=false] condition until the start of its next turn. <em>Success</em>: The target is immune to "
  + "the Stench of all [[lookup @name lowercase]]{monster} for 1 hour.</p>",
  { mJbwhj3beOIB3Jgj: { type: "save", activation: { type: "" }, save: { dc: { value: 10 } },
    target: { template: { size: "5" } } } });

const HEZROU_2014 = item("Hezrou", "Stench",
  "<p>Any creature that starts its turn within 10 feet of the hezrou must succeed on a [[/save]] saving "
  + "throw or be &amp;Reference[poisoned] until the start of its next turn. On a successful saving throw, "
  + "the creature is immune to the hezrou's stench for 24 hours.</p>",
  { a1: { type: "save", activation: { type: "" } } });

// The 2014 troglodyte (not in the SRD packs): "other than" without brackets.
const TROGLODYTE_2014 = item("Troglodyte", "Stench",
  "<p>Any creature other than a troglodyte that starts its turn within 5 feet of the troglodyte must "
  + "succeed on a DC 12 Constitution saving throw or be poisoned until the start of the creature's next "
  + "turn. On a successful saving throw, the creature is immune to the stench of all troglodytes for 1 hour.</p>");

const BASILISK_2014 = item("Basilisk", "Petrifying Gaze",
  "<p>If a creature starts its turn within 30 ft. of the basilisk and the two of them can see each other, "
  + "the basilisk can force the creature to make a DC 12 Constitution saving throw if the basilisk isn't "
  + "incapacitated. On a failed save, the creature magically begins to turn to stone and is restrained.</p>");

const FIRE_2014 = item("Fire Elemental", "Fire Form",
  "<p>A creature that touches the elemental or hits it with a melee attack while within 5 feet of it takes "
  + "5 (1d10) fire damage. A creature that starts its turn within 5 feet of the elemental takes 5 (1d10) "
  + "fire damage.</p>");

console.log("Stench: the turn-start engine reads a save-or-condition aura");

const g14 = readTurnAura(GHAST_2014);
check("2014 Ghast: the other creature's turn, 5 feet", g14?.when === "their-start" && g14?.radiusFt === 5, JSON.stringify(g14));
check("2014 Ghast: poisoned, for one round (until the start of its next turn)", g14?.condition === "poisoned" && g14?.lastsSeconds === 6);
check("2014 Ghast: a made save is 24 hours against THAT ghast", g14?.immunity?.hours === 24 && g14?.immunity?.allOfKind === false);
check("2014 Ghast: nobody left out by its words", !g14?.excludes);
check("2014 Ghast: no damage", (g14?.dice ?? []).length === 0);

const g24 = readTurnAura(GHAST_2024);
check("2024 Ghast: the lookups read, 5-foot Emanation", g24?.when === "their-start" && g24?.radiusFt === 5, JSON.stringify(g24));
check("2024 Ghast: other ghasts are left out", kindOf(g24?.excludes ?? "") === "ghast");
check("2024 Ghast: poisoned, for one round", g24?.condition === "poisoned" && g24?.lastsSeconds === 6);
check("2024 Ghast: a made save is 1 hour against EVERY ghast", g24?.immunity?.hours === 1 && g24?.immunity?.allOfKind === true);

const h14 = readTurnAura(HEZROU_2014);
check("2014 Hezrou: 10 feet, poisoned, 24 hours", h14?.radiusFt === 10 && h14?.condition === "poisoned" && h14?.immunity?.hours === 24);

const t14 = readTurnAura(TROGLODYTE_2014);
check("2014 Troglodyte: \"other than a troglodyte\" with no brackets", kindOf(t14?.excludes ?? "") === "troglodyte", JSON.stringify(t14));
check("2014 Troglodyte: 1 hour against all troglodytes", t14?.immunity?.hours === 1 && t14?.immunity?.allOfKind === true);

check("2014 Basilisk: a gaze is NOT a stench (it \"can force\")", readTurnAura(BASILISK_2014) === null);

const f14 = readTurnAura(FIRE_2014);
check("2014 Fire Elemental: still a damage aura, unchanged", f14?.when === "their-start" && f14?.radiusFt === 5
  && (f14?.dice ?? []).length === 1 && !f14?.condition, JSON.stringify(f14));

check("kindOf: a token's actor, the word, the plural", kindOf({ actor: { name: "Ghast" } }) === "ghast"
  && kindOf("ghasts") === "ghast" && kindOf("Ghast") === "ghast");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
