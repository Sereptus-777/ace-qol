// ─── A thing can make itself harder to resist ───────────────────────────────
//
// ⚠️ WHY THIS EXISTS. Every save modifier ACE reads was a property of the
// TARGET — advantage on saves is normally something you HAVE. A handful of
// effects sit on the other side of the table: Shami-Amourae's dark gift in the
// Amber Temple reads *"saving throws against the spell have disadvantage"*, and
// there was no way to express that at all. Johnny asked for the three
// sarcophagus gifts built properly on 2026-09-06, drawbacks included, and this
// was the one clause with nowhere to live.
//
// ⚠️ THE ITEM FLAG IS THE ONE THAT MATTERS. It makes ONE button harder to
// resist, which is what a dark gift, a cursed relic or a legendary action
// actually is. The actor flag is the broad version and must NOT be the only
// route, or every such item would have to alter its owner to work.
//
// ⚠️ AND IT MUST NAME ITSELF. A save that quietly rolls two dice and keeps the
// worse one reads as a bug at the table, so the reason travels with it.
//
// Run:  node tools/hard-to-resist-selftest.mjs
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.document = { querySelectorAll: () => [], querySelector: () => null };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {}, damageTypes: {} },
  statusEffects: [], Canvas: { polygonBackends: {} } };
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
  settings: { get: () => false, register: () => {} },
  user: { isGM: true }, users: [], actors: [], scenes: [], i18n: { localize: (k) => k } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(56)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

const NS = "ace-qol";
const mkFlags = (f) => ({
  flags: f,
  getFlag: (ns, key) => f?.[ns]?.[key],
});
const actor = (name, flags = {}) => ({
  id: `a-${name}`, name, type: "npc",
  system: {
    attributes: { hp: { value: 20 }, ac: { value: 12 }, senses: {} },
    traits: { di: { value: new Set() }, dr: { value: new Set() },
              dv: { value: new Set() }, ci: { value: new Set() } },
    abilities: { wis: { bonuses: {} } }, bonuses: { abilities: {} },
    details: { type: { value: "humanoid" }, cr: 1 }, skills: {},
  },
  statuses: new Set(), items: [], effects: [], appliedEffects: [],
  ...mkFlags(flags),
});
const tokenFor = (a) => ({ id: `t-${a.id}`, name: a.name, actor: a,
  document: { id: `t-${a.id}`, name: a.name, actor: a, disposition: -1, elevation: 0,
              width: 1, height: 1, x: 0, y: 0, flags: {} } });
const item = (name, flags = {}) => ({
  id: "i1", name, type: "feat",
  system: { type: { value: "supernaturalGift" }, properties: new Set() },
  ...mkFlags(flags),
});

const { TargetState } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/target-state.mjs");

const assess = (it, caster) => TargetState.assess(
  tokenFor(actor("Ireena")), caster ?? actor("Caster"), it, [], { saveAbility: "wis" });

console.log("\nNOTHING SPECIAL MEANS NOTHING CHANGES");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. If a plain item started imposing
  // disadvantage, every save in the game would silently get worse.
  const r = assess(item("Ordinary Wand"));
  check("a plain item leaves the save alone", r.saveDisadvantage, false);
  check("and says nothing about why", r.saveDisadvantageReason, "");
}

console.log("\nTHE ITEM CAN SAY IT IS HARD TO RESIST");
{
  const r = assess(item("Dark Gift of Shami-Amourae",
    { [NS]: { saveDisadvantage: true } }));
  check("the save is at disadvantage", r.saveDisadvantage, true);
  check("and it names the item that did it",
    /Shami-Amourae/.test(r.saveDisadvantageReason), true);
}

console.log("\nSO CAN THE CREATURE, FOR EVERYTHING IT DOES");
{
  const strahd = actor("Strahd", { [NS]: { imposeSaveDisadvantage: true } });
  const r = assess(item("Ordinary Wand"), strahd);
  check("the caster's own flag works too", r.saveDisadvantage, true);
  check("and names the caster", /Strahd/.test(r.saveDisadvantageReason), true);
}

console.log("\nA FLAG THAT IS NOT EXACTLY TRUE IS NOT A YES");
{
  // ⚠️ `=== true`, deliberately. A leftover `0`, `""` or `"false"` from an
  // importer or an older schema must not silently make every save worse.
  for (const junk of [0, "", "false", null, undefined, "true"]) {
    const r = assess(item("Odd Item", { [NS]: { saveDisadvantage: junk } }));
    check(`a flag of ${JSON.stringify(junk)} is ignored`, r.saveDisadvantage, false);
  }
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
