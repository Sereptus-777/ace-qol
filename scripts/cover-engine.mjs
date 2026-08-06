// ─── ACE: QOL — Cover Calculation Engine ──────────────────────────────────────
// Automatically calculates cover between tokens using corner-to-corner ray
// casting against canvas walls. Integrates with the attack pipeline to add
// cover AC bonuses before hit determination.
//
// D&D 5e Cover Rules:
//   Half Cover (+2 AC, +2 DEX saves)    — 25-74% of rays blocked
//   Three-Quarters Cover (+5 AC, +5 DEX saves) — 75-99% blocked
//   Full Cover (untargetable)            — 100% blocked
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { CombatState } from "./combat-state.mjs";

// ─── Cover level constants ──────────────────────────────────────────────────
export const COVER_NONE           = 0;
export const COVER_HALF           = 2;
export const COVER_THREE_QUARTERS = 5;
export const COVER_FULL           = 999;

// ─── Labels for display ─────────────────────────────────────────────────────
const COVER_LABELS = {
  [COVER_NONE]:           "No Cover",
  [COVER_HALF]:           "Half Cover (+2 AC)",
  [COVER_THREE_QUARTERS]: "\u00BE Cover (+5 AC)",
  [COVER_FULL]:           "Full Cover",
};

export class CoverEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Core Calculation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculate cover between an attacker token and a target token.
   * Uses corner-to-corner ray casting (DMG variant) or center-to-center
   * depending on the coverCalculationMethod setting.
   *
   * @param {Token} attacker  - The attacking token (placeable object)
   * @param {Token} target    - The target token (placeable object)
   * @returns {{ cover: number, label: string, acBonus: number, dexSaveBonus: number, blocked: number, total: number }}
   */
  static calculateCover(attacker, target) {
    if (!attacker || !target) return CoverEngine._noCover();

    // ── Check if cover calculation is enabled ──
    try {
      if (!QolSettings.get("enableCoverCalculation")) return CoverEngine._noCover();
    } catch { /* settings not ready — calculate anyway */ }

    // ── Adjacent tokens ignore cover (optional, default ON) ──
    try {
      if (QolSettings.get("ignoreCoverForAdjacent")) {
        const distance = CombatState._getDistance(attacker, target);
        if (distance <= 5) return CoverEngine._noCover();
      }
    } catch (err) { console.debug("ace-qol | CoverEngine adjacency check:", err); }

    // ── Choose calculation method ──
    let method = "corners";
    try { method = QolSettings.get("coverCalculationMethod"); } catch { /* default */ }

    let blockedCount = 0;
    let totalRays = 0;

    if (method === "center") {
      // Simple center-to-center — single ray
      totalRays = 1;
      blockedCount = CoverEngine._isRayBlocked(attacker.center, target.center) ? 1 : 0;
    } else {
      // Corner-to-corner: cast rays from each attacker corner to each target corner
      const attackerCorners = CoverEngine._getTokenCorners(attacker);
      const targetCorners = CoverEngine._getTokenCorners(target);

      totalRays = attackerCorners.length * targetCorners.length;
      for (const ac of attackerCorners) {
        for (const tc of targetCorners) {
          if (CoverEngine._isRayBlocked(ac, tc)) {
            blockedCount++;
          }
        }
      }
    }

    // ── Add creature-as-cover if enabled ──
    let creatureCover = 0;
    try {
      if (QolSettings.get("creatureAsCover")) {
        creatureCover = CoverEngine._checkCreatureCover(attacker, target);
      }
    } catch { /* no creature cover */ }

    // ── Determine cover level from blocked percentage ──
    const blockedPct = totalRays > 0 ? (blockedCount / totalRays) : 0;
    let cover = COVER_NONE;

    if (blockedPct >= 1.0) {
      cover = COVER_FULL;
    } else if (blockedPct >= 0.75) {
      cover = COVER_THREE_QUARTERS;
    } else if (blockedPct >= 0.25) {
      cover = COVER_HALF;
    }

    // Creature cover can bump up from none to half, but doesn't stack beyond that
    if (cover === COVER_NONE && creatureCover > 0) {
      cover = COVER_HALF;
    }

    // ── House rule: large+ targets resist cover (can't hide behind small things) ──
    let sizeReduced = false;
    try {
      if (QolSettings.get("reduceCoverForLargeTargets") && cover !== COVER_FULL) {
        const targetSize = target.document?.width ?? 1; // grid units; Large=2, Huge=3, Gargantuan=4
        const before = cover;
        if (targetSize >= 3) {
          // Huge / Gargantuan: only Full cover applies
          cover = COVER_NONE;
        } else if (targetSize >= 2) {
          // Large: no Half cover, ¾ cover downgrades to Half
          if (cover === COVER_HALF) cover = COVER_NONE;
          else if (cover === COVER_THREE_QUARTERS) cover = COVER_HALF;
        }
        if (cover !== before) sizeReduced = true;
      }
    } catch { /* setting not ready */ }

    const label = COVER_LABELS[cover] ?? "No Cover";
    return {
      cover,
      label,
      acBonus: cover === COVER_FULL ? 0 : cover,  // Full cover = untargetable, not an AC bonus
      dexSaveBonus: cover === COVER_FULL ? 0 : cover,
      blocked: blockedCount,
      total: totalRays,
      blockedPct: Math.round(blockedPct * 100),
      isFullCover: cover === COVER_FULL,
      sizeReduced,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Ray Casting — Wall Collision
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a ray between two points is blocked by a wall.
   * Uses Foundry's built-in wall collision system.
   *
   * @param {{ x: number, y: number }} origin
   * @param {{ x: number, y: number }} destination
   * @returns {boolean} True if the ray is blocked
   */
  static _isRayBlocked(origin, destination) {
    try {
      // Foundry v12+: ClockwiseSweepPolygon-based collision check
      // {type: "sight"} checks against walls that block vision — these are
      // the same walls that would provide physical cover in combat.
      // We use "move" type as it best represents physical obstruction.
      const result = CONFIG.Canvas.polygonBackends?.sight?.testCollision(
        origin, destination, { type: "sight", mode: "any" }
      );
      if (result !== undefined) return !!result;

      // Fallback: the WallsLayer helper.
      // ⚠️ V13 signature is checkCollision(DESTINATION, {origin, type, mode}) —
      // and `Ray` is NOT a global any more (it moved to
      // foundry.canvas.geometry.Ray). The old `new Ray(...)` here threw a
      // ReferenceError straight into the catch below, which returns false =
      // "no wall in the way" = cover silently never applied. Same fail-open
      // trap that disabled wall checking in party-transfer.mjs.
      if (typeof canvas.walls?.checkCollision === "function") {
        return !!canvas.walls.checkCollision(
          { x: destination.x, y: destination.y },
          { origin: { x: origin.x, y: origin.y }, type: "sight", mode: "any" }
        );
      }

      return false;
    } catch (err) {
      console.warn(`${MODULE_ID} | Cover ray check failed:`, err);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Token Corner Calculation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the 4 corners of a token's occupied space in pixel coordinates.
   * For multi-square tokens (Large, Huge, Gargantuan), returns the outer
   * corners of the full occupied area.
   *
   * Corners are inset by 1px to prevent false positives from walls that
   * are exactly on the grid edge.
   *
   * @param {Token} token - A placeable Token object
   * @returns {{ x: number, y: number }[]} Array of 4 corner points
   */
  static _getTokenCorners(token) {
    const gs = canvas.grid.size;
    const w = (token.document?.width ?? 1) * gs;
    const h = (token.document?.height ?? 1) * gs;
    const x = token.x;
    const y = token.y;

    // Inset by 1px to avoid false positives on grid-edge walls
    const inset = 1;

    return [
      { x: x + inset,     y: y + inset },         // Top-left
      { x: x + w - inset, y: y + inset },         // Top-right
      { x: x + inset,     y: y + h - inset },     // Bottom-left
      { x: x + w - inset, y: y + h - inset },     // Bottom-right
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Creature-as-Cover (Optional Rule)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if other tokens (creatures) provide cover between the attacker
   * and the target. Per PHB optional rule, a creature of Medium size or
   * larger in the path provides half cover.
   *
   * @param {Token} attacker
   * @param {Token} target
   * @returns {number} Cover bonus from creatures (0 or COVER_HALF)
   */
  static _checkCreatureCover(attacker, target) {
    if (!canvas.tokens?.placeables) return 0;

    const atkCenter = attacker.center;
    const tgtCenter = target.center;

    // Build a ray from attacker center to target center
    // (v13: Ray namespaced under foundry.canvas.geometry.Ray)
    const RayClass = foundry.canvas?.geometry?.Ray ?? globalThis.Ray;
    const ray = new RayClass(atkCenter, tgtCenter);
    const rayLength = ray.distance;
    if (rayLength < 1) return 0;

    for (const token of canvas.tokens.placeables) {
      // Skip the attacker and target themselves
      if (token.id === attacker.id || token.id === target.id) continue;

      // Skip tiny creatures (they don't provide meaningful cover)
      const size = token.document?.width ?? 1;
      if (size < 1) continue;

      // Skip dead/unconscious creatures (they're prone — could still provide cover
      // but we'll be lenient and skip them)
      const actor = token.actor;
      if (actor) {
        const hp = actor.system?.attributes?.hp?.value ?? 0;
        if (hp <= 0) continue;
      }

      // Check if this token's center is roughly between attacker and target
      // Project the token center onto the ray and check distance from line
      const tokenCenter = token.center;
      const closestPoint = CoverEngine._closestPointOnSegment(atkCenter, tgtCenter, tokenCenter);
      const distFromLine = Math.hypot(tokenCenter.x - closestPoint.x, tokenCenter.y - closestPoint.y);

      // The token provides cover if its center is within half its occupied space
      // from the attack ray
      const tokenRadius = (size * canvas.grid.size) / 2;
      if (distFromLine < tokenRadius) {
        // Also check that the blocking token is actually BETWEEN attacker and target
        const distToAtk = Math.hypot(tokenCenter.x - atkCenter.x, tokenCenter.y - atkCenter.y);
        const distToTgt = Math.hypot(tokenCenter.x - tgtCenter.x, tokenCenter.y - tgtCenter.y);
        if (distToAtk < rayLength && distToTgt < rayLength) {
          return COVER_HALF;
        }
      }
    }

    return 0;
  }

  /**
   * Find the closest point on a line segment AB to point P.
   * Used for creature-as-cover ray proximity check.
   */
  static _closestPointOnSegment(a, b, p) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return { x: a.x, y: a.y };

    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    return { x: a.x + t * dx, y: a.y + t * dy };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Visual Indicator
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show a brief scrolling text indicator on the target token displaying
   * the cover level. Only shown if showCoverIndicator setting is enabled.
   *
   * @param {Token} target    - The target token
   * @param {object} coverResult - Result from calculateCover()
   */
  static async showCoverIndicator(target, coverResult) {
    if (!target || !coverResult || coverResult.cover === COVER_NONE) return;

    try {
      if (!QolSettings.get("showCoverIndicator")) return;
    } catch { /* show by default */ }

    // Color coding: half = yellow, three-quarters = orange, full = red
    let color;
    let text;
    switch (coverResult.cover) {
      case COVER_HALF:
        color = 0xFFD700;  // Gold
        text = "Half Cover (+2 AC)";
        break;
      case COVER_THREE_QUARTERS:
        color = 0xFF8C00;  // Dark orange
        text = "\u00BE Cover (+5 AC)";
        break;
      case COVER_FULL:
        color = 0xFF4444;  // Red
        text = "Full Cover!";
        break;
      default:
        return;
    }

    // Use Foundry's scrolling text API on the token
    try {
      if (target.document) {
        // Foundry v12+: use the token document
        await target.document.object?.hud?.createScrollingText?.(text, {
          anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
          direction: CONST.TEXT_ANCHOR_POINTS.TOP,
          fill: `#${color.toString(16).padStart(6, "0")}`,
          fontSize: 28,
          stroke: 0x000000,
          strokeThickness: 4,
          duration: 2000,
        });
      }

      // Fallback: canvas.interface scrolling text
      if (canvas.interface?.createScrollingText) {
        canvas.interface.createScrollingText(target.center, text, {
          anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
          direction: CONST.TEXT_ANCHOR_POINTS.TOP,
          fill: `#${color.toString(16).padStart(6, "0")}`,
          fontSize: 28,
          stroke: 0x000000,
          strokeThickness: 4,
          duration: 2000,
        });
      }
    } catch (err) {
      // Scrolling text is non-critical — log and move on
      console.warn(`${MODULE_ID} | Cover indicator display failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Batch Assessment
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get cover results for all currently targeted tokens from the given
   * attacker token. Returns an array of objects with the target token
   * and its cover assessment.
   *
   * @param {Token} attacker - The attacking token
   * @returns {{ token: Token, cover: number, label: string, acBonus: number, dexSaveBonus: number }[]}
   */
  static getTargetCover(attacker) {
    if (!attacker) return [];

    const targets = game.user.targets;
    const results = [];

    for (const target of targets) {
      const coverResult = CoverEngine.calculateCover(attacker, target);
      results.push({
        token: target,
        tokenId: target.id,
        tokenDocId: target.document?.id ?? target.id,
        ...coverResult,
      });
    }

    return results;
  }

  /**
   * Get the attacker token from an actor. Tries controlled tokens first,
   * then falls back to the actor's active tokens.
   *
   * @param {Actor} actor
   * @returns {Token|null}
   */
  static getAttackerToken(actor) {
    // Prefer the currently controlled token
    const controlled = canvas.tokens?.controlled?.[0];
    if (controlled?.actor?.id === actor?.id) return controlled;

    // Fall back to actor's active tokens
    const activeTokens = actor?.getActiveTokens?.();
    return activeTokens?.[0] ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  No-Cover Helper
  // ═══════════════════════════════════════════════════════════════════════════

  /** @returns A default "no cover" result object */
  static _noCover() {
    return {
      cover: COVER_NONE,
      label: "No Cover",
      acBonus: 0,
      dexSaveBonus: 0,
      blocked: 0,
      total: 0,
      blockedPct: 0,
      isFullCover: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  API Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register public API methods on game.aceQol for external access
   * and console testing.
   */
  static registerAPI() {
    if (!game.aceQol) return;

    game.aceQol.CoverEngine = CoverEngine;
    game.aceQol.calculateCover = CoverEngine.calculateCover;
    game.aceQol.getTargetCover = CoverEngine.getTargetCover;

    console.debug(`${MODULE_ID} | Cover engine API registered (game.aceQol.calculateCover, game.aceQol.getTargetCover)`);
  }
}
