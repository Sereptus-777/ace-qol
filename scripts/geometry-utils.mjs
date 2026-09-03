// ─── ACE: QOL — Distance / geometry helpers (shared, canonical) ─────────────
// ONE place measures the distance between two tokens for the whole suite.
//
// RAW 5e measures from the NEAREST EDGE of each creature's space, not its
// centre, and counts in whole grid steps. Adjacent (footprints touching) = 5
// feet; one empty square between = 10 feet.
//
// ⚠️ WHAT A DIAGONAL COSTS IS THE TABLE'S CHOICE, AND ACE USED TO ASSUME IT.
// Foundry has a core `gridDiagonals` setting; this file now reads it. The PHB
// default is every diagonal 5 feet, the DMG's optional rule is 5-10-5-10, and a
// real diagonal is 7.07. A table on the optional rule used to get one number
// from its own ruler and a different one from every ACE range check.
//
// It is also SIZE-AWARE (a Large vampire's near edge, not its middle) and
// 3D-AWARE: each creature occupies a cube of its size (Medium 5 feet tall, Large
// 10, Huge 15, Gargantuan 20) and vertical separation counts in the same 5-ft
// steps. When everyone is on the ground (elevation 0) the vertical gap is zero
// and the result is identical to flat 2D — 3D only changes the answer once
// something flies or stands on a ledge.
//
// Two flavours, because the rules use both:
//   • GAP   — empty space between footprints. 0 when adjacent/touching. This is
//             what reach uses ("the gap is under my reach").
//   • DISTANCE — gap PLUS the target's own cell. Adjacent = 5 feet. This is what
//             "within 30 feet" / spell range / aura radius use.
//   distance = gap + one cell.
//
// Every reach / range / radius / adjacency check in ACE QOL routes through one
// of these. Do not hand-roll center-to-center math.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

/**
 * Should this measurement count vertical distance? Defaults to RAW 3D (on).
 * A caller can force it per-call with { threeD: true|false }; otherwise the
 * world setting "raw3dDistance" decides (default ON).
 */
function _use3D(opts) {
  if (typeof opts?.threeD === "boolean") return opts.threeD;
  try { return game.settings.get(MODULE_ID, "raw3dDistance") !== false; }
  catch (_) { return true; }
}

/** Pixels per grid square on the active scene. */
function _gridSize() { return canvas?.grid?.size || 100; }

/** Feet (scene distance units) per grid square. */
function _ftPerCell() {
  return canvas?.dimensions?.distance || canvas?.scene?.grid?.distance || 5;
}

/**
 * Build a footprint rectangle for a token or token document:
 *   { x, y (top-left px), w, h (px), elev (ft), hgtFt (ft, cube height) }.
 */
/* ─── Where a token actually ended up, when the document has not caught up ───
 *
 * ⚠️🔴 READING `document.x` WAS SUPPOSED TO SETTLE THIS AND DID NOT.
 *
 * The comment below `_rectOf` is right about the placeable: `Token#x` is the
 * animated display bounds. So the read was moved to `document.x`, and on
 * 2026-09-02 Johnny's log showed the aura engine STILL deciding about the
 * square he had left:
 *
 *   17:04:03.123  updateToken   Virric   changes={"x":15936}
 *   17:04:03.537  aura engine   Virric   read x=15604  -> inside a 10 ft aura
 *
 * 15604 is where he came FROM. And the instrumentation printed no "but the
 * SPRITE is at" clause, which means the document and the sprite AGREED on the
 * old number four hundred milliseconds after the update announced the new one.
 * So this is not the animation. Something in his setup - a third party
 * `autoRotation.js` is in the same stack, bundling a rotation into the move -
 * leaves the document behind for longer than the engine waits.
 *
 * ⚠️ THE POINT IS THAT WE WERE ALREADY TOLD. `changes.x` in the hook is
 * Foundry's own statement of the checkpoint the token committed to; it is
 * assigned in `TokenDocument#_preUpdate` as `changed[k] = destination[k]`.
 * Re-deriving that later from a field somebody else can hold stale adds a race
 * and buys nothing. So the hook writes it down here, and every measurement in
 * the suite - aura radius, spell range, weapon reach, cover - reads the same
 * note.
 *
 * ⚠️ A NOTE THAT OUTLIVES ITS MOVE WOULD BE A PERMANENT LIE, so it is deleted
 * the instant the document agrees with it, and expires on its own regardless.
 * Our own perception watcher has preferred `changes.x` since June for exactly
 * this reason, in one file, for one feature. This is that fix for everybody.
 */
