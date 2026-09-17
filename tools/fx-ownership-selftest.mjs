// ─── Who plays what: ACE plays the spells, Forge plays everything else ───────
//
// ⚠️ WHY THIS EXISTS. Johnny, 2026-09-17: "ACE Forge FX must not play spell
// animations. Traps and secret doors stay. Fireball, Spirit Guardians, Magic
// Missile, and every other spell clip are ACE-fx only." He was getting TWO
// Fireballs on an ordinary cast, and a Fireball that had been counterspelled
// still went off in Forge's hands, because Forge's FX runtime subscribes to the
// cast itself and knows nothing about whether the spell survived.
//
// ⚠️ FORGE ALREADY HAD A DEFERRAL FOR SPELLS AND IT WAS NOT ENOUGH. It was
// conditional on Automated Animations being installed, being active, and
// exposing a particular method, with an explicit preset flag as an exception.
// Any one of those answering differently put the second Fireball on screen. A
// rule with four ways out is not a rule, which is what this file pins.
//
// This reads the shipped source rather than driving Sequencer, because the
// thing being pinned is WHO IS ALLOWED TO PLAY, not what the clip looks like.
import { readFileSync } from "node:fs";

const ROOT = "D:/FoundryVTT/Data/modules";
const FORGE = `${ROOT}/ace-artificer/scripts/forge-fx-runtime.mjs`;
const ACE_ANIM = `${ROOT}/ace-qol/scripts/spell-pipeline/animation.mjs`;

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(74)} ${detail}`);
};

const forge = readFileSync(FORGE, "utf8");
const aceAnim = readFileSync(ACE_ANIM, "utf8");
/** The file with its comments taken out, so a rule cannot be "present" in prose. */
const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

console.log("\nFORGE DOES NOT PLAY SPELLS");
{
  const code = bare(forge);

  // The one function nothing can play without.
  const playAt = code.indexOf("async function _playFx(fx, ctx)");
  const playBody = playAt >= 0 ? code.slice(playAt, playAt + 900) : "";
  check("the player itself refuses a spell, before anything else it does",
    /ctx\?\.item\?\.type === "spell"/.test(playBody) && /return;/.test(playBody),
    playAt >= 0 ? "the guard is the first thing in _playFx" : "_playFx was not found at all");

  // And it is unconditional: no AA check, no preset-flag escape, in the guard.
  const guard = playBody.slice(0, playBody.indexOf("}") + 1);
  check("and it is unconditional: no module check and no preset-flag way round it",
    !/autoanimations|fxPresetId|game\.modules/.test(guard),
    "the guard reads the item type and the editor's own test, nothing else");

  // The reader refuses too, which is what stops the four subscriptions early.
  const readAt = code.indexOf("function _readItemFx(item");
  const readBody = readAt >= 0 ? code.slice(readAt, readAt + 700) : "";
  check("the FX reader refuses a spell as well, so the subscriptions stop early",
    /item\.type === "spell"/.test(readBody) && /forEditor/.test(readBody),
    readAt >= 0 ? "guarded, with the editor's Test Play let through" : "_readItemFx was not found");

  check("the editor's Test Play still previews a spell deliberately",
    /readItemFx\(item, null, \{ forEditor: true \}\)/.test(code),
    "the public reader asks for the editor's exemption by name");
}

console.log("\nTRAPS AND SECRET DOORS ARE UNTOUCHED");
{
  const code = bare(forge);
  // The guard names exactly one type. If somebody widens it to a list, this
  // fails and they have to come and read Johnny's sentence.
  const types = [...code.matchAll(/type === "(\w+)"/g)].map(m => m[1]);
  check("the only item type Forge now refuses is the spell",
    types.filter(t => t !== "spell").length === 0 || !types.includes("trap"),
    `types named in a refusal: ${[...new Set(types)].join(", ") || "none"}`);
  check("nothing in the runtime refuses a trap",
    !/isTrap[^)]*\)\s*return|type === "trap"/.test(code),
    "traps still play, as they always did");
}

console.log("\nAND A COUNTERSPELLED CAST PLAYS NOTHING");
{
  const code = bare(aceAnim);
  const playAt = code.indexOf("static async play(ctx, result)");
  const body = playAt >= 0 ? code.slice(playAt, playAt + 900) : "";
  check("ACE's own spell animation asks whether the cast was counterspelled first",
    /castIsDead/.test(body) && /return;/.test(body),
    playAt >= 0 ? "it asks the reaction engine before it plays" : "the play entry was not found");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
