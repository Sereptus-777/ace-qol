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

// ─── How tall is that area? ────────────────────────────────────────
//
// ⚠️🔴 EVERY AREA SPELL IN ACE WAS FLAT. The hit-test above asks x and y
// and nothing else, so a dragon hovering two hundred feet over a Moonbeam was
// standing in it. ACE reads elevation thirty-odd times for falling, flight and
// terrain regions, and never once for the question of who is inside a spell.
//
// Johnny, 2026-08-28, reading Moonbeam's own text: "that 40-foot-high cylinder,
// that's what caught my eye. For elevation, would have something's flying above
// the Moonbeam, right?" Right, and it would have been caught by it.
//
// ⚠️ WHEN THE HEIGHT IS UNKNOWN, NOBODY IS EXCLUDED. This gate can only ever
// take creatures OUT of an area, so a wrong guess about a spell's height is a
// creature silently missed by a fireball - the worst possible failure here, and
// invisible from the GM's chair. `verticalBand` returns null whenever it cannot
// prove the extent, and null means "do not filter". Being flat is the thing we
// are fixing; being confidently wrong would be worse than staying flat.
//
// ⚠️ dnd5e THROWS THE SHAPE AWAY. It maps sphere, radius AND cylinder all onto
// a Foundry `circle`, so the template on the canvas cannot tell you which it
// was. The original shape has to come back from the spell that made it, via the
// origin flag dnd5e writes onto the template.

/**
 * Cylinder heights the rules state separately, because dnd5e stores none of
 * them. These seven are the complete set of cylinder spells in the book -
 * counted, not remembered (2026-08-28).
 */
const CYLINDER_HEIGHTS = {
  "call lightning":  10,
  "flame strike":    40,
  "ice storm":       40,
  "magic circle":    20,
  "moonbeam":        40,
  "sleet storm":     20,
  "reverse gravity": 100,
};

const _shapeCache = new Map();   // template id -> {shape, name} | null
const _toldAbout  = new Set();   // template ids we have already complained about

/** The D&D shape and spell name behind a placed template, or null. */
function _originOf(templateDoc) {
  const id = templateDoc?.id;
  if (id && _shapeCache.has(id)) return _shapeCache.get(id);
  let out = null;
  try {
    const origin = templateDoc?.flags?.dnd5e?.origin;
    const doc = origin ? fromUuidSync?.(origin) : null;
    const item = doc?.item ?? doc;                       // activity -> item, or the item
    const shape = item?.system?.target?.template?.type ?? null;
    if (shape) out = { shape: String(shape).toLowerCase(), name: String(item?.name ?? "").toLowerCase() };
  } catch (_) { out = null; }   // an unreadable origin is "unknown", never "excluded"
  if (id) {
    // Templates come and go all session; keep the cache from growing forever.
    if (_shapeCache.size > 512) _shapeCache.clear();
    _shapeCache.set(id, out);
  }
  return out;
}

/**
 * The vertical slice a template occupies, in scene units, or null if unknown.
 * @returns {{bottom:number, top:number}|null}
 */
export function verticalBand(template) {
  try {
    const doc = template?.document ?? template;
    if (!doc) return null;
    const base = Number(doc.elevation ?? 0) || 0;

    // The template's own radius / length, converted from pixels back to feet.
    const gridSize = canvas?.grid?.size ?? 100;
    const gridDist = canvas?.scene?.grid?.distance ?? 5;
    const size = Number(doc.distance ?? 0) || 0;   // dnd5e stores this in scene units already
    if (!size) return null;

    const origin = _originOf(doc);
    const shape  = origin?.shape ?? null;

    switch (shape) {
      // A sphere or an emanation reaches as far up and down as it does sideways.
      // ⚠️ Treated as a cylinder of height 2R rather than a true sphere: the
      // horizontal test above is the 2014 half-coverage rule, and re-deriving it
      // against a radius that shrinks with height would replace behaviour Johnny
      // has already checked against his own board. The difference only shows at
      // the very top and bottom corners of the ball, and it errs towards
      // INCLUDING a creature, which is the safe direction.
      case "sphere":
      case "radius":
      case "emanation":
        return { bottom: base - size, top: base + size };

      // A cylinder stands ON its point and goes up. Height is a stated number.
      case "cylinder": {
        const h = CYLINDER_HEIGHTS[origin?.name ?? ""];
        if (!h) {
          if (doc.id && !_toldAbout.has(doc.id)) {
            _toldAbout.add(doc.id);
            console.warn(`ace-qol | "${origin?.name || "a cylinder spell"}" is a cylinder `
              + `and no height is known for it, so elevation is NOT being used for this `
              + `area - everything above and below it still counts as inside. Add it to `
              + `CYLINDER_HEIGHTS in template-geometry.mjs.`);
          }
          return null;
        }
        return { bottom: base, top: base + h };
      }

      // A cube or square is as tall as it is wide, sitting on its own elevation.
      case "cube":
      case "square":
        return { bottom: base, top: base + size };

      // A cone spreads to its length at the far end, so that is its half-height.
      case "cone":
        return { bottom: base - size, top: base + size };

      // ⚠️ Walls and lines have stated heights that vary per spell and are not
      // in the item data. Unknown means unknown: no filtering.
      default:
        return null;
    }
  } catch (err) {
    console.warn("ace-qol | could not work out how tall a template is - "
      + "elevation will be ignored for it:", err);
    return null;
  }
}

/** The slice of air a creature occupies: its feet, up by its own size. */
function _tokenBand(doc) {
  const gridDist = canvas?.scene?.grid?.distance ?? 5;
  const feet  = Number(doc?.elevation ?? 0) || 0;
  const cells = Math.max(Number(doc?.width) || 1, Number(doc?.height) || 1);
  return { bottom: feet, top: feet + Math.max(cells * gridDist, gridDist) };
}

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

    // ⚠️ HEIGHT FIRST: it is cheap, and it settles the whole question on its
    // own. A creature outside the vertical slice is out no matter where its
    // squares sit on the floor.
    if (opts.ignoreElevation !== true) {
      const band = verticalBand(template);
      if (band) {
        const t = _tokenBand(doc);
        if (t.top <= band.bottom || t.bottom >= band.top) return false;
      }
    }

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
