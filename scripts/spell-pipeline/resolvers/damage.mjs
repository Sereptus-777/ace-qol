// ─── ACE: QOL — Pipeline Resolver: Damage ─────────────────────────────────────
// Builds the damage card for distribute / chained / single-target damage shapes.
// Uses the existing DamageCardRenderer.postDamageButton entry point.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { DamageCalculator } from "../../damage-calculator.mjs";
import { DamageCardRenderer } from "../../damage-card-renderer.mjs";

export class DamageResolver {

  /**
   * Distribute shape — Magic Missile, Scorching Ray.
   * Builds per-target hits array with N units of damage each (e.g. dart count).
   *
   * @param {object} ctx - { entry, item, actor, castLevel, ... }
   * @param {object} result - { distribution: Map<Actor, number> }
   */
  static async runDistribute(ctx, result) {
    const { entry, item, actor } = ctx;
    const distribution = result?.distribution;
    if (!(distribution instanceof Map) || distribution.size === 0) {
      console.warn(`${MODULE_ID} | DamageResolver.runDistribute: empty distribution`);
      return;
    }

    const unitFormula = entry.unit?.formula;
    const unitType    = entry.unit?.type ?? "force";
    if (!unitFormula) {
      console.error(`${MODULE_ID} | DamageResolver.runDistribute: registry entry missing unit.formula`);
      return;
    }

    // ── Shield (vs Magic Missile) check ──
    // Shield negates ALL darts from one target. Filter before building hits.
    let filteredDistribution = distribution;
    try {
      const reactionEng = game.aceQol?.reactionEngine;
      if (reactionEng?.checkMagicMissileShield) {
        filteredDistribution = await reactionEng.checkMagicMissileShield(distribution, actor, item);
        if (!filteredDistribution || filteredDistribution.size === 0) {
          ui.notifications?.info(`${item.name}: all targets used Shield — no damage applied.`);
          console.log(`${MODULE_ID} | DamageResolver.runDistribute: all targets shielded — aborted`);
          return;
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | DamageResolver: Shield check failed (non-blocking):`, err);
    }

    // ── Build hits[] ──
    const hits = [];
    let firstHit = true;
    for (const [targetActor, units] of filteredDistribution.entries()) {
      if (!targetActor || units <= 0) continue;
      const token = targetActor.getActiveTokens?.()?.[0]
                 ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id);
      if (!token) continue;

      const combinedFormula = DamageResolver._scaleFormulaToUnits(unitFormula, units);

      hits.push({
        target: {
          name:      token.name ?? targetActor.name,
          img:       targetActor.img ?? token.document?.texture?.src,
          currentHP: targetActor.system?.attributes?.hp?.value ?? 0,
          maxHP:     targetActor.system?.attributes?.hp?.max ?? 0,
        },
        targetActor,
        targetToken: token,
        hitResult:   "hit",
        d20Result:   null,
        isCritRoll:  false,
        damageModifiers: DamageCalculator.getTargetDamageModifiers(targetActor, item),
        name: token.name ?? targetActor.name,
        img:  targetActor.img ?? token.document?.texture?.src,
        ac:   targetActor.system?.attributes?.ac?.value ?? 0,
        // The DamageCalculator looks for this magicMissileOverride field.
        // Reusing the same field name keeps backward compatibility with
        // the v0.7.17 fork; future "distribute" spells (Scorching Ray) can
        // route through the same shape.
        magicMissileOverride: {
          formula: combinedFormula,
          type:    unitType,
          darts:   units,
        },
        // Empowered Evocation (Wizard Evocation 10+): one damage roll of
        // any wizard evocation spell adds spellcasting mod. Apply to the
        // FIRST hit; override widget on the damage card lets player change.
        applyEmpoweredEvocation: firstHit,
      });
      firstHit = false;
    }

    if (!hits.length) {
      console.warn(`${MODULE_ID} | DamageResolver.runDistribute: distribution had entries but no tokens resolved`);
      return;
    }

    // ── Post the damage card ──
    await DamageCardRenderer.postDamageButton(item, actor, hits, []);
    console.debug(`${MODULE_ID} | DamageResolver.runDistribute: posted damage card for ${item.name} (${hits.length} targets)`);
  }

  /**
   * Single-target damage shape (Vampiric Touch, future). Stub for Phase 2.
   */
  static async runSingle(_ctx, _result) {
    console.warn(`${MODULE_ID} | DamageResolver.runSingle not yet implemented (Phase 2).`);
  }

  /**
   * Chained shape (Chain Lightning). Stub for Phase 2.
   */
  static async runChained(_ctx, _result) {
    console.warn(`${MODULE_ID} | DamageResolver.runChained not yet implemented (Phase 2).`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Scale a per-unit formula by N units.
   * "1d4 + 1" × 3 → "3d4 + 3"
   * Handles dice expressions, flat numbers, and additive combinations.
   * Falls back to "(formula) * N" if structure is unrecognizable.
   */
  static _scaleFormulaToUnits(unitFormula, units) {
    if (!units || units <= 0) return "0";
    if (units === 1) return unitFormula;

    // Parse "NdX" pieces — multiply count
    // Parse flat numbers — multiply
    // Anything else — wrap in (formula) * N
    const cleaned = String(unitFormula ?? "").trim();
    const pattern = /^(\d+)?d(\d+)\s*([+\-]\s*\d+)?$/i;
    const m = cleaned.match(pattern);
    if (m) {
      const baseCount = parseInt(m[1] ?? "1", 10);
      const dieSize   = m[2];
      const modifier  = m[3] ? m[3].replace(/\s/g, "") : "";
      const newCount  = baseCount * units;
      const newMod    = modifier
        ? ` ${modifier[0]} ${parseInt(modifier.slice(1), 10) * units}`
        : "";
      return `${newCount}d${dieSize}${newMod}`;
    }

    // Pure number
    if (/^\d+$/.test(cleaned)) {
      return String(parseInt(cleaned, 10) * units);
    }

    // Fallback — defensive
    return `(${cleaned}) * ${units}`;
  }
}
