// ─── Is this creature in that area? Asked once, answered once. ───────────────
//
// ⚠️🔴 ACE HAD TWO ANSWERS TO THIS QUESTION AND THEY DISAGREED.
//
//   SaveEngine._getTokensInTemplate   half-coverage: a square counts when the
//                                     area covers about half of it
//   ConcentrationWidget._tokenInside  a single centre point of the whole token
//
// The first decides who is caught WHEN THE SPELL IS CAST. The second decides
// who is caught when they WALK IN or START THEIR TURN inside. So a creature
// standing half inside a Moonbeam took the save on the cast, stepped out, and
// walked back in to take nothing at all - because the second test only asked
// about the middle of his token, which was still outside.
//
// Johnny, 2026-08-27, reading his own board: "the direct west token is clearly
// half covered, so yes, it would be affected... the guy in the southwest corner
// is just a quarter." He is describing the half-coverage rule exactly, and it
// was only ever applied on one of the two paths.
//
// ⚠️ ONE FUNCTION, BOTH CALLERS. Two implementations of one rule do not stay
// in step; they drift until somebody notices a creature being damaged on the
// way in and not on the way back.
//
// ⚠️ AND IT IMPORTS NOTHING. ace-qol.mjs is the hub of 130+ static cycles, and
// this is called from the middle of the save path and the movement path both.
// A geometry helper caught in an evaluation cycle would answer `undefined`,
// which reads exactly like "nobody is in the area".

/** Sample points across a square: thirds, avoiding the edges. */
const SAMPLES = [1 / 6, 3 / 6, 5 / 6];

/**
 * Does this creature's space put it inside the template?
 *
 * @param {Token}  token      the placeable
 * @param {object} template   the template PLACEABLE (needs .shape, .x, .y)
 * @param {object} [at]       {x, y} to test instead of the token's current spot
 * @param {object} [opts]
 * @param {boolean} [opts.anyOverlapCounts]  2024 rule: touching is enough
 * @param {boolean} [opts.whollyInside]      the spell says "wholly within"
 * @returns {boolean}
 */
export function isTokenInTemplate(token, template, at = null, opts = {}) {
  try {
    const doc = token?.document;
    const shape = template?.shape;
    if (!doc || !shape?.contains) return false;

    const grid = canvas?.grid?.size ?? 100;
    const w = Number(doc.width) > 0 ? Number(doc.width) : 1;
    const h = Number(doc.height) > 0 ? Number(doc.height) : 1;
    const originX = at?.x ?? doc.x;
    const originY = at?.y ?? doc.y;

    const inShape = (wx, wy) => shape.contains(wx - template.x, wy - template.y);

    let squaresIn = 0;
    const squares = w * h;

    for (let gx = 0; gx < w; gx++) {
      for (let gy = 0; gy < h; gy++) {
        const sqX = originX + gx * grid;
        const sqY = originY + gy * grid;

        // Fast path: dead centre, which is what most hits are.
        let inside = inShape(sqX + grid / 2, sqY + grid / 2);

        if (!inside) {
          let covered = 0;
          for (const fx of SAMPLES) {
            for (const fy of SAMPLES) {
              if (inShape(sqX + fx * grid, sqY + fy * grid)) {
                covered++;
                // ⚠️ 2024: one point inside is the whole test. A creature is
                // affected if ANY part of its space is in the area.
                if (opts.anyOverlapCounts) { inside = true; break; }
              }
            }
            if (inside) break;
          }
          // ⚠️ 2014 (DMG, Areas of Effect on a Grid): the area has to cover
          // about half the square. Five of nine lattice points is a direct,
          // cheap approximation and it is DETERMINISTIC - the same board
          // always gives the same answer, so a save that fires once fires
          // every time.
          if (!inside && covered >= 5) inside = true;
        }

        if (inside) {
          if (!opts.whollyInside) return true;
          squaresIn++;
        } else if (opts.whollyInside) {
          return false;   // one square out is enough to fail "wholly within"
        }
      }
    }

    return opts.whollyInside ? squaresIn === squares : false;
  } catch (err) {
    // ⚠️ "COULD NOT TEST" MUST NOT LOOK LIKE "NOT IN THE AREA". Saying false
    // here silently drops a creature out of a fireball, so it is said out loud.
    console.warn("ace-qol | the template hit-test threw for "
      + `"${token?.name ?? "a token"}" - treating it as OUTSIDE the area:`, err);
    return false;
  }
}

/**
 * Which edition's inclusion rule does this table use?
 *
 * ⚠️ THE TWO EDITIONS GENUINELY DISAGREE, and neither reading is a bug -
 * using the wrong one for the table is. 2014's grid guidance is a COVERAGE
 * rule; 2024 says a creature is affected if any part of its space is in the
 * area. Johnny's world is 2014, and reading his own board he confirmed the
 * coverage rule matches what he expects: half in saves, a corner clip does not.
 *
 * @param {Function} getActiveEdition  passed in so this file imports nothing
 */
export function anyOverlapCounts(getActiveEdition) {
  try { return getActiveEdition?.(null) === "2024"; }
  catch (_) { return false; }   // unknown edition -> the older, stricter rule
}
