// ─── THE TURN OF A CREATURE SOMETHING IS HOLDING ─────────────────────────────
//
// His order, 2026-10-04:
//
//   "The turn starts with the squeeze, if the hold still carries one. Roll the
//    bludgeoning and the acid through the dice hook. Post that card only after
//    the dice land. Then one popup on that creature: Attack, or Escape check...
//    A success ends the hold. A failure leaves it on. A move by the GM or the
//    player opens the same popup and does not move the token. Print the choice
//    it was given and which one it took."
//
// And, first: "any condition or whatever... has to sit above the token. For some
// reason, that's not happening on this restrained. I want you to make sure that
// ALL of them sit on top of the token, visible."
//
// Run:  node tools/held-turn-selftest.mjs
import { readFileSync } from "node:fs";

const M = "D:/FoundryVTT/Data/modules/ace-qol";
const held = readFileSync(`${M}/scripts/grapple-turn.mjs`, "utf8");
const visuals = readFileSync(`${M}/scripts/condition-visuals.mjs`, "utf8");
const breakFree = readFileSync(`${M}/scripts/break-free-engine.mjs`, "utf8");
const move = readFileSync(`${M}/scripts/restrained-movement.mjs`, "utf8");
const postHit = readFileSync(`${M}/scripts/post-hit-saves.mjs`, "utf8");
const css = readFileSync(`${M}/styles/ace-qol.css`, "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(66)} ${detail}`);
};

console.log("\nEVERY CONDITION SITS ON TOP OF THE TOKEN");
{
  /* ⚠️🔴 NOTHING HERE EVER SET A Z. The overlay container goes on canvas.stage,
     whose children are Foundry's own layers and which SORTS them: tiles, tokens,
     interface and controls carry explicit zIndexes (200, 500, 900). A container
     added with none sorts at zero, underneath every one of them — so the chains,
     the grip band and every other overlay drew BEHIND the art and showed only
     where that art happened to be transparent. */
  check("the overlay is given a z at all", /cont\.zIndex = top \+ 10;/.test(visuals));
  check("and it is read off the live layers, not guessed",
    /Math\.max\(0, \.\.\.\(layer\.children \?\? \[\]\)\.map\(c => Number\(c\?\.zIndex\) \|\| 0\)\)/.test(visuals),
    "a module that adds a layer cannot bury them again");
  check("the stage is told to sort, or the z is ignored",
    /layer\.sortableChildren = true;/.test(visuals) && /layer\.sortChildren\?\.\(\)/.test(visuals));
  check("and a canvas it cannot read says so instead of going quiet",
    /could not read the canvas layer order/.test(visuals));
}

console.log("\nTHE SQUEEZE COMES FIRST, AND ITS CARD WAITS FOR THE DICE");
{
  check("the hold carries its whole squeeze, not one roll of it",
    /const list = hold\?\.flags\?\.\[MODULE_ID\]\?\.squeeze;/.test(held)
    && /setFlag\(MODULE_ID, "squeeze", squeeze\)/.test(postHit), "the bludgeoning AND the acid");
  check("every formula is thrown and shown",
    /safeShowForRoll\(roll, `\$\{label\} \u2014 the squeeze`\)/.test(held));
  /* ⚠️ NOTHING LANDS BEFORE THE DICE. Both of them, together, then the card. */
  check("the card is posted only after they land",
    /await awaitDiceSettle\(15000\);/.test(held)
    && /\}, \{ dice: true \}\);/.test(held.slice(held.indexOf("ace-qol-squeeze-card"))),
    "through the door that holds a card for its dice");
  check("and the squeeze runs before the box",
    held.indexOf("await GrappleTurn.squeeze(actor, hold)")
      < held.indexOf("await GrappleTurn.ask(actor, token, holds[0]"), "his order");
}

