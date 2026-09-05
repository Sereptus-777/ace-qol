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
    abilities: { wis: { label: "Wisdom" }, str: { label: "Strength" },
                 dex: { label: "Dexterity" } },
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

const { CheckGate } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/check-gate.mjs");
const ActionBar = { _readCheckMode: (a, k, y) => CheckGate.read(a, k, y),
                    _modePathFor:   (k, y)    => CheckGate.modePathFor(k, y) };

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

console.log("\nA SKILL OR TOOL COMBINES TWO MODES, THE WAY dnd5e DOES");
// ⚠️🔴 SHIPPED READING ONLY ONE IN 0.13.0. dnd5e resolves a skill or tool check
// over BOTH the ability's check mode and the skill's own, so a creature with
// disadvantage on Wisdom checks was being offered NORMAL for Perception while
// dnd5e was about to roll it at disadvantage. A confidently wrong prompt is
// worse than no prompt.
check("disadvantage from the ABILITY alone still shows",
  CheckGate.read({ system: {
      skills: { prc: { roll: { mode: 0 }, total: 5, ability: "wis" } },
      abilities: { wis: { check: { roll: { mode: -1 } } } } },
    effects: [] }, "skill", "prc").mode, -1);
check("disadvantage from the SKILL alone still shows",
  CheckGate.read({ system: {
      skills: { prc: { roll: { mode: -1 }, total: 5, ability: "wis" } },
      abilities: { wis: { check: { roll: { mode: 0 } } } } },
    effects: [] }, "skill", "prc").mode, -1);
// ⚠️ AND THEY CANCEL. dnd5e's resolveMode is sign(adv) - sign(dis), so one of
// each is a straight roll however many sources there are.
check("one of each cancels to a straight roll",
  CheckGate.read({ system: {
      skills: { prc: { roll: { mode: 1 }, total: 5, ability: "wis" } },
      abilities: { wis: { check: { roll: { mode: -1 } } } } },
    effects: [] }, "skill", "prc").mode, 0);
check("combineModes: many disadvantages and one advantage is normal",
  CheckGate.combineModes([-1, -1, -1, 1]), 0);
check("combineModes: nothing is normal", CheckGate.combineModes([]), 0);
check("combineModes: junk is ignored", CheckGate.combineModes(["x", null, undefined]), 0);
// ⚠️ A SAVE READS ONE FIELD AND IS NOT COMBINED. Proven from the system source:
// an ability check and a saving throw read ability[type].roll.mode alone.
check("a save is NOT combined with the ability's CHECK mode",
  CheckGate.read({ system: { abilities: { dex: {
      save: { roll: { mode: 0 }, value: 3 }, check: { roll: { mode: -1 } } } } },
    effects: [] }, "save", "dex").mode, 0);
check("a tool reads its own mode and its ability's",
  CheckGate.read({ system: {
      tools: { thief: { roll: { mode: 0 }, total: 7, ability: "dex" } },
      abilities: { dex: { check: { roll: { mode: -1 } } } } },
    effects: [] }, "tool", "thief").mode, -1);
check("a tool with nothing on it is normal",
  CheckGate.read({ system: { tools: { thief: { roll: { mode: 0 }, total: 7, ability: "dex" } },
      abilities: { dex: { check: { roll: { mode: 0 } } } } }, effects: [] },
    "tool", "thief").mode, 0);
check("tools use the tool path", CheckGate.modePathFor("tool", "thief"), "system.tools.thief.roll.mode");
check("a tool names the effect on its ability",
  CheckGate.read({ system: { tools: { thief: { roll: { mode: 0 }, ability: "dex" } },
      abilities: { dex: { check: { roll: { mode: -1 } } } } },
    effects: [{ name: "Slippery gloves", disabled: false,
      changes: [{ key: "system.abilities.dex.check.roll.mode", value: "-1" }] }] },
    "tool", "thief").reasons, [{ reason: "Slippery gloves: disadvantage" }]);

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
  { kind: "skill", mode: 1, reasons: [{ reason: "Guidance-ish: advantage" }], modifier: null, label: "Perception check" });

