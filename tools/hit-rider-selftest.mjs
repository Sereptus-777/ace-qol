// ─── A save that follows a hit: read once, asked once, never offered twice ──
//
// Johnny, 2026-09-12. Neferon clawed a Specter: the slashing was halved, a save
// was asked, the Specter failed, and nothing happened. The claw's words write
// the poison as an inline roll, "taking 10 ([[/r 3d6]]) poison damage", and the
// reader looking for "10 (3d6)" found no damage at all. So the save could do
// nothing, and ACE never knew the Specter is immune to poison. Then pressing
// Claws asked "Attack or Save?", offering that same save as a separate choice.
//
// This pins four things: inline rolls read as their dice; which saves belong to
// a hit (three answers, see DescriptionParser._hitSaveVerdict); which activities
// come off the chooser; and, against a copy of his real world, the verdicts on
// the items that taught us each rule.
//
// ⚠️ IT WRITES NOTHING. His world is read from a copy of its files.
//
// Run:  node tools/hit-rider-selftest.mjs [world]      (default: hijinx)
// ──────────────────────────────────────────────────────────────────────────────

import { pathToFileURL } from "node:url";
import { existsSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const { inlineRollsAsText } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/spell-text.mjs");
const { DescriptionParser } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/description-parser.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(62)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const saves = (html) => DescriptionParser.parse({ system: { description: { value: html } } }).saves;
const verdicts = (html) => saves(html).map(s => s.hitVerdict);

/* ── Inline rolls ───────────────────────────────────────────────────────── */
console.log("\nAN INLINE ROLL READS AS ITS DICE");
check("a labelled roll leaves its label", inlineRollsAsText("[[/r 1d20+7]]{+7} to hit"), "+7 to hit");
check("the claw's poison, exactly as his item writes it",
  inlineRollsAsText("taking 10 ([[/r 3d6]]) poison damage"), "taking 10 (3d6) poison damage");
check("a roll with spaces in it", inlineRollsAsText("Hit: 8 ([[/r 2d4 + 3]])"), "Hit: 8 (2d4 + 3)");
check("the other roll commands", inlineRollsAsText("[[/roll 1d6]] [[/gmr 2d6]] [[/br 1d4]]"), "1d6 2d6 1d4");
check("a bare inline roll", inlineRollsAsText("[[1d6+2]] fire"), "1d6+2 fire");
// ⚠️ ONLY ROLLS. These mean something else and have readers of their own.
check("a save command is left for the save reader",
  inlineRollsAsText("[[/save con 11 format=long]]"), "[[/save con 11 format=long]]");
check("a damage command is left alone",
  inlineRollsAsText("[[/damage 2d6 type=fire]]"), "[[/damage 2d6 type=fire]]");
check("a lookup is left alone", inlineRollsAsText("[[lookup @name]]"), "[[lookup @name]]");

/* ── The claw ───────────────────────────────────────────────────────────── */
console.log("\nNEFERON'S CLAWS, WORD FOR WORD");
const CLAWS = "<div class=\"rd__b  rd__b--3\"><p><i>Melee Weapon Attack:</i> [[/r 1d20+7]]{+7} to hit, reach 5 ft., one target. <i>Hit:</i> 8 ([[/r 2d4 + 3]]) slashing damage. The target must make a DC <span class=\"rd__dc\">14</span> Constitution saving throw, taking 10 ([[/r 3d6]]) poison damage on a failed save, or half as much damage on a successful one.</p><div class=\"rd__spc-inline-post\"></div></div>";
{
  const s = saves(CLAWS);
  check("one save is found", s.length, 1);
  check("it is the DC 14 Constitution save", [s[0]?.dc, s[0]?.ability], [14, "con"]);
  check("and a failure is 3d6 poison, not nothing",
    s[0]?.failEffect, [{ type: "damage", formula: "3d6", damageType: "poison" }]);
  check("half as much on a success", s[0]?.halfOnSuccess, true);
  check("and it is the hit's own save", s[0]?.hitVerdict, "yes");
}

/* ── Whose save is it ───────────────────────────────────────────────────── */
console.log("\nTHE HIT'S OWN SAVE, HOWEVER THE BOOK WRITES IT");
check("an enriched save in the hit's own sentence",
  verdicts("<p>Hit: 5 (1d4 + 3) piercing damage, and the target must make a [[/save con 11 format=long]], taking 10 (3d6) poison damage on a failed save.</p>"), ["yes"]);
check("dnd5e's attack enrichers instead of the word Hit",
  verdicts("<p>[[/attack extended]]. [[/damage extended]]. The target must succeed on a DC 14 Constitution saving throw or its hit point maximum is reduced.</p>"), ["yes"]);
check("the 2024 book, naming who in the sentence before",
  verdicts("<p>Hit: 12 (2d8 + 3) Piercing damage. If the target is a Humanoid, it is subjected to the following effect. Constitution Saving Throw: [[/save con 12 format=long]]{ DC 12}. Failure: The target is cursed.</p>"), ["yes"]);
check("a size instead of a pronoun",
  verdicts("<p>Hit: 14 (2d8+5) bludgeoning damage. A Medium or smaller creature must succeed on a DC 17 Strength saving throw or be knocked prone.</p>"), ["yes"]);
check("\"Hit\" with no colon",
  verdicts("<p>Hit 19 (2d10 + 8) piercing damage. If the target is huge or smaller, it must make a DC 18 Strength saving throw or be knocked prone.</p>"), ["yes"]);
// ⚠️ "ft." IS NOT THE END OF A SENTENCE, or "within 5 ft. of a wall" splits
// the subject off its verb.
check("\"5 ft.\" does not end the sentence",
  verdicts("<p>Hit: 5 (1d6 + 2) piercing damage. If the target is within 5 ft. of a wall, it must succeed on a DC 12 Strength saving throw or be pinned.</p>"), ["yes"]);

console.log("\nAND NOT A SAVE THAT BELONGS TO SOMETHING ELSE");
check("hit or miss happens either way",
  verdicts("<p>Hit: 15 (2d8 + 6) Bludgeoning damage. Hit or Miss: Earth explodes from the target's space. Dexterity Saving Throw: [[/save dex 16 format=long]]{ DC 16}, each creature in a 10-foot Emanation.</p>"), ["no"]);
check("a splash around the target",
  verdicts("<p>Hit: 9 (1d10 + 3) cold damage. Creatures within 5 ft. of the target creature must succeed on a DC 13 Constitution saving throw or take 5 (2d4) cold damage.</p>"), ["no"]);
check("the target and everyone near it",
  verdicts("<p>Hit: 7 (1d10) radiant damage. In addition, the target and each creature within 20 feet of it must succeed on a DC 17 Dexterity saving throw or be blinded.</p>"), ["no"]);
check("the attacker's own save, to spit out what it swallowed",
  verdicts("<p>Hit: 22 (3d8 + 9) piercing damage. If the target is Large or smaller, it must succeed on a DC 19 Dexterity saving throw or be swallowed. If the worm takes 30 damage or more on a single turn from a creature inside it, the worm must succeed on a DC 21 Constitution saving throw at the end of that turn.</p>"), ["yes", "no"]);
check("a save on the target's later turns",
  verdicts("<p>Hit: 4 (1d4 + 2) piercing damage plus 2 (1d4) acid damage. At the end of each of its turns, the target must make a DC 10 Constitution saving throw, taking 2 (1d4) acid damage on a failure.</p>"), ["no"]);
check("one option of a menu",
  verdicts("<p>Hit: 20 (2d12 + 7) bludgeoning damage. Yeenoghu chooses one. Force. The target takes 13 (2d12) force damage. Paralysis. The target must succeed on a DC 17 Constitution saving throw or be paralyzed.</p>"), ["no"]);
check("a cone written on the same item",
  verdicts("<p>Hit: 24 (4d8+6) bludgeoning damage. Scrap Shrapnel. Creatures within a 20-foot cone must succeed on a DC 20 Dexterity saving throw, suffering 18 (4d8) piercing damage on a failed save.</p>"), ["no"]);

console.log("\nUNCLEAR STAYS AS IT WAS: ASKED AFTER A HIT, AND STILL OFFERED");
{
  const html = "<p>When you hit a giant with it, the giant takes an extra 2d6 damage of the weapon's type and must succeed on a DC 15 Strength saving throw or fall prone.</p>";
  check("a giant slayer's save is unclear", verdicts(html), ["unclear"]);
  check("and is still asked after a hit",
    DescriptionParser.hitSaves({ system: { description: { value: html } } }).length, 1);
}

/* ── The chooser ────────────────────────────────────────────────────────── */
console.log("\nWHAT COMES OFF THE CHOOSER");
const claw = { type: "weapon", system: { damage: { base: { number: 2, denomination: 4 } } } };
const atk = { id: "atk", type: "attack", damage: { parts: [], includeBase: true } };
const sv = { id: "sv", type: "save", save: { ability: new Set(["con"]) }, target: { template: { type: "" } } };
const con = [{ ability: "con" }];
check("the claw's save comes off", [...DescriptionParser.riderActivityIds(claw, [atk, sv], con)], ["sv"]);
check("a save that covers an area stays",
  [...DescriptionParser.riderActivityIds(claw, [atk, { ...sv, target: { template: { type: "line" } } }], con)], []);
check("a save of another ability stays",
  [...DescriptionParser.riderActivityIds(claw, [atk, { ...sv, save: { ability: new Set(["dex"]) } }], con)], []);
// ⚠️ ACE ASKS ON THE DAMAGE CARD, so an attack with no damage never gets there.
check("an attack that deals no damage keeps its save",
  [...DescriptionParser.riderActivityIds({ type: "weapon", system: { damage: { base: {} } } },
    [{ ...atk, damage: { parts: [], includeBase: true } }, sv], con)], []);
check("a spell is the spell pipeline's business",
  [...DescriptionParser.riderActivityIds({ ...claw, type: "spell" }, [atk, sv], con)], []);
check("with no hit's save named, nothing comes off",
  [...DescriptionParser.riderActivityIds(claw, [atk, sv], [])], []);
check("an array of abilities reads like a Set",
  [...DescriptionParser.riderActivityIds(claw, [atk, { ...sv, save: { ability: ["con"] } }], con)], ["sv"]);

/* ── His world ──────────────────────────────────────────────────────────── */
const WORLD = process.argv[2] ?? "hijinx";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";
const ACTORS = `D:/FoundryVTT/Data/worlds/${WORLD}/data/actors`;
if (!existsSync(LEVELDB) || !existsSync(join(ACTORS, "CURRENT"))) {
  console.log(`\n(no copy of ${WORLD}'s actors to read here; the world checks are skipped)`);
} else {
  console.log(`\nIN ${WORLD.toUpperCase()}: THE ITEMS THAT TAUGHT EACH RULE`);
  const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);
  const scratch = mkdtempSync(join(tmpdir(), "ace-hitrider-"));
  const dst = join(scratch, "actors");
  cpSync(ACTORS, dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  const actors = new Map(); const items = [];
  for await (const [k, v] of db.iterator()) {
    if (k.startsWith("!actors!")) actors.set(v._id, v);
    else if (k.startsWith("!actors.items!")) items.push([k.slice("!actors.items!".length).split(".")[0], v]);
  }
  await db.close();
  rmSync(scratch, { recursive: true, force: true });
  const find = (actorName, itemName) =>
    items.find(([a, it]) => actors.get(a)?.name === actorName && it.name === itemName)?.[1] ?? null;
  const read = (actorName, itemName) => {
    const it = find(actorName, itemName);
    return it ? DescriptionParser.parse(it).saves.map(s => `${s.ability} ${s.hitVerdict}`) : "not in this world";
  };
  const nef = find("Neferon", "Claws");
  check("Neferon's Claws: the hit's poison save, with its poison",
    nef ? DescriptionParser.parse(nef).saves.map(s => [s.hitVerdict, s.failEffect?.[0]?.formula, s.failEffect?.[0]?.damageType]) : "not in this world",
    [["yes", "3d6", "poison"]]);
  check("the Wraith's Life Drain is still asked", read("Wraith", "Life Drain"), ["con yes"]);
  check("the Pit Fiend's 2024 Bite is still asked", read("Pit Fiend", "Bite"), ["con yes"]);
  check("the Forge Devil's menu gives the slug no save", read("Forge Devil", "Master of Metal"), ["dex no", "cha no"]);
  check("the Purple Worm: the bite's save, not the worm's own", read("Purple Worm", "Bite"), ["dex yes", "con no"]);
  check("the Duskshroud Wyvern: the tail's save, not the sweep", read("Duskshroud Wyvern", "Tail"), ["str yes", "dex no"]);

  // The whole world, counted, so a change in the totals is read, not assumed.
  const tally = { yes: 0, no: 0, unclear: 0 };
  let offered = 0;
  for (const [, it] of items) {
    const acts = Object.entries(it.system?.activities ?? {}).map(([id, a]) => ({ ...a, id }));
    if (!acts.some(a => a.type === "attack")) continue;
    const p = DescriptionParser.parse(it);
    for (const s of p.saves) tally[s.hitVerdict]++;
    if (DescriptionParser.riderActivityIds(it, acts, p.saves.filter(s => s.followsHit)).size) offered++;
  }
  console.log(`  (every save on an item that also attacks: ${tally.yes} the hit's own, ${tally.no} `
    + `something else, ${tally.unclear} unclear; ${offered} items stop asking "Attack or Save?")`);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
