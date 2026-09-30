// ─── ONE DICE GATE FOR EVERY CARD, AND THE ROW THAT IS WAITING ───────────────
//
// His table, 2026-09-29: "The wait was only on CardDoor.post. Results now land
// through CardDoor.update and that write does not wait. That is the regression.
// Fix the door, not one caller."
//
// He was right about the mechanism and right about where to fix it. `dice` was a
// promise every caller had to remember to make: of the forty-five cards ace-qol
// can post, five made it, and of the six cards it can redraw, none did. So a save
// card that asks and then becomes its own result flipped to FAIL through the one
// door that never waited.
//
// The door asks now instead of being told. Frozen note 4 is untouched: nothing
// thrown and nothing in the air still lands on the same tick.
//
// Also pinned here, from the same report:
//   - the X on a post-hit row that had nothing left to remove
//   - the little square d6 on the table line, beside a d20 that had just rolled
//   - a Lucky reroll that changed the total and left the old die on the card
//   - one waiting row, yellow, carrying the die the player presses
//   - the GM's roll-on-their-behalf die, gone while that player is connected
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(62)} ${detail}`);
};
const read = (p) => readFileSync(`D:/FoundryVTT/Data/modules/ace-qol/${p}`, "utf8");

const doors = read("scripts/road/doors.mjs");
// ⚠️ THE GATE MOVED INTO ITS OWN LEAF (0.68.0) so the condition library could
// read it without an import cycle: doors.mjs imports the library, so the gate
// could never have lived here and been readable from there. doors.mjs
// re-exports it, which the pin below checks.
const gate  = read("scripts/road/dice-gate.mjs");
const dsn   = read("scripts/dsn-utils.mjs");
const save  = read("scripts/save-engine.mjs");
const ph    = read("scripts/post-hit-saves.mjs");
const css   = read("styles/ace-qol.css");

console.log("\nONE DICE GATE FOR EVERY CARD\n");

/* ══ 1. THE DOOR, NOT THE CALLER ══════════════════════════════════════════ */
console.log("THE DOOR ASKS, IT IS NOT TOLD");
{
  check("the door can see what is tumbling on this screen",
    /import \{ awaitDiceSettle, diceInFlight \} from "\.\.\/dsn-utils\.mjs";/.test(gate),
    "diceInFlight");
  check("and every door still reads the one gate",
    /import \{ untilDiceLand \} from "\.\/dice-gate\.mjs";/.test(doors)
    && /export \{ untilDiceLand \} from "\.\/dice-gate\.mjs";/.test(doors),
    "moved to a leaf, re-exported here");
  check("and dsn-utils really exports it",
    /export function diceInFlight\(\)\s*\{\s*\n\s*return _inFlight\.size > 0;/.test(dsn),
    "the live animation set");

  const gated = /if \(!dice && !diceInFlight\(\)\) return;/.test(gate);
  check("a landing waits whenever dice are in the air, declared or not", gated,
    "the one gate");
  check("and the old 'nobody declared dice, so do not wait' is gone",
    !/^\s*if \(!dice\) return;\s*$/m.test(gate), "no early bail");
  // ⚠️ AND SILENCE IS NOT "NO DICE" AT THE CONDITION DOOR EITHER (his rule,
  // 2026-09-30: "Dice land. Then the condition."). Every one of these read
  // `dice = false`, which the gate honours as a declaration, so a condition from
  // a save landed while the d20 was still up.
  check("the condition door asks the screen when nobody said",
    /static async apply\(actor, key, options = \{\}, \{ dice, item = null \} = \{\}\) \{/.test(doors)
    && /static async remove\(actor, key, \{ dice \} = \{\}\) \{/.test(doors),
    "no more dice = false by default");
  check("and the library holds the same rule, for the paths that never reach a door",
    /await ConditionLibrary\._beforeItLands\(actor, key, options\);/
      .test(read("scripts/condition-library.mjs")),
    "the save resolver calls the library straight");

  // FROZEN NOTE 4 IS UNTOUCHED.
  check("nothing thrown and nothing in the air still lands at once", gated,
    "note 4: no timer, no hook");
  check("the note itself is still written down",
    /NOTE 4 IS UNTOUCHED/.test(gate) && /twenty-second card of 4 September/.test(gate),
    "why it exists");

  // BOTH HALVES OF THE SAME DOOR.
  const post = doors.slice(doors.indexOf("static async post("), doors.indexOf("static async update("));
  const upd  = doors.slice(doors.indexOf("static async update("), doors.indexOf("/* \u2500\u2500 2."));
  check("CardDoor.post goes through the gate", /await untilDiceLand\(dice\);/.test(post), "post");
  check("CardDoor.update goes through the SAME gate", /await untilDiceLand\(dice\);/.test(upd), "update");
  check("and update says why it is the half that was missed",
    /THE SECOND HALF OF THE SAME RULE/.test(doors), "his report, in the file");
}

/* ══ 2. THE POST-HIT ROW IS THE SHARED ROW ════════════════════════════════ */
console.log("\nTHE CHAIN ROW IS THE CHARM PERSON ROW");
{
  check("post-hit draws the shared row, not its own",
    /_SE\.saveResultRowHtml\(forRow,/.test(ph), "one renderer");
  check("and keeps no private result markup",
    !/ace-qol-save-roll \$\{passClass\}/.test(ph), "no second layout");

  // THE X ONLY WHERE THE X DOES SOMETHING.
  check("the row's remove X is drawn only when the card can remove",
    /const removeBtn = opts\?\.canRemove/.test(save), "opts.canRemove");
  check("silence means no, so a new card never inherits a dead button",
    /SILENCE MEANS/.test(save), "the default is off");
  // And it asks for it only where there is damage left to drop a target from:
  // his card, 2026-09-29, "No X" on a save that moves no hit points.
  check("the phase-1 card asks for it only where damage is still to be rolled",
    /canRemove: hasDamage === true,/.test(save), "one caller, one condition");
  check("the post-hit card does not",
    !/canRemove/.test(ph), "no X on a grapple that already happened");

  // A SECOND ROLL IS A SECOND LINE (ACE-ONE-ROAD.md § 13.4). It was a gold pill
  // with a little d6 in it, sitting between the save's numbers and its verdict, so
  // it read as part of the save. Plain text, on its own line, under what landed.
  const at = ph.indexOf("ace-qol-save-extra-roll");
  const table = ph.slice(at, at + 300);
  check("the table roll is text on its own line, with no die of its own",
    at > 0 && !/fa-dice/.test(table) && /Rolled <strong>/.test(table), "Rolled 3: Grapple");
  check("and it is added after what landed, not inside the save's row",
    /\$\{tableLine\}\$\{hpHtml\}/.test(ph), "result, then Prone., then the extra roll");
}

/* ══ 3. A REROLL CHANGES THE DIE, NOT JUST THE TOTAL ══════════════════════ */
console.log("\nTHE FACE THAT MADE THE TOTAL");
{
  check("the save keeps the face beside the total",
    /let dieFace = null;/.test(ph), "one variable");
  check("a spent Lucky replaces BOTH",
    /if \(lk\.spent\) \{\s*\n\s*saveTotal = lk\.total;\s*\n\s*if \(Number\.isFinite\(Number\(lk\.d20\)\)\) dieFace = Number\(lk\.d20\);/.test(ph),
    "lk.d20");
  check("the HP-threshold rider does the same",
    /if \(Number\.isFinite\(Number\(lk\.d20\)\)\) riderFace = Number\(lk\.d20\);/.test(ph),
    "riderFace");
  check("and the row is handed that face, not sent digging for it",
    /dieResult: dieFace,/.test(ph), "on the result");
  check("break-free, which always did it right, is unchanged",
    /if \(lk\.spent\) \{ total = lk\.total; dieFace = lk\.d20; \}/.test(read("scripts/break-free-engine.mjs")),
    "the model it was copied from");
}

/* ══ 4. ONE WAITING ROW ═══════════════════════════════════════════════════ */
console.log("\nONE WAITING ROW, YELLOW, WITH ITS OWN DIE");
{
  const copies = (save.match(/WAITING FOR PLAYER<\/span>/g) ?? []).length;
  check("there is one waiting row in the engine, not three", copies === 0,
    `${copies} hand-written cop${copies === 1 ? "y" : "ies"} left`);
  check("the other cards call the shared one",
    (save.match(/if \(r\.pending\) return SaveEngine\.saveResultRowHtml\(r, opts\);/g) ?? []).length === 2,
    "phase 2 and the legacy card");

  const rat = save.indexOf("const _awaitLabel");
  const row = save.slice(rat, rat + 1600);
  check("it carries the die the player presses",
    /data-action="aceQolRollMySave"/.test(row) && /aceD20FaceImg\(20/.test(row), "the d20 PNG");
  check("it blinks yellow", /ace-qol-save-await/.test(row), "on the row");
  check("and says WHICH wait this is",
    /NO PLAYER ONLINE/.test(row) && /WAITING FOR PLAYER/.test(row),
    "never a human who is not there");
  check("the wait survives being written to the card",
    /ownerOnline: r\.ownerOnline !== false,/.test(save), "on allResults");

  // THE YELLOW, AND THE MOTION RULE.
  check("the yellow blink is real CSS on the row",
    /@keyframes ace-qol-await-row/.test(css) && /\.ace-qol-save-await \{/.test(css), "row-level");
  check("and it stands still for anyone who asked the OS for that",
    /prefers-reduced-motion: reduce\) \{\s*\n\s*\.ace-qol-save-await \{ animation: none; \}/.test(css),
    "solid yellow edge");

  // ⚠️ THE PLAYER'S DIE MUST SURVIVE THE GM-ONLY PASS. That pass hides every
  // .ace-qol-save-pc-roll-btn from a non-GM screen, so the row's die is
  // deliberately NOT that class.
  const hideAt = save.indexOf("aceQolRemoveTarget");
  const hideList = save.slice(hideAt, hideAt + 400);
  check("the row's die is not the class every non-GM screen strips",
    /class="ace-qol-save-await-roll"/.test(save) && !/aceQolRollMySave/.test(hideList)
    && !/ace-qol-save-await-roll/.test(hideList),
    "the player's own die survives");
}

/* ══ 5. ONLY THEY ROLL ════════════════════════════════════════════════════ */
console.log("\nONLY THEY ROLL");
{
  check("the GM's roll-for-them die is gone while their client is up",
    /const _pcDiceBtn = \(t\) => \{\s*\n\s*if \(this\._pcOwnerActive\(t\)\) return "";/.test(save),
    "_pcOwnerActive");
  check("who may press the row's die is decided on each screen",
    /_wireAwaitRollButtons\(el, message, flags\)/.test(save)
    && /mine = game\.user\?\.isGM\s*\n\s*\? !ownerOnline/.test(save),
    "per client, not baked in");
  check("a player presses only their own character's",
    /: !!actor\?\.isOwner;/.test(save), "isOwner");
  check("pressing the row spends the whispered prompt, so nothing rolls twice",
    /f\?\.type === "pcSavePrompt" && f\.tokenDocId === tokenDocId/.test(save)
    && /const shape = own \?\? SaveEngine\._promptShapeFromCard/.test(save),
    "the same roll, not a second one");
  const wat = save.indexOf("_wireAwaitRollButtons(el, message, flags) {");
  check("no dialog is opened to roll for a player",
    !/new Dialog|DialogV2/.test(save.slice(wat, wat + 4200)), "a press, not a form");

  // ONE BUILDER FOR THE SHAPE THE ROLLER READS.
  check("both dice build that shape in one place",
    /static _promptShapeFromCard\(message, flags, tokenDocId\)/.test(save)
    && (save.match(/_promptShapeFromCard\(/g) ?? []).length >= 3, "one builder");
  check("and it still carries the item link Forge needs",
    /itemUuid: flags\.itemUuid \?\? null,/.test(save.slice(save.indexOf("static _promptShapeFromCard"))),
    "animation and sound");
  check("the GM die no longer keeps its own copy of it",
    !/Build a fake pcSavePrompt message and roll it/.test(save), "the second copy is gone");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
