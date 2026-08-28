// ─── ACE: QOL — Spell Pipeline Animation Helper ──────────────────────────────
// Fires Automated Animations AFTER the picker confirms targets, so the
// trajectory animation lands on the right tokens (not pre-cast stale targets).
//
// Pattern: set game.user.targets to the resolved target list, then call
// AA's public API. AA reads targets from game.user.targets internally.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
// ⚠️ A spell ACE resolves with a PICKER never creates a template, and
// Automated Animations cannot reach it. These borrow AA's own curated choice
// and play it directly. See animation/autorec.mjs for the whole story.
import { whoOwnsThisCast, playCuratedAnimation } from "../animation/spell-animator.mjs";

export class AnimationHelper {

  /**
   * Play the AA animation for a spell after picker confirms.
   * @param {object} ctx - Pipeline context { entry, item, actor, ... }
   * @param {object} result - Picker result { targets[]?, distribution?, target? }
   */
  static async play(ctx, result) {
    try {
      const casterToken = ctx.actor.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === ctx.actor.id);
      if (!casterToken) return;

      // ── WHO OWNS THIS CAST ───────────────────────────────────────
      //
      // ⚠️ DECIDED ONCE, BEFORE EITHER FIRES. Two animations for one cast is
      // worse than none, and Johnny's rule is one sound for the source and one
      // for the primary. If the item places a template, Automated Animations
      // owns it and has always worked. If it does not, AA has nothing to hang a
      // templatefx entry on - which is exactly why Colour Spray was curated,
      // correct and completely invisible - so ACE plays AA's own choice itself.
      if (whoOwnsThisCast(ctx.item, ctx.entry) === "ace") {
        const targetsForAnim = AnimationHelper._extractTargets(result);
        if (targetsForAnim.length > 0) AnimationHelper._setUserTargets(targetsForAnim);
        await playCuratedAnimation({ casterToken, item: ctx.item, targets: targetsForAnim });
        return;
      }

      const aa = globalThis.AutomatedAnimations ?? window.AutomatedAnimations;
      if (!aa?.playAnimation) {
        // ⚠️ A SILENT RETURN HERE READS AS "THIS SPELL HAS NO ANIMATION".
        console.warn(`${MODULE_ID} | Automated Animations is not exposing `
          + `playAnimation, so "${ctx.item?.name}" will not animate. `
          + `Its API may have been renamed.`);
        return;
      }

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

  /**
   * Play a brief visual flash on the target indicating a spell/attack was
   * nullified or absorbed. Used by the nullification sweep + Shield reaction.
   *
   * Tiered fallback (no hard dependencies):
   *   1. JB2A free healing_generic.burst.bluewhite via Sequencer (richest)
   *   2. Pure PIXI circle-pulse drawn on the token (always works)
   *
   * @param {Token} token        - the target token
   * @param {string} accentColor - hex color (default soft blue)
   */
  static async flashNullification(token, accentColor = "#8ab4d8") {
    if (!token) return;

    // ── Path 1: JB2A + Sequencer (richest) ──
    try {
      if (window.Sequencer && window.Sequence) {
        const burstFile = "jb2a.healing_generic.burst.bluewhite";
        if (window.Sequencer.Database?.entryExists?.(burstFile)) {
          await new window.Sequence()
            .effect()
              .file(burstFile)
              .atLocation(token)
              .scaleToObject(1.3)
              .duration(900)
              .fadeIn(150)
              .fadeOut(400)
              .opacity(0.85)
            .play();
          return;
        }
      }
    } catch (err) {
      console.debug(`${MODULE_ID} | AnimationHelper.flashNullification: Sequencer/JB2A path failed, falling back to PIXI:`, err?.message ?? err);
    }

    // ── Path 2: PIXI pulse (always works, no module dependency) ──
    try {
      const ring = new PIXI.Graphics();
      const size = Math.max(token.w ?? 100, token.h ?? 100);
      const center = size / 2;
      const colorInt = parseInt(String(accentColor).replace("#", ""), 16);

      ring.lineStyle(4, colorInt, 0.9);
      ring.beginFill(colorInt, 0.25);
      ring.drawCircle(center, center, size * 0.55);
      ring.endFill();

      try { token.addChildAt(ring, 0); }
      catch (_) { token.addChild(ring); }

      // Animate alpha + scale pulse over 700ms
      let elapsed = 0;
      const duration = 700;
      const start = performance.now();
      const animate = (now) => {
        elapsed = now - start;
        const t = Math.min(1, elapsed / duration);
        // Ease-out cubic
        const eased = 1 - Math.pow(1 - t, 3);
        ring.alpha = 1 - eased;
        ring.scale.set(1 + eased * 0.45);
        ring.position.set(-center * (eased * 0.45), -center * (eased * 0.45));
        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          try { token.removeChild(ring); ring.destroy({ children: true }); }
          catch (_) {}
        }
      };
      requestAnimationFrame(animate);
    } catch (err) {
      console.warn(`${MODULE_ID} | AnimationHelper.flashNullification: PIXI fallback threw:`, err);
    }
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