const _knownPos = new Map();          // token id -> { x, y, elevation, at }
const _KNOWN_TTL_MS = 3000;           // a backstop; the normal exit is agreement
let _knownWarned = false;

/** Record where an update says a token landed. Called from the updateToken hook. */
export function aceNoteTokenPosition(id, pos) {
  if (!id || !pos) return;
  _knownPos.set(id, {
    x: Number(pos.x), y: Number(pos.y),
    elevation: pos.elevation === undefined ? undefined : Number(pos.elevation),
    at: performance.now(),
  });
}

/**
 * The position a measurement WOULD use for this token right now.
 *
 * ⚠️ FOR REPORTING ONLY, AND IT EXISTS BECAUSE A LOG THAT PRINTS THE INTENTION
 * MANUFACTURES A FALSE ROOT CAUSE. The aura engine records `document.x` beside
 * every verdict. Now that distance can measure from the note instead, that line
 * would keep printing the stale number and read as "still broken" when it was
 * fixed. It must say what the decision was actually made from.
 */
export function aceMeasuredPosition(t) {
  const d = t?.document ?? t ?? {};
  const known = _authoritative(d);
  return {
    x: known ? known.x : (Number(d.x ?? t?.x ?? 0) || 0),
    y: known ? known.y : (Number(d.y ?? t?.y ?? 0) || 0),
    fromUpdate: !!known,
  };
}

/** Forget a note (a deleted token, a scene change). */
export function aceForgetTokenPosition(id) { _knownPos.delete(id); }

/**
 * The position to measure from: the note if the document is behind it,
 * otherwise the document itself.
 */
function _authoritative(d) {
  const id = d?.id;
  if (!id) return null;
  const note = _knownPos.get(id);
  if (!note) return null;

  if (performance.now() - note.at > _KNOWN_TTL_MS) { _knownPos.delete(id); return null; }

  const docX = Number(d.x ?? 0) || 0;
  const docY = Number(d.y ?? 0) || 0;
  // ⚠️ ELEVATION COUNTS AS THE DOCUMENT BEING BEHIND. Comparing only x and y
  // threw away a note about a creature that rose thirty feet without moving
  // across the floor, which is every Fly, every Levitate and every dragon
  // lifting off. Caught by the self-test the same hour this was written.
  const docE = Number(d.elevation ?? 0) || 0;
  const noteE = note.elevation === undefined ? docE : note.elevation;
  if (docX === note.x && docY === note.y && docE === noteE) {
    _knownPos.delete(id);
    return null;
  }

  // ⚠️ SAY IT THE FIRST TIME, THEN STOP. Silence here would hide how often the
  // document lags and for how long, which is the one thing still unexplained.
  if (!_knownWarned) {
    _knownWarned = true;
    console.warn("ace-qol | the token document is behind the move it just "
      + `reported (document says x=${docX} y=${docY}, the update said `
      + `x=${note.x} y=${note.y}, ${Math.round(performance.now() - note.at)}ms ago). `
      + "Measuring from the update. Said once per load.");
  }
  return note;
}

/**
 * Register the tracker. Idempotent.
 *
 * ⚠️ `Hooks.once("ready")` FROM INSIDE `ready` NEVER FIRES - every ACE
 * subsystem starts from the entry file's own ready handler (2026-08-12).
 */
