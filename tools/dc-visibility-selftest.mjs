// ─── THE CHROME LAW: ACE-ONE-ROAD.md § 13 ───────────────────────────────────
//
// § 13.1  Every ACE chat card hides Foundry's speaker strip. The ⋮ stays.
// § 13.2  A player sees the DC on a roll they are making. The GM sees every DC.
// § 13.3  A monster's AC is never on a card. AC is not a save DC.
//
// ⚠️🔴 § 13.2 REPLACES WHAT 0.58 SHIPPED. I built that round the wrong question,
// "who SET this number", so Lamia's DC 13 was hidden from Jeth, the man rolling
// against it. His correction: "Do not hide Lamia's DC 13 on Jeth's Charm card.
// He is rolling against it." The number belongs to the ROLL.
//
// And § 13.3 is the mirror of it, which is why it needs its own wrapper: a DC
// goes TO the person rolling, and an AC is the one thing the person rolling must
// not be handed.
//
// This pins the MECHANISM. `dc-check.mjs` pins the sweep: that every DC and AC
// which reaches a card goes through a wrapper at all.
//
// The three properties that matter, each of them a bug I have already shipped in
// some other form:
//
//   1. DECIDED PER SCREEN. A card is built once, by the GM, and rendered on every
//      client, so a choice made while the card is written is made for the whole
//      table at once.
//   2. FAILS HIDDEN. Hidden by CSS, revealed by a pass. A card the pass never
//      reaches shows nothing rather than leaking. `forge-gm-only` is the other way
//      round and one of its cards had no handler at all.
//   3. EVERY MODULE CARRIES ITS OWN COPY. Forge and Engine draw their own cards
//      and must be right in a world without ACE QOL.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(64)} ${detail}`);
};
const M = "D:/FoundryVTT/Data/modules/";
const read = (p) => readFileSync(M + p, "utf8");

const utils = read("ace-qol/scripts/chat-render-utils.mjs");
const qolCss = read("ace-qol/styles/ace-qol.css");
const forgeCss = read("ace-artificer/styles/ace-artificer.css");
const engineCss = read("ace-engine/styles/ace-engine.css");
const qolMain = read("ace-qol/scripts/ace-qol.mjs");
const forge = read("ace-artificer/scripts/ace-artificer.mjs");
const engine = read("ace-engine/scripts/ace-engine.mjs");
const save = read("ace-qol/scripts/save-engine.mjs");
const attack = read("ace-qol/scripts/attack-pipeline.mjs");
const checker = read("ace-qol/tools/dc-check.mjs");
const release = read("ace-qol/tools/release-check.py");
const road = read("ace-qol/docs/ACE-ONE-ROAD.md");

console.log("\nTHE CHROME LAW (ACE-ONE-ROAD.md \u00a7 13)\n");

