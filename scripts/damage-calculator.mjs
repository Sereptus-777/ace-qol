// ─── ACE: QOL — Damage Calculator ────────────────────────────────────────────
// Pure math: roll damage components, apply crit rules, resolve resistance/
// immunity/vulnerability. No UI, no DOM, no hooks — just numbers in, numbers out.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { DamageConstants } from "./damage-engine.mjs";
import { CombatState } from "./combat-state.mjs";

const PHYSICAL_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

export class DamageCalculator {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll Damage Components — Each Type Separate
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll each damage source separately by type.
   * Returns array of { name, formula, roll, total, type, isCritBonus }
   */
  static async rollDamageComponents(item, actor, targetState, isCrit, critRule) {
    const components = [];
    const sys = item.system ?? {};

    // Get roll data — prefer item (includes @mod) with actor fallback
    let rollData;
    try {
      rollData = item.getRollData?.() ?? actor.getRollData?.() ?? {};
    } catch (e) {
      console.warn(`${MODULE_ID} | item.getRollData() failed, falling back to actor:`, e.message);
      rollData = actor.getRollData?.() ?? {};
    }

    // ── Parse item description for conditional damage (save-gated) ──
    const parsed = DescriptionParser.parse(item);
    const conditionalDamageTypes = new Set();
    if (parsed.saves.length > 0) {
      for (const bd of parsed.bonusDamage) {
        if (bd.damageType) conditionalDamageTypes.add(bd.damageType);
      }
    }

    // ── Use the D&D 5e system's own damage formula builder ──────────
    // The system knows EVERYTHING: ability mod, magic bonus, ammo bonus,
    // scaling, proficiency — all of it. We call getDamageConfig() to get
    // the complete formula, then roll it ourselves with our crit rules.
    let usedNativeConfig = false;
    const activities = sys.activities;
    if (activities) {
      const actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      for (const activity of actList) {
        if (!activity?.damage?.parts?.length) continue;
        if (typeof activity.getDamageConfig !== "function") continue;

        try {
          const dmgConfig = activity.getDamageConfig({}, { rollData });
          const rolls = dmgConfig?.rolls ?? [];

          for (let i = 0; i < rolls.length; i++) {
            const rollCfg = rolls[i];
            const parts = rollCfg.parts ?? [];
            if (!parts.length) continue;

            // Join the system's formula parts (it already includes @mod, @magicalBonus, etc.)
            const formula = parts.join(" + ");
            const type = rollCfg.options?.type ?? rollCfg.options?.types?.[0] ?? "untyped";

            // Skip conditional damage parts (gated behind a save from description)
            if (conditionalDamageTypes.has(type) && i > 0) continue;

            // Resolve @references and roll with our crit rules
            const data = rollCfg.data ?? rollData;
            const result = await DamageCalculator.rollWithCrit(formula, data, isCrit, critRule, `Base ${type}`);
            components.push({ name: item.name, ...result, type });
          }

          // Tag first component with modifier metadata for card labels
          if (components.length > 0 && !components[0]._modMeta) {
            const magicBonus = sys.magicalBonus ?? 0;
            let abilName = "MOD";
            let abilMod = 0;
            try {
              const str = rollData.abilities?.str?.mod ?? 0;
              const dex = rollData.abilities?.dex?.mod ?? 0;
              let resolvedAbility = activity?.ability;
              if (resolvedAbility instanceof Set || resolvedAbility instanceof Array) resolvedAbility = [...resolvedAbility][0];
              if (resolvedAbility && typeof resolvedAbility === "string") {
                abilName = resolvedAbility.toUpperCase();
                abilMod = rollData.abilities?.[resolvedAbility]?.mod ?? rollData.mod ?? 0;
              } else {
                const atkAbility = activity?.attack?.ability;
                if (atkAbility && atkAbility !== "none") {
                  abilName = atkAbility.toUpperCase();
                  abilMod = rollData.abilities?.[atkAbility]?.mod ?? rollData.mod ?? 0;
                } else {
                  const actionType = activity?.actionType ?? sys.actionType ?? "mwak";
                  const isFinesse = sys.properties?.has?.("fin") || sys.properties?.fin;
                  const isThrown = sys.properties?.has?.("thr") || sys.properties?.thr;
                  if (isFinesse) {
                    abilName = (dex >= str) ? "DEX" : "STR";
                    abilMod = Math.max(str, dex);
                  } else if (isThrown && actionType === "rwak") {
                    abilName = "STR"; abilMod = str;
                  } else if (["rwak", "rsak"].includes(actionType)) {
                    abilName = "DEX"; abilMod = dex;
                  } else {
                    abilName = "STR"; abilMod = str;
                  }
                }
              }
              if (abilMod === 0 && rollData.mod) abilMod = rollData.mod;
            } catch (_) { /* keep default */ }

            components[0]._modMeta = {
              abilityMod: abilMod,
              abilityName: abilName,
              magicBonus: magicBonus,
            };
            console.log(`${MODULE_ID} | Modifier metadata: ${abilName}=${abilMod}, MAGIC=${magicBonus}`);
          }

          usedNativeConfig = true;
        } catch (e) {
          console.warn(`${MODULE_ID} | getDamageConfig() failed for ${item.name}, falling back to manual:`, e.message);
        }

        break; // Only use first attack activity
      }
    }

    // ── Fallback: manual formula construction (legacy or getDamageConfig unavailable) ──
    if (!usedNativeConfig) {
      if (activities) {
        const actList = (typeof activities.forEach === "function")
          ? [...(activities.values?.() ?? activities)]
          : (typeof activities === "object" ? Object.values(activities) : []);

        for (const activity of actList) {
          if (!activity?.damage?.parts?.length) continue;

          for (let i = 0; i < activity.damage.parts.length; i++) {
            const part = activity.damage.parts[i];
            const partTypes = part.types ? [...part.types] : [];
            if (partTypes.some(t => conditionalDamageTypes.has(t)) && i > 0) continue;

            let formula = part.custom?.enabled
              ? part.custom.formula
              : `${part.number ?? 1}d${part.denomination ?? 8}`;

            if (part.bonus && String(part.bonus) !== "0") {
              const bonusStr = String(part.bonus);
              formula += (bonusStr.startsWith("+") || bonusStr.startsWith("-")) ? bonusStr : `+${bonusStr}`;
            }

            // First part gets ability mod + magic bonus
            if (i === 0) {
              const resolvedAbil = activity?.ability;
              const str = rollData.abilities?.str?.mod ?? 0;
              const dex = rollData.abilities?.dex?.mod ?? 0;
              const abilityMod = resolvedAbil
                ? (rollData.abilities?.[resolvedAbil]?.mod ?? rollData.mod ?? 0)
                : (rollData.mod ?? str);
              if (abilityMod !== 0) formula += abilityMod >= 0 ? `+${abilityMod}` : `${abilityMod}`;

              const magicBonus = sys.magicalBonus ?? 0;
              const partBonusNum = parseInt(part.bonus) || 0;
              if (magicBonus > 0 && partBonusNum !== magicBonus) formula += `+${magicBonus}`;
            }

            const types = part.types ? [...part.types] : ["untyped"];
            const type = types[0] ?? "untyped";
            const result = await DamageCalculator.rollWithCrit(formula, rollData, isCrit, critRule, `Base ${type}`);
            const comp = { name: item.name, ...result, type };

            // Tag first component with modifier metadata
            if (i === 0) {
              const resolvedAbil = activity?.ability;
              const str = rollData.abilities?.str?.mod ?? 0;
              const dex = rollData.abilities?.dex?.mod ?? 0;
              let abilMod, abilName;
              if (resolvedAbil) {
                abilName = resolvedAbil.toUpperCase();
                abilMod = rollData.abilities?.[resolvedAbil]?.mod ?? rollData.mod ?? 0;
              } else {
                const actionType = activity?.actionType ?? sys.actionType ?? "mwak";
                const isFinesse = sys.properties?.has?.("fin") || sys.properties?.fin;
                const isThrown = sys.properties?.has?.("thr") || sys.properties?.thr;
                abilMod = rollData.mod ?? (isFinesse ? Math.max(str, dex) : ["rwak","rsak"].includes(actionType) ? dex : str);
                abilName = isFinesse ? (dex >= str ? "DEX" : "STR")
                         : (isThrown && actionType === "rwak") ? "STR"
                         : ["rwak","rsak"].includes(actionType) ? "DEX" : "STR";
              }
              comp._modMeta = {
                abilityMod: abilMod,
                abilityName: abilName,
                magicBonus: sys.magicalBonus ?? 0,
              };
            }

            components.push(comp);
          }
          break;
        }
      }

      // Legacy damage.parts array (pre-activities dnd5e)
      if (!components.length && sys.damage?.parts?.length) {
        for (const [formula, type] of sys.damage.parts) {
          const result = await DamageCalculator.rollWithCrit(formula, rollData, isCrit, critRule, `Base ${type}`);
          components.push({ name: item.name, ...result, type: type || "untyped" });
        }
      }
    }

    // ── Attacker bonus damage (Hex, Hunter's Mark, Rage, Sneak Attack) ──
    const bonuses = targetState.attacker?.bonuses ?? targetState.attackerBonuses ?? [];
    // Track first spell-derived radiant/fire bonus so Radiant Soul can attach
    // to its component AFTER all bonuses are rolled. Per RAW: "add CHA mod to
    // that damage" — singular, applies to ONE damage roll per turn.
    let radiantSoulTargetIdx = -1;
    let radiantSoulType = null;
    for (const bonus of bonuses) {
      if (!bonus.formula) continue;
      const bonusType = bonus.type ?? components[0]?.type ?? "untyped";
      const result = await DamageCalculator.rollWithCrit(bonus.formula, rollData, isCrit, critRule, bonus.name);
      const compIdx = components.length;
      components.push({ name: bonus.name ?? "Bonus", ...result, type: bonusType });
      // Mark the first qualifying spell-derived component for Radiant Soul
      if (radiantSoulTargetIdx === -1
          && bonus.isSpellDerived === true
          && (bonusType === "radiant" || bonusType === "fire")) {
        radiantSoulTargetIdx = compIdx;
        radiantSoulType = bonusType;
      }
    }

    // ── Radiant Soul (Celestial Warlock 6+) ──
    // Apply CHA mod to the FIRST spell-derived radiant/fire bonus on this hit.
    // Once-per-turn enforced via actor flag. The bonus is added as a NEW
    // component (rather than mutating the existing roll) so the damage card
    // shows it as a separate visible line — players can see exactly where
    // the +5 came from.
    try {
      if (radiantSoulTargetIdx !== -1) {
        const chaBonus = CombatState.getRadiantSoulBonus(actor, radiantSoulType);
        if (chaBonus > 0) {
          // Push as a flat component — formula matches the bonus value so the
          // existing rollWithCrit/applyDamageModifiers pipeline handles it.
          const flatRoll = new Roll(`${chaBonus}`);
          await flatRoll.evaluate();
          components.push({
            name: "Radiant Soul",
            formula: `${chaBonus}`,
            roll: flatRoll,
            total: chaBonus,
            type: radiantSoulType,
            isFeatureRider: true,
            featureLabel: "RADIANT SOUL",
          });
          // Mark used — fire-and-forget; the await isn't strictly necessary
          // for correctness because the next damage roll comes after this
          // pipeline completes, but we await for consistency.
          await CombatState.markRadiantSoulUsed(actor);
          console.log(`${MODULE_ID} | Radiant Soul: +${chaBonus} ${radiantSoulType} added to ${actor.name}'s ${item.name} (Celestial Warlock CHA mod)`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Radiant Soul rider check failed (non-fatal):`, err);
    }

    // ── Slayer bonus ──
    if (targetState.slayerMatch && targetState.slayerDamage) {
      const result = await DamageCalculator.rollWithCrit(targetState.slayerDamage, rollData, isCrit, critRule, "Slayer");
      components.push({
        name: `Slayer (${targetState.slayerType})`,
        ...result,
        type: components[0]?.type ?? "untyped",
      });
    }

    // ── Creature-type conditional bonus damage ──
    if (parsed.creatureTrigger) {
      const triggerType = parsed.creatureTrigger.creatureType?.toLowerCase();
      const targetType = targetState.creatureType?.toLowerCase() ?? "";
      const targetSubtype = targetState.creatureSubtype?.toLowerCase() ?? "";

      if (triggerType && (targetType === triggerType
          || targetType.includes(triggerType)
          || targetSubtype.includes(triggerType))) {

        let rolled = false;

        if (parsed.bonusDamage.length > 0) {
          for (const bd of parsed.bonusDamage) {
            if (!bd.formula) continue;
            // ── Crit-only gate ──
            // Some creature-trigger weapons gate bonus damage behind a crit
            // (e.g., Mace of Smiting "+2d6 on crit, +4d6 vs construct on crit").
            // If the description marks this bonus as crit-only and we didn't
            // crit, skip — otherwise we'd add 2d6 to every hit on the trigger
            // creature, which is the production-blocking Vicious-line bug.
            if (bd.triggersOnCrit && !isCrit) continue;

            const dmgType = bd.damageType ?? components[0]?.type ?? "untyped";
            const result = await DamageCalculator.rollWithCrit(bd.formula, rollData, isCrit, critRule, `vs ${triggerType}`);
            components.push({
              name: `${item.name} (vs ${triggerType})`,
              ...result,
              type: dmgType,
            });
            rolled = true;
          }
        }

        if (!rolled && parsed.creatureTrigger.bonusFormula) {
          const dmgType = parsed.creatureTrigger.bonusType ?? components[0]?.type ?? "untyped";
          const result = await DamageCalculator.rollWithCrit(parsed.creatureTrigger.bonusFormula, rollData, isCrit, critRule, `vs ${triggerType}`);
          components.push({
            name: `${item.name} (vs ${triggerType})`,
            ...result,
            type: dmgType,
          });
          rolled = true;
        }

        if (rolled) {
          console.log(`${MODULE_ID} | Creature bonus: ${item.name} deals extra damage to ${triggerType} (target: ${targetType})`);
        }
      }
    }

    // ── Standalone bonus damage (no creature-trigger gate) ──
    // For weapons with a description like Vicious's "When you score a critical
    // hit with this weapon, the target takes an extra 2d6 damage of the
    // weapon's type." — there's no creature-type gate, just a crit gate.
    // We only run this path when the bonus is explicitly marked as
    // triggersOnCrit AND we actually crit, AND the damage type isn't already
    // gated behind a save (which would be handled by post-hit-saves). This
    // serves as a safety net for items that have description-only bonuses
    // (no activity-level damage parts) — like AI-generated or homebrew items.
    if (!parsed.creatureTrigger && Array.isArray(parsed.bonusDamage) && parsed.bonusDamage.length > 0) {
      for (const bd of parsed.bonusDamage) {
        if (!bd.formula) continue;
        if (!bd.triggersOnCrit) continue;     // only crit-gated bonuses on this path
        if (!isCrit) continue;                 // safety: must actually be a crit
        if (conditionalDamageTypes.has(bd.damageType)) continue; // save-gated → handled in post-hit
        const baseType = components[0]?.type ?? "untyped";
        const dmgType = (bd.damageType && bd.damageType !== "weapon") ? bd.damageType : baseType;
        const result = await DamageCalculator.rollWithCrit(bd.formula, rollData, isCrit, critRule, "Crit Bonus");
        components.push({
          name: `${item.name} (crit bonus)`,
          ...result,
          type: dmgType,
        });
        console.log(`${MODULE_ID} | Crit bonus: ${item.name} +${bd.formula} ${dmgType}`);
      }
    }

    return components;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll With Crit Rules
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll a damage formula, applying critical hit rules if applicable.
   *
   * @param {string} formula    — base damage formula (e.g., "2d6+3")
   * @param {object} rollData   — actor roll data for @references
   * @param {boolean} isCrit    — is this a critical hit?
   * @param {string} critRule   — "doubleDice" | "maxPlusRoll" | "maxAll"
   * @param {string} label      — display label
   * @returns {{ formula, normalTotal, critTotal, total, isCrit, breakdown }}
   */
  static async rollWithCrit(formula, rollData, isCrit, critRule, label = "") {
    // Resolve @references in formula
    let resolved = formula;
    if (typeof formula === "string") {
      resolved = formula.replace(/@([a-zA-Z0-9_.]+)/g, (match, path) => {
        const val = path.split(".").reduce((o, k) => o?.[k], rollData);
        return val !== undefined ? String(val) : "0";
      });
    }

    // Roll the base damage
    const baseRoll = new Roll(resolved);
    await baseRoll.evaluate();

    // ── DSN Crit Payoff: force every base-roll die to its max face ──
    // For "maxAll" the rule already says all dice are max — overriding the
    // result values here makes Dice So Nice ANIMATE the dice landing on
    // their top numbers (a d8 lands on 8, etc.) for dramatic visual effect.
    // For "maxPlusRoll" the BASE set is treated as max in the math, so we
    // also force max here; the SECOND `critRoll` (rolled in the switch
    // branch below) stays random — it's the bonus crit dice the rule rolls.
    // For "doubleDice" the math uses both rolls' actual values, so no
    // override — both sets stay random.
    if (isCrit && (critRule === "maxAll" || critRule === "maxPlusRoll")) {
      try {
        for (const term of baseRoll.terms) {
          if (!term.faces) continue;
          if (!Array.isArray(term.results)) continue;
          for (const r of term.results) {
            r.result = term.faces;
            r.active = true;
            // dnd5e/Foundry sometimes writes rerolled state into discarded;
            // clear flags that would suppress the result from the displayed total.
            if (r.discarded) r.discarded = false;
          }
          // Recompute the term's contribution
          if (typeof term._total === "number") term._total = term.faces * term.results.length;
        }
        // Recompute the roll total from the forced-max dice + flat terms
        baseRoll._total = baseRoll.terms.reduce((sum, t) => {
          if (t.faces && Array.isArray(t.results)) {
            return sum + t.results.reduce((s, r) => s + (r.active !== false ? (r.result ?? 0) : 0), 0);
          }
          if (t.number !== undefined) return sum + t.number;
          return sum;
        }, 0);
      } catch (err) {
        console.warn(`ace-qol | rollWithCrit max-dice override failed (visual only):`, err);
      }
    }

    await DamageConstants.showDiceAnimation(baseRoll);
    const normalTotal = baseRoll.total;

    if (!isCrit) {
      return {
        formula: resolved,
        normalTotal,
        critTotal: 0,
        total: normalTotal,
        isCrit: false,
        breakdown: `${resolved} = ${normalTotal}`,
        roll: baseRoll,
      };
    }

    // ── CRITICAL HIT DAMAGE ──
    const diceTerms = baseRoll.terms.filter(t => t.faces);
    const flatTerms = baseRoll.terms.filter(t => t.number !== undefined && !t.faces);

    switch (critRule) {
      case "doubleDice": {
        const critRoll = new Roll(resolved);
        await critRoll.evaluate();
        await DamageConstants.showDiceAnimation(critRoll);
        const diceTotal = diceTerms.reduce((sum, t) => sum + t.total, 0);
        const critDiceTotal = critRoll.terms.filter(t => t.faces).reduce((sum, t) => sum + t.total, 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = diceTotal + critDiceTotal + flatTotal;
        const breakdown = `${resolved} (${normalTotal}) + crit dice (${critDiceTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal, critTotal: critDiceTotal,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      case "maxPlusRoll": {
        const maxDice = diceTerms.reduce((sum, t) => sum + (t.faces * (t.number ?? 1)), 0);
        const critRoll = new Roll(resolved);
        await critRoll.evaluate();
        await DamageConstants.showDiceAnimation(critRoll);
        const critDiceOnly = critRoll.terms.filter(t => t.faces).reduce((sum, t) => sum + t.total, 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = maxDice + critDiceOnly + flatTotal;
        const breakdown = `max dice (${maxDice}) + crit roll (${critDiceOnly}) + mods (${flatTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal: maxDice, critTotal: critDiceOnly,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      case "maxAll": {
        const maxDice = diceTerms.reduce((sum, t) => sum + (t.faces * (t.number ?? 1)), 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = maxDice + maxDice + flatTotal;
        const breakdown = `max dice (${maxDice}) + max crit (${maxDice}) + mods (${flatTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal: maxDice, critTotal: maxDice,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      default:
        return {
          formula: resolved, normalTotal, critTotal: 0,
          total: normalTotal, isCrit: false, breakdown: `${resolved} = ${normalTotal}`,
          roll: baseRoll,
        };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply Resistance/Immunity/Vulnerability Per Type
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Take raw damage components and apply per-type modifiers.
   * Returns array with { name, type, raw, final, modifier, reason }
   */
  static applyDamageModifiers(components, damageModifiers) {
    return components.map(c => {
      const mod = damageModifiers[c.type];
      let finalDmg = c.total;
      let modifier = "normal";
      let reason = null;

      if (mod) {
        modifier = mod.modifier;
        reason = mod.reason;

        switch (mod.modifier) {
          case "immune":
            finalDmg = 0;
            break;
          case "resistant":
            finalDmg = Math.floor(c.total / 2);
            break;
          case "vulnerable":
            finalDmg = c.total * 2;
            break;
          default:
            finalDmg = c.total;
        }
      }

      return {
        ...c,
        raw: c.total,
        final: finalDmg,
        modifier,
        reason,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build Damage Modifiers from Actor Traits
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build damage modifiers map from an actor's traits (resistances/immunities/vulnerabilities).
   * @param {Actor} actor - The target actor
   * @param {Item|null} item - The attacking item (for bypass property checks)
   */
  static getTargetDamageModifiers(actor, item = null, opts = {}) {
    const traits = actor?.system?.traits ?? {};

    // dnd5e 5.x stores trait values as `SetField` instances (Set), but older
    // releases used plain Arrays. Calling `.map()` directly on a Set throws
    // (Sets don't have .map), which silently sent immunity/resistance
    // detection down the "normal damage" path. Normalize through
    // `Array.from` which handles Set, Array, and any iterable.
    const _toLowerArr = (v) => Array.from(v ?? []).map(s => String(s).toLowerCase());
    const _toArr      = (v) => Array.from(v ?? []);

    const resistSet  = new Set(_toLowerArr(traits.dr?.value));
    const immuneSet  = new Set(_toLowerArr(traits.di?.value));
    const vulnSet    = new Set(_toLowerArr(traits.dv?.value));
    const drBypasses = new Set(_toArr(traits.dr?.bypasses));
    const diBypasses = new Set(_toArr(traits.di?.bypasses));

    // Determine weapon properties for bypass checks. The
    // `treatAsNonMagical` opt forces isMagical=false regardless of the
    // item — used by movement-damage spells (Spike Growth, Wall of
    // Thorns) where the damage is conceptually physical (conjured
    // thorns/spikes/etc.) and shouldn't trigger an Iron Golem's `mgc`
    // bypass to override the immunity. Without this, every spell with
    // `system.magicAvailable=true` (which is almost all of them in dnd5e)
    // would bypass non-magical BPS immunities — making Iron Golem take
    // full piercing from Spike Growth, against most tables' rulings.
    const itemProps = new Set(item?.system?.properties ?? []);
    const isMagical = opts.treatAsNonMagical
      ? false
      : (itemProps.has("mgc") || !!item?.system?.magicAvailable);
    const isSilvered = itemProps.has("sil");
    const isAdamantine = itemProps.has("ada");

    const modifiers = {};

    for (const type of immuneSet) {
      if (PHYSICAL_TYPES.has(type) && diBypasses.size > 0) {
        const bypassed = (diBypasses.has("mgc") && isMagical)
                      || (diBypasses.has("sil") && isSilvered)
                      || (diBypasses.has("ada") && isAdamantine);
        if (bypassed) continue;
      }
      modifiers[type] = { modifier: "immune", reason: `Immune to ${type}` };
    }

    for (const type of resistSet) {
      if (modifiers[type]) continue;
      if (PHYSICAL_TYPES.has(type) && drBypasses.size > 0) {
        const bypassed = (drBypasses.has("mgc") && isMagical)
                      || (drBypasses.has("sil") && isSilvered)
                      || (drBypasses.has("ada") && isAdamantine);
        if (bypassed) continue;
      }
      modifiers[type] = { modifier: "resistant", reason: `Resists ${type}` };
    }

    for (const type of vulnSet) {
      if (modifiers[type]) continue;
      modifiers[type] = { modifier: "vulnerable", reason: `Vulnerable to ${type}` };
    }

    return modifiers;
  }
}
