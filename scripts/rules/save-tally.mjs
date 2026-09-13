// ─── Three of a kind: a save that keeps score ───────────────────────────────
//
// Prismatic Wall's indigo layer (and Flesh to Stone in 2014): the creature
// saves at the end of each of its turns and the first to three decides it.
// Three successes and the condition ends; three failures and it turns to stone.
// "The successes and failures needn't be consecutive; keep track of both until
// the target collects three of a kind."
//
// ⚠️ THE SCORE LIVES ON THE EFFECT, not in memory here, so a reload between two
// of its turns loses nothing. This file only does the counting.
//
// ⚠️ IMPORTS NOTHING.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Record one save.
 *
 * @param {{need?:number, successes?:number, failures?:number}} tally
 * @param {boolean} passed
 * @returns {{tally:{need:number, successes:number, failures:number},
 *            outcome:"continues"|"ends"|"escalates"}}
 */
export function recordTallySave(tally, passed) {
  const whole = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const need = Math.max(1, whole(tally?.need) || 3);
  const successes = whole(tally?.successes) + (passed ? 1 : 0);
  const failures = whole(tally?.failures) + (passed ? 0 : 1);
  const outcome = successes >= need ? "ends" : (failures >= need ? "escalates" : "continues");
  return { tally: { need, successes, failures }, outcome };
}

/** "1 success and 2 failures so far" */
export function describeTally(tally) {
  const s = Math.max(0, Math.floor(Number(tally?.successes) || 0));
  const f = Math.max(0, Math.floor(Number(tally?.failures) || 0));
  return `${s} ${s === 1 ? "success" : "successes"} and ${f} ${f === 1 ? "failure" : "failures"} so far`;
}
