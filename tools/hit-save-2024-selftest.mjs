// ─── A 2024 hit's own save: "Constitution Saving Throw: DC 10" ────────────────
//
// His table, 2026-10-14: the Ghast's Claw offered "Use Claw — 2d6 slashing
// (ATTACK)" and "Use Claw (SAVE)" side by side. "That's not the one-road plan":
// a save that follows a hit is asked after the hit, never a second button
// (his rule since 2026-09-12). Two gaps hid it: the parser never answered
// "[[lookup @save.dc.value ...]]", so the DC was a blank, and it had no reader
// for the 2024 heading "Constitution Saving Throw: DC 10" at all. Over 21,210
// items (dnd5e's packs and hijinx) the fix gained 579 saves, lost none, changed
// none; 14 attacks now have their save asked after the hit (the Ghast's and
// Ghoul's Claws, the Cockatrice, the Death Dog, the Homunculus, the Bearded
// Devil's Glaive, the Pit Fiend's Bite).
//
// Run: node tools/hit-save-2024-selftest.mjs
// ──────────────────────────────────────────────────────────────────────────────

globalThis.foundry = { utils: { deepClone: (x) => JSON.parse(JSON.stringify(x)) } };
const { DescriptionParser } = await import("../scripts/description-parser.mjs");

let passed = 0, failed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  (${detail})`}`);
}

console.log("A 2024 hit's own save");

// dnd5e 5.3.3, packs/actors24, the Ghast's Claw: its words, and its two activities
// as dnd5e holds them live (a save's DC worked out to a value).
const ghastClaw = {
  name: "Claw", type: "weapon", actor: { name: "Ghast" },
  system: {
    damage: { base: { number: 2, denomination: 6, types: ["slashing"] } },
    description: { value: "<p>[[/attack extended]]. [[/damage average extended]]. If the target is a non-Undead creature, it is subjected to the following effect.</p><p><em>Constitution Saving Throw</em>: DC [[lookup @save.dc.value activity=nDM4WpckiZjvBzfg]]. <em>Failure:</em> The target has the &amp;Reference[Paralyzed apply=false] condition until the end of its next turn.</p>" },
    activities: {
      W1T7dZnG8GMMwyEP: { id: "W1T7dZnG8GMMwyEP", type: "attack", damage: { parts: [], includeBase: true } },
      nDM4WpckiZjvBzfg: { id: "nDM4WpckiZjvBzfg", type: "save", save: { ability: new Set(["con"]), dc: { value: 10 } } },
    },
  },
};
const p = DescriptionParser.parse(ghastClaw);
const s = p.saves[0];
check("the lookup is answered: DC 10 Constitution", s?.dc === 10 && s?.ability === "con", JSON.stringify(p.saves));
check("it is the hit's own save", s?.hitVerdict === "yes");
check("a failure is Paralyzed", (s?.failEffect ?? []).some(e => e.condition === "paralyzed"));
const riders = DescriptionParser.riderActivityIds(ghastClaw, Object.values(ghastClaw.system.activities), p.saves.filter(x => x.hitVerdict === "yes"));
check("so the chooser does NOT offer the save as a second button", riders.has("nDM4WpckiZjvBzfg") && !riders.has("W1T7dZnG8GMMwyEP"), JSON.stringify([...riders]));

// The 2014 wording still reads exactly as it did.
const ghoul2014 = {
  name: "Claws", type: "weapon", actor: { name: "Ghoul" },
  system: { description: { value: "<p><em>Melee Weapon Attack:</em> +4 to hit, reach 5 ft., one target. <em>Hit:</em> 7 (2d4 + 2) slashing damage. If the target is a creature other than an elf or undead, it must succeed on a DC 10 Constitution saving throw or be paralyzed for 1 minute. The target can repeat the saving throw at the end of each of its turns, ending the effect on itself on a success.</p>" }, activities: {} },
};
const g = DescriptionParser.parse(ghoul2014).saves[0];
check("the 2014 wording still reads DC 10 Constitution, the hit's own", g?.dc === 10 && g?.ability === "con" && g?.hitVerdict === "yes", JSON.stringify(g));

// A save on a later turn is not the hit's (the 2024 Otyugh's Bite).
const otyugh = {
  name: "Bite", type: "weapon", actor: { name: "Otyugh" },
  system: { description: { value: "<p>[[/attack extended]]. [[/damage average extended]]. <em>Constitution Saving Throw</em>: DC 15, the target. <em>Failure:</em> The target has the Poisoned condition. Whenever the Poisoned target finishes a Long Rest, it is subjected to the following effect: it can repeat the save, and on a failure its Hit Point maximum decreases.</p>" }, activities: {} },
};
check("a save tied to a later rest is not the hit's own", DescriptionParser.parse(otyugh).saves.every(x => x.hitVerdict !== "yes"),
  JSON.stringify(DescriptionParser.parse(otyugh).saves));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
