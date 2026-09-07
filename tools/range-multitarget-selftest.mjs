// ─── One far reticle must not cancel a swing at arm's length ────────────────
//
// ⚠️🔴 THE BUG THIS EXISTS FOR. Johnny, mid-session on 2026-09-06, with a
// creature directly beside him: *"he's standing right beside this fucking
// thing, and it says he's out of range. 45 feet."* He was right and the number
// was right too. Something else across the room was ALSO targeted, and the
// range check measured `targets.first()` — whatever went into the Set first,
// which has nothing to do with what is nearest. One distant reticle cancelled
// the whole attack.
//
// ⚠️ THE SHAPE, NOT THE SPELLING. `first()` on a Set is arbitrary order
// standing in for a decision, and the same shape is worth hunting anywhere a
// rule reads one item out of a collection of targets.
//
// Run:  node tools/range-multitarget-selftest.mjs

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "  ok   " : "  FAIL ") + String(label).padEnd(58)
    + "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
};

// ── The decision, lifted out of the pipeline so it can be exercised alone ──
// This mirrors the block in attack-pipeline.mjs exactly. It is asserted against
// the source below so the two cannot drift apart.
const decide = (targets, checkRange) => {
  const ranged = [...targets].map(t => ({ token: t, ...checkRange(t) }));
  const reachable = ranged.filter(r => !r.blocked);
  const unreachable = ranged.filter(r => r.blocked);
  const nearest = (list) => list.slice().sort((a, b) => a.distanceFt - b.distanceFt)[0];
  const primary = nearest(reachable)?.token ?? nearest(ranged)?.token ?? [...targets][0];
  if (unreachable.length && !reachable.length) {
    const worst = nearest(unreachable);
    return { blocked: true, said: `${worst.distanceFt} feet away`, primary, dropped: [] };
  }
  return { blocked: false, primary, dropped: unreachable.map(r => r.token) };
};

const t = (name, ft) => ({ name, ft });
const byDistance = (x) => ({ blocked: x.ft > 5, distanceFt: x.ft, rangeDesc: "melee reach 5 feet" });

console.log("\nTHE ONE THAT HAPPENED");
{
  // The far creature was targeted FIRST, which is the whole bug: set order.
  const far = t("Thing across the room", 45), near = t("Thing beside him", 5);
  const d = decide([far, near], byDistance);
  check("the swing is allowed", d.blocked, false);
  check("and it aims at the one he is touching", d.primary.name, "Thing beside him");
  check("and it names what it dropped", d.dropped.map(x => x.name), ["Thing across the room"]);
}

console.log("\nORDER MUST NOT MATTER");
{
  const far = t("Far", 45), near = t("Near", 5);
  for (const [order, list] of [["far first", [far, near]], ["near first", [near, far]]]) {
    const d = decide(list, byDistance);
    check(`${order}: allowed`, d.blocked, false);
    check(`${order}: aims at Near`, d.primary.name, "Near");
  }
}

console.log("\nEVERYTHING OUT OF REACH IS STILL A REFUSAL");
{
  // ⚠️🔴 THE ONE THAT MUST NOT BREAK. Take this away and a melee weapon
  // reaches across the map.
  const d = decide([t("A", 45), t("B", 30)], byDistance);
  check("nothing reachable means blocked", d.blocked, true);
  // ⚠️ AND IT REPORTS THE NEAREST MISS, not an arbitrary one. "30 feet away"
  // tells him how far to walk; "45 feet away" is a different creature's number.
  check("and it quotes the nearest of them", d.said, "30 feet away");
}

console.log("\nONE TARGET BEHAVES EXACTLY AS BEFORE");
{
  check("in reach: allowed", decide([t("X", 5)], byDistance).blocked, false);
  check("out of reach: blocked", decide([t("X", 20)], byDistance).blocked, true);
  check("out of reach: still names it",
    decide([t("X", 20)], byDistance).said, "20 feet away");
}

console.log("\nAND THE PIPELINE STILL CONTAINS THIS DECISION");
{
  // ⚠️ A LOGIC COPY IN A TEST IS ONLY WORTH ANYTHING IF IT STILL MATCHES.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    "D:/FoundryVTT/Data/modules/ace-qol/scripts/attack-pipeline.mjs", "utf8");
  check("every target is measured, not just the first",
    /for \(const t of targets\) \{\s*\n\s*ranged\.push/.test(src), true);
  check("it refuses only when nothing is reachable",
    /if \(unreachable\.length && !reachable\.length\)/.test(src), true);
  check("the primary target is the nearest reachable one",
    /const firstTarget = nearest\(reachable\)\?\.token/.test(src), true);
  check("and the old arbitrary first() block is gone",
    /const rangeCheck = this\._checkRange\(actor, firstTarget/.test(src), false);
}

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
