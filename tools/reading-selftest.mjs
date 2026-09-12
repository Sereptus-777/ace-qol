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
// ⚠️ IT USED TO SAY "nothing in ACE claimed it", which reads as the cause.
// It is not: the heal pipeline is the only thing in the suite that claims at
// all, so that was true of nearly every button in the game.
check("and says no pipeline reported taking it, without calling that the fault",
  /no pipeline reported taking it .*not the fault/
    .test(notified.find(x => x[0] === "error")?.[1] ?? ""), true);

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

console.log("\nA CARD THAT IS ON ITS WAY IS NOT SILENCE");
// ⚠️🔴 2026-09-12: "Claws did nothing" in permanent red over a save card that
// arrived a moment later. The save engine waits for the cast animation and the
// dice before its first card, and now says so.
notified = [];
{
  const a = press("Claws", "weapon", "save");
  ActionInterceptor.read(a);
  Hooks.callAll("ace-qol.expectCard", { activity: a, ms: 150, who: "the save engine" });
  await sleep(100);                         // past the 60 ms window, inside the promise
  check("a promised card is waited for", notified.filter(x => x[0] === "error").length, 0);
  Hooks.call("createChatMessage", {});      // and it arrives
  await sleep(200);
  check("and when it lands nothing is said", notified.filter(x => x[0] === "error").length, 0);
}
notified = [];
{
  const a = press("Hold Person", "spell", "save");
  ActionInterceptor.read(a);
  Hooks.callAll("ace-qol.expectCard", { activity: a, ms: 100, who: "the save engine" });
  await sleep(250);
  check("a promise that is not kept is still reported",
    notified.filter(x => x[0] === "error").length, 1);
  check("and it names who promised the card",
    /the save engine said its card was on the way, and none came/
      .test(notified.find(x => x[0] === "error")?.[1] ?? ""), true);
}

/* ── Publishing ─────────────────────────────────────────────────────────── */
console.log("\nTHE ANSWER IS PUBLISHED FOR THE PIPELINES TO READ");
entryToReturn = { shape: "template-heal" };
const a2 = press("Mass Cure Wounds");
ActionInterceptor.read(a2);
check("a pipeline can read the answer by activity",
  ActionInterceptor.readingFor(a2)?.shape, "template-heal");
check("an unknown activity reads back null, not a guess",
  ActionInterceptor.readingFor({ id: "nope" }), null);

/* ── The key collision ──────────────────────────────────────────────────── */
console.log("\nTWO SPELLS THAT SHARE AN ACTIVITY ID");
// ⚠️🔴 THIS IS THE BUG THE OLD HARNESS COULD NOT SEE. Every fake press above
// gets an id of its own, so a store keyed on the activity id passed for months.
// dnd5e does not work that way: counted out of its two shipped spell books on
// 2026-09-07, 518 of 659 spells carry the id "dnd5eactivity000", Fear and Cone
// of Cold among them, in BOTH editions. One Map keyed on that held exactly one
// of those spells at a time and destroyed the rest without a word.
const sharedPress = (name, actorName = "Varek Thalor") => ({
  id: "dnd5eactivity000", type: "save",
  item: { name, type: "spell", uuid: `Item.${name}`, id: name,
          system: { source: { rules: "2014" } }, flags: {}, actor: null },
  actor: { name: actorName, system: {}, effects: [], flags: {} },
});

entryToReturn = { shape: "template-save" };
const heldBefore = ActionInterceptor._log.length;
const fear = sharedPress("Fear");
const cone = sharedPress("Cone of Cold");
ActionInterceptor.read(fear);
ActionInterceptor.read(cone);

check("both presses are kept", ActionInterceptor._log.length - heldBefore, 2);
check("the first is still readable by its own activity",
  ActionInterceptor.readingFor(fear)?.itemName, "Fear");
check("and so is the second",
  ActionInterceptor.readingFor(cone)?.itemName, "Cone of Cold");

