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

/* ═══ THE MULTIATTACK FEATURE CARRIES ITS ATTACKS (his rule, 2026-10-10) ════
   "put one activity per attack on that same feature, copied from the attack
   items on the sheet... Do not invent a second system." Pins the copy (a feat
   is not a weapon: the base damage, its modifier and the magic bonus have to be
   written in), the text's own order, and the hand-off to the real item. */
console.log("\nTHE MULTIATTACK FEATURE CARRIES ITS ATTACKS");

// A real natural claw: 1d8 slashing base, a +1 magic bonus, a finesse-style Dex
// swing, and one extra 1d6 acid part of its own.
const claw = {
  name: "Claw", type: "weapon", id: "claw-id", img: "claw.webp",
  system: {
    offersBaseDamage: true, magicAvailable: true, magicalBonus: 1, proficiencyMultiplier: 1,
    damage: { base: { formula: "1d8", toObject: () => ({ number: 1, denomination: 8, bonus: "", types: ["slashing"] }) } },
  },
};
const clawAct = {
  id: "claw-act", type: "attack", ability: "dex",
  attack: { type: { value: "melee", classification: "weapon" } },
  damage: { includeBase: true },
  toObject: () => ({
    _id: "claw-act", type: "attack", name: "", img: "", flags: {},
    attack: { ability: "", bonus: "", flat: false, type: { value: "", classification: "" } },
    damage: { includeBase: true, parts: [{ number: 1, denomination: 6, bonus: "", types: ["acid"] }] },
    effects: [{ _id: "eff1" }], uses: { spent: 1, max: "3", recovery: [] },
    consumption: { targets: [{ type: "itemUses", target: "", value: "1" }, { type: "attribute", target: "x", value: "1" }] },
  }),
};
const copy = MultiattackEngine.copyAttackActivity(claw, clawAct, { sort: 2, randomId: () => "newid0000000001" });
check("the copy has its own id", copy._id, "newid0000000001");
check("the copy is named for the real item", copy.name, "Claw");
check("the ability is written by name (Dex, not the feat's Str default)", copy.attack.ability, "dex");
check("the weapon's magic bonus goes on the to-hit", copy.attack.bonus, "1");
check("a feat gets no base damage, so includeBase is off", copy.damage.includeBase, false);
check("the claw's base dice are the first damage part", `${copy.damage.parts[0]?.number}d${copy.damage.parts[0]?.denomination}`, "1d8");
check("the base part carries the modifier and the magic bonus", copy.damage.parts[0]?.bonus, "@mod + 1");
check("the claw's own acid part follows it", copy.damage.parts[1]?.types?.[0], "acid");
check("the original's effects stay with the original", copy.effects.length, 0);
check("the copy's uses start clean", copy.uses.max, "");
check("consumption of its own uses is dropped, others kept", copy.consumption.targets.length, 1);
check("the copy remembers which item it came from", copy.flags["ace-qol"]?.multiattackFrom?.itemId, "claw-id");

// A weapon an NPC is NOT proficient with must not gain proficiency on a feat.
const clumsy = { ...claw, system: { ...claw.system, magicAvailable: false, proficiencyMultiplier: 0 } };
const clumsyCopy = MultiattackEngine.copyAttackActivity(clumsy, clawAct, { randomId: () => "x" });
check("a non-proficient weapon's copy takes proficiency back off", clumsyCopy.attack.bonus, "-@prof");

// The feature with copies on it is never one of its own attacks.
const maWithCopies = { name: "Multiattack", type: "feat", id: "ma2",
  system: { activities: { a: { type: "attack", activation: { type: "action" } } } } };
check("the Multiattack feature is never an attack item", MultiattackEngine._isAttackItem(maWithCopies), false);
check("a real claw still is", MultiattackEngine._isAttackItem({ ...claw, system: { activities: {} } }), true);

// The text's own order: "one with its bite and two with its claws".
const order = MultiattackEngine._parseMultiattack(
  "the dragon makes three attacks: one with its bite and two with its claws.",
  [{ name: "Claw" }, { name: "Bite" }]);