console.log("\nWHAT THE GATE TAKES, AND WHAT IT LEAVES ALONE");
const shape = (hookNames, extra = {}) => CheckGate._shapeOf({ hookNames, ...extra });
check("a skill check is ours",
  shape(["skill", "abilityCheck", "d20Test", ""], { skill: "prc" }), { kind: "skill", key: "prc" });
check("an ability check is ours",
  shape(["AbilityCheck", "d20Test", ""], { ability: "str" }), { kind: "ability", key: "str" });
check("a saving throw is ours",
  shape(["SavingThrow", "d20Test", ""], { ability: "dex" }), { kind: "save", key: "dex" });
// ⚠️ THE ATTACK PIPELINE ALREADY OWNS ATTACKS. Two owners of one roll is
// the bug this whole file exists to avoid.
check("an attack is NOT ours", shape(["attack", "d20Test", ""], { ability: "str" }), null);
// ⚠️🔴 THE SECOND BREAK 0.13.0 SHIPPED. `rollInitiativeDialog` lists
// "abilityCheck" and "d20Test" beside its own name, so the generic branch took
// it — and cancelling that build loses the ROLL, not just the card: dnd5e reads
// `rolls.length === 0` and returns, so the creature never rolls initiative at
// all. Silently. Initiative gets its pause by wrapping the method instead.
check("initiative is NEVER taken as an ability check",
  shape(["initiativeDialog", "abilityCheck", "d20Test", ""], { ability: "dex" }), null);

// ⚠️ HIT DICE AND RECHARGE NEVER REACH THE GATE. Neither lists "d20Test", and
// neither is a check: there is no advantage on either in either edition, so a
// three-button pause would be three buttons meaning the same thing. They are
// handled by their own hooks, which suppress dnd5e's card and post ACE's after
// the roll — nothing is cancelled, so nothing dnd5e does with them can be lost.
check("a hit die is not a check", shape(["hitDie", ""]), null);
check("a recharge is not a check", shape(["recharge", ""]), null);

check("a tool check is ours",
  shape(["tool", "abilityCheck", "d20Test", ""], { tool: "thief" }), { kind: "tool", key: "thief" });
check("something with no shape at all is not ours", shape([""]), null);

// ⚠️🔴 THE ONE THAT SHIPPED BROKEN IN 0.13.0. dnd5e builds both of these on top
// of an ordinary saving throw, so they arrive carrying "SavingThrow" and
// "d20Test" and the generic branch took them. A concentration check re-rolled
// as a plain Constitution save rolls the right dice and then does NONE of the
// bookkeeping — a failure would no longer break concentration.
check("a concentration check is its own thing, not a CON save",
  shape(["concentration", "SavingThrow", "d20Test", ""], { ability: "con", isConcentration: true }),
  { kind: "concentration", key: "con" });
check("recognised by the flag alone if the hook name is missing",
  shape(["SavingThrow", "d20Test", ""], { ability: "con", isConcentration: true }),
  { kind: "concentration", key: "con" });
// ⚠️ DEATH SAVES ESCAPED THE SAME BUG ONLY BY LUCK: they carry no ability, so
// the empty-key bail caught them. Luck is not a guard.
check("a death save is its own thing",
  shape(["deathSave", "SavingThrow", "d20Test", ""], {}), { kind: "death", key: "death" });
check("an ordinary save is still an ordinary save",
  shape(["SavingThrow", "d20Test", ""], { ability: "wis" }), { kind: "save", key: "wis" });

console.log("\nAN ENGINE ROLLING FOR ITSELF PASSES STRAIGHT THROUGH");
const cfg = { hookNames: ["skill", "abilityCheck", "d20Test", ""], skill: "prc",
              subject: { name: "Someone", system: { skills: { prc: { roll: { mode: 0 } } } }, effects: [] } };
// ⚠️ NO DIALOG AND NO CARD MEANS AN ENGINE. Every internal roll in the suite
// is made that way, and so is the gate's own re-roll — which is what stops this
// from re-entering itself forever.
check("no dialog and no card is left alone",
  CheckGate._intercept({ ...cfg }, { configure: false }, { create: false }), undefined);
