// ─── THE BANNER THAT STAYS, AND THE RULE IT QUOTES ───────────────────────────
//
// His table, 2026-10-04. A Salamander with a 10-foot reach, a target two empty
// squares away, and a banner reading "OUT OF RANGE — 15 FEET AWAY (MELEE REACH
// 10 FEET)". He had been fixing this "fifty times in six months".
//
// It was never broken. Both numbers are true: the GAP is ten feet and the RANGE
// is fifteen, because 5e counts the target's own square as the last five. The
// rule, word for word the same in the 2014 PHB p.192 and the 2024 PHB:
//
//   "To determine the range on a grid between two things — whether creatures or
//    objects — count squares from a square adjacent to one of them and stop
//    counting in the space of the other one. Count by the shortest route."
//
// So the banner carries the arithmetic and the rule, and it stays on screen
// until he clicks instead of fading in two and a half seconds.
//
// Run:  node tools/range-banner-selftest.mjs
import { readFileSync } from "node:fs";

const M = "D:/FoundryVTT/Data/modules/ace-qol";
const prompt = readFileSync(`${M}/scripts/attack-prompt.mjs`, "utf8");
const pipe = readFileSync(`${M}/scripts/attack-pipeline.mjs`, "utf8");
const main = readFileSync(`${M}/scripts/ace-qol.mjs`, "utf8");
const css = readFileSync(`${M}/styles/ace-qol.css`, "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(64)} ${detail}`);
};

console.log("\nWHAT THE BANNER SAYS");
{
  const fn = prompt.slice(prompt.indexOf("export function showOutOfRangeBanner"));
  check("there is one builder for it", prompt.includes("export function showOutOfRangeBanner"));
  check("the headline is OUT OF RANGE", /headline: "OUT OF RANGE"/.test(fn));
  check("it says how far away the target is",
    /Target is \$\{Math\.round\(distanceFt\)\} ft away/.test(fn));
  /* ⚠️ THE SQUARES ARE WORKED OUT FROM THE DISTANCE, not counted twice. The
     distance already counts the target's own square, so the empty ones are that
     count less one. */
  check("and how many empty squares that is",
    /Math\.max\(0, Math\.round\(Number\(distanceFt\) \/ gd\) - 1\)/.test(fn)
    && /empty square\$\{squares === 1 \? "" : "s"\} between you/.test(fn));
  check("and that the target's own square is the last five feet",
    /a target\\u2019s own square counts as the last \$\{gd\} ft/.test(fn)
    || /own square counts as the last \$\{gd\} ft/.test(fn));
  check("a touching pair says touching, not '0 empty squares'",
    /squares === 0\s*\n?\s*\? "touching"/.test(fn));
  check("the reach goes under it in big letters",
    /big: String\(rangeDesc \|\| ""\)\.toUpperCase\(\)/.test(fn));
  check("and the rule is quoted under that, with where it is from",
    /quote: GRID_RANGE_RULE/.test(fn) && /cite: GRID_RANGE_CITE/.test(fn));
}

console.log("\nTHE QUOTE IS THE RULE, WORD FOR WORD");
{
  /* ⚠️ JOIN THE PIECES FIRST. The constant is a concatenation, so a phrase that
     straddles two string literals is not one run of characters in the source
     even though it is one sentence on the screen. */
  const q = prompt.slice(prompt.indexOf("export const GRID_RANGE_RULE"),
    prompt.indexOf("export const GRID_RANGE_CITE")).replace(/"\s*\+\s*"/g, "");
  for (const phrase of [
    "To determine the range on a grid between two things",
    "count squares from a square adjacent to one of them",
    "stop counting in the space of the other one",
    "Count by the shortest route",
  ]) check(`"${phrase.slice(0, 44)}..."`, q.includes(phrase));
  check("and it is cited to both editions",
    /Playing on a Grid/.test(prompt) && /2014 PHB p\.192/.test(prompt));
}

console.log("\nIT STAYS UNTIL HE CLICKS");
{
  const fn = prompt.slice(prompt.indexOf("export function showCenterBanner"),
    prompt.indexOf("export function showOutOfRangeBanner"));
  check("nothing times it out", !/setTimeout\([^)]*close/.test(fn) && !/durationMs/.test(fn));
  check("the next click anywhere dismisses it",
    /document\.addEventListener\("pointerdown", close, true\)/.test(fn));
  check("and Escape does too", /ev\.key === "Escape"/.test(fn));
  /* ⚠️ ARMED ON THE NEXT FRAME, or the press that fired the attack is still
     travelling and dismisses the banner it just raised. */
  check("it is armed a frame later, not on the click that raised it",
    /requestAnimationFrame\(\(\) => requestAnimationFrame\(/.test(fn));
  /* ⚠️ AND IT SWALLOWS NOTHING: no backdrop, and the listener does not stop the
     event, so the click that clears it still does what he meant it to do. */
  check("it eats no clicks of its own",
    /pointer-events: none;/.test(css.slice(css.indexOf(".ace-qol-center-banner {"),
      css.indexOf(".ace-qol-center-banner {") + 900))
    && !/preventDefault|stopPropagation/.test(fn));
  check("a second one replaces the first instead of stacking",
    /_banner\?\.remove\?\.\(\)/.test(fn));
}

console.log("\nBOTH OUT-OF-RANGE PATHS USE IT");
{
  check("the attack pipeline raises the banner", /showOutOfRangeBanner\(worst\.distanceFt/.test(pipe));
  check("and the item-use wrapper does too", /showOutOfRangeBanner\(rangeCheck\.distanceFt/.test(main));
  /* ⚠️ ONE NOTICE, NOT THREE. The banner says it and the cancel announcement
     records it; a red corner toast carrying the same sentence was a third copy
     of one event. */
  /* ⚠️ ONE NOTICE, NOT THREE, AND ONLY THIS BLOCK. The file has other toasts
     for other refusals (the melee multi-target lockout keeps its own), so this
     reads the out-of-range block alone rather than the whole file. */
  const block = pipe.slice(pipe.indexOf("showOutOfRangeBanner(worst.distanceFt") - 600,
    pipe.indexOf("showOutOfRangeBanner(worst.distanceFt") + 500);
  check("and that block does not also flash a toast saying the same thing",
    !/showCenterToast/.test(block) && !/ui\.notifications\?\.warn/.test(block),
    "the banner replaced it");
}

console.log("\nEVERY LINE IS READABLE, NOTHING IS SQUEEZED");
{
  const block = css.slice(css.indexOf(".ace-qol-center-banner {"),
    css.indexOf(".ace-qol-banner-hint") + 300);
  check("the quote wraps instead of clipping",
    /\.ace-qol-banner-quote \{[^}]*white-space: normal;/s.test(block));
  check("nothing in it has a fixed height", !/[^-]height: \d+px/.test(block));
  check("the smallest thing on it is still 12px",
    !/font-size: ([0-9]|1[01])px/.test(block));
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