/* ══ THE LAW IS WRITTEN DOWN ══════════════════════════════════════════════ */
console.log("IT IS IN THE DOCUMENT, NOT JUST IN THE CODE");
{
  check("\u00a7 13 exists in the One Road", /## 13\. Every ACE card/.test(road), "the chrome law");
  check("\u00a7 13.1 no speaker strip", /### 13\.1 No speaker strip/.test(road), "every ACE card");
  check("\u00a7 13.2 a DC on the roll that needs it",
    /### 13\.2 A DC is shown on the roll that needs it/.test(road)
    && /Lamia's DC 13 is on\s*\n?\s*Jeth's Charm Person card/.test(road), "his own example");
  check("\u00a7 13.3 a monster's AC is never on a card",
    /### 13\.3 A monster's AC is never on a card/.test(road), "AC is not a save DC");
  check("\u00a7 13.4 what a card says about its own numbers",
    /### 13\.4 What a card says about its own numbers/.test(road)
    && /Never the word "proficiency"/.test(road), "prof, no sheet-vs-book note");
  check("and the road's own diagram points at it",
    /A DC only on a roll that\s*\n?\s*player is making\. See section 13\./.test(road), "one line, one pointer");
}

/* ══ § 13.1 THE SPEAKER STRIP ═════════════════════════════════════════════ */
console.log("\n\u00a7 13.1  NO SPEAKER STRIP, ON ANY ACE CARD");
{
  check("a card is recognised by the MESSAGE's flags, not by its own content",
    /export function isAceCard\(message, el = null\)/.test(utils)
    && /ACE_NAMESPACES\.some\(ns => flags\[ns\]/.test(utils), "save, attack, damage, heal, reaction");
  check("all four modules count",
    /\["ace-qol", "ace-artificer", "ace-engine", "ace-envoy"\]/.test(utils), "one list");
  check("the stamp goes on the message element",
    /el\.setAttribute\("data-ace-card", "1"\)/.test(utils), "data-ace-card");
  check("one pass does the strip and the numbers together",
    /export function registerAceChrome\(\)/.test(utils)
    && /stampAceCard\(message, el\);/.test(utils)
    && /revealOwnDCs\(el\);/.test(utils) && /revealOwnACs\(el\);/.test(utils), "registered once");
  check("and it is registered at ready", /registerDCVisibility\(\);/.test(qolMain), "ace-qol.mjs");
  for (const [name, css] of [["ace-qol", qolCss], ["Forge", forgeCss], ["Engine", engineCss]]) {
    check(`${name} hides the sender and the time, never the header`,
      /\.chat-message\[data-ace-card="1"\] > \.message-header \.message-sender/.test(css)
      && !/\.chat-message\[data-ace-card="1"\] > \.message-header \{[\s\S]{0,20}display: none/.test(css),
      "the \u22ee survives");
  }
  check("and the controls move into the card's corner",
    /\.message-metadata \{[\s\S]{0,40}position: absolute;/.test(qolCss), "top right");
  check("Forge and Engine stamp their own, without depending on QOL",
    /forgeStampAceCard\(message, root\)/.test(forge)
    && /root\.setAttribute\("data-ace-card", "1"\)/.test(engine), "each on its own");
}

/* ══ § 13.2 A DC GOES TO THE ROLLER ═══════════════════════════════════════ */
console.log("\n\u00a7 13.2  A DC IS SHOWN ON THE ROLL THAT NEEDS IT");
{
  const body = utils.slice(utils.indexOf("export function maySeeDC"), utils.indexOf("export function dcSpan"));
  check("the GM sees every DC", /if \(game\.user\?\.isGM\) return true;/.test(body), "always");
  check("a player sees one on a roll their creature is making",
    /return ids\.some\(id => !!game\.actors\?\.get\(id\)\?\.isOwner\);/.test(body), "isOwner");
  check("several rollers share one line, because one card asks them all",
    /String\(rollers \?\? ""\)\.split\(\/\\s\+\/\)/.test(body), "space-separated");
  check("no roller named means nobody is rolling it yet",
    /if \(!ids\.length\) return false;/.test(body), "an unsprung trap, an unrevealed sheet");
  check("and an unreadable answer is not this screen's",
    /catch \(_\) \{[\s\S]{0,60}return false;/.test(body), "fails closed");

  check("the wrapper names the roller, not whoever set the number",
    /data-dc-roller="\$\{esc\(ids\)\}"/.test(utils)
    && !/data-dc-actor/.test(utils), "data-dc-roller");
  check("Lamia's DC is on the header, for the creatures rolling against it",
    /dcSpan\(` \u00b7 \$\{dcText\}`, rollers, "ace-qol-save-cast-dc"\)/.test(save)
    && /static rollersOn\(results\)/.test(save), "Jeth reads it");
  // His own wording, 2026-09-30: "The whispered prompt is 'Roll a Wisdom save
  // (DC 13)'." The DC after the save, in brackets, not in front of the ability.
  check("and the whispered prompt shows it to the person rolling",
    /Roll a \$\{abilityLabel\} save \$\{dcSpan\(`\(DC \$\{saveDC\}\)`, tgt\?\.actorId\)\}/.test(save),
    "Roll a Wisdom save (DC 13)");
  check("the older pill, which names nobody, stays the GM's",
    /for \(const el of \(root\?\.querySelectorAll\?\.\(".ace-qol-save-dc"\) \?\? \[\]\)\)/.test(utils)
    && /decide\(el, null\);/.test(utils), "no roller, no player");
}

/* ══ § 13.3 AN AC IS NOT A DC ═════════════════════════════════════════════ */
console.log("\n\u00a7 13.3  A MONSTER'S AC IS NEVER ON A CARD");
{
  check("an AC has its own wrapper, asking a different question",
    /export function acSpan\(text, whose = null/.test(utils)
    && /data-ac-actor="\$\{esc\(whose\)\}"/.test(utils), "whose sheet, not who rolls");
  check("revealed to the GM and to the creature's own owner",
    /const mine = game\.user\?\.isGM \|\| \(!!id && !!game\.actors\?\.get\(id\)\?\.isOwner\);/.test(utils),
    "their own AC is on their own sheet");
  check("the to-hit card's AC goes through it",
    /acSpan\(`AC \$\{r\.effectiveAC\} \+\$\{r\.effectiveAC - r\.ac\}`, _acWhose\)/.test(attack)
    && /acSpan\(`AC \$\{r\.ac\}`, _acWhose\)/.test(attack), "every swing printed it before");
  check("and the math is untouched, only the display",
    /The MATH is untouched/.test(attack), "the hit was decided long before");
  for (const [name, css] of [["ace-qol", qolCss], ["Forge", forgeCss], ["Engine", engineCss]]) {
    check(`${name} hides an AC by default`,
      /\.ace-qol-ac \{ display: none !important; \}/.test(css)
      && /\.ace-qol-ac\[data-ace-ac="show"\]/.test(css), "CSS, not a handler");
  }
}

/* ══ § 13.4 WHAT A CARD SAYS ABOUT ITS NUMBERS ════════════════════════════ */
console.log("\n\u00a7 13.4  WHAT A CARD SAYS ABOUT ITS OWN NUMBERS");
{
  const rf = read("ace-qol/scripts/roll-formula.mjs");
  check("the word is prof, never proficiency",
    /label: "prof"/.test(rf) && !/label: "proficiency"/.test(rf), "on the card");
  check("the sheet-versus-roll note is a console line now",
    /console\.log\(`ace-qol \| the roll used/.test(rf)
    && !/more than the sheet shows\)`/.test(rf),
    "chat gets the number, the console gets the argument");
  check("the portrait is shown whole",
    /width: 52px !important;/.test(qolCss) && /object-fit: contain !important;/.test(qolCss),
    "not a 32px circle");
  // The die and the sum are now the row's second line, side by side, and the sum
  // itself is one piece of text (his card, 2026-09-30).
  check("the die sits with the result it made",
    /<div class="ace-qol-save-row-result">[\s\S]{0,180}\$\{d20El\}[\s\S]{0,80}\$\{mathLine\}/.test(save),
    "5 \u2212 2 = 3 FAIL");
  check("and a second roll is a second line",
    /\.ace-qol-save-extra-roll \{/.test(qolCss)
    && /ace-qol-save-extra-roll/.test(read("ace-qol/scripts/post-hit-saves.mjs")),
    "the Topple die, under the result");
}

/* ══ ENFORCED, NOT REMEMBERED ═════════════════════════════════════════════ */
console.log("\nENFORCED, NOT REMEMBERED");
{
  check("the release check runs it", /node tools\/dc-check\.mjs/.test(release), "every release");
  check("it reads all four modules",
    /ace-artificer/.test(checker) && /ace-engine/.test(checker) && /ace-envoy/.test(checker), "qol too");
  check("it checks an AC as well as a DC",
    /const STATES_AN_AC/.test(checker) && /const AC_WRAPPED/.test(checker), "\u00a7 13.3");
  check("the console is the GM's, so it is not a leak",
    /c\.object\?\.name === "console"/.test(checker), "console.* is skipped");
  check("prose and reference data are listed, never failed",
    /\(onAScreen \? hits : notes\)\.push\(row\)/.test(checker), "two lists");
  check("it reports the line the number is on",
    /const dcLine = startLine \+/.test(checker), "not the line the template opens on");
  check("a reason on a table covers the table",
    /its table already said why/.test(checker), "forty sentences, one reason");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
