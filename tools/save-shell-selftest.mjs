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
  // ⚠️🔴 THE DC IS ON IT (§ 13.2), AND IN HIS WORDING. 0.56 took it off on the
  // old reading of the rule; 0.59 put it back as "Roll a DC 13 Wisdom save"; he
  // wrote it out himself as "Roll a Wisdom save (DC 13)". Pinned in the style
  // block below, where the rest of his wording lives.
  check("the whispered prompt carries its DC",
    /Roll a \$\{abilityLabel\} save \$\{dcSpan\(/.test(save), "their roll, their number");
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
  // ⚠️ IT REFRESHES NOW RATHER THAN REFUSING (his rule, 2026-09-30: "Same source,
  // same condition: refresh the duration."). 0.56 returned early and left the old
  // duration running, so a second Charm bought Lamia nothing.
  check("a second write of the same statuses from the same source refreshes it",
    /const _wantStatuses = \[\.\.\.\(ALL_EFFECTS\[key\]\?\.statuses \?\? \[key\]\)\]/.test(cl)
    && /return \{ ok: true, applied: _twin\.name, refreshed, duplicate: true \};/.test(cl),
    "charm_person and charmed are one status");
  check("it is refused BEFORE toggleStatusEffect can make dnd5e's own copy",
    cl.indexOf("_wantStatuses") < cl.indexOf("actor.toggleStatusEffect(key, { active: true })"),
    "no second dnd5echarmed0000");
  check("two different powers can still both charm a creature",
    /if \(!sameThing\) return false;/.test(cl), "same source only");
  check("and what put it on is stamped where the guard can read it",
    /source: options\.source \?\? null,/.test(cl)
    && /const applyOpts = \{\s*\n\s*source: item\.name,/.test(save),
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

/* == THE FORMULA LINE: ONE STYLE ONLY ================================== */
// His spec, 2026-09-30:
//
//     Wis 16 (+3) = +3
//     Dex 1 (−5) + prof +3 = +0
//
// "Short ability. 'prof' not 'proficiency'. Named extras: + 1 cloak.
//  Never 'modifier'. Never 'D20 + N'. Never '+2 more than the sheet shows'."
//
// The second line is the one that matters: its parts add up to −2 and it ends in
// +0, because the total is the bonus the ROLL added and the sheet's disagreement
// with it is a console line. Both of those are pinned below.
console.log("\nONE STYLE ONLY");
{
  const rf = read("scripts/roll-formula.mjs");

  check("the ability is short, and carries its score and its modifier",
    /const ABILITY_NAME = \{ str: "Str", dex: "Dex", con: "Con", int: "Int", wis: "Wis", cha: "Cha" \};/.test(rf)
    && /\$\{p\.label\} \(\$\{signed\(p\.value\)\}\)/.test(rf), "Wis 16 (+3)");
  check("the word is prof", /label: "prof"/.test(rf) && !/"proficiency"/.test(rf), "never proficiency");
  check("and never the word modifier", !/label: "modifier"/.test(rf), "never modifier");
  // ⚠️ REVERSED (his rule, 2026-09-30, the second time round): "The line under the
  // header must end with the combined bonus as D20 + N. Wrong: Wis 16 (+3) = +3.
  // Right: Wis 16 (+3) = D20 + 3." It reads as the thing about to happen rather
  // than a number with no verb.
  check("the end is the roll it is about to make",
    /const line = `\$\{shown\.join\(" "\)\} = D20 \$\{end < 0 \? "−" : "\+"\} \$\{Math\.abs\(end\)\}`;/.test(rf),
    "= D20 + 3");
  check("and N is what was added, with no note about the sheet",
    /console\.log\(`ace-qol \| the roll used/.test(rf)
    && !/more than the sheet shows\)`/.test(rf), "never a book-vs-sheet note");
  check("the same line is on both cards, gated by nothing",
    /<span class="ace-qol-save-quiet-formula">/.test(save)
    && !/ace-qol-save-quiet-formula[^>]*gm-only/.test(save), "GM and player alike");
  check("and the sheet's disagreement is a console line",
    /console\.log\(`ace-qol \| the roll used/.test(rf)
    && !/more than the sheet shows\)`/.test(rf), "never on a card");

  // NAMED EXTRAS. The field on the sheet is a formula string and does not know
  // what put it there; the active effect granting it does.
  // ⚠️🔴 THE SHORT KIND, NOT THE TITLE (his rule, 2026-09-30). My first pass
  // printed the effect's own name, so a save read "+ Cloak of Protection +1" and
  // the card grew a title in the middle of a sum.
  check("an extra is the short kind of the thing that grants it",
    /function grantedBy\(actor, keys\)/.test(rf)
    && /const SHORT_KIND = \[/.test(rf)
    && rf.includes('"cloak"],'), "+1 cloak");
  // Plain substring checks on purpose: the rows are regex literals, and a pin
  // written as a regex about a regex is two layers of escaping and a bug waiting.
  check("its whole vocabulary is his list and nothing else",
    ["cloak", "ring", "amulet", "circlet", "stone", "Bless", "Guidance"]
      .every(k => rf.includes(`"${k}"],`))
    && (rf.match(/\], *\n/g) ?? []).length >= 7,
    "cloak ring amulet circlet stone Bless Guidance");
  check("an item maps on its type, never its title",
    /const item = resolved\?\.item \?\? resolved;/.test(rf)
    && /for \(const \[re, kind\] of SHORT_KIND\) if \(re\.test\(n\)\) return/.test(rf),
    "the effect's name or the item's");
  check("and what the table cannot map prints its number alone",
    /label: by,/.test(rf) && /has no short `/.test(rf), "+1, with the real name in the console");
  check("the order is number then label",
    /return p\.label \? `\$\{signed\(p\.value\)\} \$\{p\.label\}` : signed\(p\.value\);/.test(rf),
    "+1 cloak, +3 prof, +2 Bless");
  check("it reads the effect's own changes, by the key that field lives at",
    /system\.abilities\.\$\{ab\}\.bonuses\.save/.test(rf)
    && /system\.bonuses\.abilities\.save/.test(rf), "the only place the source exists");
  check("several things stacking are all named, not one picked",
    /const shown = \[\.\.\.new Set\(kinds\)\];/.test(rf)
    && /shown\.join\(" "\)/.test(rf), "+1 cloak ring, not a guess between them");
  check("and a bonus nobody claims is NOT given a name",
    /that no active effect claims/.test(rf)
    && /prints the number alone/.test(rf), "its number alone, and the console says why");
  check("a disabled effect grants nothing",
    /if \(e\?\.disabled\) continue;/.test(rf), "switched off is switched off");
}

/* == THE DCs STAY (§ 13.2, unchanged) ================================== */
// His correction, 2026-09-30: "Do not rewrite § 13.2. I changed my mind. DCs
// stay. A player sees the DC on a roll they are making."
console.log("\nTHE DCs STAY");
{
  check("the header's DC still names the creatures rolling against it",
    /dcSpan\(` · \$\{dcText\}`, rollers, "ace-qol-save-cast-dc"\)/.test(save),
    "Jeth reads Lamia's 13");
  check("and the whispered prompt reads the way he wrote it",
    /Roll a \$\{abilityLabel\} save \$\{dcSpan\(`\(DC \$\{saveDC\}\)`, tgt\?\.actorId\)\}/.test(save),
    "Roll a Wisdom save (DC 13)");
  check("§ 13.2 is untouched",
    /Lamia's DC 13 is on\s*\n?\s*Jeth's Charm Person card/.test(read("docs/ACE-ONE-ROAD.md")),
    "not rewritten");
}

/* == CHARM DOES NOT STACK ============================================== */
// His table, 2026-09-30: "Jeth was already Charmed. A second Charm Person from
// Lamia put a second charmed on him and played a second animation. Same source,
// same condition: refresh the duration. One effect. One clip."
//
// ⚠️🔴 AND WHY 0.56's GUARD MISSED IT. That version found its twin only by the
// `source` flag it had stamped itself, so anything already on a creature from
// before it was invisible — which is exactly Jeth, charmed in an earlier test. A
// guard that can only see its own handiwork is no guard on a live world.
console.log("\nCHARM DOES NOT STACK");
{
  const cl = read("scripts/condition-library.mjs");

  check("a twin is found three ways, not just by ACE's own flag",
    /f\.conditionKey && String\(f\.conditionKey\)\.toLowerCase\(\) === key/.test(cl)
    && /from === _src/.test(cl)
    && /String\(e\.origin \?\? ""\) === _originItem/.test(cl),
    "key, source name, or origin item");
  check("so an effect older than the guard is still recognised",
    /A guard that can only see its own handiwork/.test(cl), "conditionKey carries it");
  check("it must already put on everything this would put on",
    /!_wantStatuses\.every\(st => e\.statuses\?\.has\?\.\(st\)\)/.test(cl), "same statuses");

  // A DIFFERENT CASTER IS A DIFFERENT SOURCE.
  check("two casters do not share one charm",
    /if \(_caster && theirs && theirs !== _caster\) return false;/.test(cl),
    "a second source, not a second copy");
  check("and a caster nobody recorded still matches by name or key",
    /_caster && theirs/.test(cl), "older than 0.62 is not punished for it");

  // A REFRESH, NOT A WRITE.
  check("the same source refreshes the duration in place",
    /update\["duration\.seconds"\] = seconds;/.test(cl)
    && /update\["duration\.startTime"\] = game\.time\?\.worldTime \?\? 0;/.test(cl),
    "from the top, on the world clock");
  check("and in combat it restarts on this round and turn",
    /update\["duration\.startRound"\]/.test(cl) && /update\["duration\.startTurn"\]/.test(cl),
    "not left on the old one");
  check("nothing is created, so there is no second clip",
    /await _twin\.update\(update\);/.test(cl)
    && /there is no second animation/.test(cl), "AA fires once per effect created");
  check("whoever cast it this time owns it now",
    /update\["flags\.ace-qol\.sourceActorId"\] = options\.sourceActorId;/.test(cl),
    "so a later cast from somebody else is a different source");
  check("and it is refused BEFORE toggleStatusEffect can write dnd5e's own copy",
    cl.indexOf("_wantStatuses") < cl.indexOf("actor.toggleStatusEffect(key, { active: true })"),
    "no dnd5echarmed0000 beside ACE's charm");

  // HOW LONG, FROM ONE READER.
  check("how long it lasts comes from the caller, then the definition",
    /static _durationSecondsFor\(key, options = \{\}\)/.test(cl)
    && /if \(fromCaller > 0\) return fromCaller;/.test(cl), "one reader");
  check("and neither naming one leaves the duration it had",
    /return 0;/.test(cl) && /leaves the duration it already had/.test(cl), "never cleared");

  // THE EFFECT REMEMBERS WHO.
  check("an effect is stamped with what put it on and who cast it",
    /source: options\.source \?\? null,/.test(cl)
    && /sourceActorId: options\.sourceActorId \?\? null,/.test(cl), "on creation");
  check("and the save path hands both over",
    /sourceActorId: saveCtx\?\.casterActor\?\.id \?\? item\?\.actor\?\.id \?\? null,/.test(save)
    && /origin: item\?\.uuid \?\? null,/.test(save), "caster and item");
}

/* == THE ROLL BOX ====================================================== */
// His card, 2026-09-30: title centred and gold, no white SVG d20, a bigger
// sentence, the button below the die and never over it, the die on its own row,
// and portraits shown whole inside the gold frame.
console.log("\nTHE ROLL BOX");
{
  const box = read("scripts/roll-popout.mjs");

  check("the title is centred and gold",
    /\.ace-qol-roll-popout \.window-header \{ justify-content: center; \}/.test(box)
    && /color: #d4af37;[\s\S]{0,40}text-align: center;/.test(box), "the spell's name, as a heading");
  check("the white d20 glyph is off the button",
    !/class="acp-pill" data-acp="roll"><i class="fas fa-dice-d20">/.test(box),
    "the PNG is the only die on the box");
  check("the sentence is the biggest thing after the title",
    /\.ace-qol-roll-popout \.acp-line \{[\s\S]{0,60}font-size: 20px;/.test(box),
    "Lamia casts Charm Person at you.");
  check("the die has a row of its own",
    /<div class="acp-die-row">/.test(box)
    && /\.ace-qol-roll-popout \.acp-die-row \{ min-height: 78px; \}/.test(box), "nothing covers it");
  check("and the button has its own row under it",
    /<div class="acp-pill-row">/.test(box)
    && box.indexOf('class="acp-die-row"') < box.indexOf('class="acp-pill-row"'),
    "below the d20, never over it");
  check("a portrait is shown whole inside its frame",
    /\.acp-portrait \{[\s\S]{0,120}object-fit: contain;/.test(box), "Lamia's art is not clipped");
  check("the button names the DC he is rolling against",
    /pillLabel: Number\.isFinite\(Number\(f\.saveDC\)\)/.test(save)
    && /Roll \$\{abilityLabel\} save \(DC \$\{f\.saveDC\}\)/.test(save), "Roll Wisdom save (DC 13)");
}

/* == THE D20 GLOW ====================================================== */
// "Keep the gold circle behind the die (glowSpan). Take the drop-shadow off the
// PNG. No glow on the face, no glow on the image."
console.log("\nLIGHT BEHIND THE DIE, NONE ON IT");
{
  const face = read("scripts/dice-face.mjs");

  check("the gold circle behind the die stays",
    /const glowSpan = glow/.test(face) && /radial-gradient\(circle,rgba\(212,175,55/.test(face),
    "glowSpan");
  check("and nothing is painted onto the picture",
    /const shadow = "";/.test(face) && !/filter:drop-shadow\(0 0 3px/.test(face),
    "no drop-shadow on the PNG");
  check("the damage dice are untouched",
    /drop-shadow\(0 1px 3px rgba\(0,0,0,0\.6\)\)/.test(css), "their dark shadow is depth, not glow");
  check("the nat-20 and nat-1 highlight is untouched",
    /\.ace-qol-rs-d20\.ace-qol-rs-nat20 \{[\s\S]{0,120}box-shadow/.test(css), "green and red stay");
  check("and the roll box keeps its own pulse",
    /@keyframes acp-blink-die/.test(read("scripts/roll-popout.mjs")), "CSS on the button, not this function");
}

/* == HARM FROM THE SOURCE ENDS THE CHARM =============================== */
// His rule, 2026-09-30: "When the caster of that Charm, or that caster's allies,
// deal damage to that target, that caster's Charm ends immediately. No extra
// save. 2014: you or your companions do anything harmful. 2024: you or your
// allies damage it. Read the edition off the item."
console.log("\nHARM FROM THE SOURCE ENDS THE CHARM");
{
  const raw = read("scripts/condition-raw-hooks.mjs");

  // ⚠️🔴 THE REASON IT NEVER FIRED. ACE writes hit points with a raw actor.update,
  // which does not fire dnd5e.preApplyDamage, and only the Sleep wake had been
  // moved onto ACE's own signal. So every drop of ACE damage came down the one
  // path this door ignored.
  check("ACE's own damage drives every reaction, not just the Sleep wake",
    /ConditionRawHooks\._dispatch\(key, \{ actor, effect, sourceActor, sourceItem, amount \}\)/.test(raw),
    "the same dispatch as the dnd5e hook");
  check("and it reads the caster and the amount off the signal",
    /const sourceActor = payload\?\.sourceActor \?\? null;/.test(raw)
    && /Number\(payload\?\.hpDelta \?\? payload\?\.total \?\? 0\)/.test(raw),
    "the payload has carried both since the hit-point door");
  check("a heal is not harm",
    /if \(!Number\.isFinite\(amount\) \|\| amount <= 0\) return;/.test(raw), "only damage ends it");

  check("the caster's SIDE ends it, not the caster alone",
    /static _onCasterSide\(sourceActor, casterActorId\)/.test(raw)
    && /if \(!ConditionRawHooks\._onCasterSide\(sourceActor, casterActorId\)\) return;/.test(raw),
    "2014 companions, 2024 allies");
  check("a side is a disposition, the only allegiance Foundry knows",
    /mine\.disposition === theirs\.disposition/.test(raw), "same side");
  check("and a creature it cannot place does NOT end a charm on a guess",
    /so the charm is left for the GM to end/.test(raw), "no token, no answer");

  check("the edition is read off the ITEM, never the world setting",
    /item\?\.system\?\.source\?\.rules/.test(raw), "the item is what is being cast");
  check("2014's wider wording is said, not pretended",
    /which is wider than damage/.test(raw), "other harm is still the GM's call");
  check("it ends with no extra save",
    /No save:/.test(raw) && /await effect\.delete\(\);/.test(raw), "immediately");
  check("Command is NOT in the dispatch",
    !/case "command":/.test(raw), "his rule: Command is not this rule");
  check("Suggestion IS, through the same door",
    /case "suggestion":/.test(raw), "that spell's own text");
}

/* == THE PICKER GETS OUT OF THE WAY ==================================== */
console.log("\nTHE PICKER GETS OUT OF THE WAY");
{
  const pk = read("scripts/spell-target-picker.mjs");

  check("one legal target already selected means no picker",
    /if \(cap === 1 && kind !== "exclude"\)/.test(pk)
    && /return \[chosen\[0\]\.actor\];/.test(pk), "use that target");
  check("two targeted with room for one is still a question",
    /if \(chosen\.length > 1\)/.test(pk), "the picker opens to ask which");
  check("and nothing filters a creature out for a condition it already has",
    /a recast\s*\n?\s*\/\/ refreshes it/.test(pk), "already Charmed is still legal");

  check("with one target, the click is the cast",
    /if \(maxTargets === 1\) \{[\s\S]{0,260}confirm\.click\(\); return;/.test(pk),
    "no second Cast button");
  check("and it presses the dialog's own confirm, so there is one way out",
    /button\[data-action="confirm"\]/.test(pk)
    && /ONE path out of this dialog/.test(pk), "the selection is read the same way");
  check("that button is hidden when a click already does it",
    /if \(confirm\) confirm\.style\.display = "none";/.test(pk), "no second Cast button");
  check("with room for several the confirm button stays",
    /the confirm button stays/.test(pk), "he asked for it there");
}

/* == A PRESS IS NEVER LABELLED "SAVE" ================================== */
console.log("\nA PRESS IS NEVER LABELLED SAVE");
{
  const main = read("scripts/ace-qol.mjs");
  check("an unnamed activity is named after the thing being done",
    /const _verb = item\.type === "spell" \? "Cast" : "Use";/.test(main)
    && /const _named = `\$\{_verb\} \$\{item\.name\}`;/.test(main), "Cast Charm Person");
  check("and dnd5e's type word is never the label",
    !/\|\| a\.name \|\| a\.type \|\| "Action"/.test(main), "never Save");
  check("an activity with a real name of its own keeps it",
    /if \(a\.name\) return base;/.test(main), "that name tells two of them apart");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