// ⚠️ A SHIFT-CLICK IS STILL A PERSON. Foundry's keybinds set configure:false
// and nothing else; the pause is what gets skipped, never the record.
check("a hurried click still gets a card",
  CheckGate._intercept({ ...cfg }, { configure: false }, {}), false);
check("a plain sheet click is taken",
  CheckGate._intercept({ ...cfg }, {}, {}), false);
check("an actor we cannot name is left alone",
  CheckGate._intercept({ hookNames: ["skill", "d20Test"], skill: "prc" }, {}, {}), undefined);

console.log("\nSAVES READ THE SAVE PATH, NOT THE CHECK PATH");
check("a save uses the save mode", CheckGate.modePathFor("save", "dex"), "system.abilities.dex.save.roll.mode");
check("an ability check uses the check mode", CheckGate.modePathFor("ability", "dex"), "system.abilities.dex.check.roll.mode");
const brave = { name: "Ireena", effects: [{ name: "Aura of Protection", disabled: false,
  changes: [{ key: "system.abilities.dex.save.roll.mode", value: "1" }] }],
  system: { abilities: { dex: { save: { roll: { mode: 1 }, value: 7 } } } } };
check("a death save keeps its own mode, not Constitution's",
  CheckGate.modePathFor("death", "death"), "system.attributes.death.roll.mode");
check("initiative keeps its own mode",
  CheckGate.modePathFor("initiative", "init"), "system.attributes.init.roll.mode");
// ⚠️ AND COMBINES, like a skill: the initiative attribute's mode plus the
// check mode of whichever ability initiative uses.
check("advantage on initiative alone shows",
  CheckGate.read({ system: { attributes: { init: { roll: { mode: 1 }, total: 4, ability: "dex" } },
      abilities: { dex: { check: { roll: { mode: 0 } } } } }, effects: [] },
    "initiative", "init").mode, 1);
check("disadvantage on DEX checks reaches initiative",
  CheckGate.read({ system: { attributes: { init: { roll: { mode: 0 }, total: 4, ability: "dex" } },
      abilities: { dex: { check: { roll: { mode: -1 } } } } }, effects: [] },
    "initiative", "init").mode, -1);
check("and they cancel",
  CheckGate.read({ system: { attributes: { init: { roll: { mode: 1 }, total: 4, ability: "dex" } },
      abilities: { dex: { check: { roll: { mode: -1 } } } } }, effects: [] },
    "initiative", "init").mode, 0);
check("initiative names the effect behind it",
  CheckGate.read({ system: { attributes: { init: { roll: { mode: 1 }, ability: "dex" } },
      abilities: { dex: { check: { roll: { mode: 0 } } } } },
    effects: [{ name: "Alert", disabled: false,
      changes: [{ key: "system.attributes.init.roll.mode", value: "1" }] }] },
    "initiative", "init").reasons, [{ reason: "Alert: advantage" }]);

check("so does concentration",
  CheckGate.modePathFor("concentration", "con"), "system.attributes.concentration.roll.mode");
const dying = { name: "Jeth",
  system: { attributes: { death: { roll: { mode: -1 }, success: 1, failure: 2 } } },
  effects: [{ name: "Broken ribs", disabled: false,
    changes: [{ key: "system.attributes.death.roll.mode", value: "-1" }] }] };
check("a death save reads its own mode and names its source",
  CheckGate.read(dying, "death", "death"),
  { kind: "death", mode: -1, reasons: [{ reason: "Broken ribs: disadvantage" }],
    modifier: null, label: "Death saving throw" });
// ⚠️ AN EFFECT ON CONSTITUTION SAVES MUST NOT LEAK INTO EITHER. dnd5e models
// them as separate attributes, and they are separate rules at the table.
check("a CON save effect does not reach a death save",
  CheckGate.read({ system: { attributes: { death: { roll: { mode: 0 } } } },
    effects: [{ name: "Bless-ish", disabled: false,
      changes: [{ key: "system.abilities.con.save.roll.mode", value: "1" }] }] },
    "death", "death").reasons, []);

