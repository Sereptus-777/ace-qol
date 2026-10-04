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

console.log("\nTHE ROW AND THE LINE ARE ONE SUM");
{
  check("the phase-1 result row draws the formula",
    /\$\{opts\?\.formulaOnShell \? "" : SaveEngine\._formulaForRow\(r, opts\)\}/.test(save),
    "on every row the shell is not already speaking for");
  const at = save.indexOf("static _formulaForRow");
  const body = save.slice(at, save.indexOf("\n  }", at) + 4);

  /* ⚠️🔴 HIS RULE, 2026-10-02: "The bonus is what was added to that die, and the
     line names those parts. It does not read the sheet again... If the named
     parts do not add up to the bonus on the row, the line is not drawn."

     Escher rolled 13 for 13 while the line printed −2. The Gorgon and the Cloud
     Giant added +2 and got no line. Lamia added +3 under a line saying +1. Four
     rows, four numbers, because two readers answered the same question minutes
     apart: the roll used a profile number plus a measured cover, and the line
     went back to the sheet afterwards. */
  check("the line draws what the ROLL carried",
    /const parts = Array\.isArray\(r\.saveParts\) \? r\.saveParts : null;/.test(body),
    "r.saveParts");
  check("and never reads the sheet again",
    !/explainSave\(/.test(body), "no second reading");
  check("if the named parts do not add up to the row, no line is drawn",
    /if \(sum !== onRow\) \{/.test(body) && /return "";/.test(body),
    "worse than none");
  check("and the row's own bonus is the die taken off its total",
    /r\.saveTotal - die/.test(body));
  check("it is drawn as a pill, never loose on the card",
    /rolledPill\(parts\);/.test(body), "inside its pill");
  check("a row that never rolled gets no formula",
    /if \(!r \|\| r\.noRoll \|\| r\.pending\) return "";/.test(body), "nothing to explain");
  /* ⚠️ A CREATURE WITH NOTHING TO ADD GETS NO PILL. */
  check("a creature with nothing to add gets no line at all",
    /if \(!parts\.some\(p => Number\(p\.value\) !== 0\)\) return "";/
      .test(readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/roll-formula.mjs", "utf8")),
    "Virric gets no line");
  // The old bare modifier is gone from the asking card.
  check("the asking card no longer prints a bare ability modifier",
    /formulaText\(explainSave\(_actor, _ab\)\.parts, t\.saveModBase\)/.test(save),
    "it prints the parts");
}

console.log("\nCOVER IS DECIDED ONCE, WHEN THE BOLT IS MEASURED");
{
  /* ⚠️🔴 IT WAS DECIDED INSIDE EACH ROLL, AND ADDED TO A SHEET NUMBER THAT
     ALREADY HELD IT. dnd5e folds a creature's cover status into
     `abilities.dex.save.value`, so a creature wearing the status had cover twice
     and one standing behind the same rock without it had cover once. */
  check("the card measures it once for the whole area",
    /const coverByToken = new Map\(\);/.test(save)
    && /SaveEngine\._measureCover\(casterTokenDocForCover, td\)/.test(save),
    "when the bolt is measured");
  check("and every target row carries that one number",
    /coverBonus: coverByToken\.has\(/.test(save));
  check("the player's prompt carries it too, so a PC is the same sum as an NPC",
    /coverBonus: t\.coverBonus \?\? null,/.test(save));
  check("the sheet's own cover comes back out, so it is counted once",
    (save.match(/const sheetCover = coverInSheetSave\(targetActor, ability\);/g) ?? []).length >= 2,
    "both roll paths");
  check("and the roll is the sheet, less its cover, plus the measured one",
    (save.match(/const saveMod = profileMod - sheetCover \+ cover;/g) ?? []).length >= 2,
    "both roll paths");
  /* ⚠️ AND NOTHING DOWNSTREAM MEASURES AGAIN. */
  check("no roll path calls the cover engine for itself any more",
    !/CoverEngine\.calculateCover\(casterTokenDoc, tokenDoc\)/.test(save),
    "one measurer");
}

console.log("\nA PLAYER'S ROW IS AN NPC'S ROW");
{
  /* ⚠️🔴 HIS TABLE, 2026-10-02: "Jeth is a bare 15 and Virric is a bare 12. No
     die, no line. The NPC rows carried both. A player's result carries the same
     die and the same parts, and the row draws them."

     The hole was one line: the GM learns about a player's roll by destructuring
     that result's flags, and anything not named there never reaches the row. */
  check("the GM reads the parts out of a player's result",
    /saveParts, saveBonusUsed \} = resultFlags;/.test(save), "named or lost");
  check("and hands them to the row with the die",
    /saveParts: Array\.isArray\(saveParts\) \? saveParts : \[\],/.test(save));
  check("a player's result with no die at all is called out",
    /a player's save came back with a total of \$\{saveTotal\} and no `/.test(save));
  /* ⚠️ AND THE ROW KEEPS THEM THROUGH A REDRAW. */
  check("the card's own flags keep the parts",
    /saveParts: Array\.isArray\(r\.saveParts\) \? r\.saveParts : \[\],/.test(save),
    "serialized with the row");
  check("and keep which save it was, so a redrawn row can still read itself",
    /saveAbility: r\.saveAbility \?\? r\.ability \?\? null,/.test(save));
  /* ⚠️ A BARE NUMBER SAYS WHAT IT LOST. */
  check("a row that comes out bare names the field that went missing",
    /die \$\{r\.dieResult \?\? "missing"\}, \$\{\(r\.saveParts \?\? \[\]\)\.length\} named part/.test(save));
}

console.log("\nEVASION IS THE WORD BESIDE THE NUMBER");
{
  /* ⚠️🔴 HIS CARD, 2026-10-02: "A failed save with Evasion is half damage, and
     the row prints Evasion beside that number. Jeth failed and took 9 with no
     word. A pass with Evasion prints Evasion beside the 0."

     I hung it on the pass alone, which is half the feature: Evasion is what
     makes a failed save half instead of whole, so a 9 is as much its doing as a
     0 was. */
  const at = save.indexOf("static _evasionPill(r) {");
  check("there is one builder for the word", at > 0, "_evasionPill");
  const body = save.slice(at, save.indexOf("\n  }", at) + 4);

  check("it says the word and nothing else",
    />Evasion</.test(body) && !/PASS/.test(body), "not PASS (EVASION), not in brackets");
  check("it is the yellow pill form",
    /ace-qol-tag ace-qol-tag-condition/.test(body), "the condition tag's yellow");
  check("a FAILED save with Evasion gets it too",
    !/r\.passed/.test(body) && /if \(!r\.superSaver\) return "";/.test(body),
    "the 9 is Evasion's doing as much as the 0");
  check("a creature without Evasion gets nothing",
    /if \(!r\.superSaver\) return "";/.test(body), "a pass without it still prints the half");
  check("and a row that never rolled gets nothing",
    /if \(!r \|\| r\.noRoll \|\| r\.pending\) return "";/.test(body));

  /* ⚠️ BOTH ROWS, because there are two renderers of the same row and one of
     them having it is the same bug wearing a hat. */
  check("both result rows draw it",
    (save.match(/\$\{SaveEngine\._evasionPill\(r\)\}/g) ?? []).length === 2,
    `${(save.match(/\$\{SaveEngine\._evasionPill\(r\)\}/g) ?? []).length} rows`);
}

console.log("\nTHE DAMAGE LINE, AND THE BUTTONS BELOW IT");
{
  /* ⚠️ His rule, 2026-10-02: "The word is on the damage line, beside the number.
     The X, the quarter, the half, the one and the two stay on the line below
     it." They were all one line with a spacer pushing the number right. */
  check("the damage line holds the word, the number and the hit points",
    (save.match(/<div class="ace-qol-save-dmg-line">/g) ?? []).length === 2
    && /ace-qol-save-dmg-line">\n            \$\{SaveEngine\._evasionPill\(r\)\}\n            <span class="ace-qol-save-result-dmg"/.test(save),
    "one thought per line");
  check("and it sits above the buttons",
    /<\/div>\n          <div class="ace-qol-save-ovr-line">/.test(save));
  check("the buttons line no longer carries the damage or the hit points",
    !/ace-qol-save-ovr-spacer/.test(save), "the spacer went with them");

  /* ⚠️🔴 ONE ORDER FOR EVERY CREATURE ON THE CARD (his rule, 2026-10-03):
     portrait and name, the roll and PASS or FAIL, the damage with Evasion beside
     it, the buttons, then the hit points LAST. They used to ride on the damage
     line, so on one creature they sat beside the number and on the next they
     wrapped above the buttons, and which it was came down to how wide that row's
     own number happened to be. */
  check("the hit points are their own line, under the buttons",
    (save.match(/<div class="ace-qol-save-hp-line">/g) ?? []).length === 2
    && /<\/div>\s*<!--[\s\S]*?-->\s*<div class="ace-qol-save-hp-line">/.test(save),
    "HP: 50 → 50 goes last");
  check("and they are off the damage line",
    !/ace-qol-save-dmg-line">[\s\S]{0,400}?ace-qol-save-result-hp/.test(save),
    "never beside the damage");

  const css = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/styles/ace-qol.css", "utf8");
  check("the damage line wraps, with no fixed height",
    /\.ace-qol-save-dmg-line \{[^}]*flex-wrap: wrap;/s.test(css)
    && !/\.ace-qol-save-dmg-line \{[^}]*[^-]height: \d/s.test(css));
  check("the number keeps its size on that line",
    /\.ace-qol-save-dmg-line \.ace-qol-save-result-dmg/.test(css));

  const pill = css.slice(css.indexOf(".ace-qol-evasion-pill"), css.indexOf(".ace-qol-evasion-pill") + 300);
  /* ⚠️ "Do not squish the word or anything like that." */
  check("the word is not squished: no nowrap, no fixed height",
    /white-space: normal/.test(pill) && !/[^-]height: \d+px/.test(pill), "min-height only");
  check("and it is readable, not the tag's 0.6rem", /font-size: 14px/.test(pill));
  check("it prints as he wrote it, not shouted", /text-transform: none/.test(pill));
}

console.log("\nTHE GM ROLLS FOR AN ABSENT PLAYER, AND THE ROW GETS ALL OF IT");
{
  /* ⚠️🔴 HIS CARD, 2026-10-02: "Jeth is a bare 18. Virric is a bare 17. No die,
     no line. The four NPC rows have both. Both players were offline, so the GM
     rolled them, and that path still writes a total and nothing else."

     The offline roll goes out before the card is built and its result is handed
     straight to the row builder. That builder named the total and nothing else,
     so the die and the parts were thrown away between the roll and the row. */
  check("the roll hands its parts back to the caller",
    /saveParts: _parts,\n      saveBonusUsed: _partsTotal,\n    \};/.test(save),
    "_rollPcSave returns them");
  check("and the row built from a handed result keeps the die",
    /dieResult: existing\.dieResult \?\? null,/.test(save));
  check("and the parts",
    /saveParts: Array\.isArray\(existing\.saveParts\) \? existing\.saveParts : \[\],/.test(save));
  check("and which save it was, so a redraw can still read itself",
    /saveAbility: existing\.saveAbility \?\? tgt\.saveAbility \?\? null,/.test(save));
  /* ⚠️ AND THE MEASUREMENT REACHES THE ROLL. Virric was measured +2 and his row
     showed nothing, because the hand-made prompt listed every field but that. */
  check("the GM's stand-in prompt carries the measured cover",
    /coverBonus: tgt\.coverBonus \?\? null,\n      currentHP: tgt\.currentHP/.test(save),
    "Virric's +2");
}

console.log("\nA DICE SO NICE THROW IS A FINISHED ROLL");
{
  /* ⚠️ His rule, same message: "Do not hold the card." Two offline characters
     held the whole save card behind an animation of a result they were not there
     to watch. */
  check("the roll can be told not to wait for the animation",
    /async _rollPcSave\(message, \{ holdForDice = true \} = \{\} \)?/.test(save)
    || /async _rollPcSave\(message, \{ holdForDice = true \} = \{\}\) \{/.test(save),
    "holdForDice");
  check("and the GM rolling for an absent player does not",
    /_rollPcSave\(fakeMsg, \{ holdForDice: false \}\)/.test(save));
  check("while a player's own roll still waits, because they are watching it",
    /if \(holdForDice\) await awaitDsnRoll\(\);/.test(save));
}

console.log("\nONLY THE NUMBER AFTER THE EQUALS IS BRIGHT");
{
  const css = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/styles/ace-qol.css", "utf8");
  const rf = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/roll-formula.mjs", "utf8");
  /* ⚠️ His rule: "only the number after the equals is bright orange and a little
     bigger. The equals stays with the line." */
  check("the equals and the number are two elements",
    /class="ace-qol-formula-eq">=<\/span>/.test(rf)
    && /class="ace-qol-formula-sum">/.test(rf), "the sign is not the answer");
  /* ⚠️ THE BASE RULE, not the escape card's override of it. The escape card
     draws the same pill at twice the size and its selector contains this one's
     name, so a plain indexOf finds the override first. */
  const at = css.search(/^\.ace-qol-formula-sum \{/m);
  check("the number is bright orange and a little bigger",
    at > 0 && /#ff9d2e/.test(css.slice(at, at + 200)) && /font-size: 1\.12em/.test(css.slice(at, at + 200)));
  check("the words stay light yellow",
    /\.ace-qol-formula-rolled \.ace-qol-formula-text \{ color: #f0e4c0; \}/.test(css));
  check("and the pipe stays the darker gold",
    /#8b6914/.test(css.slice(css.indexOf(".ace-qol-formula-pipe"), css.indexOf(".ace-qol-formula-pipe") + 200)));
}

console.log("\nTHE PARTS TRAVEL WITH THE ROLL");
{
  check("an NPC's roll records them",
    /saveParts: _parts,/.test(save) && /saveBonusUsed: _partsTotal,/.test(save));
  check("a player's roll records them in its own result",
    (save.match(/saveParts: _parts,/g) ?? []).length >= 2, "both paths");
  check("and they are put on the row the GM's card draws",
    /r\.saveParts = Array\.isArray\(pcResult\.saveParts\)/.test(save));
  check("a redrawn card keeps them",
    /r\.saveParts  = Array\.isArray\(f\.saveParts\)/.test(save));
  check("and a roll whose parts do not match its own formula says so",
    /The row keeps the roll's number and the line under it is not drawn/.test(save));
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
