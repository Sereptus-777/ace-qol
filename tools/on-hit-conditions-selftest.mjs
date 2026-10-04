// ─── A HIT PUTS ITS CONDITIONS ON ────────────────────────────────────────────
//
// His table, 2026-10-04: "A Constrict hit must put Grappled on the target, then
// Restrained while that grapple lasts, escape DC from the item. This press
// recorded grappled on the hit and applied neither."
//
// FOUR FAULTS, ALL PROVEN AGAINST THE 2024 MONSTER MANUAL'S OWN WORDING:
//
//  1. "it HAS the Grappled condition" was never read. Every pattern expected
//     "have the", which is the 2014 phrasing; the 2024 statblocks write a
//     creature's own conditions in the singular. The parser answered an empty
//     list for every one of them and everything downstream believed it.
//  2. The escape DC made the condition look save-gated. "(escape DC 14)" sits
//     beside the words, the gate test saw a DC and marked the Restrained as
//     something a save avoids. It is what it takes to get OUT afterwards.
//  3. The ongoing dice were on the swing. "Until this grapple ends, the target
//     takes 7 (2d6) ... at the start of each of its turns" matched the bonus
//     damage patterns word for word, so a Constrict dealt them once, at the
//     grab, and never again.
//  4. Nothing applied a hit's conditions at all. `attackLands` has built
//     `verdict.conditions` since Phase 3 and every consumer on the hit path
//     reads `.damage`, `.extras` and `.notes`. A save's result lands its
//     conditions; an attack's hit landed none, on any item, ever.
//
// Run:  node tools/on-hit-conditions-selftest.mjs
import { readFileSync } from "node:fs";

globalThis.canvas = { grid: { size: 100 }, ready: false,
  scene: { grid: { distance: 5, size: 100 } }, tokens: { placeables: [] } };
globalThis.game = { ready: false, settings: { get: () => false, register: () => {} },
  i18n: { localize: (k) => k }, modules: { get: () => null }, users: [], actors: [] };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: {} };
class _App {}
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: { ApplicationV2: _App, HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } } },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };

const M = "D:/FoundryVTT/Data/modules/ace-qol";
const { DescriptionParser } = await import(`file:///${M}/scripts/description-parser.mjs`);
const postHit = readFileSync(`${M}/scripts/post-hit-saves.mjs`, "utf8");
const breakFree = readFileSync(`${M}/scripts/break-free-engine.mjs`, "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(66)} ${detail}`);
};

// The 2024 Monster Manual's Constrict, as a statblock writes it.
const CONSTRICT = "<p><em><strong>Constrict.</strong></em> <em>Melee Attack Roll:</em> +6, reach 10 ft. "
  + "<em>Hit:</em> 13 (2d8 + 4) Bludgeoning damage. If the target is a Large or smaller creature, "
  + "it has the Grappled condition (escape DC 14), and it has the Restrained condition until the "
  + "grapple ends. Until this grapple ends, the target takes 7 (2d6) Bludgeoning damage at the "
  + "start of each of its turns.</p>";
const item = (value, name = "Constrict") =>
  ({ name, type: "weapon", system: { description: { value }, activities: { contents: [] } } });

console.log("\nTHE WORDS A 2024 STATBLOCK USES");
{
  const p = DescriptionParser.parse(item(CONSTRICT));
  const keys = (p.conditions ?? []).map(c => c.condition);
  check("both conditions are read", keys.includes("grappled") && keys.includes("restrained"), keys.join(", "));
  /* ⚠️ "HAS", NOT ONLY "HAVE". The singular is the 2024 phrasing. */
  check("and the singular is what finds them",
    DescriptionParser.parse(item("<p>The target has the Prone condition.</p>"))
      .conditions.some(c => c.condition === "prone"), "has the Prone condition");
  check("the plural still works, for a 2014 statblock",
    DescriptionParser.parse(item("<p>Targets have the Prone condition.</p>"))
      .conditions.some(c => c.condition === "prone"), "have the Prone condition");
  /* ⚠️ AN ESCAPE DC IS NOT A SAVE THAT GATES THE CONDITION. */
  check("neither is gated by the escape DC beside them",
    (p.conditions ?? []).every(c => c.requiresSave === false),
    JSON.stringify((p.conditions ?? []).map(c => [c.condition, c.requiresSave])));
  /* ⚠️ A REAL SAVE STILL GATES ONE. */
  const saved = DescriptionParser.parse(item(
    "<p>The target must succeed on a DC 15 Constitution saving throw or have the Poisoned condition.</p>"));
  check("but a condition a real save avoids is still marked as one",
    saved.conditions.some(c => c.condition === "poisoned" && c.requiresSave === true));
  check("and the escape DC is read off the item",
    DescriptionParser.escapeFromGrapple(item(CONSTRICT))?.dc === 14, "DC 14");
}

