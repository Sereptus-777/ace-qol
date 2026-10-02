// ─── ONE SAVE CARD, AND ONE TARGET THAT STAYS ────────────────────────────────
//
// "Pins are not the table." Twice now a pin was green while his screen was not,
// because the pin read the function and the table walked a different path. So
// this one reads the PATHS: every place a save card can be born, and every place
// targeting is cleared.
//
// 1. ONE SAVE CARD. "The Save Required message is the only message. After the
//    roll it becomes the result on THAT same ChatMessage. Never create Save
//    Results." There were three ways a results card could be born:
//      _postLiveTargetCard      the one that asks  -> stays, it IS the card
//      _postSaveResultsPhase1   posted a SECOND    -> becomes the asking card
//      _postSaveResults         posted a THIRD     -> becomes the asking card
//    The second is the one his chat was filling with; the first fix only reached
//    the third, which is why the live run still showed two.
//
// 2. THE FORMULA on the card that survives: "Dex 1 (-5) + proficiency +3 = -2",
//    inside its pill, nothing invented.
//
// 3. ONE TARGET STAYS. Two or more still clear when the resolve is done; that
//    path is read here and deliberately not changed.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(62)} ${detail}`);
};

const read = (p) => readFileSync(`D:/FoundryVTT/Data/modules/ace-qol/${p}`, "utf8");
const save = read("scripts/save-engine.mjs");
const applicator = read("scripts/damage-applicator.mjs");
const main = read("scripts/ace-qol.mjs");

console.log("\nONE SAVE CARD, AND ONE TARGET THAT STAYS\n");

