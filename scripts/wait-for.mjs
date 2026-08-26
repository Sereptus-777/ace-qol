// ─── Wait for the thing, not for the clock ───────────────────────────────────
//
// ⚠️🔴 WHY THIS EXISTS. A timer audit on 2026-08-26 found the roll path full
// of `await new Promise(r => setTimeout(r, N))`. Most turned out to be fine —
// user-configurable pacing, cache expiry, deliberate beats between dice. But
// two were the dangerous kind: a fixed sleep taken in the HOPE that one of
// dnd5e's hooks would fire during it.
//
//   · save-engine.mjs slept 200ms hoping `postCreateUsageMessage` had run,
//     then checked once. If it had not run yet, the fallback engaged and the
//     same cast was handled twice — the bug the sleep was added to prevent.
//   · reaction-engine.mjs slept 250ms hoping the V2 hook had claimed the
//     activity, then checked once. Same shape, same double.
//
// ⚠️ THE PROBLEM IS NOT THE NUMBER, IT IS THE SHAPE. Raising 200 to 500 makes
// the race rarer and every cast half a second slower. Sleeping and checking
// once is the worst of both: it pays the full delay every single time AND
// still loses whenever the machine is busier than the guess. Johnny's table
// runs four players, Dice So Nice, and a loaded scene; the guess was made on
// an idle one.
//
// ⚠️ SO: POLL FOR THE ACTUAL CONDITION. Exit the instant it becomes true, and
// treat the timer as a DEADLINE rather than a duration. That is strictly
// better in both directions - the common case gets faster (the hook usually
// fires in a few milliseconds, and we stop right there), and because waiting
// longer now costs nothing unless the condition genuinely never arrives, the
// deadline can be generous enough to survive a busy table.
//
// This does not abolish the race. Nothing can, without a real signal from
// dnd5e. It widens the window by a lot and makes the common path quicker,
// and when the deadline does win it SAYS SO instead of proceeding as though
// nothing happened.
//
// ⚠️ IMPORTS NOTHING, ON PURPOSE. ace-qol.mjs is the hub of 130+ static
// import cycles; a helper used this deep in the pipelines must not be able to
// join one. Same reason why-not.mjs hardcodes the id.
const MODULE_ID = "ace-qol";

/**
 * Wait until `test()` returns truthy, or until the deadline passes.
 *
 * @param {() => (boolean|Promise<boolean>)} test  checked immediately, then every stepMs
 * @param {object}  [opts]
 * @param {number}  [opts.maxMs=600]   how long to keep asking before giving up
 * @param {number}  [opts.stepMs=20]   how often to ask
 * @param {string}  [opts.what]        plain-English name, used only if it times out
 * @param {boolean} [opts.quiet=false] suppress the timeout line (for expected misses)
 * @returns {Promise<boolean>} true if the condition became true, false on deadline
 */
export async function waitUntil(test, {
  maxMs = 600, stepMs = 20, what = "a condition", quiet = false,
} = {}) {
  const deadline = Date.now() + Math.max(0, Number(maxMs) || 0);
  const step = Math.max(1, Number(stepMs) || 20);

  for (;;) {
    // ⚠️ ASKED BEFORE THE FIRST SLEEP. If the condition already holds, this
    // costs nothing at all - which is the whole point, and is exactly what
    // the sleep-then-check version could never do.
    try {
      if (await test()) return true;
    } catch (err) {
      // A test that throws is a broken test, not a false condition. Say so
      // rather than silently polling a function that can never succeed.
      console.warn(`${MODULE_ID} | while waiting for ${what}, the check itself `
        + `threw - treating it as not yet true:`, err);
    }
    if (Date.now() >= deadline) {
      if (!quiet) {
        // ⚠️ REPORT THE OUTCOME, NOT THE INTENTION. A deadline that wins is
        // the interesting case: it means the thing we were waiting for never
        // arrived, and whatever happens next is the fallback path.
        console.debug(`${MODULE_ID} | ${what} did not arrive within ${maxMs}ms; `
          + `continuing on the fallback path.`);
      }
      return false;
    }
    await new Promise(r => setTimeout(r, step));
  }
}
