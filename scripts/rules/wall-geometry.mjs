// ─── ACE: QOL — Where a wall is, and whether a creature came near or through ─
//
// Pure geometry for spells that raise a wall or a globe. Prismatic Wall first;
// the same three questions serve any wall with a band or a burning side.
//   How far is this creature from the wall?         (the 20-foot blinding band)
//   Did this path bring it within that distance?    (it "moves within 20 feet")
//   Did this path go through the wall, how often?   (each pass is all seven layers)
//
// ⚠️ MEASURED THE WAY EVERY OTHER ACE DISTANCE IS. The gap between the
// creature's space and the wall is counted in grid steps under the table's own
// diagonal rule, exactly as geometry-utils counts spell range and reach. A band
// measured with a ruler while range is counted in squares would give one
// creature two distances to the same wall (two answers to one question,
// 2026-08-27).
//
// ⚠️ A WALL IS A LINE, NOT AN AREA. Everything else ACE measures asks "is this
// creature inside the shape?", and a wall one inch thick has no inside worth the
// name: a creature steps straight through it between two squares. So this asks
// whether the PATH crossed it, at a height where the wall stands.
//
// ⚠️ IMPORTS NOTHING, so the rules and their tests can use it freely.
//
// Units: positions in canvas pixels, heights and answers in feet.
//   grid = { gridPx, ftPerCell, rule }   rule: "equidistant" | "alternating" |
//                                        "exact" | "rectilinear" (geometry-utils' names)
//   rect = { x, y, w, h, bottom, top }   a creature's space; bottom/top in feet
//   path point = { x, y, bottom, top, teleport }  the creature's centre at each step;
//                teleport: it arrived here without travelling from the last point
// ──────────────────────────────────────────────────────────────────────────────

const EPS = 1e-6;

const pxPerFtOf = (grid) => (Number(grid?.gridPx) || 100) / (Number(grid?.ftPerCell) || 5);

/**
 * A placed template as the wall it draws.
 *
 * dnd5e places a wall as a "ray" from the point clicked, `distance` feet long in
 * `direction` degrees, and a globe as a "circle" of `distance` feet radius. The
 * wall's height rides in flags.dnd5e.dimensions.height.
 *
 * @returns {{kind:"line", a:{x,y}, b:{x,y}, bottom:number, top:number|null}
 *          |{kind:"globe", c:{x,y}, rFt:number, z:number}|null}
 */
export function wallShapeOf(template, grid) {
  const t = String(template?.t ?? "");
  const x = Number(template?.x) || 0;
  const y = Number(template?.y) || 0;
  const base = Number(template?.elevation) || 0;
  if (t === "ray" || t === "line") {
    const len = (Number(template?.distance) || 0) * pxPerFtOf(grid);
    const rad = (Number(template?.direction) || 0) * Math.PI / 180;
    const height = Number(template?.flags?.dnd5e?.dimensions?.height) || 0;
    return { kind: "line", a: { x, y }, b: { x: x + Math.cos(rad) * len, y: y + Math.sin(rad) * len },
             bottom: base, top: height > 0 ? base + height : null };
  }
  if (t === "circle") {
    return { kind: "globe", c: { x, y }, rFt: Number(template?.distance) || 0, z: base };
  }
  return null;
}

/** Cost of `straights` orthogonal and `diagonals` diagonal steps, as geometry-utils counts it. */
function stepsToFeet(straights, diagonals, ftPerCell, rule) {
  switch (rule) {
    case "alternating": return (straights + diagonals + Math.floor(diagonals / 2)) * ftPerCell;
    case "rectilinear": return (straights + diagonals * 2) * ftPerCell;
    case "exact":       return Math.round(Math.hypot(straights + diagonals, diagonals)) * ftPerCell;
    default:            return (straights + diagonals) * ftPerCell;
  }
}

