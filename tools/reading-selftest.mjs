// ─── The reading: one answer, and silence is impossible ──────────────────────
//
// ⚠️🔴 WHAT THIS EXISTS TO STOP. On 2026-09-05 Johnny pressed Mass Cure Wounds
// and Aura of Vitality and got NOTHING. No card, no template, no message, no
// error. The heal pipeline had cancelled the cast and then waited for an event
// that the cancelled cast was the only thing that could fire. The spell sat in
// a variable until reload. It had been that way for months, and the one module
// whose entire job was watching every button press had never seen a heal in its
// life, because it registered after the handler that cancels the chain.
//
// So the watchdog is not a nicety. It is the thing that makes "I press a button
// and nothing happens, and I have no idea why" impossible. A watchdog nobody
// exercises is the same as no watchdog, which is why the window is a static.
//
// ⚠️🔴 AND ONE ANSWER, NOT TWO. The first version of the reading asked a
// different data file than the pipelines ask, so it would have printed a shape
// into his console that disagreed with the shape used to resolve the spell.
// Two readers of one question is the fault this whole night was spent finding,
// and I committed it again four hours later while fixing it.
//
// Run:  node tools/reading-selftest.mjs

let notified = [];
globalThis.game = { ready: true, packs: [], user: { isGM: true },
  settings: { get: () => true, register: () => {} } };
const hooks = {};
globalThis.Hooks = {
  on: (n, fn) => { (hooks[n] ??= []).push(fn); },
  once: () => {}, off: () => {},
  call: (n, ...a) => { for (const fn of (hooks[n] ?? [])) fn(...a); return true; },
  callAll: (n, ...a) => { for (const fn of (hooks[n] ?? [])) fn(...a); },
};
globalThis.ui = { notifications: {
  info:  (m) => notified.push(["info", m]),
  warn:  (m) => notified.push(["warn", m]),
  error: (m) => notified.push(["error", m]),
} };
globalThis.CONFIG = { DND5E: { abilities: {}, skills: {} } };
globalThis.fromUuid = async () => null;
class _App { static DEFAULT_OPTIONS = {}; constructor() {} render() {} close() {} }
globalThis.foundry = {
  utils: { getProperty: () => null, setProperty: () => {}, escapeHTML: (x) => String(x),
           mergeObject: (a, b) => ({ ...a, ...b }), deepClone: (o) => o,
           randomID: () => "id", getRoute: (p) => p, isEmpty: (o) => !o || !Object.keys(o).length },
  applications: {
    api: { ApplicationV2: _App, DialogV2: { wait: async () => null },
           HandlebarsApplicationMixin: (B) => class extends B {} },
    ux: {}, apps: {}, handlebars: {}, instances: new Map(),
  },
  dice: { terms: {} },
};
// The import graph reaches card sweepers that touch the DOM at load.
globalThis.document = { querySelectorAll: () => [], querySelector: () => null,
                        createElement: () => ({ style: {}, classList: { add() {} },
                                                setAttribute() {}, appendChild() {} }) };
globalThis.canvas = { grid: { size: 100, distance: 5 }, scene: null, tokens: { placeables: [] } };
globalThis.CONST = { ACTIVE_EFFECT_MODES: { ADD: 2, CUSTOM: 0, OVERRIDE: 5 },
                     GRID_SNAPPING_MODES: {} };

const { ActionInterceptor } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/profiles/action-interceptor.mjs");
const { SpellPipeline } = await import(
  "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/spell-pipeline/pipeline.mjs");

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Keep the tests fast, and prove the window is honoured at all.
ActionInterceptor.silenceMs = 60;

ActionInterceptor._wireWitnesses();   // register() does this in the real thing

let entryToReturn = null;
SpellPipeline._getEntry = () => entryToReturn;
SpellPipeline.owns = () => !!entryToReturn;
SpellPipeline.ownsAttackRoll = () => false;

let n = 0;
const press = (name, type = "spell", aType = "heal") => ({
  id: `act${++n}`, type: aType,
  item: { name, type, uuid: `Item.${name}`, id: name, system: { source: { rules: "2014" } },
          flags: {}, actor: null },
  actor: { name: "Akra", system: {}, effects: [], flags: {} },
});

/* ── One answer ─────────────────────────────────────────────────────────── */
console.log("\nTHE READING ASKS THE SAME DECIDER THE PIPELINES ASK");
entryToReturn = { shape: "emanation-heal", range: 0 };
let r = ActionInterceptor.read(press("Aura of Vitality"));
check("it reports the registry's shape, not one of its own", r.shape, "emanation-heal");
check("and says the answer was a written ruling", r.source, "curated");
check("and names the spell pipeline as the owner", r.owner, "spell-pipeline");

entryToReturn = { shape: "multi-heal", inferred: true, confidence: "high" };
r = ActionInterceptor.read(press("Homebrew Word of Mending"));
check("a worked-out shape is labelled as worked out", r.source, "worked-out");
check("and carries its confidence", r.confidence, "high");

