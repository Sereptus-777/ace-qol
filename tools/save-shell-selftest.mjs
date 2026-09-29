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
  check("it carries the roller's own bonus when one creature rolls",
    /if \(rollers\.length === 1\)/.test(save) && /formulaText\(explainSave\(actor, ab\)\.parts\)/.test(save),
    "Wis 16 (+3) = +3");
  check("with several rollers each row keeps its own instead",
    /formulaOnShell: _rollers\.length === 1/.test(save), "one line cannot be true for four sheets");
  check("and the row does not repeat what the shell already says",
    /\$\{opts\?\.formulaOnShell \? "" : SaveEngine\._formulaForRow\(r, opts\)\}/.test(save), "once");

  // 3. The result line.
  check("line 3's portrait is shown whole, not cropped",
    /ace-qol-save-tgt-img ace-qol-save-portrait/.test(save)
    && /\.ace-qol-save-portrait \{\s*\n\s*object-fit: contain;/.test(css), "object-fit: contain");
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
  check("with how long it lasts, read from what actually landed",
    /const secs = durationSecondsOf\(applyOpts\?\.duration\) \|\| Number\(durationSeconds\) \|\| 0;/.test(save)
    && /durations: durationForThisTarget/.test(save), "seconds beside the condition");
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
  check("no DC pill on the shell; the DC is the quiet line's GM half",
    !/ace-qol-save-dc/.test(card) && /ace-qol-save-quiet-dc ace-qol-gm-only/.test(save),
    "a player never sees a DC");
  check("and every other DC pill in the suite is the GM's too",
    /for \(const dcEl of el\.querySelectorAll\("\.ace-qol-save-dc"\)\)/.test(save)
    && /\.ace-qol-save-dc \{ display: none !important; \}/.test(css), "stamped at render");
  check("the X is offered only where damage is still to be rolled",
    /canRemove: hasDamage === true,/.test(save), "nothing to drop it from");
}

/* ══ 5. FOUNDRY'S SPEAKER STRIP ═══════════════════════════════════════════ */
console.log("\nTHE MANILA STRIP, AND THE \u22ee THAT STAYS");
{
  check("the message is stamped, so only ACE save cards lose the strip",
    /el\.setAttribute\("data-ace-save-shell", "1"\)/.test(save)
    && /data-ace-save-shell="1"/.test(save), "other chat keeps it");
  check("the stylesheet hides the sender and the time",
    /\.chat-message\[data-ace-save-shell="1"\] > \.message-header \.message-sender/.test(css)
    && /display: none !important;/.test(css), "the strip");
  check("and it never hides the whole header, so the \u22ee survives",
    !/\.chat-message\[data-ace-save-shell="1"\] > \.message-header \{\s*\n\s*display: none/.test(css)
    && /\.message-metadata \{\s*\n\s*position: absolute;/.test(css), "tucked into the corner");
  check("the card is the positioning context for it",
    /\.chat-message\[data-ace-save-shell="1"\] \{ position: relative; \}/.test(css), "top right");
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
  check("the whispered prompt says which save, never the number to beat",
    /Roll a \$\{abilityLabel\} save/.test(save)
    && !/DC \$\{saveDC\} \$\{abilityLabel\} Save<\/div>/.test(save),
    "a player never sees a DC");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