/** The gap from a creature's space to one point of the wall, in feet, counted in squares. */
function gapFt(rect, p, zGapFt, grid) {
  const gridPx = Number(grid?.gridPx) || 100;
  const ftPerCell = Number(grid?.ftPerCell) || 5;
  const dxPx = Math.max(0, rect.x - p.x, p.x - (rect.x + rect.w));
  const dyPx = Math.max(0, rect.y - p.y, p.y - (rect.y + rect.h));
  const cx = Math.max(0, Math.ceil(dxPx / gridPx - EPS));
  const cy = Math.max(0, Math.ceil(dyPx / gridPx - EPS));
  const diagonals = Math.min(cx, cy);
  let straights = Math.max(cx, cy) - diagonals;
  // Height is counted in the same steps and can only lengthen the trip.
  const cz = Math.max(0, Math.ceil((Number(zGapFt) || 0) / ftPerCell - EPS));
  if (cz > straights + diagonals) straights = cz - diagonals;
  return stepsToFeet(straights, diagonals, ftPerCell, grid?.rule);
}

/** Points along a wall, one a foot, so no stretch of it is skipped. */
function linePoints(shape, grid) {
  if (shape._pts) return shape._pts;
  const { a, b } = shape;
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / pxPerFtOf(grid)));
  const pts = [];
  for (let k = 0; k <= n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  Object.defineProperty(shape, "_pts", { value: pts, enumerable: false });
  return pts;
}

/** Points around a globe's surface at one height, one a foot of its circumference. */
function circlePoints(c, rPx) {
  const n = Math.max(24, Math.ceil(2 * Math.PI * rPx / 20));
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push({ x: c.x + Math.cos(t) * rPx, y: c.y + Math.sin(t) * rPx });
  }
  return pts;
}

/** The wall's points that matter to this creature, with the height gap to them. */
function nearPoints(shape, rect, grid) {
  if (shape.kind === "line") {
    const zGap = Math.max(0, shape.top === null ? 0 : rect.bottom - shape.top, shape.bottom - rect.top);
    return { pts: linePoints(shape, grid), zGap };
  }
  // A globe: the slice of the sphere at the height of the creature nearest its centre.
  const zc = Math.min(Math.max(shape.z, rect.bottom), rect.top);
  const dz = Math.abs(zc - shape.z);
  if (dz >= shape.rFt) return { pts: [shape.c], zGap: dz - shape.rFt };
  const rh = Math.sqrt(shape.rFt * shape.rFt - dz * dz);
  return { pts: circlePoints(shape.c, rh * pxPerFtOf(grid)), zGap: 0 };
}

/**
 * How far a creature's space is from the wall, in feet. 0 when it touches it.
 */