let _tracking = false;
export function aceRegisterPositionTracking() {
  if (_tracking) return;
  _tracking = true;
  Hooks.on("updateToken", (doc, changes) => {
    try {
      if (changes?.x === undefined && changes?.y === undefined
          && changes?.elevation === undefined) return;
      aceNoteTokenPosition(doc?.id, {
        x: changes.x ?? doc?.x, y: changes.y ?? doc?.y,
        elevation: changes.elevation ?? doc?.elevation,
      });
    } catch (err) {
      console.warn("ace-qol | could not record where a token landed:", err);
    }
  });
  Hooks.on("deleteToken", (doc) => aceForgetTokenPosition(doc?.id));
  Hooks.on("canvasTearDown", () => _knownPos.clear());
  console.debug("ace-qol | position tracking online — distance measures from the "
    + "position an update reported, not from a document that may lag it.");
}

function _rectOf(t, gs, gd) {
  const d = t?.document ?? t ?? {};
  const wU = Number(d.width  ?? 1) || 1;
  const hU = Number(d.height ?? 1) || 1;
  // Snap sub-cell (Tiny) footprints out to their whole 5-ft square — see
  // aceSnapSubCellRect for the full why. No-op for Medium / Large / +.
  // ⚠️🔴 THE DOCUMENT IS THE TRUTH. THE PLACEABLE IS AN ANIMATION IN PROGRESS.
  //
  // This read `t.x` first and only fell back to the document, and in Foundry
  // V13 `PlaceableObject#x` is literally `return this._bounds.x` — the display
  // bounds, which the movement animation drives frame by frame. `document.x` is
  // set immediately and is where the token actually IS.
  //
  // Every rules decision that measured distance therefore ran against the
  // position the token was LEAVING. The aura engine recomputes 80ms after a
  // move; a token crossing one 332px square animates for far longer than that,
  // so it read the old square every time.
  //
  // Johnny, 2026-09-01, describing it exactly: "If I move another token in, it
  // doesn't draw it right away until I move another token... It's not checking
  // every move." It was checking every move. It was measuring the previous one.
  //
  // ⚠️ THIS IS NOT ONLY AURAS. Everything downstream of aceDistanceFt reads this:
  // spell range, weapon reach, cover, aura radius. All of them were one move
  // stale whenever a decision landed during an animation.
  //
  // The same lesson, in a different file: the concentration widget was fixed on
  // 2026-06-xx to read the NEW position from the update payload rather than a
  // value that had reverted under it. Same class of bug, same conclusion.
  // ⚠️ THE UPDATE OUTRANKS THE DOCUMENT. See `_authoritative` above: on
  // 2026-09-02 the document was still reporting the square Virric had left,
  // 400ms after the update announced the one he had reached.
  const known = _authoritative(d);
  return aceSnapSubCellRect({
    x: known ? known.x : (Number(d.x ?? t?.x ?? 0) || 0),
    y: known ? known.y : (Number(d.y ?? t?.y ?? 0) || 0),
    w: wU * gs,
    h: hU * gs,
    elev:  Number((known?.elevation ?? d.elevation) ?? 0) || 0,
    hgtFt: Math.max(wU, hU) * gd,
  });
}

/**
 * Snap a sub-cell (Tiny) token footprint OUT to the whole grid cell that holds
 * its centre. RAW, a Tiny creature occupies its full 5-ft square for reach and
 * distance — but its token is < 1 cell and Foundry centres it inside the square,
 * leaving a fractional-cell gap to a neighbour. aceEdgeGapFt's ceil() then rounds
 * that part-cell sliver UP to a whole 5-ft cell, so an ADJACENT tiny creature
 * wrongly reads as 10 feet instead of 5 feet. Snapping each sub-cell dimension to its
 * enclosing cell makes the edge math see the square the creature truly occupies.
 *
 * Idempotent and safe on any rect: a side already >= 1 cell is left untouched, so
 * Medium / Large / Huge / Gargantuan — and the opportunity-attack path's
 * hypothetical-position rects — all pass through unchanged. Callers that build
 * their own TOKEN rects (not tiles) should wrap them in this.
 *
 * @param {{x:number,y:number,w:number,h:number,elev?:number,hgtFt?:number}} rect
 * @returns {{x:number,y:number,w:number,h:number,elev?:number,hgtFt?:number}}
 */
