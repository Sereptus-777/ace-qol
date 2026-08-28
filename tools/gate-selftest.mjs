// ─── Does the One Gate still decide the way the architecture says? ──────────
//
// ⚠️ WRITTEN BECAUSE THE FIRST WIRING WAS WRONG AND LOOKED FINE. The Gate's
// guard originally demanded a `targetActor`, and the save engine hands it a
// PROFILE, which carries actorId and not actor. Every dead and immune check
// would have returned null — "roll normally" — and the dead Specter would have
// been back with nothing on screen to say so. Syntax was valid, lint was clean,
// nothing threw. Only asserting the verdicts catches it.
//
// Run:  node tools/gate-selftest.mjs
// ⚠️ The Gate imports the three profiles, and their own import chain reaches
// modules that register Foundry hooks at load. That is not a fault to work
// around here — it is why this harness stubs the platform rather than pretends
// the Gate is a leaf.
globalThis.canvas = { grid: { size: 100, distance: 5 }, ready: false,
  scene: { grid: { distance: 5, units: "ft" }, name: "test", id: "s1" },
  tokens: { placeables: [] } };
globalThis.game = { combat: null, time: { worldTime: 0 }, ready: false,
  settings: { get: () => undefined, register: () => {} },
  user: { isGM: true }, users: [], actors: [], i18n: { localize: (k) => k } };
globalThis.Hooks = { on: () => {}, once: () => {}, off: () => {}, callAll: () => {} };
globalThis.CONFIG = { DND5E: {}, statusEffects: [], Canvas: { polygonBackends: {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
class _App {}
globalThis.foundry = {
  utils: { escapeHTML: (s) => String(s), deepClone: (o) => o, mergeObject: (a, b) => ({ ...a, ...b }) },
  applications: { api: { ApplicationV2: _App, HandlebarsApplicationMixin: (C) => C },
                  ux: { TextEditor: { implementation: { enrichHTML: async (h) => h } } } },
};
globalThis.ChatMessage = { create: async () => {}, getSpeaker: () => ({}) };

const { ActionGate } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/gate/action-gate.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(60) + "got " + got + ", want " + want);
};

/** A target profile of the shape the save engine actually passes. */
const profile = ({ dead = false, immuneTo = [] } = {}) => ({
  actorId: "abc123", actorUuid: "Actor.abc123",
  isDead: dead,
  immuneToCondition: (c) => immuneTo.includes(c),
});

console.log("\nA PROFILE WITH NO `actor` FIELD MUST STILL BE JUDGED");
check("dead creature is stopped when only a profile is given",
  ActionGate.verdictFor({ targetProfile: profile({ dead: true }) })?.reason, "dead");
check("live creature rolls",
  ActionGate.verdictFor({ targetProfile: profile() }), null);

console.log("\nIMMUNITY IS DECISIVE ONLY WHEN NOTHING ELSE RESOLVES");
check("immune to the only outcome, no damage: no save",
  ActionGate.verdictFor({ targetProfile: profile({ immuneTo: ["petrified"] }),
    outcomes: ["petrified"] })?.reason, "immune");
check("immune but the spell also deals damage: still rolls",
  ActionGate.verdictFor({ targetProfile: profile({ immuneTo: ["petrified"] }),
    outcomes: ["petrified"], dealsDamage: true }), null);
check("immune to one of two outcomes: still rolls",
  ActionGate.verdictFor({ targetProfile: profile({ immuneTo: ["petrified"] }),
    outcomes: ["petrified", "frightened"] }), null);
check("no outcomes known at all: rolls, gate stays inert",
  ActionGate.verdictFor({ targetProfile: profile({ immuneTo: ["petrified"] }),
    outcomes: [] }), null);

console.log("\nORDERING: DEAD BEATS EVERYTHING");
check("dead AND immune reports dead, not immune",
  ActionGate.verdictFor({ targetProfile: profile({ dead: true, immuneTo: ["petrified"] }),
    outcomes: ["petrified"] })?.reason, "dead");

console.log("\nIT FAILS OPEN");
check("no profile and no actor: rolls", ActionGate.verdictFor({}), null);
check("a profile that throws: rolls",
  ActionGate.verdictFor({ targetProfile: { get isDead() { throw new Error("boom"); } } }), null);

console.log("\nRANGE AND LINE OF EFFECT ONLY DECIDE WHEN PROVEN TO APPLY");
// No tokens are passed, so no environment can be built: the scan must not guess.
check("no tokens: range cannot decide anything",
  ActionGate.verdictFor({ targetProfile: profile(), rangeFt: 5 }), null);

console.log("");
console.log("THE GATE SETTLES CONDITIONAL EFFECTS INSTEAD OF PUNTING");
const withEffects = (rows) => ({
  modifiersFor: (group) => ({
    always:      rows.filter(r => r.group === group && !r.conditional),
    conditional: rows.filter(r => r.group === group && r.conditional),
  }),
});
const slayerRows = [
  { effect: "Undead Slayer", group: "attack", value: "+2",
    conditional: "+2 to attack rolls against undead." },
  { effect: "Bless", group: "attack", value: "+1d4", conditional: null },
];
const vsUndead = ActionGate.effectsOn({
  attackerProfile: withEffects(slayerRows),
  targetProfile: { creatureType: "undead", size: "med", hasCondition: () => false },
  group: "attack",
});
check("Bless always applies", vsUndead.applies.some(a => a.effect === "Bless"), true);
check("+2 vs undead APPLIES against a skeleton",
  vsUndead.applies.some(a => a.effect === "Undead Slayer"), true);
check("nothing is left for the GM to judge", vsUndead.needsJudging.length, 0);

const vsGiant = ActionGate.effectsOn({
  attackerProfile: withEffects(slayerRows),
  targetProfile: { creatureType: "giant", size: "lg", hasCondition: () => false },
  group: "attack",
});
check("+2 vs undead does NOT apply against a giant",
  vsGiant.applies.some(a => a.effect === "Undead Slayer"), false);
check("and it is kept, so the card can say why",
  vsGiant.ruledOut.map(r => r.effect).join(","), "Undead Slayer");
check("with the reason attached",
  /giant/.test(vsGiant.ruledOut[0]?.evaluation?.why ?? ""), true);

const unknowable = ActionGate.effectsOn({
  attackerProfile: withEffects([{ effect: "Lucky", group: "attack", value: "+1",
    conditional: "once per turn" }]),
  targetProfile: { creatureType: "undead", hasCondition: () => false },
  group: "attack",
});
check("what genuinely cannot be settled is still handed over",
  unknowable.needsJudging.map(r => r.effect).join(","), "Lucky");
check("and is NOT quietly counted as applying", unknowable.applies.length, 0);

console.log("");
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
