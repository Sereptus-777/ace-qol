// ─── A versatile weapon defaults to the two-handed die ───────────────────────
//
// ⚠️🔴 THE BUG. Johnny swung a quarterstaff and got a d6: "Versatile damage
// should be the default damage, not one-handed damage." dnd5e lists oneHanded
// before twoHanded for a versatile weapon, so the first option wins.
//
// ⚠️ BUT THE HAND HAS TO BE FREE. A fighter with a longsword AND a shield rolls
// a d8, exactly as RAW says. Getting this wrong in the generous direction hands
// every sword-and-board fighter a permanent damage upgrade, which is a house
// rule nobody asked for.
//
// Run:  node tools/versatile-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game = { settings: { get: () => true, register: () => {} }, user: { isGM: true } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (x) => String(x), mergeObject: (a, b) => ({ ...a, ...b }),
           deepClone: (o) => o, randomID: () => "id" },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (B) => class extends B {} },
                  ux: {}, apps: {}, handlebars: {} },
};
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.canvas = { grid: { size: 100, distance: 5 }, tokens: { placeables: [] } };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {} } };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };

const { VersatileDefault } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/versatile-default.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

let nextId = 0;
const weapon = ({ versatile = true, props = [], equipped = true, name = "Quarterstaff",
                  natural = false } = {}) => ({
  id: `i${++nextId}`, name, type: "weapon",
  system: {
    equipped, isVersatile: versatile,
    properties: new Set(props),
    type: { value: natural ? "natural" : "simpleM", baseItem: "quarterstaff" },
  },
});
const shield = () => ({
  id: `i${++nextId}`, name: "Shield", type: "equipment",
  system: { equipped: true, type: { value: "shield" }, properties: new Set() },
});
const actorWith = (...items) => ({ id: "a1", name: "Test", items, getFlag: () => undefined });

console.log("\nBOTH HANDS FREE MEANS THE TWO-HANDED DIE");
{
  const staff = weapon();
  check("a staff and nothing else", VersatileDefault.twoHandedFor(actorWith(staff), staff).yes, true);
  check("and it says why",
    VersatileDefault.twoHandedFor(actorWith(staff), staff).why, "both hands free");
}

console.log("\nA SHIELD IS A HAND, AND RAW SAYS ONE-HANDED");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. Sword and board is the commonest build in
  // the game; handing it the versatile die is a silent damage buff on every PC.
  const sword = weapon({ name: "Longsword" });
  const a = actorWith(sword, shield());
  check("longsword with a shield stays one-handed",
    VersatileDefault.twoHandedFor(a, sword).yes, false);
  check("and it names what is in the other hand",
    /Shield/.test(VersatileDefault.twoHandedFor(a, sword).why), true);
}

console.log("\nA SECOND WEAPON IS A HAND TOO");
{
  const sword = weapon({ name: "Longsword" });
  const dagger = weapon({ name: "Dagger", versatile: false, props: ["lgt"] });
  check("two weapons drawn means one-handed",
    VersatileDefault.twoHandedFor(actorWith(sword, dagger), sword).yes, false);
}

console.log("\nWHAT COSTS NO HANDS DOES NOT COUNT");
{
  // ⚠️ THE SAME MORNING'S OTHER BUG: an Unarmed Strike is a weapon item and is
  // marked equipped, and it is not in anybody's hand.
  const staff = weapon();
  const fists = weapon({ name: "Unarmed Strike", versatile: false });
  check("an unarmed strike does not occupy a hand",
    VersatileDefault.twoHandedFor(actorWith(staff, fists), staff).yes, true);
  const claws = weapon({ name: "Claws", versatile: false, natural: true });
  check("nor do natural weapons",
    VersatileDefault.twoHandedFor(actorWith(staff, claws), staff).yes, true);
}

console.log("\nAND A WEAPON THAT IS NOT VERSATILE IS LEFT ALONE");
{
  const axe = weapon({ name: "Greataxe", versatile: false, props: ["two"] });
  check("a two-handed weapon needs no default",
    VersatileDefault.twoHandedFor(actorWith(axe), axe).yes, false);
  const bow = weapon({ name: "Shortbow", versatile: false });
  check("a plain weapon needs no default",
    VersatileDefault.twoHandedFor(actorWith(bow), bow).yes, false);
}

console.log("\nSTOWED AND UNEQUIPPED THINGS ARE NOT IN HANDS");
{
  const staff = weapon();
  const sheathed = weapon({ name: "Spare Sword", versatile: false, equipped: false });
  check("a sheathed sword frees the hand",
    VersatileDefault.twoHandedFor(actorWith(staff, sheathed), staff).yes, true);
}

console.log("\nIT SETS A DEFAULT, IT DOES NOT OVERRULE A CHOICE");
{
  const staff = weapon();
  const actor = actorWith(staff);
  const cfg = (mode) => {
    const c = { attackMode: mode, subject: { item: staff, actor } };
    VersatileDefault._apply(c, "attack");
    return c.attackMode;
  };
  check("nothing chosen becomes two-handed", cfg(undefined), "twoHanded");
  check("one-handed is treated as the untouched default", cfg("oneHanded"), "twoHanded");
  // ⚠️ A STATED CHOICE IS A DECISION. Overriding "thrown" or "offhand" would be
  // automation fighting the player.
  check("a thrown attack is left alone", cfg("thrown"), "thrown");
  check("an offhand attack is left alone", cfg("offhand"), "offhand");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
