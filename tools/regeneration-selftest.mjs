// ─── Regeneration self-test: the number a creature regains ────────────────────
//
// His table, 2026-10-14: "should regain 1 hit point... Isn't it 10, like every
// other regeneration? ...That is the second time it's happened." His world's
// Shield Guardians carry five wordings. Three wrote the number as a tag
// ("[[/damage 10 type=heal]]", "[[lookup @healing.formula]]", "[[/heal]]{10}"),
// the old reader could not see it, and its fallback took the first "N hit
// points" anywhere: "if it has at least 1 hit point". Where there was no such
// clause it read nothing, and the Spirit Troll, Juiblex and the Frost Giant
// Everlasting One never regenerated at all.
//
// This runs overtime-engine.mjs's own _detectRegeneration, lifted out of the file
// (the engine imports the whole module and cannot load outside Foundry), with
// the shared words reader it now uses.
//
// Run: node tools/regeneration-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { itemWords, plainWords } from "../scripts/rules/creature-words.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../scripts/overtime-engine.mjs"), "utf8");
const start = src.indexOf("  _detectRegeneration(actor) {");
const end = src.indexOf("  /** Why (if at all) regeneration is suppressed");
if (start < 0 || end < 0) { console.log("FAIL could not find _detectRegeneration in overtime-engine.mjs"); process.exit(1); }
const body = src.slice(start, end).replace("_detectRegeneration(actor) {", "function detect(actor) {");
globalThis.game = { user: { isGM: false } };
globalThis.ui = {};
const warned = [];
const realWarn = console.warn;
console.warn = (...a) => warned.push(a.join(" "));
const detect = new Function("itemWords", "MODULE_ID", `${body}; return detect;`)(itemWords, "ace-qol").bind({});

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}
/** A creature with one feat, as dnd5e holds it live (a heal activity's formula is a getter there). */
function creature(name, featName, html, activities = {}) {
  const actor = { id: name, name, items: [] };
  actor.items.push({ id: "f1", type: "feat", name: featName, actor, system: { description: { value: html }, activities } });
  return actor;
}

console.log("Regeneration: the number regained");

// His five Shield Guardians, word for word.
const sg = [
  ["D&D Beyond 2024 import, a damage tag", "<p>The shield guardian regains [[/damage 10 type=heal average=false]] hit points at the start of its turn if it has at least 1 hit point.</p>"],
  ["2014 plain words", "<p>The shield guardian regains 10 hit points at the start of its turn if it has at least 1 hit point.</p>"],
  ["dnd5e's own 2024 guardian, a lookup on its heal activity", "<p>The [[lookup @name lowercase]]{monster} regains [[lookup @healing.formula activity=5cGvjZJIJVicjJ3d]] Hit Points at the start of each of its turns if it has at least 1 Hit Point.</p>",
    { "5cGvjZJIJVicjJ3d": { type: "heal", healing: { formula: "10" } } }],
  ["2024 plain words", "<p>The guardian regains 10 Hit Points at the start of each of its turns if it has at least 1 Hit Point.</p>"],
  ["a heal tag with a label", "<p>The shield guardian regains [[/heal]]{10} hit points at the start of its turn if it has at least 1 hit point.</p>"],
];
for (const [what, html, acts] of sg) {
  const r = detect(creature("Shield Guardian", "Regeneration", html, acts ?? {}));
  check(`Shield Guardian, ${what}: 10, never the \"at least 1\"`, r?.amount === 10 && r?.requiresMinHp === true, JSON.stringify(r));
}

const troll = detect(creature("Spirit Troll", "Regeneration",
  "<p>The troll regains [[/damage 10 type=heal average=false]] hit points at the start of its turn. If the troll takes psychic or force damage, this trait doesn't function at the start of the troll's next turn.</p>"));
check("Spirit Troll (no \"at least\" clause): 10, where it used to read nothing", troll?.amount === 10, JSON.stringify(troll));
check("and its shut-off is psychic and force", troll?.shutoff?.includes("psychic") && troll?.shutoff?.includes("force"));

const vamp = detect(creature("Vampire", "Regeneration",
  "<p>The vampire regains 20 hit points at the start of its turn if it has at least 1 hit point and isn't in sunlight or running water. If the vampire takes radiant damage or damage from holy water, this trait doesn't function at the start of the vampire's next turn.</p>"));
check("Vampire: 20, radiant shuts it off, sunlight noted", vamp?.amount === 20 && vamp?.shutoff?.includes("radiant") && vamp?.noRegenInSunlight === true);

const touch = detect(creature("Varek Thalor", "Regenerate",
  "<p>A creature you touch regains 4d8 + 15 Hit Points. For the duration, the target regains [[/healing 1 type=healing]]{1 Hit Point} at the start of each of its turns.</p>"));
check("the Regenerate power (\"a creature you touch\") is not the caster regenerating", touch === null, JSON.stringify(touch));

warned.length = 0;
const unread = detect(creature("Odd Thing", "Regeneration", "<p>It regains some hit points at the start of its turn if it has at least 1 hit point.</p>"));
check("a regeneration with no readable number does nothing...", unread === null, JSON.stringify(unread));
check("...and says so, out loud", warned.some(w => /could not read how many hit points/.test(w)), warned.join(" | "));

check("the words reader: a heal written as a damage tag is its number",
  plainWords("regains [[/damage 10 type=heal average=false]] hit points") === "regains 10 hit points");
check("the words reader: a fire damage tag still keeps its dice",
  plainWords("takes [[/damage 3d6 type=fire]] damage") === "takes 3d6 fire damage");

console.warn = realWarn;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