/* ══ 1. EVERY WAY A SAVE CARD CAN BE BORN ════════════════════════════════ */
console.log("THE CARD CENSUS");
{
  // Every CardDoor.post in the save engine, with the function it sits in.
  const lines = save.split("\n");
  const posts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/CardDoor\.post\(/.test(lines[i])) continue;
    let fn = "(top level)";
    for (let j = i; j >= 0; j--) {
      const m = /^  (?:static )?(?:async )?([_a-zA-Z0-9]+)\s*\(/.exec(lines[j]);
      if (m) { fn = m[1]; break; }
    }
    posts.push(fn);
  }
  check("the save engine still posts from a known, small set of places",
    posts.length <= 8, `${posts.length}: ${[...new Set(posts)].join(", ")}`);

  // The two results builders must be able to BECOME the asking card.
  // Read the WHOLE function, not a fixed window: _postSaveResults is long and the
  // branch that matters is its last statement, so a 12k slice stopped short of it
  // and this pin failed on code that was already right.
  const bodyOf = (fn) => {
    const at = save.indexOf(`async ${fn}(`);
    if (at < 0) return "";
    const next = save.slice(at + 10).search(/\n  (?:static )?(?:async )?[_a-zA-Z0-9]+\s*\(/);
    return next < 0 ? save.slice(at) : save.slice(at, at + 10 + next);
  };
  for (const fn of ["_postSaveResultsPhase1", "_postSaveResults"]) {
    const body = bodyOf(fn);
    check(`${fn} was found in one piece`, body.length > 500, `${body.length} chars`);
    check(`${fn} takes the card it should become`,
      /updateMessage = null/.test(body), "updateMessage");
    // ⚠️ AND IT ASKS WHETHER THE CARD CAN BE REDRAWN, not merely whether one was
    // handed over. A deleted card is truthy and has no update, and the result then
    // landed nowhere and said nothing.
    check(`${fn} updates in place when the card can be redrawn`,
      /if \(typeof updateMessage\?\.update === "function"\) \{[\s\S]{0,900}CardDoor\.update\(updateMessage/.test(body),
      "CardDoor.update, not a second post");
    check(`${fn} posts instead of losing the result when it cannot`,
      /\} else \{[\s\S]{0,200}CardDoor\.post\(_(phase1Card|cardData)\)/.test(body),
      "nothing dead-ends");
  }

  // And their callers hand it over.
  check("the target-list card is handed to the phase that answers it",
    /_postSaveResultsPhase1\(item, casterActor, allResults, \{[\s\S]{0,400}updateMessage: message/.test(save),
    "the asking card becomes the result");
  // THE CARD THAT BECOMES THE RESULT IS STILL THE CAST. Everything that
  // reconciles a player's own result looks it up by castId, and the target list
  // answered that with its own id. Once it stops calling itself a target list
  // that shortcut dies, so the id has to be written in.
  check("both keep the cast id on the card they become",
    (save.match(/castId: updateMessage\.id/g) ?? []).length === 2,
    `${(save.match(/castId: updateMessage\.id/g) ?? []).length} of 2`);
  check("and the legacy path is handed its card too",
    /_postSaveResults\(item, casterActor, results, \{[\s\S]{0,300}updateMessage: message/.test(save),
    "no third card either");
}

/* ══ 2. THE FORMULA ON THE CARD THAT SURVIVES ════════════════════════════ */
/* == THE POST-HIT SAVE: ITS OWN CARD, AND ONLY ONE ===================== */
// His table, 2026-09-29: the Spiked Chain's after-hit save is posted by
// post-hit-saves.mjs, not by the save engine. Its console line said it plainly -
// "rolls on a table, which its recipe cannot carry yet, so it keeps its own card"
// - and that is true and stays true. What was wrong is that it kept its own card
// AND posted a second one beside it when the roll came in.
console.log("\nTHE POST-HIT SAVE KEEPS ONE CARD");
{
  const ph = read("scripts/post-hit-saves.mjs");

  // Every card this file can post, with the function it sits in.
  const lines = ph.split("\n");
  const posts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/CardDoor\.post\(|ChatMessage\.create\(/.test(lines[i])) continue;
    let fn = "(top level)";
    for (let j = i; j >= 0; j--) {
      const m = /^  (?:static )?(?:async )?([_a-zA-Z0-9]+)\s*\(/.exec(lines[j]);
      if (m) { fn = m[1]; break; }
    }
    posts.push(fn);
  }
  check("every card this file can post is accounted for",
    posts.length <= 8, `${posts.length}: ${[...new Set(posts)].join(", ")}`);

  // EXACTLY ONE SAVE MESSAGE PER CAST: the one that asks becomes the one that
  // answers. Nothing else in this file may post a save card.
  const saveCardTypes = [...ph.matchAll(/type: "(postHitSave[A-Za-z]*)"/g)].map(m => m[1]);
  check("there are two save shapes: the question and the answer",
    new Set(saveCardTypes).size === 2
    && saveCardTypes.includes("postHitSave") && saveCardTypes.includes("postHitSaveResult"),
    [...new Set(saveCardTypes)].join(", "));
  check("the answer is built but no longer posted on its own",
    /const _resultCard = \{/.test(ph)
    && !/await CardDoor\.post\(\{\s*\n\s*content: cardHtml,\s*\n\s*speaker[\s\S]{0,200}postHitSaveResult/.test(ph),
    "it becomes the asking card");
  check("it updates that card in place when the card can be redrawn",
    /if \(typeof updateMessage\?\.update === "function"\) \{[\s\S]{0,900}CardDoor\.update\(updateMessage/.test(ph),
    "CardDoor.update");
  check("and the roll handler hands its own card over",
    /postSaveResults\(item, casterActor, results, save, message\)/.test(ph),
    "the card that asked answers");
  check("the card keeps its id as the cast, so its buttons still find it",
    /castId: updateMessage\.id/.test(ph), "flags merged, id kept");
  check("with no card to become it still posts, so nothing dead-ends",
    /\} else \{[\s\S]{0,120}CardDoor\.post\(_resultCard/.test(ph), "the fallback stands");

  // REUSE, NOT A SECOND LAYOUT. The row is the QOL one.
  check("it draws the shared QOL save row",
    /_SE\.saveResultRowHtml\(forRow,/.test(ph), "SaveEngine.saveResultRowHtml");
  check("and keeps no private result-row markup of its own",
    !/ace-qol-save-result-row/.test(ph) && !/ace-qol-save-roll \$\{passClass\}/.test(ph),
    "no portrait, name, roll or verdict markup left in this file");
  check("the die face and the ability are handed over in the shape that row wants",
    /dieResult: r\.dieResult \?\? r\.saveRoll/.test(ph)
    && /saveAbility: r\.saveAbility \?\? save\?\.ability/.test(ph),
    "the roll and the save travel with the row");
  check("what belongs to THIS card rides under the row as extraHtml",
    /extraHtml: effectsHtml/.test(ph) && /static _rowExtraHtml\(r\)/.test(ph),
    "the table line and the HP readout");
  // ⚠️ THE FORMULA MOVED UP, IT DID NOT GO AWAY (his shell, 2026-09-29:
  // "Formula is already on line 2 so they know the math before they click"). With
  // one creature rolling it is the shell's quiet line; with several, each row keeps
  // its own, because one line cannot be true for four sheets. So the row still
  // draws it and now knows when the shell already has.
  check("the shared row is still the one that draws the formula",
    /\$\{opts\?\.formulaOnShell \? "" : SaveEngine\._formulaForRow\(r, opts\)\}/.test(save)
    && /\$\{r\.extraHtml \?\? ""\}/.test(save),
    "one row, one formula, one extra hook");
  // ⚠️ AND THE TOTAL IT PRINTS IS THE BONUS THE ROLL ADDED (his card, 2026-09-30:
  // "Print the bonus that was actually added"). The parts still come off the sheet
  // through the one reader; only the total is read off the roll.
  check("and the shell's quiet line is the same reader, not a second one",
    /static saveQuietLineHtml\(/.test(save)
    && /formulaText\(explainSave\(actor, ab\)\.parts, _used\)/.test(save),
    "roll-formula.mjs, both places");
  // The phase-1 card is the one whose handler the remove X belongs to, so it is
  // the one card that asks for it. Everything else about the row is shared.
  // The X is offered only where damage is still to be rolled, and the shell tells
  // the row whether the quiet line already carries the formula.
  check("the QOL card still uses that same row, so neither can drift",
    /saveResultRowHtml\(r, \{ \.\.\.opts,[\s\S]{0,80}canRemove: hasDamage === true,/.test(save),
    "both cards, one renderer");

  // AND THE THINGS HE TOLD ME NOT TO TOUCH.
  check("the table reading is unchanged",
    /rolls on a table, which its recipe/.test(ph), "it still keeps its own card");
  check("and the stamp is unchanged",
    /holds: landed\.filter\(l => l\.id\)/.test(ph), "grappled + restrained by id");
}

console.log("\nTHE FORMULA IS ON THE ROW THAT IS LEFT");
{
  check("the phase-1 result row draws the formula",
    /\$\{opts\?\.formulaOnShell \? "" : SaveEngine\._formulaForRow\(r, opts\)\}/.test(save),
    "on every row the shell is not already speaking for");
  const at = save.indexOf("static _formulaForRow");
  const body = save.slice(at, at + 1400);
  /* ⚠️ REWRITTEN TO HIS NEW RULE, 2026-10-01: "Print the die, then every bonus
     and where it came from." The row no longer reads the sheet and the die
     itself — one reader does both for the row, the rebuilt row and this line,
     because three readers is how a player's row showed a bare total with no
     picture while the line under it printed a different sum. */
  check("it reads the creature's sheet and its die through the one reader",
    /SaveEngine\._rollReadingFor\(r, opts\)/.test(body), "_rollReadingFor");
  check("it shows the total the ROLL made, so the math is not redone",
    /total: typeof r\.saveTotal === "number" \? r\.saveTotal : used/.test(body),
    "the row's own number");
  check("and the die is on the line, his rule",
    /die, rolled: true/.test(body), "d20 14 +5 Dex 20 +4 prof = 23");
  check("and it is drawn as a pill, never loose on the card",
    /formulaPill\(parts/.test(body), "inside its pill");
  check("a row that never rolled gets no formula",
    /if \(!r \|\| r\.noRoll \|\| r\.pending\) return "";/.test(body), "nothing to explain");
  // The old bare modifier is gone from the asking card.
  check("the asking card no longer prints a bare ability modifier",
    /formulaText\(explainSave\(_actor, _ab\)\.parts, t\.saveModBase\)/.test(save),
    "it prints the parts");
}

/* ══ 3. ONE TARGET STAYS, TWO OR MORE STILL CLEAR ════════════════════════ */
console.log("\nONE TARGET STAYS");
{
  // After a template resolves.
  const at = main.indexOf("target(s) released after spell template");
  const block = main.slice(Math.max(0, at - 900), at + 200);
  check("a single target is left alone when a template resolves",
    /held\.length === 1/.test(block), "one stays");
  check("and two or more are still released, unchanged",
    /else if \(held\.length\) \{[\s\S]{0,260}setTarget\?\.\(false/.test(block),
    "the multi-target path is as it was");

  // After APPLY ALL.
  const at2 = applicator.indexOf("one target (");
  const block2 = applicator.slice(Math.max(0, at2 - 400), at2 + 700);
  check("a single target survives APPLY ALL",
    /held\.length === 1/.test(block2) && /return;/.test(block2), "one stays");
  check("and APPLY ALL still clears two or more",
    /for \(const t of held\)[\s\S]{0,200}setTarget\?\.\(false/.test(block2)
    && /targets\?\.clear\?\.\(\)/.test(block2), "unchanged for a group");

  // NOTHING IS RESTORED ANYWHERE. His rule: current target only.
  check("no path remembers and puts back an old target",
    !/restoreTargets|previousTargets|savedTargets|_oldTargets/.test(main + applicator + save),
    "current target only");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