console.log("\nTHE ONGOING DICE STAY OFF THIS ROLL");
{
  const p = DescriptionParser.parse(item(CONSTRICT));
  check("nothing extra is added to the swing", (p.bonusDamage ?? []).length === 0,
    JSON.stringify((p.bonusDamage ?? []).map(b => b.formula)));
  check("and the 2d6 is kept for the turns it ticks on",
    (p.bonusDamage.ongoing ?? []).some(o => o.formula === "2d6" && o.damageType === "bludgeoning"),
    JSON.stringify(p.bonusDamage.ongoing));
  /* ⚠️ A REAL RIDER ON THE SWING IS UNTOUCHED. */
  const rider = DescriptionParser.parse(item(
    "<p><em>Hit:</em> 7 (1d8 + 3) Slashing damage plus 3 (1d6) Fire damage.</p>", "Flame Tongue"));
  check("a rider that really is on the hit still is",
    (rider.bonusDamage ?? []).some(b => b.formula === "1d6"),
    JSON.stringify((rider.bonusDamage ?? []).map(b => b.formula)));
  check("an end-of-turn rider is ongoing too",
    DescriptionParser.parse(item("<p>It takes 5 (2d4) Acid damage at the end of each of its turns.</p>"))
      .bonusDamage.ongoing.length === 1);
}

console.log("\nTHE HIT LANDS THEM, THROUGH THE SAME DOOR AS A SAVE");
{
  check("there is one lander for a hit's conditions",
    /static async _landHitConditions\(item, actor, hits\)/.test(postHit));
  check("it reads the recipe's own verdict for this result",
    /whatLands\(recipe, \{ result: h\.hitResult \}\)/.test(postHit));
  check("and lands them through the condition door, not its own copy",
    /PostHitSaves\._landConditions\(v\.conditions, targetActor, result, name, item\)/.test(postHit));
  /* ⚠️ BEFORE THE GATE. A Constrict has no save, no table and no rider, so the
     early return would drop out before any of this could run. */
  check("it runs before the early-return gate",
    postHit.indexOf("_landHitConditions(item, actor, hits)")
      < postHit.indexOf("// Early-return gate"), "a Constrict never reaches that gate");
  /* ⚠️ PRINT THE TARGET AND BOTH CONDITIONS, OR THE REASON NEITHER LANDED. */
  check("it names the target and what went on",
    /hit \$\{name\} \\u2014 `\s*\+ `\$\{put\.length \? `put on \$\{put\.join\(" and "\)\}` : "put on nothing"\}/.test(postHit)
    || /put on \$\{put\.join\(" and "\)\}/.test(postHit));
  check("and the reason for anything refused",
    /refused \$\{kept\.join\("; "\)\}/.test(postHit));
  check("a creature it cannot read is said out loud, not skipped quietly",
    /no creature could be read/.test(postHit));
  check("and so is an item whose words name no condition",
    /its words name no condition/.test(postHit));
  /* ⚠️ THE LANDER HANDS BACK WHAT IT PUT ON, so the ongoing tick hangs on THIS
     grapple and not on any Grappled the creature happens to carry. */
  check("the lander hands back the effects it created", /\n    return landed;\n  \}/.test(postHit));
}

console.log("\nTHE ONGOING DICE TICK ON THE EFFECT, WHILE IT HOLDS");
{
  check("there is one armer for them", /static async _armOngoing\(item, targetActor, name, landed\)/.test(postHit));
  check("it hangs them on the grapple when there is one",
    /landed\.find\(l => l\.key === "grappled"\) \?\? landed\[0\]/.test(postHit));
  /* ⚠️ THE ENGINE THIS SUITE ALREADY RUNS, not a second ticker: burning and
     poison go through the same flag. */
  check("as an OverTime tick at the start of a turn",
    /setFlag\(MODULE_ID, "OverTime", \{/.test(postHit) && /turn: "start"/.test(postHit));
  /* ⚠️ "Only while the grapple is still on" needs nothing to check it: the tick
     lives on the effect, so it goes when the effect goes. */
  check("and living on the effect is what ends it with the grapple",
    /when the grapple ends the effect goes, and the tick goes with it/.test(postHit));
  check("an effect that is already gone is said, not guessed at",
    /the effect it should tick on is already gone/.test(postHit));
}

console.log("\nTHE ESCAPE CHECK IS NOT HIDDEN");
{
  /* ⚠️ ACE hides every chat card carrying a dnd5e flag and no ACE type of its
     own. The escape result is ACE's own card about the held creature's own
     check, so it says so. */
  check("the escape result card is stamped as ACE's",
    /flags: \{ \[MODULE_ID\]: \{ type: "breakFreeResult"/.test(breakFree));
  check("and so is the prompt that offers it",
    /type: "breakFreePrompt"/.test(breakFree));
  check("the check itself never asks dnd5e to post a card",
    /\{ create: false \}/.test(breakFree) && /chatMessage: false/.test(breakFree),
    "ACE posts it, so nothing can suppress it as the system's");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
