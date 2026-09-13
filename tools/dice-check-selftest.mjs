#!/usr/bin/env node
/**
 * PROVE THE CHECKER FIRST (lesson, 2026-08-26): tools/dice-check.mjs gates every
 * release on Johnny's rule that nothing lands before the dice, so it must be shown
 * to catch what it claims to catch and to leave alone what is right.
 *
 * Every case below is a shape found in ACE's own code on 2026-09-13, reduced to a
 * few lines: the ones it must report (the Prismatic Wall's layers, the heal that
 * wrote HP before its dice were thrown, a signal sent under a rolling d20, a card
 * carrying dice ACE had already shown), and the ones its first versions got wrong
 * (an unrelated `register()` in another file, Sequencer's `play()`, an empty
 * catch around a wait, a `break` between switch cases).
 *
 * Run from the ace-qol folder:   node tools/dice-check-selftest.mjs
 */
import { checkSources, loadEspree } from "./dice-check.mjs";

let passed = 0, failed = 0;
const espree = loadEspree();
if (!espree) {
  console.log("The dice check's parser (espree) is missing; the lint check installs it: npx --yes eslint@9 --version");
  console.log("0 passed, 1 failed");
  process.exit(1);
}

/** files: {name: source}; expect: number of findings, or a list of line numbers. */
function check(label, files, expect) {
  const sources = Object.entries(files).map(([file, src]) => ({ file, src }));
  const { findings, parseErrors } = checkSources(sources, espree);
  const lines = findings.map(f => `${f.file}:${f.line}${f.twice ? " (twice)" : ""}`);
  const ok = !parseErrors.length && (Array.isArray(expect)
    ? JSON.stringify(lines) === JSON.stringify(expect)
    : findings.length === expect);
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL  ${label}\n      expected ${JSON.stringify(expect)}, got ${JSON.stringify(lines)}${parseErrors.length ? ` parse: ${parseErrors[0].why}` : ""}`);
  }
}

// ── What it must report ──────────────────────────────────────────────────────
check("a condition put on while the dice roll", { "a.mjs": `
async function go(actor, r) {
  safeShowForRoll(r, "save");
  await ConditionLibrary.applyEffect(actor, "blinded");
}` }, ["a.mjs:4"]);

check("damage that lands before its dice are even thrown (the heal resolver)", { "a.mjs": `
async function heal(actor) {
  const roll = await new Roll("2d8").evaluate();
  await actor.update({ "system.attributes.hp.value": 10 });
  safeShowForRoll(roll, "healing");
}` }, ["a.mjs:4"]);

check("a helper that throws and returns leaves its caller in flight (the wall's _rollSave)", { "a.mjs": `
class Wall {
  static async _rollSave(r) { safeShowForRoll(r, "save"); return 3; }
  static async layers(actor, r) {
    await this._rollSave(r);
    await ConditionLibrary.applyEffect(actor, "restrained");
  }
}` }, ["a.mjs:6"]);

check("a helper that lands before waiting is a landing at its call (the wall's _putOn)", { "a.mjs": `
class Wall {
  static async _putOn(actor) { return ConditionLibrary.applyEffect(actor, "restrained"); }
  static async layers(actor, r) {
    safeShowForRoll(r, "damage");
    await this._putOn(actor);
  }
}` }, ["a.mjs:6"]);

check("a signal sent under a rolling d20 (saveComplete)", { "a.mjs": `
async function save(r) {
  safeShowForRoll(r, "NPC save roll");
  Hooks.callAll("ace-qol.saveComplete", { passed: false });
}` }, ["a.mjs:4"]);

check("a dnd5e roll that makes its own card, then a landing", { "a.mjs": `
async function trap(actor, tokenDoc) {
  await actor.rollSavingThrow({ ability: "con", target: 15 }, { configure: false });
  await tokenDoc.update({ hidden: true });
}` }, ["a.mjs:4"]);

check("the landing at the top of a loop, after the last pass threw", { "a.mjs": `
async function heal(targets, r) {
  for (const t of targets) {
    await t.actor.update({ "system.attributes.hp.value": 1 });
    safeShowForRoll(r, "healing");
  }
}` }, ["a.mjs:4"]);

check("the same dice shown by ACE and handed to chat as well", { "a.mjs": `
async function area(roll, content) {
  safeShowForRoll(roll, "auto-damage");
  await awaitDiceSettle();
  await ChatMessage.create({ content, rolls: [roll] });
}` }, ["a.mjs:5 (twice)"]);

check("a guessed delay is not a wait (Forge's 1.1 seconds)", { "a.mjs": `
async function disarm(roll, message) {
  game.dice3d.showForRoll(roll, game.user, true).catch(() => {});
  await new Promise(r => setTimeout(r, 1100));
  await message.update({ content: "" });
}` }, ["a.mjs:5"]);

// ── What it must leave alone ─────────────────────────────────────────────────
check("throw, wait, then land", { "a.mjs": `
async function go(actor, r) {
  safeShowForRoll(r, "save");
  await awaitDiceSettle();
  await ConditionLibrary.applyEffect(actor, "blinded");
  await ChatMessage.create({ content: "" });
}` }, 0);

check("a wait inside try with an empty catch still counts", { "a.mjs": `
async function go(eff, r) {
  safeShowForRoll(r, "break free");
  try { await awaitDsnRoll(); } catch (_) {}
  await eff.delete();
}` }, 0);

check("a catch is the roll failing, not the roll landing", { "a.mjs": `
async function go(subject, item) {
  try { await subject.rollAttack({}, { configure: false }, {}); }
  catch (err) { Hooks.callAll("ace-qol.attackCancelled", { item }); }
}` }, 0);

check("break ends a switch case", { "a.mjs": `
async function go(k, r, doc) {
  switch (k) {
    case 1: safeShowForRoll(r, "x"); break;
    case 2: await doc.update({ a: 1 }); break;
  }
}` }, 0);

check("an unrelated function of the same name in another file is not followed", {
  "a.mjs": `export function register(r) { safeShowForRoll(r, "x"); }`,
  "b.mjs": `function register() {}
async function go() { register(); await ChatMessage.create({ content: "" }); }`,
}, 0);

check("a short common verb on an unknown object is not ACE's (Sequencer's play)", {
  "a.mjs": `export async function play(r) { safeShowForRoll(r, "x"); }`,
  "b.mjs": `async function go(seq) { await seq.play(); await ChatMessage.create({ content: "" }); }`,
}, 0);

check("an import is followed to the file it names", {
  "a.mjs": `export function throwIt(r) { safeShowForRoll(r, "x"); }`,
  "b.mjs": `import { throwIt } from "./a.mjs";
async function go(r, doc) { throwIt(r); await doc.update({ a: 1 }); }`,
}, ["b.mjs:2"]);

check("a roll made with create: false throws nothing", { "a.mjs": `
async function go(actor, doc) {
  await actor.rollSavingThrow({ ability: "con" }, { configure: false }, { create: false });
  await doc.update({ a: 1 });
}` }, 0);

check("an awaited raw showForRoll has landed when it returns", { "a.mjs": `
async function go(r, actor) {
  await game.dice3d.showForRoll(r, game.user, true);
  await actor.update({ a: 1 });
}` }, 0);

check("dice-ok on the line above excuses a landing, with its reason", { "a.mjs": `
async function go(r) {
  safeShowForRoll(r, "x");
  // dice-ok: this card is only a button; no answer is on it.
  await ChatMessage.create({ content: "" });
}` }, 0);

check("Forge's own waits count", { "a.mjs": `
async function go(roll, card, msg) {
  const watch = forgeWatchMessageDice();
  const m = await roll.toMessage({});
  await watch.untilDiceLand(m);
  await msg.update({ a: 1 });
  forgeShowDice(roll);
  await forgeAwaitDice();
  await msg.update({ b: 1 });
}`, "b.mjs": `export function forgeShowDice(r) { game.dice3d.showForRoll(r, game.user, true); }` }, 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
