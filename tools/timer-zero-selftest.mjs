// ─── AT ZERO THE EFFECT IS DELETED ───────────────────────────────────────────
//
// His table, 2026-10-02: "Any effect with a timer comes off at zero. Charm,
// Bless, and everything else. Escher still has four charms: Charmed by Lamia at
// -4200 seconds, Charmed by Kasimir at -2400, and two more by Lamia at -1800 and
// -1200. The clock counted through zero and left them on. At zero the effect is
// deleted. It does not go negative."
//
// THE CAUSE: three sweeps expire effects — turn change, the stale sweep, and the
// world-time one — and the world-time one asked a different question. It looked
// for ACE's own `worldTimeStart` flag and nothing else, so an effect carrying
// Foundry's own anchor (`duration.startTime` + `seconds`, which is what the
// condition library stamps and what the yellow bar counts down) was invisible to
// it. Outside combat, with no scene change, that is the ONLY sweep a clock
// advance runs.
//
// AND THE ORDER WAS WRONG in the shared test: a run-out effect with no anchor
// was sent back to be re-anchored, and an anchor stamped now restarts a clock
// that had already finished.
//
// Run:  node tools/timer-zero-selftest.mjs
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(64)} ${detail}`);
};

const src = readFileSync("D:/FoundryVTT/Data/modules/ace-qol/scripts/duration-tracker.mjs", "utf8");

/* ── The shared test, lifted verbatim from the module ──────────────────────
   ⚠️ duration-tracker.mjs cannot be imported outside Foundry (it reads the
   `foundry` global at load), so the rule is read out of the file and run here.
   The slice is checked first: if the function is renamed or restructured, this
   fails loudly instead of testing a stale copy. */
const at = src.indexOf("static _staleState(effect, combat) {");
check("the one test is where this pin expects it", at > 0, "_staleState");
const body = src.slice(at, src.indexOf("\n  }", at) + 4);

const MODULE_ID = "ace-qol";
globalThis.game = { time: { worldTime: 10000 }, combat: null };
const _shouldPreserve = (effect) => {
  if (effect.statuses?.has?.("bloodied")) return true;
  if (/bloodied/i.test(effect.name ?? "")) return true;
  const d = effect.duration;
  const hasDur = (d?.rounds ?? 0) > 0 || (d?.turns ?? 0) > 0 || (d?.seconds ?? 0) > 0;
  return !hasDur;
};
const DurationTracker = { _shouldPreserve };
// eslint-disable-next-line no-new-func
const staleState = new Function("DurationTracker", "game", "MODULE_ID",
  `${body.replace("static _staleState", "return function _staleState")}`
)(DurationTracker, globalThis.game, MODULE_ID);

/** An effect as Foundry hands one over: `remaining` is a live getter there. */
const fx = ({ name = "Charmed by Lamia", seconds = 3600, startTime = null,
              rounds = 0, turns = 0, startRound = null, remaining = undefined,
              statuses = [] } = {}) => ({
  name, statuses: new Set(statuses),
  duration: { seconds, startTime, rounds, turns, startRound,
    remaining: remaining === undefined
      ? (seconds ? seconds - (globalThis.game.time.worldTime - (startTime ?? globalThis.game.time.worldTime)) : null)
      : remaining },
});

console.log("\nHIS FOUR CHARMS");
{
  for (const [who, rem] of [["Lamia", -4200], ["Kasimir", -2400], ["Lamia", -1800], ["Lamia", -1200]]) {
    check(`Charmed by ${who} at ${rem}s is deleted`,
      staleState(fx({ name: `Charmed by ${who}`, startTime: 1, remaining: rem }), null) === "expire");
  }
  check("and exactly at zero, not one second after",
    staleState(fx({ startTime: 1, remaining: 0 }), null) === "expire");
  check("a timer still running is left alone",
    staleState(fx({ startTime: 9400, remaining: 600 }), null) === null, "600s left");
}

console.log("\nIT DOES NOT GO NEGATIVE, WHATEVER ELSE IS TRUE");
{
  /* ⚠️🔴 THE ORDER. A run-out effect with no anchor used to be sent back for a
     fresh one, and an anchor stamped now restarts a clock that had finished. */
  check("a run-out effect with no anchor is deleted, not re-started",
    staleState(fx({ startTime: null, remaining: -900 }), null) === "expire",
    "zero wins over the anchor question");
  check("an effect that never started still gets its clock",
    staleState(fx({ startTime: null, remaining: 3600 }), null) === "anchor");
}

console.log("\nAND NOTHING WITHOUT A TIMER IS TOUCHED");
{
  check("a permanent effect is left alone",
    staleState(fx({ seconds: 0, remaining: null }), null) === null);
  check("Bloodied is left alone", staleState(fx({ name: "Bloodied", seconds: 0 }), null) === null);
  check("and so is a condition marked bloodied by status",
    staleState(fx({ name: "Hurt", seconds: 3600, startTime: 1, statuses: ["bloodied"] }), null) === null);
}

console.log("\nTHE THREE SWEEPS ASK THE SAME QUESTION");
{
  check("the turn-change sweep asks it",
    /const state = DurationTracker\._staleState\(effect, combat\);/.test(src));
  check("the stale sweep asks it",
    (src.match(/DurationTracker\._staleState\(effect, combat\)/g) ?? []).length >= 2);
  /* ⚠️🔴 THE ONE THAT DID NOT, AND THE ONLY ONE A CLOCK ADVANCE RUNS. */
  check("and the world-time sweep asks it now",
    /_staleState\(effect, game\.combat \?\? null\)/.test(src), "the four charms' path");
  check("the world-time sweep still knows ACE's own stamp as a second chance",
    /worldTimeStart/.test(src));
}

console.log("\nA SWEEP THAT WALKS PAST A DEAD TIMER SAYS SO");
{
  /* ⚠️ Four charms sat there through reload after reload and every sweep that
     passed them printed nothing, so there was no way to tell a sweep that found
     them healthy from one that never looked. */
  check("it reports what it deleted and what it started",
    /deleted \$\{expired\} that had run out/.test(src));
  check("and warns by name about any it left on past zero",
    /LEFT \$\{leftOn\.length\} on with a timer already past zero/.test(src));
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