export function aceSnapSubCellRect(rect) {
  const gs = _gridSize();
  let { x, y, w, h } = rect;
  if (w < gs) { x = Math.floor((x + w / 2) / gs) * gs; w = gs; }
  if (h < gs) { y = Math.floor((y + h / 2) / gs) * gs; h = gs; }
  return { ...rect, x, y, w, h };
}

/**
 * Nearest-edge GAP in feet between two footprint rectangles, counted in 5e grid
 * steps (diagonal = straight, NOT Pythagorean), 3D-aware. Returns 0 when the
 * footprints touch or overlap. This is the shared primitive — token helpers and
 * the opportunity-attack path (which measures hypothetical move positions, not
 * live tokens) both build rects and call this.
 *
 * rect = { x, y (top-left px), w, h (px), elev? (ft), hgtFt? (ft) }
 *
 * @param {{x:number,y:number,w:number,h:number,elev?:number,hgtFt?:number}} rectA
 * @param {{x:number,y:number,w:number,h:number,elev?:number,hgtFt?:number}} rectB
 * @param {{threeD?: boolean}} [opts]
 * @returns {number} gap in feet (a clean multiple of the scene's ft/cell)
 */
/**
 * What does a diagonal cost at THIS table?
 *
 * ⚠️🔴 ACE ASSUMED THE SIMPLE RULE AND NEVER READ THE SETTING. Foundry has
 * a core `gridDiagonals` option and dnd5e honours it, so a table running the
 * DMG's optional rule got one number from their own ruler and a different one
 * from every ACE range check. Invisible to Johnny, whose table wants the simple
 * rule, and wrong for anyone who ships with the other.
 *
 * A real diagonal is 5 x sqrt(2) = 7.07 feet. Neither rule is honest; they are
 * two ways of avoiding an irrational number at the table.
 *
 *   EQUIDISTANT (0)     every diagonal 5 feet. The PHB default in both
 *                       editions. Fast, and worth about 41% free movement.
 *   ALTERNATING (4, 5)  5, 10, 5, 10. Averages 7.5, within 6% of the truth,
 *                       at the cost of tracking diagonal parity.
 *   EXACT (1)           the real sqrt(2), which stops producing multiples of 5.
 *   RECTILINEAR (3)     a diagonal costs two squares.
 *
 * @returns {"equidistant"|"alternating"|"exact"|"rectilinear"}
 */
function _diagonalRule() {
  try {
    // A scene may override the world setting; prefer what the scene says.
    const scene = canvas?.scene?.grid?.diagonals;
    const raw = (scene ?? null) !== null && scene !== undefined
      ? scene
      : game?.settings?.get?.("core", "gridDiagonals");
    switch (Number(raw)) {
      case 1: return "exact";
      case 2: return "alternating";   // APPROXIMATE, 1.5 per diagonal
      case 3: return "rectilinear";
      case 4:
      case 5: return "alternating";
      default: return "equidistant";
    }
  } catch (_) {
    // ⚠️ Unknown falls to the PHB default, which is what both editions print.
    return "equidistant";
  }
}

/**
 * Cost of moving `straights` orthogonal cells and `diagonals` diagonal cells,
 * under the table's rule, in feet.
 */
function _cellsToFeet(straights, diagonals, gd) {
  switch (_diagonalRule()) {
    case "alternating":
      // 1st diagonal 5, 2nd 10, 3rd 5, 4th 10 ... = 5n + 5*floor(n/2)
      return (straights * gd) + (diagonals * gd) + (Math.floor(diagonals / 2) * gd);
    case "rectilinear":
      return (straights * gd) + (diagonals * gd * 2);
    case "exact": {
      // Kept on the grid: the true length, rounded to whole squares so the
      // answer is still a multiple of the grid distance.
      const exact = Math.hypot(straights + diagonals, diagonals);
      return Math.round(exact) * gd;
    }
    default:
      return (straights + diagonals) * gd;
  }
}

/**
 * The gap between two rectangles, as a count of orthogonal and diagonal steps.
 *
 * ⚠️ THE TWO AXES ARE KEPT SEPARATE. Collapsing them with `Math.max` up
 * front throws away the information every rule except equidistant needs.
 */