console.log("\nONE BOX: ATTACK, OR ESCAPE CHECK");
{
  check("those are the two choices", /id: "attack"/.test(held) && /id: "escape"/.test(held));
  check("the attack says it is at disadvantage while Restrained",
    /at disadvantage while Restrained/.test(held));
  check("and the escape names the hold's own DC",
    /Athletics against DC \$\{meta\.dc\}/.test(held));
  /* ⚠️ PRINT THE CHOICE IT WAS GIVEN AND WHICH ONE IT TOOK. A box that opens and
     closes with nothing in the log is the same as one that never opened. */
  check("the choice it was offered is printed",
    /offered: `\s*\+ `\$\{choices\.map\(c => c\.label\)\.join\(" or "\)\}/.test(held)
    || /choices\.map\(c => c\.label\)\.join\(" or "\)/.test(held));
  check("and the one it took", /chose \$\{picked === "escape" \? "the escape check" : "to attack"\}/.test(held));
  check("and a box closed without an answer is said too",
    /closed the box without choosing/.test(held));
  check("either answer spends the action",
    /_spendAction\(actor, "an attack while held"\)/.test(held)
    && /_spendAction\(actor, "an escape check"\)/.test(held));
  check("and a turn whose action is spent is not asked twice",
    /_actionSpent\(actor\)/.test(held));
  check("it asks through the live reaction engine, not a second copy",
    /game\.aceQol\?\.reactionEngine/.test(held) && !/new ReactionEngine\(\)/.test(held));
}

console.log("\nTHE ESCAPE: ATHLETICS, THE DICE HOOK, AND THE HOLD ENDS OR DOES NOT");
{
  check("it rolls Athletics", /const skill = "ath";/.test(held));
  check("through the same dice hook, with the card after",
    /safeShowForRoll\(roll, "escape check"\)/.test(held)
    && /await awaitDiceSettle\(15000\);/.test(held));
  check("a success takes off every condition that grab put on, by id",
    /const ids = \(meta\.holds \?\? \[\]\)\.map\(h => h\.id\)/.test(held),
    "not by status, so Web's Restrained is never touched");
  check("a failure leaves it on, and says so",
    /holds\.`\);\s*\n\s*return false;/.test(held) || /: "\$\{label\}" holds/.test(held));
  /* ⚠️ THE FORMULAS STAY THE SAME COLOURS AND ARE DRAWN TWICE AS BIG. */
  check("the escape card's formula is twice the size",
    /\.ace-qol-escape-formula \.ace-qol-formula-text[^}]*font-size: 28px/s.test(css));
  check("and keeps every colour the other cards use",
    !/\.ace-qol-escape-formula[^}]*color:/s.test(css.slice(css.indexOf(".ace-qol-escape-formula"),
      css.indexOf(".ace-qol-escape-formula") + 700)), "size only");
}

console.log("\nA MOVE OPENS THE SAME BOX AND THE TOKEN STAYS PUT");
{
  check("a hold stops the GM too, not only a player",
    /if \(game\.user\.isGM && !held\) return;/.test(move),
    "a Restrained with no hold behind it leaves the GM free");
  check("the move is refused", /return false;   \/\/ cancel the update/.test(move));
  check("and the same box opens instead of nothing",
    /GrappleTurn\.ask\(tokenDoc\.actor, tokenDoc\.object \?\? null, holds\[0\]/.test(move));
  /* ⚠️ ONE DOOR. A second preUpdateToken hook in grapple-turn.mjs would be a
     second answer to one question. */
  /* ⚠️ READ THE CODE, NOT THE COMMENT. The note in grapple-turn.mjs says which
     file owns that hook, and a pin that greps the whole file fails on the
     explanation — four times in two days now. */
  check("there is only one door onto that question",
    !/Hooks\.on\("preUpdateToken"/.test(held), "restrained-movement.mjs owns it");
}

console.log("\nTHE GRAPPLE IS NOT ROLLED FOR THEM ANY MORE");
{
  check("break-free hands a grapple to the held-turn box",
    /held-turn box asks it/.test(breakFree) && !/if \(meta\.auto\) this\._autoAttempt/.test(breakFree));
  check("and keeps its own prompt for everything else",
    /this\._postPrompt\(actor, combatant, eff, meta, round, turn\);/.test(breakFree),
    "Web, the net, the Entangling Rope");
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