export function distanceToWallFt(shape, rect, grid) {
  if (!shape || !rect) return Infinity;
  const { pts, zGap } = nearPoints(shape, rect, grid);
  let best = Infinity;
  for (const p of pts) {
    const d = gapFt(rect, p, zGap, grid);
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}

/**
 * The wall's points within `feet` of a creature's space, every `everyFt` feet.
 * Used to ask whether it can SEE the wall: a sight line to any of them will do.
 */
export function wallPointsWithin(shape, rect, feet, grid, everyFt = 5) {
  if (!shape || !rect) return [];
  const { pts, zGap } = nearPoints(shape, rect, grid);
  const stride = Math.max(1, Math.round(everyFt));
  const out = [];
  for (let i = 0; i < pts.length; i += (shape.kind === "line" ? stride : 1)) {
    if (gapFt(rect, pts[i], zGap, grid) <= feet + EPS) out.push(pts[i]);
  }
  return out;
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Straight-line distance from a point to a segment, in pixels. */
function pointToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > EPS ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Where along p→q the stretch meets segment a→b, as a fraction of p→q, or null. */
function meetsAt(p, q, a, b) {
  const rx = q.x - p.x, ry = q.y - p.y, sx = b.x - a.x, sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return null;
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
  const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.min(1, Math.max(0, t));
}

const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Half a pixel: a creature's middle this close to the wall is standing in it. */
const ON_PX = 0.5;

/**
 * How many times a path went into the wall.
 *
 * ⚠️🔴 STEPPING INTO THE WALL IS GOING THROUGH IT (2026-09-13). The wall is one
 * inch thick, so a creature whose middle stands on it is inside it, and RAW the
 * layers take any creature that "reaches into or passes through the wall". The
 * first version let a point ON the line keep the side it came from, so a step
 * into the wall counted for nothing. Johnny's first live test: Neferon stepped
 * into and out of a wall running down the middle of his row, and only his third
 * move, the one that crossed it in a single step, set it off.
 *
 *   into the wall, from either side    one pass
 *   out of it again                    nothing more; it went through on the way in
 *   straight across in one step        one pass
 *   starting inside it                 nothing: RAW, a wall placed on a creature
 *                                      ends the spell, so there is no pass to count
 *
 * ⚠️ OVER THE TOP IS NOT THROUGH. A 30-foot wall does not touch a creature
 * flying at 35 feet; the height is taken where the path meets the wall.
 * ⚠️ A TELEPORT PASSES NOTHING. Misty Step lands on the other side without
 * touching a layer.
 */
export function wallCrossings(shape, path, grid) {
  const pts = (path ?? []).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (!shape || pts.length < 2) return 0;
  let count = 0;

  if (shape.kind === "line") {
    // Is a creature with this much height at a height where the wall stands?
    const atWallHeight = (bottom, top) =>
      !((shape.top !== null && bottom >= shape.top - EPS) || top <= shape.bottom + EPS);
    const inWall = (p) => pointToSegment(p, shape.a, shape.b) <= ON_PX
      && atWallHeight(num(p.bottom), num(p.top, num(p.bottom)));
    // Which side of the wall's line; 0 on the line itself, or on its extension past an end.
    const sideOf = (p) => Math.sign(cross(shape.a, shape.b, p));

    let inside = inWall(pts[0]);
    let side = inside ? 0 : sideOf(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      const qIn = inWall(q), qSide = sideOf(q);
      if (q.teleport) { inside = qIn; if (!qIn && qSide) side = qSide; continue; }
      if (qIn) {
        if (!inside) count++;                               // stepped into the wall
        inside = true;
        continue;
      }
      if (inside) { inside = false; side = qSide || side; continue; }   // out again: counted going in
      if (side && qSide && qSide !== side) {                // straight across in one step
        const t = meetsAt(p, q, shape.a, shape.b);
        if (t !== null && atWallHeight(lerp(num(p.bottom), num(q.bottom), t),
            lerp(num(p.top, num(p.bottom)), num(q.top, num(q.bottom)), t))) count++;
      }
      if (qSide) side = qSide;
    }
    return count;
  }

  if (shape.kind === "globe") {
    const pxPerFt = pxPerFtOf(grid);
    const tolFt = ON_PX / pxPerFt;
    const where = (p) => {
      const zc = Math.min(Math.max(shape.z, num(p.bottom)), num(p.top, num(p.bottom)));
      const d = Math.hypot(Math.hypot(p.x - shape.c.x, p.y - shape.c.y) / pxPerFt, zc - shape.z);
      return d < shape.rFt - tolFt ? "inside" : (d <= shape.rFt + tolFt ? "wall" : "outside");
    };
    let state = where(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      const s = where(q);
      if (q.teleport) { state = s; continue; }
      if (s === "wall") { if (state !== "wall") count++; state = s; continue; }   // into the wall itself
      if (state === "wall") { state = s; continue; }                              // out again
      if (s !== state) { count++; state = s; continue; }                          // in, or out, in one step
      if (s === "inside") continue;
      // Both outside: a straight step can still cut across the globe, in and out.
      const dx = q.x - p.x, dy = q.y - p.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > EPS ? Math.min(1, Math.max(0, ((shape.c.x - p.x) * dx + (shape.c.y - p.y) * dy) / len2)) : 0;
      const nearest = where({ x: p.x + dx * t, y: p.y + dy * t,
        bottom: lerp(num(p.bottom), num(q.bottom), t), top: lerp(num(p.top, num(p.bottom)), num(q.top, num(q.bottom)), t) });
      if (nearest === "inside") count += 2;
      else if (nearest === "wall") count += 1;                                    // grazed it
    }
    return count;
  }
  return 0;
}

/**
 * Does the wall pass through a creature's space?
 *
 * Both books forbid placing it so. 2024: "If you position the wall in a space
 * occupied by a creature, the spell ends instantly without effect." 2014: "If
 * you position the wall so that it passes through a space occupied by a
 * creature, the spell fails, and your action and the spell slot are wasted."
 * Johnny, 2026-09-13: "yes, enforce it".
 *
 * ⚠️ THROUGH, NOT BESIDE. A wall run along the line between two squares touches
 * both and stands in neither, so the space is shrunk by a pixel before asking.
 * ⚠️ A GLOBE AROUND A CREATURE IS NOT THROUGH IT. The globe's wall is its
 * surface: a creature wholly inside it (the usual reason to cast one) or wholly
 * outside it is clear. Only a surface cutting through its space counts.
 * ⚠️ AND HEIGHT COUNTS. A creature flying above a 30-foot wall is not in it.
 */
export function wallPassesThrough(shape, rect, grid) {
  if (!shape || !rect) return false;
  const TOL = 1;   // px
  const x0 = rect.x + TOL, y0 = rect.y + TOL, x1 = rect.x + rect.w - TOL, y1 = rect.y + rect.h - TOL;
  if (x1 <= x0 || y1 <= y0) return false;
  const bottom = num(rect.bottom), top = num(rect.top, bottom);

  if (shape.kind === "line") {
    if (shape.top !== null && bottom >= shape.top - EPS) return false;   // above it
    if (top <= shape.bottom + EPS) return false;                          // below it
    // Does any stretch of the wall lie inside the (shrunk) space? Liang-Barsky clipping.
    const { a, b } = shape;
    const dx = b.x - a.x, dy = b.y - a.y;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (Math.abs(p) < EPS) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    return clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dy, a.y - y0) && clip(dy, y1 - a.y) && t0 <= t1;
  }

  if (shape.kind === "globe") {
    // The space as a box in feet around the globe's centre: the surface passes
    // through it when the box's nearest point is inside the sphere and its
    // farthest corner is outside.
    const pxPerFt = pxPerFtOf(grid);
    const span = (lo, hi) => [lo, hi];
    const [bx0, bx1] = span((x0 - shape.c.x) / pxPerFt, (x1 - shape.c.x) / pxPerFt);
    const [by0, by1] = span((y0 - shape.c.y) / pxPerFt, (y1 - shape.c.y) / pxPerFt);
    const [bz0, bz1] = span(bottom - shape.z, top - shape.z);
    const nearest = (lo, hi) => (lo > 0 ? lo : (hi < 0 ? hi : 0));
    const farthest = (lo, hi) => Math.max(Math.abs(lo), Math.abs(hi));
    const dMin = Math.hypot(nearest(bx0, bx1), nearest(by0, by1), nearest(bz0, bz1));
    const dMax = Math.hypot(farthest(bx0, bx1), farthest(by0, by1), farthest(bz0, bz1));
    return dMin < shape.rFt && dMax > shape.rFt;
  }
  return false;
}

/**
 * Did this path bring the creature within `bandFt` of the wall from outside it?
 *
 * ⚠️ WATCHED ALONG THE WAY, NOT ONLY WHERE IT STOPPED. A creature that walks
 * past the end of a wall comes within 20 feet of it and walks on; checking only
 * the square it stopped in would miss the very case the rule is about. And one
 * that starts inside, steps out and comes back in has arrived again.
 *
 * @param {{w:number, h:number}} size  the creature's footprint in pixels
 */
export function entersBand(shape, path, bandFt, grid, size) {
  const pts = (path ?? []).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (!shape || !pts.length) return false;
  const w = Number(size?.w) || Number(grid?.gridPx) || 100;
  const h = Number(size?.h) || Number(grid?.gridPx) || 100;
  const near = (p) => distanceToWallFt(shape, { x: p.x - w / 2, y: p.y - h / 2, w, h,
    bottom: num(p.bottom), top: num(p.top, num(p.bottom)) }, grid) <= bandFt + EPS;
  let wasNear = near(pts[0]);
  const step = Math.max(1, (Number(grid?.gridPx) || 100) / 2);      // half a square
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const n = q.teleport ? 1 : Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / step));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const s = q.teleport ? q : { x: lerp(p.x, q.x, f), y: lerp(p.y, q.y, f),
        bottom: lerp(num(p.bottom), num(q.bottom), f), top: lerp(num(p.top, num(p.bottom)), num(q.top, num(q.bottom)), f) };
      const isNear = near(s);
      if (isNear && !wasNear) return true;
      wasNear = isNear;
    }
  }
  return false;
}