const sorted = [...(order ?? [])].sort((a, b) => a.at - b.at).map(e => `${e.count} ${e.item.name}`).join(", ");
check("entries can be put in the text's order", sorted, "1 Bite, 2 Claw");

/* ── His three rules after the first fill (2026-10-10) ── */
console.log("\nA NUMBER WINS, OR IS A CHOICE, NO NUMBER IS NO CHAIN, FORMS STAY APART");
const read = (txt, names) => MultiattackEngine.readChain(txt, names.map(n => ({ name: n })));
const show = (r) => (r.entries ?? []).map(e => `${e.count} ${e.item.name}`).join(", ") || "none";

check("four words between the number and the name still count",
  show(read("Rahadin makes three melee attacks with his scimitar.", ["Scimitar", "Dagger"])), "3 Scimitar");
check("a plural name reads: three tentacles",
  show(read("The creature makes three attacks with its tentacles.", ["Tentacle"])), "3 Tentacle");
check("'only one of which can be a bite' is a limit, not a count",
  show(read("Strahd makes two attacks, only one of which can be a bite attack.", ["Unarmed Strike", "Bite"])), "none");
check("a total with no names is no chain",
  show(read("The giant makes two attacks, using Thunderous Mace or Thundercloud in any combination.",
    ["Thunderous Mace", "Thundercloud"])), "none");
const knight = read("The knight makes two attacks with its longsword or two attacks with its longbow.",
  ["Longsword", "Longbow"]);
check("'or' keeps the first option only", show(knight), "2 Longsword");
check("and says which option it kept", /longsword/i.test(knight.kept ?? ""), true);
check("and which it left out", /longbow/i.test(knight.dropped ?? ""), true);
check("'and' is not 'or': bite and claws stay together",
  show(read("It makes three attacks: one with its bite and two with its claws.", ["Bite", "Claws"])), "1 Bite, 2 Claws");
const raven = read("The wereraven makes two weapon attacks: one with its beak, one with its shortsword and one with its hand crossbow.",
  ["Beak (Raven or Hybrid Form Only)", "Shortsword (Humanoid or Hybrid Form Only)", "Hand Crossbow (Humanoid Form Only)"]);
check("the beak, the sword and the crossbow are not one attack (no shared form)", show(raven), "none");
check("the form-only attacks that were left out are named", raven.formDropped.length, 3);
const wolf = read("The werewolf makes two attacks: two with its spear or one with its bite and one with its claws.",
  ["Spear (Humanoid Form Only)", "Bite (Wolf or Hybrid Form Only)", "Claws (Hybrid Form Only)"]);
check("a chain all of one form keeps it (spear, first option)", show(wolf), "2 Spear (Humanoid Form Only)");
const hybrid = read("It makes two attacks: one with its bite and one with its claws.",
  ["Bite (Wolf or Hybrid Form Only)", "Claws (Hybrid Form Only)"]);
check("bite and claws that share Hybrid stay together", show(hybrid), "1 Bite (Wolf or Hybrid Form Only), 1 Claws (Hybrid Form Only)");

// The hand-off: pressing a copy presses the real activity instead.
let pressed = null;
const realAct = { id: "claw-act", type: "attack", use: async (cfg) => { pressed = cfg ?? {}; } };
const owner = { name: "Bear", items: [] };
const realItem = { ...claw, actor: owner, system: { ...claw.system, activities: { get: (id) => (id === "claw-act" ? realAct : null) } } };
owner.items = [realItem];
owner.items.get = (id) => owner.items.find(i => i.id === id) ?? null;
const pressedCopy = { flags: { "ace-qol": { multiattackFrom: { itemId: "claw-id", activityId: "claw-act", itemName: "Claw" } } },
  actor: owner, item: { actor: owner } };
check("a press of the copy is stopped", MultiattackEngine.redirectCopiedAttack(pressedCopy, {}), false);
await new Promise(r => setTimeout(r, 5));
check("and the real Claw is pressed instead", pressed !== null, true);
check("an ordinary press is left alone", MultiattackEngine.redirectCopiedAttack({ flags: {} }, {}), undefined);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