check("a save reads its own mode and names its source",
  CheckGate.read(brave, "save", "dex"),
  { kind: "save", mode: 1, reasons: [{ reason: "Aura of Protection: advantage" }], modifier: 7,
    label: "Dexterity saving throw" });

console.log("\nEACH KIND GOES BACK THROUGH ITS OWN dnd5e METHOD");
// ⚠️🔴 THE WIRING MOST LIKELY TO BE WRONG AND LEAST LIKELY TO BE NOTICED.
// The gate CANCELS dnd5e's roll, so if a death save is re-rolled as a plain
// saving throw it rolls the right dice and does none of the bookkeeping: no
// pips, no revive on a natural twenty, no stabilised-or-died line. That is
// exactly what concentration was doing when 0.13.0 shipped, and the dice looked
// perfect the whole time.
{
  const calls = [];
  const stub = (name) => function (cfg, dialog, message) {
    calls.push({ name, cfg, dialog, message });
    return Promise.resolve([]);        // no rolls back -> run() stops after this
  };
  const actor = {
    name: "Test", hasPlayerOwner: false,
    system: { skills: { prc: { roll: { mode: 0 }, ability: "wis" } },
              tools: { thief: { roll: { mode: 0 }, ability: "dex" } },
              abilities: { wis: { check: { roll: { mode: 0 } } },
                           dex: { check: { roll: { mode: 0 } }, save: { roll: { mode: 0 } } } },
              attributes: { death: { roll: { mode: 0 } }, concentration: { roll: { mode: 0 } },
                            init: { roll: { mode: 0 }, ability: "dex" } } },
    effects: [],
    rollSkill: stub("rollSkill"), rollToolCheck: stub("rollToolCheck"),
    rollAbilityCheck: stub("rollAbilityCheck"), rollSavingThrow: stub("rollSavingThrow"),
    rollDeathSave: stub("rollDeathSave"), rollConcentration: stub("rollConcentration"),
    getRollData: () => ({}),
  };
  // The prompt is stubbed to always answer "normal" so run() reaches the roll.
  const realWait = foundry.applications.api.DialogV2.wait;
  foundry.applications.api.DialogV2.wait = async () => "normal";

  const ran = async (kind, key, dc) => {
    calls.length = 0;
    await CheckGate.run(actor, kind, key, { dc });
    return calls[0];
  };

  check("a skill check calls rollSkill", (await ran("skill", "prc"))?.name, "rollSkill");
  check("a tool check calls rollToolCheck", (await ran("tool", "thief"))?.name, "rollToolCheck");
  check("an ability check calls rollAbilityCheck", (await ran("ability", "wis"))?.name, "rollAbilityCheck");
  check("a save calls rollSavingThrow", (await ran("save", "dex"))?.name, "rollSavingThrow");
  check("a death save calls rollDeathSave", (await ran("death", "death"))?.name, "rollDeathSave");
  check("concentration calls rollConcentration", (await ran("concentration", "con"))?.name, "rollConcentration");

  console.log("\nAND IT ALWAYS ASKS FOR NO DIALOG AND NO CARD");
  // ⚠️ THIS IS ALSO WHAT STOPS THE GATE RE-ENTERING ITSELF. The re-roll is
  // recognised as an engine's own roll by exactly these two flags.
  {
    const c = await ran("skill", "prc");
    check("dnd5e's dialog is suppressed", c?.dialog?.configure, false);
    check("dnd5e's card is suppressed", c?.message?.create, false);
  }
  // ⚠️ AND THE DC IS CARRIED BACK. A concentration DC is half the damage taken;
  // dropping it would reset every concentration check in the game to 10.
  check("a concentration DC survives the re-roll", (await ran("concentration", "con", 17))?.cfg?.target, 17);
  check("a save DC survives the re-roll", (await ran("save", "dex", 15))?.cfg?.target, 15);
  // ⚠️ A SKILL HAS NOTHING TO PASS OR FAIL AGAINST, so no target is invented.
  check("a skill check is given no DC", (await ran("skill", "prc", 15))?.cfg?.target, undefined);

  foundry.applications.api.DialogV2.wait = realWait;
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