// ⚠️ AND THE CLAIM MUST LAND ON THE RIGHT ONE. Under the old key a pipeline
// claiming Fear marked Cone of Cold instead, because they were the same slot.
ActionInterceptor.claim(fear, "spell-pipeline");
check("a claim lands on the spell it was made for",
  ActionInterceptor.readingFor(fear)?.claimedBy, "spell-pipeline");
check("and not on the other spell sharing the id",
  ActionInterceptor.readingFor(cone)?.claimedBy, null);
check("an activity nobody read reads back null, not a guess",
  ActionInterceptor.readingFor({ id: "dnd5eactivity000" }), null);

/* ── The report ─────────────────────────────────────────────────────────── */
console.log("\nTHE REPORT ANSWERS ABOUT ONE THING, NOT IN ROWS");
{
  const out = ActionInterceptor.report({ log: false, why: false });
  check("it describes the last button pressed",
    /Cone of Cold/.test(out.snapshot ?? ""), true);
  check("and says what it does, not just what it is called",
    /arrives by|decided by|could not be read/.test(out.snapshot ?? ""), true);
  check("the press log is still kept underneath", out.presses.length > 0, true);
}

console.log("\nAND IT NAMES AN OPTION IT DOES NOT UNDERSTAND");
{
  // ⚠️🔴 2026-09-07: I told him `readings({ raw: true })` would say so if there
  // were no such option. It took no arguments at all and swallowed it in
  // silence. "I do not understand that" and "there is nothing there" must never
  // print the same, which is the oldest standing rule in this codebase.
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  ActionInterceptor.report({ raw: true, log: false, why: false });
  console.warn = realWarn;
  check("the unknown option is named",
    /does not understand "raw"/.test(warns.join("\n")), true);
  check("and the real options are listed",
    /item\s+a spell name/.test(warns.join("\n")), true);
}

/* ── Finding the thing he means ─────────────────────────────────────────── */
console.log("\nASKING BY NAME");
{
  const { resolveItem } = await import(
    "file:///D:/FoundryVTT/Data/modules/ace-qol/scripts/inference/snapshot.mjs");

  const mkItem = (name) => ({ name, type: "spell", uuid: `Item.${name}`, id: name,
                              system: {}, flags: {} });
  const strahd = { name: "Strahd", type: "npc", items: [mkItem("Fireball")] };
  const akra = { name: "Akra", type: "character", hasPlayerOwner: true,
                 items: [mkItem("Cone of Cold"), mkItem("Fear (Legacy)")] };
  game.actors = [strahd, akra];
  canvas.tokens.controlled = [{ actor: strahd }];

  check("a name is found on a player character",
    resolveItem("Cone of Cold").item?.name, "Cone of Cold");
  check("case does not matter", resolveItem("cone of cold").item?.name, "Cone of Cold");

  // ⚠️ HIS 2014 ITEMS ARE NAMED "(Legacy)". Matching the raw name only is the
  // fault from 2026-09-05 that made every Legacy spell miss its registry entry.
  check("a Legacy suffix still answers to the spell's name",
    resolveItem("Fear").item?.name, "Fear (Legacy)");

  // ⚠️ THE SELECTED TOKEN IS NEAREST. Asking about a spell while a creature is
  // selected must mean THAT creature's copy.
  check("the selected token is searched first",
    resolveItem("Fireball").actor?.name, "Strahd");

  // ⚠️ AND "I DID NOT FIND IT" NAMES WHERE IT LOOKED. A bare null here is the
  // silent refusal this codebase has a standing rule against.
  const missing = resolveItem("Prismatic Wall");
  check("a miss returns no item", missing.item, null);
  check("and says what it searched",
    /selected.*player character.*actor/s.test(missing.note), true);

  check("an item handed over directly is used as-is",
    resolveItem(mkItem("Bless")).item?.name, "Bless");
  check("and a non-item object is refused in words",
    /not an item/.test(resolveItem({ nonsense: true }).note), true);

  game.actors = [];
  canvas.tokens.controlled = [];
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
