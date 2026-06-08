// ─── ACE: QOL — Spell Pipeline Animation Helper ──────────────────────────────
// Fires Automated Animations AFTER the picker confirms targets, so the
// trajectory animation lands on the right tokens (not pre-cast stale targets).
//
// Pattern: set game.user.targets to the resolved target list, then call
// AA's public API. AA reads targets from game.user.targets internally.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";

export class AnimationHelper {

  /**
   * Play the AA animation for a spell after picker confirms.
   * @param {object} ctx - Pipeline context { entry, item, actor, ... }
   * @param {object} result - Picker result { targets[]?, distribution?, target? }
   */
  static async play(ctx, result) {
    try {
      const aa = globalThis.AutomatedAnimations ?? window.AutomatedAnimations;
      if (!aa?.playAnimation) return;

      const casterToken = ctx.actor.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === ctx.actor.id);
      if (!casterToken) return;

      // Resolve targets from picker result into Token objects
      const targets = AnimationHelper._extractTargets(result);

      // Set game.user.targets via per-Token setTarget (V13 API)
      if (targets.length > 0) {
        AnimationHelper._setUserTargets(targets);
      }

      aa.playAnimation(casterToken, ctx.item);
      console.debug(`${MODULE_ID} | AnimationHelper: fired AA for ${ctx.item.name} (${targets.length} targets)`);
    } catch (err) {
      console.warn(`${MODULE_ID} | AnimationHelper failed (non-fatal):`, err);
    }
  }

  /**
   * Clear game.user.targets — used after damage card to leave state clean.
   */
  static clearUserTargets() {
    try {
      for (const t of [...(game.user.targets ?? [])]) {
        t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
      }
      game.user.targets.clear?.();
    } catch (_) { /* non-fatal */ }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  static _extractTargets(result) {
    if (!result) return [];
    if (Array.isArray(result.targets)) {
      return result.targets.map(t => t.token ?? t).filter(Boolean);
    }
    if (result.distribution instanceof Map) {
      return [...result.distribution.keys()]
        .map(a => a.getActiveTokens?.()?.[0] ?? null)
        .filter(Boolean);
    }
    if (result.target) {
      return [result.target.token ?? result.target].filter(Boolean);
    }
    return [];
  }

  static _setUserTargets(tokens) {
    try {
      // Clear first
      for (const t of [...(game.user.targets ?? [])]) {
        t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
      }
      // Set the new ones
      for (const t of tokens) {
        t.setTarget?.(true, { user: game.user, releaseOthers: false, groupSelection: false });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | AnimationHelper._setUserTargets failed:`, err);
    }
  }
}
