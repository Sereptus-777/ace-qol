// ─── A feature named after a spell is not that spell ────────────────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. Johnny, 2026-09-06: *"random PCs are getting
// under command this turn right now, and on PCs I've never even cast command
// on... I even took command off of one person, Mark, and then it just appeared
// again. I don't know where the hell that came from."*
//
// The pipeline lets a FEATURE borrow a SPELL's registry entry, on purpose, so a
// monster's Banishment reuses Banishment's entry and resolver instead of a
// duplicate. "Banish is Banish." That is a good idea with no brakes on it.
//
// It does not hold for a spell whose name is an ordinary English word. Command,
// Shield, Fly, Bane, Sleep, Slow, Haste, Light, Darkness, Fear, Web, Silence:
// all spells, and all names a statblock hands to a legendary action or a bark.
// A monster feature called "Command" inherited the 1st-level enchantment's
// whole entry — a Wisdom save nobody wrote, and a Commanded condition stamped
// on whoever failed it. Deleting the condition did not help, because the next
// use of the feature made another one.
//
// ⚠️ THE GUARD IS "THE ITEM MUST ALREADY DO THE THING." A borrowed entry that
// imposes a saving throw may only be taken by a feature whose own sheet
// declares that same save. The item outranks the registry, which is the
// standing rule here, and the real cases pay nothing: a monster's Banishment
// has the Charisma save written on it.
//
// Run:  node tools/feature-borrow-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: { abilities: {} }, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }), getDocumentClass: () => null },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
                  apps: {}, handlebars: {} },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2, OVERRIDE: 5 } };
globalThis.canvas = { ready: true, scene: { id: "s1", grid: { distance: 5 } },
  grid: { size: 100, distance: 5 }, tokens: { placeables: [], controlled: [] } };
globalThis.game = { combat: null, ready: true, time: { worldTime: 0 },
  settings: { get: () => "2024", register: () => {} },
  user: { isGM: true }, users: [], actors: [], scenes: [], i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const { SpellPipeline } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/spell-pipeline/pipeline.mjs");

// A feature whose activities declare the given saves (or none at all).
const feat = (name, ...saveAbilities) => ({
  name, type: "feat",
  system: { activities: { contents: saveAbilities.map(ab => ({
    type: "save", save: { ability: ab instanceof Set ? ab : new Set([ab]) },
  })) } },
});
const featNoSave = (name) => ({
  name, type: "feat",
  system: { activities: { contents: [{ type: "utility" }] } },
});

const COMMAND = { shape: "save-single", save: { ability: "wis", onFail: "effect" },
                  effect: { key: "command", duration: { rounds: 1 } } };
const BANISH  = { shape: "save-single", save: { ability: "cha", onFail: "effect" },
                  effect: { key: "banishment" } };
const BLESS   = { shape: "multi-buff", effect: { key: "bless" } };

const may = (item, entry, name) => SpellPipeline._featureMayBorrow(item, entry, name);

console.log("\nTHE ONE THAT HAPPENED");
{
  // ⚠️🔴 A statblock "Command" is a bark, a legendary action, an order to a
  // servant. It has no saving throw on it anywhere.
  const r = may(featNoSave("Command"), COMMAND, "command");
  check("a feature called Command with no save is refused", r.ok, false);
  check("and the refusal says why",
    /declares no saving throw at all/.test(r.reason), true);
}

console.log("\nBUT A REAL COPY OF THE SPELL STILL BORROWS");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. This is the whole reason the borrow
  // exists: a monster ability that IS the spell reuses the spell's entry.
  const r = may(feat("Banishment", "cha"), BANISH, "banishment");
  check("a monster Banishment with its Charisma save borrows", r.ok, true);
  check("and it says the two agree", /both ask for a CHA save/.test(r.reason), true);
}

console.log("\nTHE WRONG SAVE IS ALSO THE WRONG SPELL");
{
  // A "Command" that makes people roll Constitution is somebody's homebrew
  // roar, not the enchantment.
  const r = may(feat("Command", "con"), COMMAND, "command");
  check("a CON-save feature does not take a WIS-save entry", r.ok, false);
  check("and it names both abilities", /WIS save and this feature asks for CON/.test(r.reason), true);
}

console.log("\nONE MATCHING SAVE AMONG SEVERAL IS ENOUGH");
{
  // A feature with two activities, one of which is the save in question.
  const item = feat("Frightful Command", "con", "wis");
  check("a feature that does ask for WIS somewhere borrows",
    may(item, COMMAND, "command").ok, true);
}

console.log("\nAN ENTRY WITH NO SAVE IS LENT AS FREELY AS EVER");
{
  // ⚠️ This narrows exactly one thing. Buffs, heals and auras are untouched,
  // because there is no save for the item to contradict.
  check("a buff entry borrows with no save on either side",
    may(featNoSave("Bless"), BLESS, "bless").ok, true);
  check("and says so plainly",
    /imposes no save/.test(may(featNoSave("Bless"), BLESS, "bless").reason), true);
}

console.log("\nA STRING SAVE ABILITY STILL READS");
{
  // dnd5e 5.x stores this as a Set; older imported data as a plain string.
  const older = { name: "Banishment", type: "feat",
    system: { activities: { contents: [{ type: "save", save: { ability: "cha" } }] } } };
  check("older data with a plain string is understood", may(older, BANISH, "banishment").ok, true);
}

console.log("\nAND AN UNREADABLE FEATURE FAILS CLOSED");
{
  // ⚠️ Guessing "yes" is how this got out. Guessing "no" only sends the item to
  // the inference engine, which reads the item itself.
  const broken = { name: "Command", type: "feat",
    get system() { throw new Error("no sheet"); } };
  const r = may(broken, COMMAND, "command");
  check("it refuses rather than guessing", r.ok, false);
  check("and says it could not read it", /could not be read/.test(r.reason), true);
}

console.log("\nA SPELL IS UNAFFECTED BY ANY OF THIS");
{
  // The guard is only on the feature path. A real spell named Command keeps
  // its entry with no questions asked.
  const spell = { name: "Command", type: "spell", system: { activities: { contents: [] } } };
  const entry = SpellPipeline._getEntry(spell);
  check("the Command spell still finds its entry", entry?.effect?.key, "command");
  check("and it is still a single-target save", entry?.shape, "save-single");
}

console.log("\nAND THE FEATURE NAMED AFTER IT NO LONGER DOES");
{
  const entry = SpellPipeline._getEntry(featNoSave("Command"));
  // It may still be inferred from its own text, which is correct — what it must
  // never do is arrive carrying the spell's Wisdom save.
  check("a save-less Command feature does not inherit the WIS save",
    entry?.save?.ability === "wis", false);
  check("nor the Commanded condition",
    entry?.effect?.key === "command", false);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
