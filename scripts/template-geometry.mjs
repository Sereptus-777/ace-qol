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
// ⚠️ AND IT IMPORTS ONLY A LEAF. ace-qol.mjs is the hub of 130+ static cycles,
// and this is called from the middle of the save path and the movement path
// both. A geometry helper caught in an evaluation cycle would answer
// `undefined`, which reads exactly like "nobody is in the area". Its one import,
// geometry-utils.mjs, imports nothing itself (made a leaf 2026-09-18 so the
// template and every distance could share one answer to "which squares is this
// creature standing in").

// A creature's space: the one rule, shared with every distance (a leaf import).
import { aceTokenSpace } from "./geometry-utils.mjs";

/** A hair's width, so a square that only just touches an edge still counts. */
const TOUCH = 1e-6;

/** Does the segment a→b cross the rectangle, or lie inside it? */
function _segmentHitsRect(ax, ay, bx, by, rx, ry, rw, rh) {
  const x0 = rx, y0 = ry, x1 = rx + rw, y1 = ry + rh;
  // Liang-Barsky: the segment clipped to the rectangle, in one pass.
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < -TOUCH) return false; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/**
 * Does any part of this square touch the area?
 *
 * ⚠️🔴 ANY PART, AND AN EDGE COUNTS. Johnny, 2026-09-16, with a Large Draft
 * Horse whose space the Spirit Guardians circle plainly cut: "A creature is in
 * the template if ANY part of its occupied space intersects the area. Edge
 * touching counts. Do not require the token's center to sit inside the circle."
 * That replaces the half-coverage reading of 2026-08-27 and the centre-point one
 * before it, for every template ACE tests.
 *
 * ⚠️ POINTS ARE NOT ENOUGH, WHICH IS WHY THIS IS GEOMETRY. Nine sample points
 * inside a square all miss a circle that clips one corner of it, and that corner
 * is exactly the horse's case. So: a point of the square inside the shape, the
 * nearest point of the square to a circle's centre, a polygon vertex inside the
 * square, or a polygon edge crossing it. Cones, lines and walls all reach ACE as
 * polygons, and circles as circles.
 *
 * All coordinates are the shape's own, which sit relative to the template's
 * origin: the caller translates.
 */
function _squareTouchesShape(shape, rx, ry, size) {
  const x1 = rx + size, y1 = ry + size;
  // 1. A corner, an edge midpoint or the centre inside the shape.
  const pts = [[rx, ry], [x1, ry], [rx, y1], [x1, y1], [rx + size / 2, ry + size / 2],
               [rx + size / 2, ry], [rx + size / 2, y1], [rx, ry + size / 2], [x1, ry + size / 2]];
  for (const [px, py] of pts) {
    if (shape.contains(px, py)) return true;
  }
  // 2. A circle: the nearest point of the square to its centre.
  const pointList = Array.isArray(shape?.points) ? shape.points : null;
  if (!pointList && Number.isFinite(shape?.radius) && Number.isFinite(shape?.x) && Number.isFinite(shape?.y)) {
    const nx = Math.min(Math.max(shape.x, rx), x1);
    const ny = Math.min(Math.max(shape.y, ry), y1);
    const dx = shape.x - nx, dy = shape.y - ny;
    return (dx * dx + dy * dy) <= (shape.radius * shape.radius) + TOUCH;
  }
  // 3. A polygon: a vertex inside the square, or an edge crossing it.
  if (pointList && pointList.length >= 6) {
    for (let i = 0; i + 1 < pointList.length; i += 2) {
      const px = pointList[i], py = pointList[i + 1];
      if (px >= rx - TOUCH && px <= x1 + TOUCH && py >= ry - TOUCH && py <= y1 + TOUCH) return true;
    }
    for (let i = 0; i + 1 < pointList.length; i += 2) {
      const ax = pointList[i], ay = pointList[i + 1];
      const bx = pointList[(i + 2) % pointList.length], by = pointList[(i + 3) % pointList.length];
      if (_segmentHitsRect(ax, ay, bx, by, rx, ry, size, size)) return true;
    }
    return false;
  }
  // 4. Anything else with a bounding box (a rectangle, an ellipse): overlap it.
  if (Number.isFinite(shape?.x) && Number.isFinite(shape?.y)
    && Number.isFinite(shape?.width) && Number.isFinite(shape?.height)) {
    return !(x1 < shape.x - TOUCH || rx > shape.x + shape.width + TOUCH
      || y1 < shape.y - TOUCH || ry > shape.y + shape.height + TOUCH);
  }
  return false;
}

