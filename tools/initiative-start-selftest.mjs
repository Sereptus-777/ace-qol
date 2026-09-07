// ─── Does rolling initiative start the encounter? ───────────────────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. Johnny, mid-session on 2026-09-06: *"PCs and
// even NPCs cannot just roll initiative and start an encounter. Again, how did
// that get rolled fucking back? I need to fucking start by initiative, not by
// me creating an encounter."*
//
// Three separate places in ACE answered the press with a refusal, and all three
// made the roll wait on the thing the roll is supposed to cause:
//   • the two combat-tracker buttons: "No active combat encounter."
//   • the action bar's portrait die: "There is no combat running — start one
//     first."
//   • `playerCanStartCombat`, flipped to default OFF by a blanket "defaults
//     OFF" review pass on 2026-06-01, then taken off the settings page on
//     2026-07-22 — so the behaviour was switched off and then the switch was
//     put away.
//
// ⚠️ NOTHING HERE ASSERTS A MESSAGE STRING. It asserts that an encounter comes
// into existence and the right creatures are in it, because that is the part
// that failing costs him a fight at the table.
//
// Run:  node tools/initiative-start-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }

const notes = { info: [], warn: [], error: [] };
globalThis.ui = { notifications: {
  info: (m) => notes.info.push(String(m)),
  warn: (m) => notes.warn.push(String(m)),
  error: (m) => notes.error.push(String(m)),
} };

let created = null;
const CombatCls = {
  create: async ({ scene, active }) => {
    created = {
      scene, active,
      combatants: { contents: [] },
      createEmbeddedDocuments: async (_type, rows) => {
        for (const r of rows) {
          created.combatants.contents.push({
            name: r.__name, initiative: null, hidden: r.hidden,
            actor: r.__actor,
            rollInitiative: async function () { this.initiative = 12; },
          });
        }
      },
    };
    globalThis.game.combat = created;
    return created;
  },
};

globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, randomID: () => "id",
           mergeObject: (a, b) => ({ ...a, ...b }),
           getDocumentClass: (n) => (n === "Combat" ? CombatCls : null) },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
                         HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
                  apps: {}, handlebars: {} },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2 } };
globalThis.canvas = { ready: true, scene: { id: "s1", name: "Barovia" },
  grid: { size: 100, distance: 5 }, tokens: { controlled: [], placeables: [] } };
globalThis.game = { combat: null, ready: true, scenes: { viewed: { id: "s1" } },
  settings: { get: () => true, set: async () => {}, register: () => {} },
  user: { isGM: true }, users: [], actors: [], i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(60)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const token = (name, { pc = false, inCombat = false, hidden = false } = {}) => {
  const actor = { id: `a-${name}`, name, hasPlayerOwner: pc };
  return { id: `t-${name}`, name, actor, inCombat, scene: { id: "s1" },
           document: { hidden } };
};
// The stub combat records what it was handed, so give it the name and actor.
const patchRows = (t) => ({ __name: t.name, __actor: t.actor });
const place = (...tokens) => {
  canvas.tokens.placeables = tokens;
  canvas.tokens.controlled = [];
  game.combat = null;
  created = null;
  notes.info.length = notes.warn.length = notes.error.length = 0;
};

const { InitiativeTools } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/initiative-tools.mjs");

// The real _populate builds rows from tokens; teach the stub to carry the name
// and actor through so the roster is inspectable.
const _origPopulate = InitiativeTools._populate.bind(InitiativeTools);
InitiativeTools._populate = async (combat, kind) => {
  const wrapped = combat.createEmbeddedDocuments;
  combat.createEmbeddedDocuments = async (type, rows) => {
    const byId = new Map(canvas.tokens.placeables.map(t => [t.id, t]));
    return wrapped.call(combat, type,
      rows.map(r => ({ ...r, ...patchRows(byId.get(r.tokenId)) })));
  };
  try { return await _origPopulate(combat, kind); }
  finally { combat.createEmbeddedDocuments = wrapped; }
};

console.log("\nWITH NO ENCOUNTER, THE PRESS OPENS ONE");
{
  place(token("Wolf"), token("Wolf B"), token("Virric", { pc: true }));
  await InitiativeTools.rollAllNpcs();
  check("an encounter now exists", !!game.combat, true);
  check("it is active on the viewed scene", [created?.scene, created?.active], ["s1", true]);
  check("the two NPCs are in it", created.combatants.contents.map(c => c.name), ["Wolf", "Wolf B"]);
  check("the PC was not swept in", created.combatants.contents.some(c => c.actor.hasPlayerOwner), false);
  check("and they actually rolled", created.combatants.contents.every(c => c.initiative === 12), true);
}

console.log("\nA SELECTION MEANS THAT SELECTION, AND THE MESSAGE SAYS SO");
{
  place(token("Wolf"), token("Wolf B"), token("Wolf C"));
  canvas.tokens.controlled = [canvas.tokens.placeables[0]];
  await InitiativeTools.rollAllNpcs();
  check("only the selected wolf is added", created.combatants.contents.map(c => c.name), ["Wolf"]);
  check("and it says the selection was used",
    notes.info.some(m => /tokens you have selected/.test(m)), true);
}
{
  place(token("Wolf"), token("Wolf B"));
  await InitiativeTools.rollAllNpcs();
  check("with nothing selected it says it used the scene",
    notes.info.some(m => /every one on this scene/.test(m)), true);
}

console.log("\nTHE PC BUTTON STARTS IT TOO, AND TAKES ONLY PCs");
{
  place(token("Virric", { pc: true }), token("Deeds", { pc: true }), token("Wolf"));
  game.settings.get = () => true;   // pcInitiativeAutoRoll on, so it rolls here
  await InitiativeTools.rollAllPcs();
  check("an encounter exists", !!game.combat, true);
  check("both PCs are in it", created.combatants.contents.map(c => c.name), ["Virric", "Deeds"]);
}

console.log("\nAN AMBUSH STAYS HIDDEN");
{
  // ⚠️ A hidden token that announces itself in the tracker is not an ambush.
  place(token("Assassin", { hidden: true }), token("Thug"));
  await InitiativeTools.rollAllNpcs();
  check("the hidden token stays hidden",
    created.combatants.contents.map(c => [c.name, c.hidden]),
    [["Assassin", true], ["Thug", false]]);
}

console.log("\nA ROSTER SOMEBODY BUILT ON PURPOSE IS NEVER INVADED");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. A GM who deliberately left two of the
  // four wolves out of the fight keeps them out. Filling only happens when the
  // encounter holds nobody of that kind at all.
  place(token("Wolf"), token("Wolf B"), token("Wolf C"));
  await CombatCls.create({ scene: "s1", active: true });
  created.combatants.contents.push({ name: "Wolf", initiative: null, hidden: false,
    actor: { hasPlayerOwner: false }, rollInitiative: async function () { this.initiative = 9; } });
  await InitiativeTools.rollAllNpcs();
  check("the other two were not dragged in", created.combatants.contents.map(c => c.name), ["Wolf"]);
}

console.log("\nAND NOTHING TO FIGHT IS SAID PLAINLY, NOT AS 'ALREADY ROLLED'");
{
  place(token("Virric", { pc: true }));
  await InitiativeTools.rollAllNpcs();
  check("it names the real problem",
    notes.warn.some(m => /no NPC tokens to add/i.test(m)), true);
  check("and never claims everybody rolled",
    notes.info.some(m => /already rolled/i.test(m)), false);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
