// ═══════════════════════════════════════════════════════════════════════════
//  NAME SWAP SELF-TEST — renaming a creature fixes the history it leaves
// ───────────────────────────────────────────────────────────────────────────
//  His table, 2026-09-24. He renamed a Carrion Ogre to Gromm the Unyielding,
//  the biography window opened as promised, and the bar said:
//
//      "The biography does not use 'Carrion Ogre (1)' anywhere,
//       so there is nothing to swap."
//
//  True, and useless. The token label carries Foundry's duplicate counter and
//  the prose says "Carrion Ogre", so the one button he wanted never appeared.
//  "I just wanted to change his name. How hard is that to figure out?"
//
//  ⚠️ THIS TEST READS THE REAL FUNCTIONS OUT OF THE MODULE. Not a copy of them,
//  not a description of them: the same source the game loads. A test that
//  re-implements what it is testing passes forever and proves nothing.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";

const FILE = "D:/FoundryVTT/Data/modules/ace-engine/scripts/npc/bio-editor.mjs";
const src = readFileSync(FILE, "utf8");
const code = src.slice(src.indexOf("function _nameRe("), src.indexOf("/** A yes/no the GM actually sees"));
if (!code.includes("_nameCandidates")) {
    console.error("name-swap: could not find the naming helpers in bio-editor.mjs — has it been renamed?");
    process.exit(1);
}
const { _nameCandidates, _countName, _swapName } =
    new Function("MODULE_ID", code + "\nreturn { _nameCandidates, _countName, _swapName };")("ace-engine");

let passed = 0, failed = 0;
function check(what, ok, detail = "") {
    if (ok) { passed++; console.log(`  ok   ${what}`); }
    else { failed++; console.log(`  FAIL ${what}${detail ? `  ${detail}` : ""}`); }
}

/** Exactly what the rename bar does, so the test cannot drift from the window. */
function plan(bioHtml, previousLabel, actor, newName) {
    const candidates = _nameCandidates(previousLabel, actor)
        .filter(n => n.toLowerCase() !== newName.toLowerCase())
        .map(n => ({ name: n, n: _countName(bioHtml, n) }))
        .filter(c => c.n > 0);
    const hits = candidates.reduce((sum, c) => sum + c.n, 0);
    let after = bioHtml;
    for (const c of candidates) after = _swapName(after, c.name, newName);
    return { candidates, hits, after };
}

console.log("\nNAME SWAP: RENAMING FIXES THE HISTORY");

// ── 1. His own case, verbatim ────────────────────────────────────────────
{
    const bio = `<p>Carrion Ogre is a fearsome creature, embodying the raw strength of an ogre `
        + `with the grotesque head of a carrion crawler. Born within the labyrinthine depths of the `
        + `Amber Temple, he found acceptance among the Thousand Fists.</p>`
        + `<p>As a member of the Ogre Raiders, Carrion Ogre serves as a Battering Ram.</p>`
        + `<p>Despite his brutish nature, Carrion Ogre possesses a pragmatic approach to life.</p>`
        + `<p>In the current moment, Carrion Ogre finds himself deep within the Amber Temple.</p>`;
    const actor = { name: "Carrion Ogre", getFlag: () => "" };
    const r = plan(bio, "Carrion Ogre (1)", actor, "Gromm the Unyielding");

    check("the token label's duplicate counter does not hide the name the biography actually uses",
        r.hits === 4, `expected 4 places, got ${r.hits}`);
    check("and after the swap nothing still calls him by the old name",
        !/Carrion Ogre/.test(r.after));
    check("while the species it is made of is left alone: a carrion crawler is not a person",
        /carrion crawler/.test(r.after));
    check("the button names the spelling that actually appears, not the one on the token",
        r.candidates[0]?.name === "Carrion Ogre");
}

// ── 2. The boundary rules, which decide what counts as the name ──────────
{
    const bio = `<p>Grizzle the goblin. Grizzle's axe. Grizzled veteran. O'Grizzle. (Grizzle)</p>`;
    const actor = { name: "Goblin", getFlag: () => "" };
    const r = plan(bio, "Grizzle", actor, "Ulthrax");

    check("a possessive is the same person: \"Grizzle's axe\" becomes \"Ulthrax's axe\"",
        /Ulthrax's axe/.test(r.after));
    check("a longer word is not: \"Grizzled veteran\" is left as it was",
        /Grizzled veteran/.test(r.after));
    check("and another name that merely ends in it is left alone: O'Grizzle",
        /O'Grizzle/.test(r.after));
    check("a name in brackets is still the name",
        /\(Ulthrax\)/.test(r.after));
}

// ── 3. Case, which is the difference between a name and a species ────────
{
    const bio = `<p>Mind Flayer rules this place. Another mind flayer guards the door.</p>`;
    const actor = { name: "Mind Flayer", getFlag: () => "" };
    const r = plan(bio, "Mind Flayer (2)", actor, "Ulth'kaan");

    check("the capitalised one is the creature being named, and it is renamed",
        /Ulth'kaan rules this place/.test(r.after));
    check("the lower-case one is the species being described, and it is not",
        /another mind flayer guards/i.test(r.after) && /mind flayer guards/.test(r.after));
}

// ── 4. Nothing to do is said, not guessed ────────────────────────────────
{
    const bio = `<p>The creature has no name in this text at all.</p>`;
    const actor = { name: "Ogre", getFlag: () => "" };
    const r = plan(bio, "Ogre (3)", actor, "Gromm");
    check("a biography that never names it reports no places rather than a false one",
        r.hits === 0 && r.after === bio);

    const r2 = plan(`<p>Gromm walks.</p>`, "Gromm", { name: "Ogre", getFlag: () => "" }, "Gromm");
    check("and renaming something to the name it already has swaps nothing",
        r2.hits === 0);
}

// ── 5. A flavour name it had before is remembered ────────────────────────
{
    const bio = `<p>Skarn the Bold led them. Skarn was an ogre.</p>`;
    const actor = { name: "Ogre", getFlag: (_m, k) => (k === "originalName" ? "Ogre" : "") };
    const r = plan(bio, "Skarn the Bold", actor, "Gromm the Unyielding");
    check("the longest spelling goes first, so \"Skarn the Bold\" is not left half-renamed",
        /Gromm the Unyielding led them/.test(r.after) && !/Gromm the Unyielding the Bold/.test(r.after));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
