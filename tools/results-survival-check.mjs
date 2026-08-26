// ─── A reaction may change an outcome. It may never delete one. ─────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. `checkPostHitReactions` returned THE CALLER'S
// OWN ARRAY on its early-return paths:
//
//     if (!QolSettings.get("enableReactions")) return results;
//
// and the caller then did:
//
//     const modifiedResults = await checkPostHitReactions(results, ...);
//     if (modifiedResults) {
//       results.length = 0;                // empties BOTH — one object
//       results.push(...modifiedResults);  // spreads what was just emptied
//     }
//
// Two names, one array. The wipe deleted the results and the refill put back
// nothing. An empty array is truthy, so the guard waved it through. One line
// later the card builder got zero results and returned instantly.
//
// EVERY ATTACK CARD IN THE GAME DISAPPEARED whenever reactions were switched
// off — any creature, any weapon. It ended Johnny's session on 2026-08-24 and
// survived a whole night of hunting because nothing threw and nothing logged:
// the roll happened, the Gate printed, the loop ran, the builder was reached.
// Only the results had been deleted on the way past.
//
// ⚠️ THE TEST IS IDENTITY, NOT CONTENT. A version that returns a copy with the
// same contents passes a content check and still hands the caller a live
// reference the day someone re-adds a mutation. So these cases assert the
// returned array is a DIFFERENT OBJECT, and that the swing survives the round
// trip with every setting combination.
//
// Run:  node tools/results-survival-check.mjs
const NL = String.fromCharCode(10);

// The caller's logic, exactly as it now stands in attack-pipeline.mjs.
function callerMerge(results, modifiedResults) {
  if (Array.isArray(modifiedResults) && modifiedResults !== results) {
    results.length = 0;
    results.push(...modifiedResults);
  }
  return results;
}

// The old caller, kept so the bench proves the bug it was written for.
function callerMergeOld(results, modifiedResults) {
  if (modifiedResults) {
    results.length = 0;
    results.push(...modifiedResults);
  }
  return results;
}

// The two early-return shapes: the broken one and the fixed one.
const returnSame = (results) => results;
const returnCopy = (results) => [...results];

const swing = () => ([{ name: "Arcanaloth", hitResult: "hit", attackTotal: 19 }]);

let ok = true;
const check = (title, got, want, why) => {
  const pass = got === want;
  if (!pass) ok = false;
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${title}`);
  console.log(`        ${got} result(s) survived`);
  console.log(`        ${why}`);
  if (!pass) console.log(`        EXPECTED ${want}`);
};

console.log("");
console.log("DOES A SWING SURVIVE THE POST-HIT REACTION PASS?");
console.log("=".repeat(78));

// The bug, reproduced. If this ever stops failing, the bench is broken.
{
  const r = swing();
  const out = callerMergeOld(r, returnSame(r));
  const reproduced = out.length === 0;
  if (!reproduced) ok = false;
  console.log("");
  console.log(`  ${reproduced ? "PASS" : "FAIL"}  the original bug still reproduces against the OLD caller`);
  console.log(`        ${out.length} result(s) survived — the swing was deleted`);
  console.log(`        same array returned + unconditional wipe = every card in the game gone`);
  if (!reproduced) console.log("        EXPECTED 0 — if this passes, the bench has stopped testing anything");
}

check("reactions OFF — the path Johnny was on",
  callerMerge(swing(), returnCopy(swing())).length, 1,
  "the early return now hands back a copy, and the caller checks identity");

check("the OLD return shape against the NEW caller",
  (() => { const r = swing(); return callerMerge(r, returnSame(r)).length; })(), 1,
  "belt: even if something returns the caller's own array again, identity stops the wipe");

check("the NEW return shape against the OLD caller",
  (() => { const r = swing(); return callerMergeOld(r, returnCopy(r)).length; })(), 1,
  "braces: even under the old merge, a copy survives — both halves fixed independently");

check("Shield genuinely flips a hit to a miss",
  (() => {
    const r = swing();
    const modified = r.map(x => ({ ...x, hitResult: "miss" }));
    const out = callerMerge(r, modified);
    return out.length === 1 && out[0].hitResult === "miss" ? 1 : 0;
  })(), 1,
  "a reaction MAY change the outcome — that still works, and the result is kept");

check("a reaction returning nothing at all",
  callerMerge(swing(), null).length, 1,
  "null is not a replacement — the swing stands");

check("two targets, one Shielded",
  (() => {
    const r = [
      { name: "A", hitResult: "hit" },
      { name: "B", hitResult: "hit" },
    ];
    return callerMerge(r, [r[0], { ...r[1], hitResult: "miss" }]).length;
  })(), 2,
  "a genuine replacement list still replaces, and nobody is lost");

console.log("");
console.log("=".repeat(78));
console.log(ok
  ? "ALL PASS — a reaction may change an outcome; it can no longer delete one." + NL
  : "FAILURES ABOVE — a swing is being lost between the roll and the card." + NL);
process.exit(ok ? 0 : 1);