function _gapSteps(rectA, rectB, opts) {
  const gs = _gridSize();
  const gd = _ftPerCell();
  const dxPx = Math.max(0, rectA.x - (rectB.x + rectB.w), rectB.x - (rectA.x + rectA.w));
  const dyPx = Math.max(0, rectA.y - (rectB.y + rectB.h), rectB.y - (rectA.y + rectA.h));
  const cx = Math.ceil(dxPx / gs);
  const cy = Math.ceil(dyPx / gs);
  let diagonals = Math.min(cx, cy);
  let straights = Math.max(cx, cy) - diagonals;

  if (_use3D(opts)) {
    const aBot = Number(rectA.elev ?? 0) || 0, aH = Number(rectA.hgtFt ?? 0) || 0;
    const bBot = Number(rectB.elev ?? 0) || 0, bH = Number(rectB.hgtFt ?? 0) || 0;
    const gapZ = Math.max(0, aBot - (bBot + bH), bBot - (aBot + aH));
    const cz = Math.ceil(gapZ / gd);
    // Vertical separation is counted in the same steps; it can only lengthen.
    if (cz > straights + diagonals) straights = cz - diagonals;
  }
  return { straights, diagonals };
}

export function aceEdgeGapFt(rectA, rectB, opts = {}) {
  const { straights, diagonals } = _gapSteps(rectA, rectB, opts);
  return _cellsToFeet(straights, diagonals, _ftPerCell());
}

/**
 * Nearest-edge GAP in feet between two tokens (empty space; 0 when adjacent).
 * Accepts a Token placeable or a TokenDocument for each argument.
 */
export function aceTokenGapFt(a, b, opts = {}) {
  try {
    if (!a || !b) return Infinity;
    const gs = _gridSize();
    const gd = _ftPerCell();
    return aceEdgeGapFt(_rectOf(a, gs, gd), _rectOf(b, gs, gd), opts);
  } catch (err) {
    console.warn("ace-qol | aceTokenGapFt failed — centre-to-centre fallback:", err);
    try {
      // ⚠️ THE SAME STALE-POSITION TRAP AS `_rectOf` ABOVE. `token.center` is
      // derived from the display bounds, so mid-animation it is the old square.
      // Build the centre from the DOCUMENT, and only fall back to the placeable.
      const _centre = (t) => {
        const d = t?.document ?? t ?? {};
        const gs = _gridSize();
        const x = Number(d.x ?? t?.x), y = Number(d.y ?? t?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return { x: x + ((Number(d.width) || 1) * gs) / 2,
                   y: y + ((Number(d.height) || 1) * gs) / 2 };
        }
        return t?.center ?? { x: 0, y: 0 };
      };
      const ca = _centre(a);
      const cb = _centre(b);
      const gd = _ftPerCell();
      const d = canvas?.grid?.measurePath
        ? (canvas.grid.measurePath([ca, cb]).distance ?? Infinity)
        : (Math.hypot(ca.x - cb.x, ca.y - cb.y) / _gridSize()) * gd;
      // De-cell so aceDistanceFt re-adds the target's own square on this path too.
      return Number.isFinite(d) ? Math.max(0, d - gd) : Infinity;
    } catch (_) { return Infinity; }
  }
}

/**
 * Nearest-edge DISTANCE in feet between two tokens — the gap plus the target's
 * own cell, so two adjacent creatures are 5 feet apart. Size-aware and 3D-aware.
 * This is the number to use for "within X feet", spell range, and aura radius.
 *
 * Accepts a Token placeable or a TokenDocument for each argument.
 *
 * @param {Token|TokenDocument} a
 * @param {Token|TokenDocument} b
 * @param {{threeD?: boolean}} [opts]  Force 3D on/off; omit to follow the setting.
 * @returns {number} Distance in feet, or Infinity if it cannot be measured.
 */
