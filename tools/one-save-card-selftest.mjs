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
    check(`${fn} updates in place when it has one`,
      /if \(updateMessage\) \{[\s\S]{0,900}CardDoor\.update\(updateMessage/.test(body),
      "CardDoor.update, not a second post");
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
console.log("\nTHE FORMULA IS ON THE ROW THAT IS LEFT");
{
  check("the phase-1 result row draws the formula",
    /\$\{SaveEngine\._formulaForRow\(r, opts\)\}/.test(save), "on every result row");
  const at = save.indexOf("static _formulaForRow");
  const body = save.slice(at, at + 1400);
  check("it reads the creature's own sheet through the one reader",
    /explainSave\(actor, ab\)/.test(body), "roll-formula.mjs");
  check("it shows the bonus the ROLL used, so the math is not redone",
    /r\.saveTotal - d20/.test(body), "total minus the die");
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
