// ─── Does Multiattack say how many attacks, and which? ───────────────────────
//
// ⚠️ THE CASE THAT MATTERS IS THE ONE JOHNNY HAS, AND IT IS THE COMMON ONE.
// His importer writes the Multiattack feat as one useless sentence and leaves
// the real line in the CREATURE's stat block text. Reading only the item and
// giving up is reading the copy that was thrown away.
//
//   item description : "The Shadow Dragon (Huge) uses Multiattack."
//   creature bio     : "Multiattack. The dragon makes three attacks: one with
//                       its bite and two with its claws."
//
// Run:  node tools/multiattack-selftest.mjs
globalThis.canvas = { grid: { size: 100 }, ready: false, tokens: { placeables: [] },
  scene: { grid: { distance: 5, size: 100 }, name: "test", id: "s1" } };
globalThis.game = { ready: false, combat: null, time: { worldTime: 0 },
  settings: { get: () => false, register: () => {} },
  user: { isGM: true }, users: [], actors: [], i18n: { localize: (k) => k },
  modules: { get: () => null } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {}, call: () => true };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} }, Item: {}, Token: {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App {}
globalThis.Actor = class {};
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: { ApplicationV2: _App, HandlebarsApplicationMixin: (C) => C, DialogV2: null },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } } },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };

const { MultiattackEngine } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/multiattack-engine.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(58) + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

/** A weapon the creature can actually swing. */
const weapon = (name) => ({
  name, type: "weapon", id: name.toLowerCase(),
  system: { equipped: true, activities: {} },
  actor: null,
});

/** An NPC with a Multiattack feat and a stat block biography. */
const creature = ({ itemText, bio, weapons }) => {
  const items = [
    { name: "Multiattack", type: "feat", id: "ma",
      system: { description: { value: itemText } } },
    ...weapons.map(weapon),
  ];
  const actor = {
    name: "Shadow Dragon", type: "npc", hasPlayerOwner: false,
    items, system: { details: { biography: { value: bio } } },
  };
  for (const i of items) i.actor = actor;
  return actor;
};

// The engine only offers items it recognises as main-action attacks; the real
// reader inspects activities. Stub that one predicate so the test exercises the
// TEXT logic it was written for rather than dnd5e's activity shape.
MultiattackEngine._isAttackItem = (i) => i?.type === "weapon";
MultiattackEngine._hasMainActionAttack = () => true;

console.log("\nTHE COMMON CASE — the item says nothing, the creature says everything");
const dragon = creature({
  itemText: "<p>The Shadow Dragon (Huge) uses Multiattack.</p>",
  bio: "<p><strong>Multiattack.</strong> The dragon makes three attacks: one with its bite and two with its claws.</p>",
  weapons: ["Bite", "Claw"],
});
let s = MultiattackEngine.summaryFor(dragon);
check("the count comes from the creature, not the useless item text", s?.total, 3);
check("and it is reported as known, not assumed", s?.exact, true);
check("it names which attacks and how many of each", s?.label, "3 attacks: 1 Bite, 2 Claw");

console.log("\nWHEN THE ITEM DOES CARRY THE LINE, THE ITEM WINS");
const goblin = creature({
  itemText: "<p>The goblin makes two attacks with its scimitar.</p>",
  bio: "<p>Some unrelated prose about goblins that mentions nothing.</p>",
  weapons: ["Scimitar"],
});
s = MultiattackEngine.summaryFor(goblin);
check("parsed from the item", s?.total, 2);
check("named", s?.label, "2 attacks: 2 Scimitar");

console.log("\nA BARE COUNT WITH NO WEAPONS NAMED");
const brute = creature({
  itemText: "<p>The brute uses Multiattack.</p>",
  bio: "<p><strong>Multiattack.</strong> The brute makes four attacks.</p>",
  weapons: ["Slam"],
});
s = MultiattackEngine.summaryFor(brute);
check("still gets the number", s?.total, 4);
check("and says so plainly", s?.label, "4 attacks");

console.log("\nNOTHING ANYWHERE SAYS A NUMBER");
const mystery = creature({
  itemText: "<p>It uses Multiattack.</p>",
  bio: "<p>No stat block text was imported for this creature at all.</p>",
  weapons: ["Claw"],
});
s = MultiattackEngine.summaryFor(mystery);
check("falls back to two", s?.total, 2);
// ⚠️ THE POINT OF THIS ONE. A guess presented as a fact is worse than no number.
check("and MARKS it as assumed", s?.exact, false);

console.log("\nA CREATURE WITH NO MULTIATTACK AT ALL");
const plain = {
  name: "Rat", type: "npc", hasPlayerOwner: false,
  items: [], system: { details: { biography: { value: "" } } },
};
check("reports nothing rather than inventing a count",
  MultiattackEngine.summaryFor(plain), null);

console.log("\nHIS CLOUD GIANT — the real sentence, then the importer's junk");
// ⚠️ THE EXACT STRING OFF HIS SCREEN, 2026-09-03 01:23. The first half is the
// rule out of the book; the second is boilerplate riding along behind it, and
// its enricher syntax reached his tooltip in full because the multiattack
// passage never went through the description reader.
const giant = creature({
  itemText: "<p>The Cloud Giant (Legacy) uses Multiattack.</p>",
  bio: "<p><strong>Multiattack.</strong> The giant makes two morningstar attacks. "
     + "The [[lookup @name]] uses [[lookup @item.name]].</p>",
  weapons: ["Morningstar", "Rock"],
});
s = MultiattackEngine.summaryFor(giant);
check("the count is right", s?.total, 2);
check("nothing bracketed survives", /\[\[|\]\]/.test(String(s?.text ?? "")), false);
check("the importer's tail is cut", /\buses\b/i.test(String(s?.text ?? "")), false);
check("the real sentence is kept whole",
  String(s?.text ?? "").includes("makes two morningstar attacks"), true);


console.log("\nTHE LEGENDARY ACTION FURTHER DOWN THE PAGE IS NOT MULTIATTACK");
const lich = creature({
  itemText: "<p>The lich uses Multiattack.</p>",
  bio: "<p><strong>Multiattack.</strong> The lich makes two attacks with its "
     + "paralyzing touch.</p><p><strong>Legendary Actions.</strong> The lich can "
     + "take three legendary actions and makes five attacks with its staff.</p>",
  weapons: ["Paralyzing Touch", "Staff"],
});
s = MultiattackEngine.summaryFor(lich);
check("reads the Multiattack passage, not the legendary one", s?.total, 2);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
