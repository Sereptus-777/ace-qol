// ─── ACE: QOL — Hide V13 token movement trail ───────────────────────────────
// Foundry V13's native token ruler remembers the path a token took during its
// turn and redraws that trail (a line + dots) every time you pick the token
// back up. Core ships NO setting to turn this off — the request was rejected
// upstream (foundryvtt#12254, "closed as not planned").
//
// This restores the off-switch. The core ruler tags each drawn segment by
// `stage`: the past path is "passed", the live drag is "pending"/"planned".
// We wrap the ruler's two style hooks and, when the GM has opted in, blank ONLY
// the "passed" segments/waypoints — so the movement-history trail disappears
// while the live drag-distance readout keeps working untouched.
//
// The wrapper reads the setting on every call, so toggling the setting takes
// effect on the next ruler refresh (no reload, no re-patching). Verified
// against Foundry 13.351: see TokenRuler#_getSegmentStyle / #_getWaypointStyle.
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

    const origSegment  = R.prototype._getSegmentStyle;
    const origWaypoint = R.prototype._getWaypointStyle;

    const hideTrail = () => {
      try { return game.settings.get(MODULE_ID, "hideMovementTrail") === true; }
      catch (_) { return false; }
    };

    R.prototype._getSegmentStyle = function (waypoint) {
      if (hideTrail() && waypoint?.stage === "passed") return { width: 0 };
      return origSegment.call(this, waypoint);
    };
    R.prototype._getWaypointStyle = function (waypoint) {
      if (hideTrail() && waypoint?.stage === "passed") return { radius: 0 };
      return origWaypoint.call(this, waypoint);
    };

    R.__aceTrailPatched = true;
    console.log(`${MODULE_ID} | MovementTrail: token-ruler history toggle installed.`);
  },

  /** Force every token's ruler to redraw — called when the setting flips. */
  refreshAll() {
    try {
      for (const t of (canvas?.tokens?.placeables ?? [])) t.renderFlags?.set?.({ refreshRuler: true });
    } catch (_) { /* non-fatal */ }
  },
};
