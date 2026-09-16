// ─── Does a creature standing in the area actually get caught? ───────────────
//
// ⚠️ WHY THIS EXISTS. `_getTokensInTemplate` used to test ONE point per square:
// the exact centre. That is the strictest reading of "is the creature in the
// area" that exists, and it fails in ways a person watching the table can see:
// a goblin three-quarters inside a cone takes nothing because the middle pixel
// fell outside the edge (Johnny, 2026-08-24: "The Goblin is inside the
// template, well within the 15 ft").
//
// It then sampled a 3x3 lattice per square and asked for five of nine, which is
// the 2014 DMG's "at least half the square" (p.251, Areas of Effect on a Grid).
// That is the rule this file used to lift out of the shipped source and
// demonstrate against a real cone.
//
// ⚠️🔴 AND ON 2026-09-16 HIS TABLE REPLACED IT, with a Large Draft Horse whose
// space the 2014 Spirit Guardians circle plainly cut: "A creature is in the
// template if ANY part of its occupied space intersects the area. Edge touching
// counts. Do not require the token's center to sit inside the circle. Same rule
// for every template ACE tests." Nine points inside a square all miss a circle
// that clips one of its corners, which is exactly the horse, so the shipped
// test is geometry now rather than sampling.
//
// ⚠️ SO THIS DRIVES THE SHIPPED FUNCTION, it no longer lifts constants out of
// it. It was renamed from template-coverage-check.mjs on 2026-09-16 and joined
// the self-tests the release check runs, which is the stronger form of its own
// old warning: "do not delete it, or the rule goes untested".
import { isTokenInTemplate } from "../scripts/template-geometry.mjs";

const GRID = 100;          // pixels per square
globalThis.canvas = { grid: { size: GRID }, scene: { grid: { distance: 5 } } };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(64)} got ${got}, want ${want}`);
};

/** A PIXI-style circle, in the template's own coordinates. */
const circle = (radius) => ({
  x: 0, y: 0, radius,
  contains: (px, py) => (px * px + py * py) <= radius * radius,
});

/** A PIXI-style polygon: a 15-foot cone pointing east, as Foundry builds one. */
const cone = () => {
  const pts = [0, 0, 300, -150, 300, 150];
  return {
    points: pts,
    contains: (px, py) => {
      // Point in triangle, by sign of the cross products.
      const [ax, ay, bx, by, cx, cy] = pts;
      const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
      const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
      const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
      const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      return !(neg && pos);
    },
  };
};

/** A token placeable, as the hit-test reads one: a document with a size. */
const token = (x, y, cells = 1) => ({ document: { x, y, width: cells, height: cells, elevation: 0 } });
/** The template placeable: a shape and where its origin sits on the canvas. */
const at = (shape, x = 0, y = 0) => ({ shape, x, y });

console.log("\nANY PART OF ITS SPACE, AND AN EDGE COUNTS");
{
  // A 15-foot emanation: 300 pixels at 100 pixels to the square.
  const sg = at(circle(300));

  // ⚠️ THE HORSE. A Large creature whose nearest square is clipped at the
  // corner: its centre is 353 pixels out and every one of the nine sample
  // points the old rule used is outside the circle, so it used to be left out
  // of the tick. The circle cuts its space, so it is in it.
  check("a Large creature the circle clips at one corner is in the area",
    isTokenInTemplate(token(200, 200, 2), sg), true);

  // The same creature, one square further out, touches nothing.
  check("and one that is clear of it is not",
    isTokenInTemplate(token(320, 320, 2), sg), false);

  // Edge touching: a square whose corner sits exactly on the circle.
  check("a square whose corner sits exactly on the edge counts",
    isTokenInTemplate(token(300, 0, 1), sg), true);

  // A Medium creature whose square the circle falls short of, and one it reaches.
  check("a Medium creature the circle falls short of is out",
    isTokenInTemplate(token(290, 290, 1), sg), false);
  check("and it is in as soon as the circle touches its square",
    isTokenInTemplate(token(210, 210, 1), sg), true);

  // The old centre-point reading would have said no to all of these.
  check("dead centre still counts, obviously",
    isTokenInTemplate(token(-50, -50, 1), sg), true);
}

console.log("\nA CONE IS A POLYGON, AND ITS EDGE COUNTS TOO");
{
  const spray = at(cone());
  check("a creature the cone's edge cuts is in it",
    isTokenInTemplate(token(250, 100, 1), spray), true);
  check("a creature past its point is not",
    isTokenInTemplate(token(400, 0, 1), spray), false);
  check("a creature beside it, untouched, is not",
    isTokenInTemplate(token(100, -300, 1), spray), false);
  // A square the cone crosses without any of the square's own points being
  // inside it: the polygon's edge does the work.
  check("a square a long edge crosses is in, with no point of it inside",
    isTokenInTemplate(token(100, -60, 1), spray), true);
}

console.log("\n\"WHOLLY WITHIN\" IS A DIFFERENT QUESTION");
{
  const web = at(circle(300));
  check("a creature only clipped by the area is NOT wholly within it",
    isTokenInTemplate(token(200, 200, 2), web, null, { whollyInside: true }), false);
  check("one standing fully inside it is",
    isTokenInTemplate(token(-50, -50, 1), web, null, { whollyInside: true }), true);
  check("a Large creature fully inside it is too",
    isTokenInTemplate(token(-100, -100, 2), web, null, { whollyInside: true }), true);
}

console.log("\nNOTHING THROWS ON RUBBISH");
{
  check("no token", isTokenInTemplate(null, at(circle(300))), false);
  check("no shape", isTokenInTemplate(token(0, 0, 1), { x: 0, y: 0 }), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