/** Is every corner and the centre of this square inside the shape? */
function _squareWhollyInside(shape, rx, ry, size) {
  const x1 = rx + size, y1 = ry + size;
  return [[rx, ry], [x1, ry], [rx, y1], [x1, y1], [rx + size / 2, ry + size / 2]]
    .every(([px, py]) => shape.contains(px, py));
}

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
    // ⚠️ THE ACTIVITY FIRST. dnd5e 5.x keeps a spell's area on its activity,
    // and the origin flag names the activity; the item's own field is the
    // fallback for the item types that still carry one.
    const shape = doc?.target?.template?.type ?? item?.system?.target?.template?.type ?? null;
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
      case "square": {
        // ⚠️🔴 A CUBE'S `distance` IS ITS DIAGONAL, NOT ITS SIDE. dnd5e builds
        // a cube as a Foundry `rect` template with distance = Math.hypot(size,
        // size) and direction 45 (dnd5e.mjs, AbilityTemplate.fromActivity).
        // Read as a height, that made every 30 foot cube 42 feet tall: Hypnotic
        // Pattern's card said "the area reaches from 0 to 42 feet" (2026-09-10).
        // Rounded so a creature standing exactly on the top face is judged by
        // the rule, not by a floating point remainder.
        const isRect = String(doc.t ?? "").toLowerCase() === "rect";
        const side = isRect ? Math.round((size / Math.SQRT2) * 1e6) / 1e6 : size;
        return { bottom: base, top: base + side };
      }

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

/**
 * The slice of air a creature occupies, for anything that has to explain a
 * height decision. ONE reader: the out-of-reach report asks this rather than
 * working the creature's height out again and disagreeing with the hit-test.
 */
export function tokenBand(doc) { return _tokenBand(doc); }

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

    // ⭐ THE SQUARES IT STANDS IN, by the one space rule (geometry-utils,
    // aceTokenSpace), the same space reach, range and the opportunity attack
    // measure from. A picture a hair off the grid is still in its square
    // (2026-09-18: a kobold 41 pixels off its square read 10 feet away).
    const grid = canvas?.grid?.size ?? 100;
    const space = aceTokenSpace(token, at ? { x: at.x, y: at.y } : null);
    const w = Math.max(1, Math.round(space.w / grid));
    const h = Math.max(1, Math.round(space.h / grid));
    const originX = space.x;
    const originY = space.y;

    let squaresIn = 0;
    const squares = w * h;

    for (let gx = 0; gx < w; gx++) {
      for (let gy = 0; gy < h; gy++) {
        // The square, in the shape's own coordinates.
        const sqX = originX + gx * grid - template.x;
        const sqY = originY + gy * grid - template.y;

        // ⚠️ "WHOLLY WITHIN" IS A DIFFERENT QUESTION AND KEEPS ITS OWN ANSWER.
        // Web and Stinking Cloud say a creature has to be wholly inside, so
        // every square it stands on must be fully covered, not merely touched.
        const inside = opts.whollyInside
          ? _squareWhollyInside(shape, sqX, sqY, grid)
          : _squareTouchesShape(shape, sqX, sqY, grid);

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
 * ⚠️🔴 FROZEN, 2026-09-16. There is no edition gate on who an area catches, and
 * no option to ask for one. His words: "EVERY ACE template uses real geometry
 * overlap: token occupied space vs the shape. Edge touching = in... No point
 * sampling. No 5 of 9 points. No edition gate." The reader that used to answer
 * "only at a 2024 table" lived here and is gone; `isTokenInTemplate` is the one
 * function, and `whollyInside` is the only thing that changes its answer.
 */