export function aceDistanceFt(a, b, opts = {}) {
  try {
    if (!a || !b) return Infinity;
    const gs = _gridSize();
    const gd = _ftPerCell();
    const { straights, diagonals } = _gapSteps(_rectOf(a, gs, gd), _rectOf(b, gs, gd), opts);

    // ⚠️🔴 THE TARGET'S OWN SQUARE IS A STEP, AND IT FOLLOWS THE SAME RULE.
    // This used to be `gap + oneCell` - a flat five feet bolted on outside the
    // diagonal logic. Under the alternating rule that is wrong: two diagonal
    // steps cost 5 then 10, so a creature one diagonal square away is 15 feet,
    // and adding a flat 5 to a 5-foot gap produced 10.
    //
    // The extra step travels in the same direction as the rest of the journey:
    // diagonally if any part of it was diagonal, straight otherwise. Two
    // touching creatures have no gap at all and are one step apart, which is
    // 5 feet under every rule that matters.
    const goesDiagonally = diagonals > 0 || (straights === 0 && diagonals === 0);
    return _cellsToFeet(
      straights + (goesDiagonally ? 0 : 1),
      diagonals + (goesDiagonally ? 1 : 0),
      gd);
  } catch (err) {
    console.warn("ace-qol | aceDistanceFt failed:", err);
    return Infinity;
  }
}

/**
 * Convenience boolean: is b within rangeFt of a (nearest-edge, 3D-aware)?
 * A tiny epsilon absorbs float wobble so an exact 30-ft reach includes 30 feet.
 *
 * @param {Token|TokenDocument} a
 * @param {Token|TokenDocument} b
 * @param {number} rangeFt
 * @param {{threeD?: boolean}} [opts]
 * @returns {boolean}
 */
export function aceWithinFt(a, b, rangeFt, opts = {}) {
  return aceDistanceFt(a, b, opts) <= (Number(rangeFt) || 0) + 0.1;
}

/**
 * Build a Foundry V13 Region shape matching a MeasuredTemplate's footprint.
 * Circles map to a circle Region; cone/ray/grid-snapped shapes map to a
 * polygon traced from the drawn template shape (local points → absolute scene
 * coordinates); 5e cubes ("rect") map to a rectangle.
 *
 * CANONICAL + SHARED: the concentration-widget difficult-terrain path and the
 * rules-engine space-effects executor both trace template footprints through
 * THIS function — one tracer, identical regions. (Lifted verbatim from the
 * proven concentration-widget implementation, 2026-07-09.)
 *
 * Returns a Region shape data object, or null when the placeable's shape
 * isn't computed yet (caller may retry briefly — fresh templates take a
 * moment to draw).
 */
export function buildRegionShapeFromTemplate(templateDoc) {
  const obj = templateDoc?.object;
  const x = templateDoc?.x ?? 0;
  const y = templateDoc?.y ?? 0;
  const s = obj?.shape;
  // Foundry computes the template shape per type:
  //   cone / ray / grid-snapped circle → PIXI.Polygon (has .points)
  //   5e cube ("rect")                 → PIXI.Rectangle (.x/.y/.width/.height)
  //   euclidean circle                 → PIXI.Circle (.radius)
  // All are in LOCAL coords (origin at the template's x,y), so we add x,y.

  // 1) Polygon-based (cone, ray, grid circle): trace the points.
  const pts = s?.points;
  if (Array.isArray(pts) && pts.length >= 6) {
    const abs = pts.map((p, i) => (i % 2 === 0 ? p + x : p + y));
    return { type: "polygon", points: abs };
  }
  // 2) Rectangle (5e cubes — PIXI.Rectangle, no .points).
  if (s && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0) {
    return { type: "rectangle", x: x + (s.x ?? 0), y: y + (s.y ?? 0), width: s.width, height: s.height, rotation: 0 };
  }
  // 3) Circle (euclidean) — fall back to grid math if .radius is missing.
  let radius = s?.radius;
  if (!(radius > 0)) {
    const g = canvas?.grid;
    if (g?.size && g?.distance) radius = (templateDoc.distance ?? 0) * g.size / g.distance;
  }
  if (radius > 0) return { type: "circle", x, y, radius };
  return null;
}