entryToReturn = { shape: "touch", inferred: true, corrected: true };
r = ActionInterceptor.read(press("A spell he corrected"));
check("a shape he corrected outranks everything", r.source, "corrected-by-you");

entryToReturn = null;
r = ActionInterceptor.read(press("Something nobody knows"));
check("no entry means no shape, honestly reported", [r.shape, r.source], [null, "unknown"]);
// ⚠️ AND IT STILL NAMES AN EXPECTED OWNER, so a dead button says who should
// have taken it rather than just "nothing happened".
check("the activity type still names an expected owner", r.owner, "heal-pipeline");

/* ── Silence ────────────────────────────────────────────────────────────── */
console.log("\nA BUTTON THAT DOES NOTHING SAYS SO");
entryToReturn = { shape: "template-heal" };
await sleep(120);          // let the reads above finish crying, then start clean

notified = [];
ActionInterceptor.read(press("Mass Cure Wounds"));
await sleep(120);
check("nothing happened, so he is told", notified.filter(x => x[0] === "error").length, 1);
check("and the message names the item",
  /Mass Cure Wounds/.test(notified.find(x => x[0] === "error")?.[1] ?? ""), true);
check("and says nothing claimed it",
  /nothing in ACE claimed it/.test(notified.find(x => x[0] === "error")?.[1] ?? ""), true);

console.log("\nBUT A BUTTON THAT WORKED SAYS NOTHING");
notified = [];
ActionInterceptor.read(press("Cure Wounds"));
Hooks.call("createChatMessage", {});          // a card appeared
await sleep(120);
check("a chat card counts as something happening",
  notified.filter(x => x[0] === "error").length, 0);

notified = [];
ActionInterceptor.read(press("Fireball"));
Hooks.call("createMeasuredTemplate", {});     // a template was placed
await sleep(120);
check("a placed template counts too", notified.filter(x => x[0] === "error").length, 0);

notified = [];
ActionInterceptor.read(press("Some check"));
Hooks.call("renderDialogV2", {});             // he was asked something
await sleep(120);
check("an open dialog counts too", notified.filter(x => x[0] === "error").length, 0);

notified = [];
ActionInterceptor.read(press("Bless"));
Hooks.call("createActiveEffect", {});         // a buff landed, no card
await sleep(120);
check("an applied effect counts too", notified.filter(x => x[0] === "error").length, 0);

notified = [];
ActionInterceptor.read(press("Summon Fey"));
Hooks.call("createToken", {});                // a creature appeared
await sleep(120);
check("a summoned creature counts too", notified.filter(x => x[0] === "error").length, 0);

notified = [];
ActionInterceptor.read(press("Aura of Vitality"));
Hooks.call("renderActivityUsageDialog", {});  // dnd5e's own cast dialog, waiting on him
await sleep(120);
// ⚠️ CAUGHT LIVE ON THE FIRST REAL PRESS. dnd5e's cast dialog is an
// ActivityUsageDialog, not a DialogV2, so it opened, sat there waiting for him
// to pick a slot, and ACE called the button dead underneath it.
check("dnd5e's own cast dialog counts as something happening",
  notified.filter(x => x[0] === "error").length, 0);

notified = [];
ActionInterceptor.read(press("Summon Fey"));
Hooks.call("renderSummonUsageDialog", {});
await sleep(120);
check("and so does a summon's dialog", notified.filter(x => x[0] === "error").length, 0);

console.log("\nCLAIMING IS NOT DOING");
// ⚠️🔴 THIS IS EXACTLY THE HEAL PIPELINE'S TEMPLATE BRANCH. It took the button
// and produced nothing. A claim must NOT silence the warning, or the one bug
// this was built to catch would be the one bug it cannot see.
notified = [];
const act = press("Aura of Vitality");
ActionInterceptor.read(act);
ActionInterceptor.claim(act, "heal-pipeline (placing a template)");
await sleep(120);
check("a claim alone does not count as something happening",
  notified.filter(x => x[0] === "error").length, 1);
check("and the warning names who took it and dropped it",
  /heal-pipeline \(placing a template\) took it and produced nothing/
    .test(notified.find(x => x[0] === "error")?.[1] ?? ""), true);

console.log("\nTHE WINDOW IS REAL, NOT INSTANT");
notified = [];
ActionInterceptor.read(press("Slow to draw"));
await sleep(20);
check("it has not cried wolf before the window is up",
  notified.filter(x => x[0] === "error").length, 0);
Hooks.call("createChatMessage", {});
await sleep(120);
check("and a late card still counts", notified.filter(x => x[0] === "error").length, 0);

/* ── Publishing ─────────────────────────────────────────────────────────── */
console.log("\nTHE ANSWER IS PUBLISHED FOR THE PIPELINES TO READ");
entryToReturn = { shape: "template-heal" };
const a2 = press("Mass Cure Wounds");
ActionInterceptor.read(a2);
check("a pipeline can read the answer by activity",
  ActionInterceptor.readingFor(a2)?.shape, "template-heal");
check("an unknown activity reads back null, not a guess",
  ActionInterceptor.readingFor({ id: "nope" }), null);

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
