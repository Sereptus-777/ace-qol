// ─── THE SAVE-CARD SHELL HE APPROVED ─────────────────────────────────────────
//
// His card, 2026-09-29, top to bottom:
//
//   1. caster portrait + "Lamia casts Charm Person on Jeth"
//   2. one quiet line: Wis 16 (+3) = +3 · DC 13 Wisdom
//   3. target portrait (not cropped) + name + the ACE d20 PNG for the number that
//      was rolled + "9 + 3 = 12" + FAIL
//   4. one line of what landed: "Charmed — 1 hour"
//
// And what must NOT be on it: "No SAVE pill. No X. No APPLY. No skull. No
// 'Charm_person' death row." Before the roll it is the same shell with no total
// and the d20 as the click target, blinking yellow. On the player's own screen
// line 4 reads "You are Charmed for 1 hour."
//
// The two bugs underneath it, both his words:
//   "Grep why APPLY ran and why charm_person plus dnd5echarmed0000 both landed.
//    One write. The collision in the log is the second write."
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(62)} ${detail}`);
};
const read = (p) => readFileSync(`D:/FoundryVTT/Data/modules/ace-qol/${p}`, "utf8");

const save  = read("scripts/save-engine.mjs");
const ph    = read("scripts/post-hit-saves.mjs");
const doors = read("scripts/road/doors.mjs");
const css   = read("styles/ace-qol.css");
const utils = read("scripts/chat-render-utils.mjs");
const dur   = read("scripts/duration-words.mjs");

console.log("\nTHE SAVE-CARD SHELL\n");

/* ══ 1. ONE WRITE ═════════════════════════════════════════════════════════ */
console.log("ONE WRITE, NOT TWO");
{
  // The spell's own effect IS the condition when it carries that status and adds
  // no rules. It went on beside the condition, so Jeth wore charmed twice.
  const at = doors.indexOf("const srcStatuses =");
  const block = doors.slice(at, at + 900);
  check("the door asks what the effect ADDS, not what it is called",
    /const srcRules = Array\.isArray\(src\.changes\) \? src\.changes\.length : 0;/.test(block),
    "changes, not the name");
  check("no rules and a status the creature already has is not written again",
    /if \(!srcRules && srcStatuses\.length && srcStatuses\.every\(s => actor\?\.statuses\?\.has\?\.\(s\)\)\)/.test(block),
    "one write");
  check("and it says so, rather than doing nothing quietly",
    /ONE WRITE: it is not put on twice/.test(block), "in the console");
  check("an effect with real rules still goes on",
    /!srcRules &&/.test(block), "Hypnotic Pattern's Speed 0, Enervated");
  check("the duplicate is not listed beside the condition it already is",
    /if \(res\.duplicate\) \{/.test(save) && /res\.ok && !res\.duplicate/.test(save),
    "no \"Charm_person\" row");
  check("and it is not reported as a failure either",
    /return \{ ok: true, name, duplicate: true, of: srcStatuses \};/.test(doors),
    "ok, and a duplicate");
}

/* ══ 2. WHY APPLY RAN ═════════════════════════════════════════════════════ */
console.log("\nWHY APPLY RAN");
{
  // ⚠️ AND IT READS THE FACT RATHER THAN BEING HANDED IT. 0.55 asked the caller,
  // and of the five places that land a failed save only one was told — so his live
  // Charm Person still said "waits for APPLY".
  check("a save that moves no hit points lands what it leaves",
    /const _nothingToSequence = _dealsDamage === false[\s\S]{0,60}!saveCtx\?\.presence\?\.sourceTokenId;/.test(save),
    "no APPLY on Charm");
  check("and the hold is skipped for exactly that case",
    /if \(_holdPCs && !_nothingToSequence && r\.isPC && !saveCtx\?\.dryRun\) \{/.test(save),
    "one condition added, nothing else changed");
  check("a frightening presence still holds (2026-09-20)",
    /!saveCtx\?\.presence\?\.sourceTokenId/.test(save), "named explicitly");
  check("the Wing's Prone still holds, because the Wing deals damage (2026-09-21)",
    /dealsDamage: hasDamage,/.test(save), "the live path hands the fact over");
  check("and the skip says so in the console",
    /so what it leaves lands now instead of waiting on APPLY/.test(save), "never silent");
}

/* ══ 3. THE SHELL ═════════════════════════════════════════════════════════ */
console.log("\nTOP TO BOTTOM");
{
  // 1. The caster's own face.
  check("line 1 is the caster's portrait and one sentence",
    /static castLineHtml\(casterActor, title, targetNames/.test(save)
    && /ace-qol-save-caster-img ace-qol-save-portrait/.test(save), "not the spell's icon");
  check("a feature is used and a spell is cast",
    /\$\{isSpell \? "casts" : "uses"\}/.test(save), "a claw is not cast");

  // 2. The quiet line.
  check("line 2 is one quiet line, from one reader",
    /static saveQuietLineHtml\(results, \{ saveAbility, saveDC, abilityLabel = null \} = \{\}\)/.test(save),
    "shared with the post-hit card");
  // ⚠️🔴 THE PARTS COME OFF THE SHEET, THE TOTAL COMES OFF THE ROLL (his card,
  // 2026-09-30: "Print the bonus that was actually added. If the sheet and the
  // roll disagree, console only."). The live card said "= +0" for a roll that had
  // added +3.
  check("it carries the bonus the roll actually added",
    /if \(rollers\.length === 1\)/.test(save)
    && /formulaText\(explainSave\(actor, ab\)\.parts, _used\)/.test(save)
    && /\? r\.saveTotal - _die : null;/.test(save),
    "Wis 16 (+3) = +3");
  check("and before the roll the sheet's own sum stands",
    /const _used = \(typeof r\.saveTotal === "number" && _die != null\)/.test(save),
    "nothing to read yet");
  check("with several rollers each row keeps its own instead",
    /formulaOnShell: _rollers\.length === 1/.test(save), "one line cannot be true for four sheets");
  check("and the row does not repeat what the shell already says",
    /\$\{opts\?\.formulaOnShell \? "" : SaveEngine\._formulaForRow\(r, opts\)\}/.test(save), "once");

  // 3. The result line.
  // ⚠️ ALL FOUR PROPERTIES, not just the fit: the base class is a 32px circle with
  // `cover`, so overriding object-fit alone still left a cropped thumbnail
  // (ACE-ONE-ROAD.md § 13.4, his card: "not a 32px circle").
  check("line 3's portrait is shown whole, not a 32px circle",
    /ace-qol-save-tgt-img ace-qol-save-portrait/.test(save)
    && /\.ace-qol-save-portrait \{[\s\S]{0,260}object-fit: contain !important;/.test(css)
    && /width: 52px !important;/.test(css) && /border-radius: 8px !important;/.test(css),
    "52px, square corners, contain");
  // A real minus sign, not a hyphen: "9 − 2 = 7" lines up with the figures
  // beside it where a hyphen sits too high and too short.
  check("the math reads the way he wrote it",
    /modifier >= 0 \? "\+" : "−"/.test(save) && /ace-qol-save-math-die/.test(save),
    "9 + 3 = 12");
  check("and a bonus of nothing says nothing",
    /modifier === 0 \? "" :/.test(save), "never \"+ 0\"");

  // 4. What landed.
  check("line 4 is one line of what landed",
    /static _landedLineHtml\(r, opts = \{\}\)/.test(save), "Charmed \u2014 1 hour");
  // Three places a duration can come from, in the order that makes it true: what
  // the cast set, then the spell's own sheet, then the condition's definition.
  check("with how long it lasts, read from what actually landed",
    /const secs = durationSecondsOf\(applyOpts\?\.duration\)[\s\S]{0,220}conditionDurationSeconds\(cond\.condition\)/.test(save)
    && /durations: durationForThisTarget/.test(save), "seconds beside the condition");
  check("and it names the condition, never the registry key",
    /const name = conditionDisplayName\(c\)|conditionDisplayName\(c\)/.test(save)
    && /export function conditionDisplayName\(key\)/.test(read("scripts/condition-library.mjs")),
    "Charmed, not Charm_person");
  check("the footer no longer names every creature a second time",
    /\(a\?\.onSuccess && a\?\.conditions\?\.length\)/.test(save)
    && !/row\("fa-skull-crossbones", "#ff5555", a\.targetName/.test(save),
    "no skull, no second list");
  check("and the duration comes out in English",
    /export function durationWords\(seconds\)/.test(dur) && /n\(h, "hour"\)/.test(dur), "1 hour");
  check("90 minutes is not rounded into 2 hours",
    /Number\.isInteger\(m\) \? n\(m, "minute"\) :/.test(dur), "nothing is rounded into a lie");
  check("the owner's own screen reads it in the second person",
    /data-mine="You are \$\{esc\(mine\)\}\."/.test(save)
    && /line\.textContent = mine;/.test(save), "You are Charmed for 1 hour.");
  check("and the GM keeps the table's wording",
    /if \(game\.user\?\.isGM\) \{ line\.dataset\.wired = "1"; continue; \}/.test(save),
    "he is watching all of them");
}

/* ══ 4. WHAT IS NOT ON IT ═════════════════════════════════════════════════ */
console.log("\nNO PILL, NO X, NO SKULL");
{
  const at = save.indexOf('ace-qol-save-results-card ace-qol-save-shell" data-phase="1"');
  const card = save.slice(at, at + 700);
  check("the old header, its item icon and its \u2014 Saves title are gone",
    at > 0 && !/ace-qol-save-header/.test(card) && !/ace-qol-save-item-img/.test(card),
    "the shell replaced the strip");
  // ⚠️🔴 THE DC MOVED ONTO THE HEADER AND STOPPED BEING GM-ONLY (§ 13.2, replacing
  // what 0.58 shipped). "Header: 'Jeth uses Spiked Chain on Escher · DC 14
  // Dexterity'", and "Do not hide Lamia's DC 13 on Jeth's Charm card. He is
  // rolling against it."
  check("the DC is on the header, named for the creatures rolling against it",
    /dcSpan\(` · \$\{dcText\}`, rollers, "ace-qol-save-cast-dc"\)/.test(save)
    && /rollers: SaveEngine\.rollersOn\(results\)/.test(save),
    "shown to them and to the GM");
  check("and the old quiet-line DC is gone, so it lives in one place",
    !/ace-qol-save-quiet-dc/.test(save), "not two");
  // The per-handler stamp is gone: it only covered the cards that ONE handler
  // reached, which is how the others kept leaking. One pass, every ACE card, every
  // module (chat-render-utils.mjs, pinned in dc-visibility-selftest.mjs).
  check("and every other DC pill in the suite is the GM's too",
    /\.ace-qol-save-dc \{ display: none !important; \}/.test(css)
    && /\.ace-qol-save-dc\[data-ace-dc="show"\]/.test(css)
    && /registerDCVisibility\(\);/.test(read("scripts/ace-qol.mjs")), "one pass, every card");
  check("the X is offered only where damage is still to be rolled",
    /canRemove: hasDamage === true,/.test(save), "nothing to drop it from");
}

/* ══ 5. FOUNDRY'S SPEAKER STRIP ═══════════════════════════════════════════ */
console.log("\nTHE MANILA STRIP, AND THE \u22ee THAT STAYS");
{
  // \u26a0\ufe0f\ud83d\udd34 EVERY ACE CARD, NOT ONLY SAVES (\u00a7 13.1). It was stamped from the save
  // card's own content, so the attack, damage, heal and refusal cards all kept the
  // manila bar. It comes off the MESSAGE's flags now, in the one chrome pass, for
  // all four modules.
  check("every ACE card is stamped, from the message's own flags",
    /export function stampAceCard\(message, el\)/.test(utils)
    && /el\.setAttribute\("data-ace-card", "1"\)/.test(utils)
    && /ACE_NAMESPACES/.test(utils), "save, attack, damage, heal, reaction, refusal");
  check("and the save engine no longer stamps it from one card's content",
    !/setAttribute\("data-ace-save-shell"/.test(save), "one pass, not one handler");
  check("the stylesheet hides the sender and the time",
    /\.chat-message\[data-ace-card="1"\] > \.message-header \.message-sender/.test(css)
    && /display: none !important;/.test(css), "the strip");
  check("in all three stylesheets, so a module is right without QOL",
    /data-ace-card="1"/.test(read("../ace-artificer/styles/ace-artificer.css"))
    && /data-ace-card="1"/.test(read("../ace-engine/styles/ace-engine.css")),
    "Forge and Engine carry it too");
  check("and it never hides the whole header, so the \u22ee survives",
    !/\.chat-message\[data-ace-card="1"\] > \.message-header \{[\s\S]{0,20}display: none/.test(css)
    && /\.message-metadata \{[\s\S]{0,30}position: absolute;/.test(css), "tucked into the corner");
  check("the card is the positioning context for it",
    /\.chat-message\[data-ace-card="1"\] \{ position: relative; \}/.test(css), "top right");
}

/* ══ 6. BEFORE THE ROLL, AND THE CHAIN ════════════════════════════════════ */
console.log("\nBEFORE THE ROLL, AND THE CHAIN");
{
  check("before the roll it is the same shell with the die as the click target",
    /ace-qol-save-result-pending ace-qol-save-await/.test(save)
    && /data-action="aceQolRollMySave"/.test(save), "no total yet");
  check("and it blinks yellow until the roll is in",
    /@keyframes ace-qol-await-row/.test(css), "on the row");

  check("the chain draws the same shell, not its own header",
    /_SE\.castLineHtml\(actor, item\?\.name/.test(ph)
    && /_SE\.saveQuietLineHtml\(results,/.test(ph)
    && !/ace-qol-save-header/.test(ph), "one card, two abilities");
  check("its extra line is text: the table roll, then what landed",
    /Rolled <strong>/.test(ph) && /ace-qol-save-landed">\$\{landed\.map/.test(ph),
    "Rolled 3: Grapple / Grappled. Restrained.");
  check("no tag, no icon, no pill per condition",
    !/ace-qol-tag-debuff"><i class="fas fa-circle-xmark/.test(ph), "the sentence");
  check("and a condition an immunity refused still gets its own line",
    /ace-qol-save-refused">/.test(ph), "say what did NOT go on");
  check("still one ChatMessage, still no second Save Results post",
    /if \(typeof updateMessage\?\.update === "function"\) \{/.test(ph)
    && /castId: updateMessage\.id, resolved: true/.test(ph), "it becomes the card that asked");
}

/* == EVERY SAVE CARD, NOT JUST THE ONE I CONVERTED ===================== */
// His correction, 2026-09-29: "0.55 built a shell the live Charm path does not
// render ... If the new template is unused, delete it or wire it. Do not leave
// both." Five functions in this engine can draw a save card. I converted one and
// then checked the one I converted, which is the same mistake as reading a pin
// instead of the table: the live Charm path drew a different one.
console.log("\nNO CARD IS LEFT BEHIND");
{
  check("not one manila header is left in the engine",
    !/ace-qol-save-header/.test(save), "0 left");
  check("nor in the post-hit card",
    !/ace-qol-save-header/.test(ph), "0 left");
  const shells = (save.match(/data-ace-save-shell="1"/g) ?? []).length;
  check("every card the engine draws is stamped as the shell", shells >= 4,
    `${shells} cards`);
  check("and the post-hit asking and result cards too",
    (ph.match(/data-ace-save-shell="1"/g) ?? []).length === 2, "ask and answer");
  check("the quiet line is the one header they all draw",
    (save.match(/saveQuietLineHtml\(/g) ?? []).length >= 5, "one reader, five cards");

  // THE PLAYER'S WHISPERED PROMPT LEAKED THE DC IN GOLD.
  // ⚠️🔴 AND THE DC IS BACK ON IT (§ 13.2). 0.56 took it off on the old reading of
  // the rule; this card IS the roll that player is making, whispered to them.
  check("the whispered prompt shows the DC to the person rolling it",
    /Roll a \$\{dcSpan\(`DC \$\{saveDC\} `, tgt\?\.actorId\)\}\$\{abilityLabel\} save/.test(save),
    "their roll, their number");
}

/* == THE HOLD IS READ, NOT PASSED IN ================================== */
console.log("\nTHE HOLD ASKS THE RECIPE");
{
  check("the lander reads whether the power deals damage",
    /const _dealsDamage = saveCtx\?\.dealsDamage \?\? SaveEngine\._recipeDealsDamage\(recipe\);/.test(save),
    "no caller can forget it");
  check("and reads it off the recipe's own outcomes",
    /o\?\.kind === "damage" && String\(o\?\.formula \?\? ""\)\.trim\(\)/.test(save),
    "kind: damage, with a formula");
  check("an unreadable recipe holds, because that is the recoverable answer",
    /if \(!recipe\) return true;/.test(save), "hold, not land");
  check("the cast card's X is gone where nothing is sequenced too",
    /const _castRemoveBtn = \(t, title\) => _castDealsDamage/.test(save), "both cards");
}

/* == ONE WRITE PER STATUS, PER SOURCE ================================= */
console.log("\nONE WRITE PER STATUS");
{
  const cl = read("scripts/condition-library.mjs");
  check("a second write of the same statuses from the same source is refused",
    /const _wantStatuses = \[\.\.\.\(ALL_EFFECTS\[key\]\?\.statuses \?\? \[key\]\)\]/.test(cl)
    && /return \{ ok: true, applied: _twin\.name, duplicate: true \};/.test(cl),
    "charm_person and charmed are one status");
  check("it is refused BEFORE toggleStatusEffect can make dnd5e's own copy",
    cl.indexOf("_wantStatuses") < cl.indexOf("actor.toggleStatusEffect(key, { active: true })"),
    "no second dnd5echarmed0000");
  check("two different powers can still both charm a creature",
    /return from === _src;/.test(cl), "same source only");
  check("and what put it on is stamped where the guard can read it",
    /source: options\.source \?\? null,/.test(cl)
    && /const applyOpts = \{ source: item\.name \};/.test(save),
    "not a layer nothing calls");
}

/* == WHICH FUNCTION DREW THE CARD ===================================== */
console.log("\nTHE CARD SAYS WHO DREW IT");
{
  check("one line names the renderer, the message and whether it is the shell",
    /static _sayCard\(who, message, note = ""\)/.test(save)
    && /NOT the shell/.test(save), "no more guessing between five");
  check("every write point says it",
    (save.match(/SaveEngine\._sayCard\(/g) ?? []).length >= 5, "five callers");
  check("and the row patcher no longer cries wolf",
    /has no cast-card row to patch/.test(save)
    && /already become its own result and is redrawn whole/.test(save),
    '"not found" is not "nothing to find"');
}

/* == THE ROW IS TWO ROWS, NOT THREE ==================================== */
// His card, 2026-09-30: "Body is two rows, not three. 1. Jeth's portrait (whole,
// not a 32px circle) flush top, same row as the name 'Jeth'. 2. Under that: the
// d20 PNG for the number rolled, then '2 + 3 = 5' as one line, then FAIL."
//
// ⚠️🔴 THE PORTRAIT WAS HANGING IN THE MIDDLE. It sat in a left column of its own
// spanning the whole row, and the row was centred, so with a name line, a numbers
// line and a landed line beside it the picture floated to the vertical middle with
// the name ABOVE it.
console.log("\nTWO ROWS, NOT THREE");
{
  check("the portrait and the name are on one row",
    /<div class="ace-qol-save-row-who">[\s\S]{0,180}\$\{portrait\}[\s\S]{0,140}ace-qol-save-tgt-name/.test(save),
    "no left column of its own");
  check("the die, the sum and the verdict are on the row under it",
    /<div class="ace-qol-save-row-result">[\s\S]{0,180}\$\{d20El\}[\s\S]{0,80}\$\{mathLine\}/.test(save),
    "in that order");
  check("the row stacks, so a picture cannot centre itself against three lines",
    /\.ace-qol-save-row \{[\s\S]{0,140}flex-direction: column;/.test(css),
    "flex-direction: column");
  check("the portrait's top is flush with the name row",
    /\.ace-qol-save-row-who \{[\s\S]{0,180}align-items: center;/.test(css), "not floating");
  check("the sum is ONE piece of text, so it cannot split",
    /ace-qol-save-math">`[\s\S]{0,60}ace-qol-save-math-die/.test(save),
    "not four flex children with gaps");
  check("and its CSS says so",
    /\.ace-qol-save-row-result \.ace-qol-save-math \{[\s\S]{0,80}display: inline;/.test(css),
    "inline text, no flex");
  check("what landed is still the last line",
    /ace-qol-save-row-result[\s\S]{0,500}_landedLineHtml\(r, opts\)/.test(save),
    "Charmed — 1 hour");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
