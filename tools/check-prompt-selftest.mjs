// ─── Ability and skill checks: what ACE suggests, and why ────────────────────
//
// ⚠️ THE BUG THIS GUARDS. Johnny, 2026-09-04: "the guy that's inside the lich
// did a Perception check, and it just automatically rolled disadvantage. It
// didn't show up in the chat." Before that it was dnd5e's own dialog, which is
// not ours. The answer is ACE's pause with the right button already lit — and
// the button is only right if the mode is read from where dnd5e resolved it.
//
// ⚠️ AND THE REASON MATTERS AS MUCH AS THE MODE. "ACE suggests disadvantage"
// with nothing beside it cannot be told apart from a bug.
//
// Run:  node tools/check-prompt-selftest.mjs
globalThis.game = { settings: { get: () => false, register: () => {} }, user: { isGM: true, targets: new Set() },
  modules: { get: () => ({ active: true }) }, i18n: { localize: (k) => k }, time: { worldTime: 0 } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.CONFIG = {
  Actor: {}, Token: {}, Item: {},
  DND5E: {
    skills: { prc: { label: "Perception", ability: "wis" }, ste: { label: "Stealth", ability: "dex" } },
    abilities: { wis: { label: "Wisdom" }, str: { label: "Strength" } },
  },
};
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), getRoute: (p) => p, mergeObject: (a, b) => ({ ...a, ...b }),
           deepClone: (o) => JSON.parse(JSON.stringify(o ?? null)), randomID: () => "id" },
  applications: {
    api: { DialogV2: { wait: async () => null }, ApplicationV2: _App,
           HandlebarsApplicationMixin: (B) => class extends B {} },
    ux: {}, apps: {}, handlebars: {},
  },
};
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: { regions: [] } };

const { ActionBar } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/action-bar.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(56)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// A creature standing in Thunderstorm of Misery: one effect, one change,
// pointed at the skill dnd5e resolved to -1.
const stormEffect = {
  name: "Perception disadvantage (ACE — Stormforger)", disabled: false,
  changes: [{ key: "system.skills.prc.roll.mode", mode: 2, value: "-1" }],
};
const actorIn = {
  name: "Lich (Legacy)", hasPlayerOwner: false, effects: [stormEffect],
  system: {
    skills: { prc: { roll: { mode: -1 }, total: 9, ability: "wis" }, ste: { roll: { mode: 0 }, total: 3, ability: "dex" } },
    abilities: { wis: { mod: 3, check: { roll: { mode: 0 } } }, str: { mod: 2, check: { roll: { mode: 0 } } } },
  },
};

console.log("\nTHE MODE COMES FROM WHERE dnd5e RESOLVED IT");
check("inside the storm, Perception reads disadvantage",
  ActionBar._readCheckMode(actorIn, "skill", "prc").mode, -1);
check("and it names the effect that did it",
  ActionBar._readCheckMode(actorIn, "skill", "prc").reasons,
  [{ reason: "Perception disadvantage (ACE — Stormforger): disadvantage" }]);
check("a skill nothing touches is normal, with no reason invented",
  [ActionBar._readCheckMode(actorIn, "skill", "ste").mode,
   ActionBar._readCheckMode(actorIn, "skill", "ste").reasons], [0, []]);
check("the label is the creature-facing name, not the key",
  ActionBar._readCheckMode(actorIn, "skill", "prc").label, "Perception check");
check("the modifier comes along so the box says what he is rolling",
  ActionBar._readCheckMode(actorIn, "skill", "prc").modifier, 9);

console.log("\nABILITY CHECKS READ THEIR OWN PATH");
check("Wisdom check is normal here", ActionBar._readCheckMode(actorIn, "ability", "wis").mode, 0);
check("and is labelled as an ability check",
  ActionBar._readCheckMode(actorIn, "ability", "wis").label, "Wisdom check");
check("skills use the skill path", ActionBar._modePathFor("skill", "prc"), "system.skills.prc.roll.mode");
check("abilities use the check path", ActionBar._modePathFor("ability", "wis"), "system.abilities.wis.check.roll.mode");

console.log("\nAN EFFECT ON THE ABILITY REACHES ITS SKILLS");
// ⚠️ A SKILL CHECK IS ALSO AN ABILITY CHECK. Reading only the skill path would
// show "ACE suggests disadvantage" with nothing beside it to explain why.
const exhausted = {
  name: "Exhaustion 1", disabled: false,
  changes: [{ key: "system.abilities.wis.check.roll.mode", mode: 2, value: "-1" }],
};
const tired = { name: "Jeth", hasPlayerOwner: true, effects: [exhausted],
  system: { skills: { prc: { roll: { mode: -1 }, total: 5, ability: "wis" } },
            abilities: { wis: { mod: 1, check: { roll: { mode: -1 } } } } } };
check("Perception names the Wisdom effect behind it",
  ActionBar._readCheckMode(tired, "skill", "prc").reasons, [{ reason: "Exhaustion 1: disadvantage" }]);

console.log("\nNOTHING SILLY GETS THROUGH");
check("a DISABLED effect argues for nothing",
  ActionBar._readCheckMode({ effects: [{ ...stormEffect, disabled: true }],
    system: { skills: { prc: { roll: { mode: 0 } } } } }, "skill", "prc").reasons, []);
check("a change of 0 or a junk value is not a source",
  ActionBar._readCheckMode({ effects: [{ name: "Odd", disabled: false, changes: [
      { key: "system.skills.prc.roll.mode", value: "0" },
      { key: "system.skills.prc.roll.mode", value: "banana" }] }],
    system: { skills: { prc: { roll: { mode: 0 } } } } }, "skill", "prc").reasons, []);
check("an effect on a DIFFERENT skill is not borrowed",
  ActionBar._readCheckMode({ effects: [{ name: "Armor", disabled: false, changes: [
      { key: "system.skills.ste.roll.mode", value: "-1" }] }],
    system: { skills: { prc: { roll: { mode: 0 }, ability: "wis" } }, abilities: { wis: {} } } },
    "skill", "prc").reasons, []);
check("an actor with no system data does not throw, it just suggests normal",
  ActionBar._readCheckMode({}, "skill", "prc").mode, 0);
check("advantage is read as advantage",
  ActionBar._readCheckMode({ effects: [{ name: "Guidance-ish", disabled: false, changes: [
      { key: "system.skills.prc.roll.mode", value: "1" }] }],
    system: { skills: { prc: { roll: { mode: 1 }, ability: "wis" } }, abilities: { wis: {} } } },
    "skill", "prc"),
  { mode: 1, reasons: [{ reason: "Guidance-ish: advantage" }], modifier: null, label: "Perception check" });

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
