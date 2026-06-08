// ─── ACE: QOL — Pipeline Resolver: Damage ─────────────────────────────────────
// Builds the damage card for distribute / chained / single-target damage shapes.
// Uses the existing DamageCardRenderer.postDamageButton entry point.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { DamageCalculator } from "../../damage-calculator.mjs";
import { DamageCardRenderer } from "../../damage-card-renderer.mjs";
import { TargetState } from "../../target-state.mjs";
import { AnimationHelper } from "../animation.mjs";

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

    const spellName = String(item.name ?? "").toLowerCase().trim();

    // ── PASSIVE NULLIFICATION SWEEP (v0.7.18) ──
    // Walk TargetState.assess() per target to check for:
    //   • Active Shield effect → MM immunity (RAW: "no damage from magic missile")
    //   • Brooch of Shielding equipped → MM immunity
    //   • Spell-name immunity registry entries
    //   • Damage type immunity for the unit's damage type
    // Filter these targets out of the distribution BEFORE prompting for Shield
    // (no point prompting someone who's already immune) AND post chat notes
    // explaining WHY each excluded target took no damage.
    let filteredDistribution = new Map();
    const nullifiedNotes = [];
    for (const [targetActor, darts] of distribution.entries()) {
      if (!targetActor || darts <= 0) continue;
      const token = targetActor.getActiveTokens?.()?.[0]
                 ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id);
      if (!token) { filteredDistribution.set(targetActor, darts); continue; }

      let state = null;
      try { state = TargetState.assess(token, actor, item, [unitType], { isSpell: true }); }
      catch (err) { console.warn(`${MODULE_ID} | TargetState.assess threw (non-blocking):`, err); }

      // (1) Spell-by-name immunity (Shield→MM, Brooch→MM, future Globe→sub-5th, etc.)
      const spellImmune = state?.nullifications?.spellImmune ?? [];
      if (spellImmune.includes(spellName)) {
        const sources = state.nullifications?.spellImmuneSources?.[spellName] ?? ["spell immunity"];
        const reason = sources.join(", ");
        nullifiedNotes.push({ name: token.name ?? targetActor.name, reason, type: "spell-immune" });
        console.log(`${MODULE_ID} | DamageResolver: ${targetActor.name} immune to ${spellName} via [${reason}] — ${darts} unit(s) nullified silently`);
        // Visual flash on the absorbing token — soft blue burst (JB2A free with PIXI fallback)
        AnimationHelper.flashNullification(token).catch(() => {});
        continue;  // do NOT add to filteredDistribution
      }

      // (2) Damage-type immunity (Force immunity vs MM, Fire immunity vs Fireball, etc.)
      const dmgMod = state?.damageModifiers?.[unitType]?.modifier;
      if (dmgMod === "immune") {
        const reason = state.damageModifiers[unitType]?.reason ?? `immune to ${unitType}`;
        nullifiedNotes.push({ name: token.name ?? targetActor.name, reason, type: "damage-immune" });
        console.log(`${MODULE_ID} | DamageResolver: ${targetActor.name} immune to ${unitType} via [${reason}] — units nullified`);
        AnimationHelper.flashNullification(token).catch(() => {});
        continue;
      }

      // Made it through — they take damage (possibly reduced by resistance, applied at card)
      filteredDistribution.set(targetActor, darts);
    }

    if (filteredDistribution.size === 0 && nullifiedNotes.length) {
      await DamageResolver._postNullificationCard(item, actor, nullifiedNotes);
      ui.notifications?.info(`${item.name}: all targets are immune — no damage applied.`);
      return;
    }

    // ── Shield-CAST reaction prompt (existing v0.7.17 behavior) ──
    // Now ONLY prompts targets that aren't already passively immune above.
    try {
      const reactionEng = game.aceQol?.reactionEngine;
      if (reactionEng?.checkMagicMissileShield) {
        filteredDistribution = await reactionEng.checkMagicMissileShield(filteredDistribution, actor, item);
        if (!filteredDistribution || filteredDistribution.size === 0) {
          if (nullifiedNotes.length) await DamageResolver._postNullificationCard(item, actor, nullifiedNotes);
          ui.notifications?.info(`${item.name}: all targets used Shield — no damage applied.`);
          console.log(`${MODULE_ID} | DamageResolver.runDistribute: all targets shielded — aborted`);
          return;
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | DamageResolver: Shield check failed (non-blocking):`, err);
    }

    // ── If any targets were nullified silently, post the explainer card ──
    if (nullifiedNotes.length) {
      await DamageResolver._postNullificationCard(item, actor, nullifiedNotes);
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

  /**
   * Post a chat card explaining why specific targets took zero damage from a
   * spell. Dark ACE wrapper, blue accent matching our other nullification cards.
   */
  static async _postNullificationCard(item, caster, notes) {
    if (!notes?.length) return;
    const accent = "#8ab4d8";
    const rows = notes.map(n => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 8px;background:rgba(138,180,216,0.08);border-radius:4px;margin-bottom:4px;">
        <i class="fas fa-shield-halved" style="color:${accent};font-size:14px;"></i>
        <div style="flex:1;">
          <strong style="color:#e8d49a;">${n.name}</strong>
          <span style="color:#c0b288;font-size:13px;"> — nullified by ${n.reason}</span>
        </div>
      </div>
    `).join("");

    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                  border:2px solid ${accent};
                  border-radius:6px;
                  padding:12px 14px;
                  color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;
                  box-shadow:0 0 10px ${accent}33;">
        <div style="display:flex;align-items:center;gap:10px;
                    font-size:15px;font-weight:700;color:${accent};
                    text-transform:uppercase;letter-spacing:0.6px;
                    border-bottom:1px solid #4a3a28;
                    padding-bottom:6px;margin-bottom:8px;">
          <i class="fas fa-shield-halved" style="font-size:16px;color:${accent};"></i>
          <span>${item.name.toUpperCase()} — NULLIFIED</span>
        </div>
        <div style="font-size:13px;color:#c0b288;margin-bottom:8px;font-style:italic;">
          The following ${notes.length === 1 ? "target was" : "targets were"} immune via active defenses:
        </div>
        ${rows}
      </div>
    `;
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: caster }),
        content: html,
        flavor: `${item.name} nullified for ${notes.length} target${notes.length === 1 ? "" : "s"}`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | DamageResolver: nullification card post failed:`, err);
    }
  }
}
