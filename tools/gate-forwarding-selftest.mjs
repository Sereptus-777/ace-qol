// ─── Does the save engine's real door reach the Gate's rules? ───────────────
//
// ⚠️🔴 WRITTEN BECAUSE THE FIRST WIRING PASSED EVERY TEST AND DID NOTHING.
// 2026-09-10: the Gate learned to spare a creature immune to every damage type
// an action deals (a Specter and Neferon rolled against Cloudkill while immune
// to poison). The Gate's own tests call ActionGate directly and all passed.
// But _preRollVerdict's signature and _rollSingleSave's call both listed their
// fields by name, and neither listed the new ones, so the save engine could
// never reach the rule. A profile built and never consulted.
//
// This goes through SaveEngine._preRollVerdict and _gateContextFor, the doors
// the real casts use.
//
// Run:  node tools/gate-forwarding-selftest.mjs
// dropped on the way there, which is exactly what happened first time.
let warned = [];
globalThis.game = { ready: true, packs: [], user: { isGM: true }, users: [], actors: [],
  scenes: { get: () => null }, combat: null, time: { worldTime: 0 },
  settings: { get: () => true, register: () => {} }, i18n: { localize: (k) => k },
  modules: { get: () => null } };
const hooks = {};
globalThis.Hooks = { on: (n, f) => { (hooks[n] ??= []).push(f); }, once: () => {}, off: () => {},
  call: () => true, callAll: () => {} };
globalThis.ui = { notifications: { info: () => {}, warn: (m) => warned.push(m), error: () => {} } };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {}, damageTypes: {}, senses: {} },
  statusEffects: [], Canvas: { polygonBackends: {} } };
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { getProperty: () => null, setProperty: () => {}, escapeHTML: (x) => String(x),
    mergeObject: (a, b) => ({ ...a, ...b }), deepClone: (o) => o, randomID: () => "id",
    getRoute: (p) => p, isEmpty: (o) => !o || !Object.keys(o).length },
  applications: { api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
    HandlebarsApplicationMixin: (B) => class extends B {} },
    ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } },
    apps: {}, handlebars: {}, instances: new Map() },
  dice: { terms: {} },
  canvas: { placeables: { MeasuredTemplate: class {} } },
};
globalThis.document = { querySelectorAll: () => [], querySelector: () => null,
  createElement: () => ({ style: {}, classList: { add() {} }, setAttribute() {}, appendChild() {} }) };
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: null, tokens: { placeables: [] } };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2, CUSTOM: 0, OVERRIDE: 5 }, GRID_SNAPPING_MODES: {} };
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };
globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(60) + "got " + got + ", want " + want);
};

let SaveEngine;
try {
  ({ SaveEngine } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/save-engine.mjs"));
} catch (err) {
  console.log("could not load save-engine.mjs under stubs:", err?.message ?? err);
  process.exit(2);
}

// Neferon, as his sheet says: immune to acid and poison, and to charmed and poisoned.
const neferon = { actorId: "n", actorUuid: "Actor.n", isDead: false,
  immuneToCondition: (c) => ["charmed", "poisoned"].includes(c),
  immuneToDamage: (t) => ["acid", "poison"].includes(t) };

// The context the save engine now builds, passed exactly the way it passes it.
const v = SaveEngine._preRollVerdict(neferon,
  { outcomeConditions: [], dealsDamage: true, damageTypes: ["poison"], magical: true });
check("the save engine's door reaches the new rule", v?.reason, "immune");
check("and the label names what he is immune to", /IMMUNE to Poison/.test(v?.label ?? ""), true);

const fire = SaveEngine._preRollVerdict(neferon,
  { outcomeConditions: [], dealsDamage: true, damageTypes: ["fire"], magical: true });
check("damage he is NOT immune to still rolls", fire, null);

// And the context builder feeds it.
const item = { type: "spell", name: "Cloudkill", system: { properties: new Set(),
  description: { value: "Each creature in the Sphere makes a Constitution saving throw, "
    + "taking 5d8 Poison damage on a failed save or half as much on a successful one." },
  activities: new Map() }, effects: [] };
const ctx = SaveEngine._gateContextFor(item, ["poison"]);
check("the builder marks a spell as magical", ctx.magical, true);
check("the builder carries the damage type", ctx.damageTypes.join(","), "poison");
check("Cloudkill leaves no condition behind", ctx.outcomeConditions.length, 0);
const built = SaveEngine._preRollVerdict(neferon, ctx);
check("so, built end to end, Neferon does not roll", built?.reason, "immune");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
