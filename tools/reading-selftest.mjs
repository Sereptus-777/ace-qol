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
// It is not one thing: it names all three things it did not see (2026-09-18).
check("and says what it did not see: no pipeline, no reaction, nothing on screen",
  /no pipeline reported taking it, no reaction was asked, and nothing appeared/
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

// Capture what the watch prints, for the pins that are about the console.
const consoleSaid = async (fn) => {
  const said = [];
  const keep = { warn: console.warn, error: console.error };
  console.warn = (...a) => said.push(a.map(String).join(" "));
  console.error = (...a) => said.push(a.map(String).join(" "));
  try { await fn(); } finally { console.warn = keep.warn; console.error = keep.error; }
  return said;
};

console.log("\nA PRESS A PIPELINE TOOK IS NOT A DEAD BUTTON");
// ⚠️🔴 HIS RULE, 2026-09-18: "Keep the toast only when the press truly
// produced no pipeline and no reaction." This block used to pin the opposite
// ("claiming is not doing": a claim still raised the red banner), and a
// pipeline waiting on a Counterspell answer is exactly a claim with nothing on
// screen yet. The console still names who took it, so it is not silent.
notified = [];
{
  const act = press("Aura of Vitality");
  const said = await consoleSaid(async () => {
    ActionInterceptor.read(act);
    ActionInterceptor.claim(act, "heal-pipeline (placing a template)");
    await sleep(120);
  });
  check("a press a pipeline took raises no red banner",
    notified.filter(x => x[0] === "error").length, 0);
  check("but the console names who took it and that nothing has appeared",
    said.some(l => /heal-pipeline \(placing a template\) took it, and nothing has appeared/.test(l)), true);
}

console.log("\nA REACTION BOX IS SOMETHING HAPPENING");
// ⚠️🔴 HIS TABLE, 2026-09-18: "Magic Missile did nothing. no pipeline
// reported taking it." The missile resolved; the watch fired while the
// Counterspell box was still open, because that box is an old-style Dialog
// this watch never heard and could be on another player's screen entirely.
notified = [];
ActionInterceptor.read(press("Magic Missile", "spell", "damage"));
ActionInterceptor.reactionBox({ id: "box-cs", open: true, what: "Counterspell for Kasimir Velikov" });
await sleep(120);                            // well past the window, box still open
check("a reaction box opening counts as something happening",
  notified.filter(x => x[0] === "error").length, 0);
ActionInterceptor.reactionBox({ id: "box-cs", open: false });
await sleep(120);
check("and after it is answered, still nothing is said about that press",
  notified.filter(x => x[0] === "error").length, 0);

console.log("\nNOTHING IS JUDGED WHILE A BOX IS OPEN");
// A press that began while somebody else's box was open is held, not judged,
// and gets a fresh window once the box closes. If it then truly did nothing,
// it is still reported: the rule narrows the banner, it does not remove it.
notified = [];
ActionInterceptor.reactionBox({ id: "box-shield", open: true, what: "Shield for Beric" });
ActionInterceptor.read(press("A button that is truly dead"));
await sleep(150);                            // past the window, box still open
check("while a box is open, no press is called dead",
  notified.filter(x => x[0] === "error").length, 0);
ActionInterceptor.reactionBox({ id: "box-shield", open: false });
await sleep(20);
check("and closing the box does not judge it on the spot",
  notified.filter(x => x[0] === "error").length, 0);
await sleep(ActionInterceptor.boxPollMs + 200);
check("but a press that truly did nothing is still reported once the box has closed",
  notified.filter(x => x[0] === "error").length, 1);

console.log("\nA BOX RAISED ON ANOTHER CLIENT ARRIVES OVER THE SOCKET");
// The Counterspell box is raised by the GM's client, and the press may be a
// player's. The reaction engine emits it; the watch listens on the socket.
{
  const socketHandlers = [];
  game.socket = { on: (name, fn) => socketHandlers.push([name, fn]), emit: () => {} };
  ActionInterceptor._witnessesWired = false;
  ActionInterceptor._wireWitnesses();
  const mine = socketHandlers.find(([name]) => name === "module.ace-qol");
  notified = [];
  ActionInterceptor.read(press("Magic Missile", "spell", "damage"));
  mine?.[1]?.({ action: "reactionBox", id: "gm-box-1", open: true, what: "Counterspell for Kasimir Velikov" });
  await sleep(120);
  check("the watch listens for boxes from other clients",
    !!mine, true);
  check("and a box announced by the GM's client counts for a player's press",
    notified.filter(x => x[0] === "error").length, 0);
  mine?.[1]?.({ action: "reactionBox", id: "gm-box-1", open: false });
  delete game.socket;
}

console.log("\nA BOX NOBODY CLOSES STOPS HOLDING");
// A client that disconnects with a box open never says it closed. One
// abandoned box must not hush every dead button until reload.
{
  const keepMax = ActionInterceptor.boxHoldMaxMs;
  ActionInterceptor.boxHoldMaxMs = 50;
  ActionInterceptor.reactionBox({ id: "box-abandoned", open: true, what: "Shield for someone who left" });
  await sleep(80);
  check("an abandoned box stops counting as open", ActionInterceptor._boxesOpen(), 0);
  ActionInterceptor.boxHoldMaxMs = keepMax;
}

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
  // ⚠️ IN THE CONSOLE, NOT THE BANNER (his rule, 2026-09-18): the save engine
  // promising a card is a pipeline that took the press.
  const said = await consoleSaid(async () => {
    ActionInterceptor.read(a);
    Hooks.callAll("ace-qol.expectCard", { activity: a, ms: 100, who: "the save engine" });
    await sleep(250);
  });
  check("a promise that is not kept raises no red banner",
    notified.filter(x => x[0] === "error").length, 0);
  check("but the console names who promised the card",
    said.some(l => /the save engine said its card was on the way, and nothing has appeared/.test(l)), true);
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
