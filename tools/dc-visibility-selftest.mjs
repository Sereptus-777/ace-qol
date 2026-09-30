// ─── A DC BELONGS TO WHOEVER SET IT ─────────────────────────────────────────
//
// His rule, 2026-09-29:
//
//   "The player knows its own DCs. It has no idea about any other DC. The
//    dungeon master knows all DCs. That's all there is to it."
//
// This pins the MECHANISM, and `dc-check.mjs` pins the sweep. Two different
// jobs: the check asks "is every DC that reaches a screen wrapped", and this
// asks "does the wrapper actually do the right thing on each screen".
//
// The three properties that matter, and every one of them is a bug I have
// already shipped in some other form:
//
//   1. IT IS DECIDED PER SCREEN. A card is built once by the GM and rendered on
//      every client, so a choice made while the card is written is made for the
//      whole table at once. That is how "DC 13 Wisdom" got printed to everybody.
//   2. IT FAILS HIDDEN. Hidden by CSS, revealed by a pass. A card the pass never
//      reaches shows nothing rather than leaking, which is the opposite of
//      `forge-gm-only` (visible until something hides it) and of the 2026-08-07
//      bug that chat-render-utils exists to prevent.
//   3. EVERY MODULE CARRIES ITS OWN HIDE RULE. Forge and Engine draw their own
//      cards and must be correct in a world without ACE QOL.
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
const checker = read("ace-qol/tools/dc-check.mjs");
const release = read("ace-qol/tools/release-check.py");

console.log("\nA DC BELONGS TO WHOEVER SET IT\n");

/* ══ 1. WHO MAY KNOW ══════════════════════════════════════════════════════ */
console.log("WHO MAY KNOW");
{
  const body = utils.slice(utils.indexOf("export function maySeeDC"), utils.indexOf("export function dcSpan"));
  check("the GM knows all of them", /if \(game\.user\?\.isGM\) return true;/.test(body), "always");
  check("a player knows the ones their own creature set",
    /return !!actor\?\.isOwner;/.test(body), "isOwner");
  check("no owner named means it is not theirs",
    /if \(!actorId\) return false;/.test(body), "hidden, not shown");
  check("and an unreadable answer is 'not theirs' too",
    /return false;\s*\n\s*\/\/ unreadable: it is not theirs/.test(body)
    || /catch \(_\) \{\s*\n\s*return false;/.test(body), "fails closed");
}

/* ══ 2. DECIDED PER SCREEN, NOT WHEN THE CARD IS WRITTEN ══════════════════ */
console.log("\nDECIDED PER SCREEN");
{
  check("the wrapper carries the creature that SET the number",
    /data-dc-actor="\$\{esc\(actorId\)\}"/.test(utils), "dcSpan");
  check("both wrappers are revealed by one pass",
    /querySelectorAll\?\.\(".ace-qol-dc"\)/.test(utils)
    && /querySelectorAll\?\.\(".ace-qol-save-dc"\)/.test(utils), "owner-aware and GM-only");
  check("the older pill has no owner, so it is the GM's alone",
    /\/\/ No owner named: the GM's alone\.\s*\n\s*for \(const el of \(root\?\.querySelectorAll\?\.\(".ace-qol-save-dc"\)/.test(utils),
    "a monster's save DC");
  check("registered once for every ACE card, from every module",
    /export function registerDCVisibility\(\)/.test(utils)
    && /registerDCVisibility\(\);/.test(qolMain), "not per handler");
  check("and NOT stamped inside one handler any more",
    !/for \(const dcEl of el\.querySelectorAll\("\.ace-qol-save-dc"\)\)/.test(read("ace-qol/scripts/save-engine.mjs")),
    "a stamp in one handler covers only its own cards");
}

/* ══ 3. IT FAILS HIDDEN ═══════════════════════════════════════════════════ */
console.log("\nIT FAILS HIDDEN");
for (const [name, css] of [["ace-qol", qolCss], ["Forge", forgeCss], ["Engine", engineCss]]) {
  check(`${name} hides a DC by default`,
    /\.ace-qol-dc \{ display: none !important; \}/.test(css)
    && /\.ace-qol-save-dc \{ display: none !important; \}/.test(css), "CSS, not a handler");
  check(`${name} shows one only once a pass has said so`,
    /\.ace-qol-dc\[data-ace-dc="show"\]/.test(css)
    && /\.ace-qol-save-dc\[data-ace-dc="show"\]/.test(css), "data-ace-dc");
}
{
  check("Forge reveals its own, without depending on ACE QOL",
    /function forgeRevealOwnDCs\(root\)/.test(forge) && /registerForgeDCVisibility\(\)/.test(forge),
    "its own pass");
  check("Engine reveals its own, on every card it draws",
    /function _aceRevealOwnDCs\(root\)/.test(engine)
    && /_aceRevealOwnDCs\(root\);/.test(engine), "in its render handler");
  check("and Forge sweeps what is already on screen",
    /for \(const node of document\.querySelectorAll\("#chat-log \[data-message-id\]/.test(forge),
    "Foundry paints the log once");
}

/* ══ 4. THE SWEEP IS ENFORCED, NOT REMEMBERED ═════════════════════════════ */
console.log("\nENFORCED, NOT REMEMBERED");
{
  check("the release check runs the DC check",
    /node tools\/dc-check\.mjs/.test(release), "every release");
  check("it reads all four modules",
    /ace-artificer/.test(checker) && /ace-engine/.test(checker) && /ace-envoy/.test(checker),
    "qol, Forge, Engine, Envoy");
  check("it accepts all three wrappers and no others",
    /const WRAPPED = \/ace-qol-dc\\b\|ace-qol-save-dc\\b\|forge-gm-only\\b\|dcSpan/.test(checker),
    "and says why each counts");
  check("the console is the GM's, so it is not a leak",
    /c\.object\?\.name === "console"/.test(checker), "console.* is skipped");
  check("prose and reference data are listed, never failed",
    /\(onAScreen \? hits : notes\)\.push\(row\)/.test(checker), "two lists");
  check("it reports the line the DC is on, not the line the template opens on",
    /const dcLine = startLine \+/.test(checker), "a card is one literal, forty lines long");
  check("a justification anywhere from above the literal to the DC counts",
    /for \(let l = Math\.max\(1, startLine - 3\); l <= dcLine; l\+\+\)/.test(checker),
    "dc-ok: <reason>");
}

/* ══ 5. AND THE ONE IT WAS ALL FOR ════════════════════════════════════════ */
console.log("\nTHE CARD HE WAS LOOKING AT");
{
  const save = read("ace-qol/scripts/save-engine.mjs");
  check("the save card's quiet line keeps its DC on the GM's side",
    /ace-qol-save-quiet-dc ace-qol-gm-only/.test(save), "line 2");
  check("the whispered prompt names the save and not the number",
    /Roll a \$\{abilityLabel\} save/.test(save), "sent TO the player");
  check("every DC pill in the suite is hidden until a pass says otherwise",
    /\.ace-qol-save-dc \{ display: none !important; \}/.test(qolCss), "one rule");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
