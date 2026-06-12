// ─── ACE: QOL — Distance / geometry helpers (shared, canonical) ─────────────
// ONE place measures the distance between two tokens for the whole suite.
//
// RAW 5e measures from the NEAREST EDGE of each creature's space, not its
// centre, and counts in 5-ft grid steps where a diagonal costs the same as a
// straight step (the PHB default — NOT Pythagorean). Adjacent (footprints
// touching) = 5 ft; one empty square between = 10 ft; and so on. This matches
// the in-game ruler a player drags across the grid.
//
// It is also SIZE-AWARE (a Large vampire's near edge, not its middle) and
// 3D-AWARE: each creature occupies a cube of its size (Medium 5 ft tall, Large
// 10, Huge 15, Gargantuan 20) and vertical separation counts in the same 5-ft
// steps. When everyone is on the ground (elevation 0) the vertical gap is zero
// and the result is identical to flat 2D — 3D only changes the answer once
// something flies or stands on a ledge.
//
// Two flavours, because the rules use both:
//   • GAP   — empty space between footprints. 0 when adjacent/touching. This is
//             what reach uses ("the gap is under my reach").
//   • DISTANCE — gap PLUS the target's own cell. Adjacent = 5 ft. This is what
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
function _rectOf(t, gs, gd) {
  const d = t?.document ?? t ?? {};
  const wU = Number(d.width  ?? 1) || 1;
  const hU = Number(d.height ?? 1) || 1;
  return {
    x: Number(t?.x ?? d.x ?? 0) || 0,
    y: Number(t?.y ?? d.y ?? 0) || 0,
    w: wU * gs,
    h: hU * gs,
    elev:  Number(d.elevation ?? 0) || 0,
    hgtFt: Math.max(wU, hU) * gd,
  };
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
export function aceEdgeGapFt(rectA, rectB, opts = {}) {
  const gs = _gridSize();
  const gd = _ftPerCell();
  const dxPx = Math.max(0, rectA.x - (rectB.x + rectB.w), rectB.x - (rectA.x + rectA.w));
  const dyPx = Math.max(0, rectA.y - (rectB.y + rectB.h), rectB.y - (rectA.y + rectA.h));
  let cells = Math.max(Math.ceil(dxPx / gs), Math.ceil(dyPx / gs));

  if (_use3D(opts)) {
    const aBot = Number(rectA.elev ?? 0) || 0, aH = Number(rectA.hgtFt ?? 0) || 0;
    const bBot = Number(rectB.elev ?? 0) || 0, bH = Number(rectB.hgtFt ?? 0) || 0;
    const gapZ = Math.max(0, aBot - (bBot + bH), bBot - (aBot + aH)); // ft
    cells = Math.max(cells, Math.ceil(gapZ / gd));
  }
  return cells * gd;
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
      const ca = a?.center ?? { x: a?.x ?? 0, y: a?.y ?? 0 };
      const cb = b?.center ?? { x: b?.x ?? 0, y: b?.y ?? 0 };
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
 * own cell, so two adjacent creatures are 5 ft apart. Size-aware and 3D-aware.
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
  const gap = aceTokenGapFt(a, b, opts);
  return Number.isFinite(gap) ? gap + _ftPerCell() : gap;
}

/**
 * Convenience boolean: is b within rangeFt of a (nearest-edge, 3D-aware)?
 * A tiny epsilon absorbs float wobble so an exact 30-ft reach includes 30 ft.
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
