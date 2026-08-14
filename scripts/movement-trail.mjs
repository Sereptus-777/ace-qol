// ─── ACE: QOL — Hide V13 token movement trail ───────────────────────────────
// Foundry V13's native token ruler remembers the path a token took during its
// turn and redraws that trail every time you hover or pick the token back up.
// Core ships NO setting to turn this off — the request was rejected upstream
// (foundryvtt#12254, "closed as not planned").
//
// The core ruler tags every waypoint it draws by `stage`: the past path is
// "passed", the live drag is "pending"/"planned". We wrap the ruler's style
// hooks and, when the GM has opted in, blank ONLY the "passed" ones — so the
// history disappears while the live drag ruler keeps working untouched.
//
// ⚠️ THE TRAIL IS DRAWN BY **FOUR** HOOKS, NOT TWO (found 2026-08-14).
// This shipped wrapping two of them, and the trail stayed on screen — because
// the two it missed are the two you actually SEE from across the room:
//
//     _getWaypointStyle        the dots            → {radius: 0}
//     _getSegmentStyle         the joining line    → {width: 0}
//     _getGridHighlightStyle   the coloured GRID SQUARES   ← was missed
//     _getWaypointLabelContext the "160 ft (+25) −60 ft" LABELS ← was missed
//
// Johnny's screen had a violet path of highlighted cells with distance and
// elevation labels running the length of a mine corridor. Zero dots, zero
// lines — those were suppressed perfectly. The feature looked completely
// broken while doing exactly what it was written to do.
//
// ⚠️ HOW THAT HID FOR SO LONG, because the shape repeats: the FIRST diagnostic
// confirmed the wrapper returned width 0 for a synthetic "passed" waypoint, and
// the SECOND confirmed the real ruler called it 12 times and got 0 every time.
// Both were true. Both were irrelevant. Verifying that the code you wrote does
// what you wrote it to do is not the same as verifying the FEATURE works —
// only looking at the canvas settled it. When a fix "provably works" and the
// user still sees the problem, the proof is aimed at the wrong thing.
//
// ⚠️ THE LABEL HOOK MUTATES SHARED STATE. `_getWaypointLabelContext` walks the
// path accumulating `state.hasElevation` / `state.previousElevation`, and the
// LIVE drag labels are built from that same running state. Returning early
// without calling the original would corrupt the elevation deltas on the very
// ruler we are trying to preserve. So we always call through, then discard.
//
// The wrappers read the setting on every call, so toggling takes effect on the
// next ruler refresh — no reload, no re-patching. Verified against Foundry
// 13.351 and dnd5e 5.3.3, whose TokenRuler5e subclass overrides two of these
// four (waypoint style and label context) and inherits the other two.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export const MovementTrail = {
  /** Patch the active token-ruler class. Safe to call once, at ready. */
  init() {
    const R = CONFIG.Token?.rulerClass;
    if (!R?.prototype) {
      console.warn(`${MODULE_ID} | MovementTrail: no Token rulerClass to patch.`);
      return;
    }
    if (R.__aceTrailPatched) return;
    const P = R.prototype;

    const hideTrail = () => {
      try { return game.settings.get(MODULE_ID, "hideMovementTrail") === true; }
      catch (_) { return false; }
    };
    const isPast = (wp) => wp?.stage === "passed";

    // ⚠️ Resolved through the prototype CHAIN. dnd5e's TokenRuler5e defines only
    // some of these; the rest come from Foundry's TokenRuler. Assigning below
    // creates an own property that shadows whichever one we captured, which is
    // correct in both cases. Anything genuinely missing is left alone rather
    // than replaced with a guess — a wrong style is worse than an unhidden one.
    const orig = {
      segment:  P._getSegmentStyle,
      waypoint: P._getWaypointStyle,
      grid:     P._getGridHighlightStyle,
      label:    P._getWaypointLabelContext,
    };
    const missing = Object.entries(orig).filter(([, fn]) => typeof fn !== "function").map(([k]) => k);

    // ── The joining line ──────────────────────────────────────────────────
    if (typeof orig.segment === "function") {
      P._getSegmentStyle = function (waypoint) {
        if (hideTrail() && isPast(waypoint)) return { width: 0 };
        return orig.segment.call(this, waypoint);
      };
    }

    // ── The dots ──────────────────────────────────────────────────────────
    if (typeof orig.waypoint === "function") {
      P._getWaypointStyle = function (waypoint) {
        if (hideTrail() && isPast(waypoint)) return { radius: 0 };
        return orig.waypoint.call(this, waypoint);
      };
    }

    // ── The coloured grid squares ─────────────────────────────────────────
    // `{alpha: 0}` is Foundry's OWN "draw nothing" return here — it is what the
    // stock method gives back for unreachable waypoints, so this is the
    // sanctioned way to say no, not a hack.
    if (typeof orig.grid === "function") {
      P._getGridHighlightStyle = function (waypoint, offset) {
        if (hideTrail() && isPast(waypoint)) return { alpha: 0 };
        return orig.grid.call(this, waypoint, offset);
      };
    }

    // ── The distance / elevation labels ───────────────────────────────────
    // ⚠️ ALWAYS CALL THROUGH FIRST. See the header: this hook accumulates the
    // running elevation state the live drag labels depend on. Suppress the
    // RESULT, never the call. Foundry skips any waypoint whose context is
    // falsy (`if (!context) continue`), so null is the supported "no label".
    if (typeof orig.label === "function") {
      P._getWaypointLabelContext = function (waypoint, state) {
        const context = orig.label.call(this, waypoint, state);
        if (hideTrail() && isPast(waypoint)) return null;
        return context;
      };
    }

    R.__aceTrailPatched = true;
    if (missing.length) {
      console.warn(`${MODULE_ID} | MovementTrail: ${R.name} has no ${missing.join(", ")} — ` +
        `that part of the trail cannot be hidden on this Foundry/system version.`);
    }
    console.log(`${MODULE_ID} | MovementTrail: history toggle installed on ${R.name} ` +
      `(dots, line, grid squares, labels).`);
  },

  /** Force every token's ruler to redraw — called when the setting flips. */
  refreshAll() {
    try {
      for (const t of (canvas?.tokens?.placeables ?? [])) t.renderFlags?.set?.({ refreshRuler: true });
    } catch (_) { /* non-fatal */ }
  },
};
