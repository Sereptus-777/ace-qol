// ─── ACE: QOL — Damage Calculator ────────────────────────────────────────────
// Pure math: roll damage components, apply crit rules, resolve resistance/
// immunity/vulnerability. No UI, no DOM, no hooks — just numbers in, numbers out.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { DamageConstants } from "./damage-engine.mjs";
import { CombatState } from "./combat-state.mjs";
import { NullificationWalker } from "./target-state-registry/walker.mjs";
import { getChosenDamageType } from "./multi-type-damage-chooser.mjs";

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

    // ── Magic Missile dart override ────────────────────────────────────
    // When the MagicMissilePicker assigns N darts to this target, the
    // spell-auto-damage handler stuffs `magicMissileOverride` onto the
    // hit. Each target gets a custom formula (Nd4+N combined, or N
    // separate 1d4+1 per-dart depending on the setting). Magic Missile
    // is auto-hit, no-save, no-crit — so we skip the normal item-parts
    // path entirely and emit a single component.
    //
    // Empowered Evocation (Wizard Evocation 10+) RAW: "add INT to one
    // damage roll of any wizard evocation spell." We honor that by
    // applying EE to the FIRST target's hit only (the spell-auto-damage
    // handler tags hit #0 with `applyEmpoweredEvocation: true`).
    if (targetState?.magicMissileOverride) {
      try {
        const ov = targetState.magicMissileOverride;
        const dartLabel = `Magic Missile (${ov.darts} dart${ov.darts === 1 ? "" : "s"})`;
        const result = await DamageCalculator.rollWithCrit(
          ov.formula, rollData, /* isCrit */ false, critRule, dartLabel, item
        );
        components.push({ name: item.name, ...result, type: ov.type || "force" });

        // Empowered Evocation rider — applies once per spell, on this target only.
        if (targetState.applyEmpoweredEvocation && item?.system?.school === "evo") {
          try {
            const intBonus = CombatState.getEmpoweredEvocationBonus(actor);
            if (intBonus > 0) {
              const flatRoll = new Roll(`${intBonus}`);
              await flatRoll.evaluate();
              components.push({
                name:           "Empowered Evocation",
                formula:        `${intBonus}`,
                roll:           flatRoll,
                total:          intBonus,
                type:           ov.type || "force",
                isFeatureRider: true,
                featureLabel:   "EMPOWERED EVOCATION",
              });
              console.log(`${MODULE_ID} | Empowered Evocation: +${intBonus} added to ${actor.name}'s Magic Missile (Wizard Evocation 10+)`);
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | Empowered Evocation override-path check failed (non-fatal):`, err);
          }
        }

        return components;
      } catch (err) {
        console.error(`${MODULE_ID} | Magic Missile override roll failed:`, err);
        // Fall through to normal flow on error
      }
    }

    // ── Parse item description for conditional damage (save-gated) ──
    const parsed = DescriptionParser.parse(item);
    const conditionalDamageTypes = new Set();
    if (parsed.saves.length > 0) {
      for (const bd of parsed.bonusDamage) {
        if (bd.damageType) conditionalDamageTypes.add(bd.damageType);
      }
    }

    // ── Multi-type damage choice (Blood Halberd "fire or cold", etc.) ──
    // If the player has set a preferred damage type on this item via the
    // chooser dialog, we filter damage parts in both the native and fallback
    // paths to only include parts matching the chosen type. "default" or
    // null means use all parts normally (weapon's listed types as-is).
    const chosenDamageType = getChosenDamageType(item);
    const shouldFilterByChosen = chosenDamageType && chosenDamageType !== "default";

    // ── True Strike (2024) — one-shot weapon-damage-type swap to Radiant ──
    // Set by BladeCantrips dialog at cantrip cast. Consume the flag now (so
    // an error mid-rollDamageComponents doesn't leave the flag stuck).
    let trueStrikeSwap = false;
    try {
      if (actor?.getFlag?.(MODULE_ID, "trueStrike.swapDamage")) {
        trueStrikeSwap = true;
        await actor.unsetFlag(MODULE_ID, "trueStrike.swapDamage");
        console.log(`${MODULE_ID} | True Strike radiant-swap consumed for ${actor.name}`);
      }
    } catch (_) { /* non-fatal */ }

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

            // Skip parts that don't match the chosen damage type (Blood Halberd
            // "fire or cold" → only the chosen one rolls).
            if (shouldFilterByChosen && String(type).toLowerCase() !== chosenDamageType) {
              console.log(`${MODULE_ID} | Multi-type damage: skipping ${type} part (chosen=${chosenDamageType})`);
              continue;
            }

            // Resolve @references and roll with our crit rules
            const data = rollCfg.data ?? rollData;
            const result = await DamageCalculator.rollWithCrit(formula, data, isCrit, critRule, `Base ${type}`, item);
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

            // Skip parts that don't match the chosen damage type. For multi-
            // type parts (a single part listing both "fire" AND "cold"), we
            // pass through if the chosen type is in the part's type list —
            // the part still rolls, just labeled as the chosen type.
            if (shouldFilterByChosen) {
              const partTypesLower = types.map(t => String(t).toLowerCase());
              if (!partTypesLower.includes(chosenDamageType)) {
                console.log(`${MODULE_ID} | Multi-type damage: skipping ${type} part (chosen=${chosenDamageType})`);
                continue;
              }
            }

            // If the chosen type IS one of the part's types, use that as the
            // applied type instead of the first-listed type. So "fire or cold"
            // with chosen=cold rolls as cold (not as fire).
            const appliedType = shouldFilterByChosen ? chosenDamageType : type;
            const result = await DamageCalculator.rollWithCrit(formula, rollData, isCrit, critRule, `Base ${appliedType}`, item);
            const comp = { name: item.name, ...result, type: appliedType };

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

      // ── Once-per-turn race-window guard (v0.7.4) ──
      // The push-side check in combat-state.assess already gated this, BUT
      // a parallel attack flow (Two-Weapon Fighting, Action Surge, multi-
      // attack, rapid sequential clicks) can queue the same rider on TWO
      // attacks before either consumes the flag — both attacks resolve
      // their hits, both bonuses arrays get the rider, both damage rolls
      // would double-apply it. Re-check the flag here so the FIRST damage
      // roll to land this turn gets the bonus; subsequent rolls see the
      // flag and skip silently. Smites mark at consumeResources time so
      // they're already race-proof; only divineStrike + sneakAttack are
      // affected by the late-mark pattern. Grok audit catch.
      if (bonus.isOncePerTurn === "divineStrike"
          && actor?.getFlag?.(MODULE_ID, "divineStrike.usedThisTurn")) {
        console.log(`${MODULE_ID} | Divine Strike skipped on this hit — already consumed this turn (race-window guard)`);
        continue;
      }
      if (bonus.isOncePerTurn === "sneakAttack"
          && actor?.getFlag?.(MODULE_ID, "sneakAttack.usedThisTurn")) {
        console.log(`${MODULE_ID} | Sneak Attack skipped on this hit — already consumed this turn (race-window guard)`);
        continue;
      }

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
      // Once-per-turn riders: mark the actor flag now that the bonus has
      // actually been rolled into a damage component. The push-side guard in
      // combat-state.mjs reads this flag and skips re-pushing on subsequent
      // attacks the same turn. combatTurnChange clears it at turn end.
      if (bonus.isOncePerTurn === "divineStrike") {
        await CombatState.markDivineStrikeUsed(actor);
      } else if (bonus.isOncePerTurn === "sneakAttack") {
        await CombatState.markSneakAttackUsed(actor);
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

    // ── Empowered Evocation (Wizard Evocation School 10+, v0.7.12) ──
    // RAW: "you can add your Intelligence modifier to one damage roll of
    // any wizard evocation spell you cast." Pushed as a new component so
    // the damage card shows the +mod as a clearly-labeled line.
    try {
      if (item?.type === "spell" && item.system?.school === "evo") {
        const intBonus = CombatState.getEmpoweredEvocationBonus(actor);
        if (intBonus > 0 && components.length > 0) {
          const flatRoll = new Roll(`${intBonus}`);
          await flatRoll.evaluate();
          components.push({
            name:          "Empowered Evocation",
            formula:       `${intBonus}`,
            roll:          flatRoll,
            total:         intBonus,
            type:          components[0]?.type ?? "untyped",
            isFeatureRider: true,
            featureLabel:  "EMPOWERED EVOCATION",
          });
          console.log(`${MODULE_ID} | Empowered Evocation: +${intBonus} added to ${actor.name}'s ${item.name} (INT mod, Wizard Evocation School 10+)`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Empowered Evocation rider check failed (non-fatal):`, err);
    }

    // ── Agonizing Blast (Warlock invocation, v0.7.12) ──
    // RAW: "When you cast eldritch blast, add your Charisma modifier to
    // the damage it deals on a hit." Per beam — Eldritch Blast at higher
    // caster levels rolls more beams (2 @ 5th, 3 @ 11th, 4 @ 17th). Each
    // beam normally comes through as its own damage component in dnd5e's
    // rollDamage result; we add CHA mod to each. If dnd5e instead
    // aggregates the beams into one combined component (some configs do
    // this), GM can manually adjust via the per-component override UI.
    try {
      if (item?.type === "spell" && /eldritch\s*blast/i.test(item.name ?? "")) {
        const chaBonus = CombatState.getAgonizingBlastBonus(actor);
        if (chaBonus > 0 && components.length > 0) {
          for (const comp of components) {
            comp.total = (comp.total ?? 0) + chaBonus;
            comp.featureLabel = comp.featureLabel
              ? `${comp.featureLabel} + AGONIZING BLAST`
              : "AGONIZING BLAST";
            // Annotate the formula display so the chat card shows the bonus
            comp.formula = comp.formula
              ? `${comp.formula} + ${chaBonus}`
              : `${chaBonus}`;
          }
          console.log(`${MODULE_ID} | Agonizing Blast: +${chaBonus} per beam (${components.length} component${components.length === 1 ? "" : "s"}) on ${actor.name}'s Eldritch Blast (CHA mod)`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Agonizing Blast rider check failed (non-fatal):`, err);
    }

    // ── Potent Spellcasting (Cleric 8+ / Druid 8+, v0.7.12) ──
    // RAW: "When you cast a cleric cantrip that deals damage, you can
    // add your Wisdom modifier to the damage." (Same for Druid with
    // druid cantrips.) Cantrip-level gate via item.system.level === 0.
    try {
      if (item?.type === "spell" && Number(item.system?.level) === 0) {
        const wisBonus = CombatState.getPotentSpellcastingBonus(actor);
        if (wisBonus > 0 && components.length > 0) {
          const flatRoll = new Roll(`${wisBonus}`);
          await flatRoll.evaluate();
          components.push({
            name:          "Potent Spellcasting",
            formula:       `${wisBonus}`,
            roll:          flatRoll,
            total:         wisBonus,
            type:          components[0]?.type ?? "untyped",
            isFeatureRider: true,
            featureLabel:  "POTENT SPELLCASTING",
          });
          console.log(`${MODULE_ID} | Potent Spellcasting: +${wisBonus} added to ${actor.name}'s cantrip ${item.name} (WIS mod)`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Potent Spellcasting rider check failed (non-fatal):`, err);
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
    //
    // Two sub-cases:
    //   (a) Bonus has NO requiresCreatureTypes → fires on any target (subject
    //       to crit gate). Mace of Smiting +7 falls here because the rider
    //       sentence has no creature mention.
    //   (b) Bonus has requiresCreatureTypes set → only fires if target's
    //       creature type matches ONE of those (case-insensitive). Holy Avenger
    //       +2d10 radiant falls here — only fires vs fiend/undead.
    //
    // We also skip if a creature-trigger ALREADY captured AND fired bonus
    // damage via the creature-trigger path above (to avoid double-stacking).
    const creatureTriggerFiredBonus = parsed.creatureTrigger
                                   && parsed.creatureTrigger.bonusFormula
                                   && targetState.creatureType
                                   && (targetState.creatureType.toLowerCase() === parsed.creatureTrigger.creatureType?.toLowerCase());
    if (!creatureTriggerFiredBonus && Array.isArray(parsed.bonusDamage) && parsed.bonusDamage.length > 0) {

      // PRE-PASS: "X or Y if creature-type" replacement detection.
      //
      // Mace of Smiting: "extra 7 Bludgeoning damage, OR 14 Bludgeoning damage
      // if it's a Construct." RAW: 14 REPLACES 7 vs construct; doesn't stack.
      //
      // Heuristic: if a creature-gated bonus matches the target type AND
      // shares the same damage type with an ungated bonus, the gated bonus
      // is a REPLACEMENT. We skip the ungated variant for that damage type.
      //
      // Safe because: the "extra ... or ... if it's a ..." phrasing only
      // appears in items where the second clause replaces the first. If two
      // truly-additive bonuses share a damage type, they wouldn't both have
      // crit-or-creature gates that match in this narrow way.
      const targetTypeLower = String(targetState.creatureType ?? "").toLowerCase();
      const replacedDamageTypes = new Set();
      if (targetTypeLower) {
        for (const bd of parsed.bonusDamage) {
          if (!Array.isArray(bd.requiresCreatureTypes) || bd.requiresCreatureTypes.length === 0) continue;
          const matchesTarget = bd.requiresCreatureTypes.some(t => {
            const tl = String(t).toLowerCase();
            return targetTypeLower === tl || targetTypeLower.includes(tl);
          });
          if (matchesTarget && bd.damageType) {
            replacedDamageTypes.add(String(bd.damageType).toLowerCase());
          }
        }
      }

      for (const bd of parsed.bonusDamage) {
        if (!bd.formula) continue;
        if (conditionalDamageTypes.has(bd.damageType)) continue; // save-gated → handled in post-hit

        // Crit gate: if the bonus is explicitly marked as crit-only, require a crit.
        if (bd.triggersOnCrit && !isCrit) continue;

        // Creature gate: if the bonus is creature-type-gated (Holy Avenger
        // "+2d10 radiant vs fiend/undead"), the target's creature type must
        // match ONE of the listed types.
        const isCreatureGated = Array.isArray(bd.requiresCreatureTypes) && bd.requiresCreatureTypes.length > 0;
        if (isCreatureGated) {
          if (!targetTypeLower) continue;
          const matches = bd.requiresCreatureTypes.some(t => {
            const tl = String(t).toLowerCase();
            return targetTypeLower === tl || targetTypeLower.includes(tl);
          });
          if (!matches) continue;
        }

        // Replacement gate: if THIS bonus is ungated but a creature-gated
        // bonus of the same damage type fired (Mace of Smiting +14 construct
        // overrides the +7 generic), skip this one — the gated one replaces it.
        if (!isCreatureGated && bd.damageType && replacedDamageTypes.has(String(bd.damageType).toLowerCase())) {
          console.log(`${MODULE_ID} | Bonus replaced: ${item.name} +${bd.formula} ${bd.damageType} skipped (creature-gated override fired)`);
          continue;
        }

        // Safety: don't fire wildly. A bonus with NO crit gate AND NO creature
        // gate is suspicious — it would apply on every single hit. Preserve
        // the prior behavior of "must be either crit-gated or creature-gated"
        // to keep this path from over-applying on free-text descriptions.
        if (!bd.triggersOnCrit && !isCreatureGated) continue;

        const baseType = components[0]?.type ?? "untyped";
        const dmgType = (bd.damageType && bd.damageType !== "weapon") ? bd.damageType : baseType;
        const gateLabel = bd.triggersOnCrit ? "crit bonus" : `vs ${bd.requiresCreatureTypes?.join("/")}`;
        const result = await DamageCalculator.rollWithCrit(bd.formula, rollData, isCrit, critRule, gateLabel);
        components.push({
          name: `${item.name} (${gateLabel})`,
          ...result,
          type: dmgType,
        });
        console.log(`${MODULE_ID} | Bonus (${gateLabel}): ${item.name} +${bd.formula} ${dmgType}`);
      }
    }

    // ── True Strike swap — applied AFTER all weapon-damage components are
    // pushed but BEFORE riders are tallied. Walks components and swaps the
    // type to "radiant" only on the weapon's base damage (name matches item
    // name). Riders (Smites, Savage Attacks, etc.) keep their own types.
    if (trueStrikeSwap) {
      for (const c of components) {
        if (c?.name === item?.name) {
          c.type = "radiant";
        }
      }
    }

    // ── Piercer crit — one additional weapon damage die on piercing crit ──
    // The Piercer feat's crit bonus marker is set in feat-effects.mjs when
    // the attack lands a crit with piercing damage. We consume it here on
    // the next damage roll and add a single weapon-die component.
    try {
      const piercerPending = !!actor?.getFlag?.(MODULE_ID, "piercerCrit.pendingExtraDie");
      if (piercerPending && isCrit) {
        await actor.unsetFlag(MODULE_ID, "piercerCrit.pendingExtraDie");
        const partsArr = item?.system?.damage?.parts ?? [];
        const firstFormula = Array.isArray(partsArr[0]) ? partsArr[0][0] : partsArr[0]?.formula;
        const dieMatch = String(firstFormula ?? "").match(/(\d*d\d+)/i);
        if (dieMatch) {
          const wpnDie = `1${dieMatch[1].replace(/^\d+/, "")}`;
          const wpnType = (Array.isArray(partsArr[0]) ? partsArr[0][1] : partsArr[0]?.types?.[0]) ?? "piercing";
          const piercerRoll = new Roll(wpnDie);
          await piercerRoll.evaluate();
          components.push({
            name: "Piercer (Crit)",
            type: wpnType,
            formula: wpnDie,
            normalTotal: piercerRoll.total,
            critTotal:   piercerRoll.total,
            final:       piercerRoll.total,
            raw:         piercerRoll.total,
            modifier:    0,
            isCrit:      true,
            roll:        piercerRoll,
          });
          console.log(`${MODULE_ID} | Piercer crit bonus: +${piercerRoll.total} ${wpnType} (${wpnDie})`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Piercer crit-die (non-fatal):`, err);
    }

    // ── Savage Attacks (Half-Orc / Orc Lineage) — extra weapon die on melee crit ──
    // RAW (2024): "When you damage a creature with a critical hit from an
    // attack roll using a Strength-based weapon, you can roll one of the
    // weapon's damage dice one additional time and add it to the extra
    // damage." Adds a single weapon-die component, only on melee crits.
    try {
      const itemSys = item?.system ?? {};
      const isMeleeWeapon = itemSys.actionType === "mwak" || itemSys.actionType === "msak";
      if (isCrit && isMeleeWeapon) {
        const race = actor?.system?.details?.race ?? "";
        const raceLower = String(race).toLowerCase();
        const isOrcKin = raceLower.includes("orc"); // catches Half-Orc, Orc, Half Orc
        if (isOrcKin) {
          const partsArr = itemSys.damage?.parts ?? [];
          const firstFormula = Array.isArray(partsArr[0]) ? partsArr[0][0] : partsArr[0]?.formula;
          const dieMatch = String(firstFormula ?? "").match(/(\d*d\d+)/i);
          const wpnDie = dieMatch ? `1${dieMatch[1].replace(/^\d+/, "")}` : "1d6";
          const wpnType = (Array.isArray(partsArr[0]) ? partsArr[0][1] : partsArr[0]?.types?.[0]) ?? "slashing";
          const savageRoll = new Roll(wpnDie);
          await savageRoll.evaluate();
          components.push({
            name: "Savage Attacks",
            type: wpnType,
            formula: wpnDie,
            normalTotal: savageRoll.total,
            critTotal:   savageRoll.total,
            final:       savageRoll.total,
            raw:         savageRoll.total,
            modifier:    0,
            isCrit:      true,
            roll:        savageRoll,
          });
          console.log(`${MODULE_ID} | Savage Attacks crit bonus: +${savageRoll.total} ${wpnType} (${wpnDie})`);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Savage Attacks (non-fatal):`, err);
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
   * @param {Item5e} [item]     — source item (used for GWF gating). Optional;
   *                              if omitted, the GWF dice-bump simply skips.
   * @returns {{ formula, normalTotal, critTotal, total, isCrit, breakdown }}
   */
  static async rollWithCrit(formula, rollData, isCrit, critRule, label = "", item = null) {
    // Derive actor + system data from the optional item parameter. Pre-fix,
    // this code referenced bare `actor` and `sys` which were never in scope —
    // every GWF dice-bump attempt threw a non-fatal ReferenceError and the
    // dice-bump never actually fired for any character. Threading `item`
    // through gives us both refs cleanly.
    const actor = item?.actor ?? null;
    const sys   = item?.system ?? {};

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

    // ── Great Weapon Fighting (2024 PHB) — treat any 1 or 2 on a damage die as a 3 ──
    // Gate: actor has a "Great Weapon Fighting" feat AND the weapon is wielded
    // two-handed (system.properties has "two" — two-handed — OR is a versatile
    // weapon being used two-handed). 2014 GWF was "reroll 1s and 2s once"; the
    // 2024 rule is the simpler "treat 1 or 2 as 3" mechanic, applied here.
    try {
      const hasGWF = (actor?.items ?? []).some(
        i => i.type === "feat" && /great\s*weapon\s*fighting/i.test(String(i.name ?? ""))
      );
      if (hasGWF) {
        const props = sys?.properties ?? new Set();
        const isTwoHanded = props.has?.("two") || (props.has?.("ver") && (sys.equipped !== false));
        if (isTwoHanded) {
          for (const term of baseRoll.terms) {
            if (!term.faces || !Array.isArray(term.results)) continue;
            for (const r of term.results) {
              if (r.result === 1 || r.result === 2) r.result = 3;
            }
          }
          // Recompute total after die mutation.
          baseRoll._total = baseRoll.terms.reduce((sum, t) => {
            if (t.faces && Array.isArray(t.results)) {
              return sum + t.results.reduce((a, r) => a + (r.active === false ? 0 : r.result), 0);
            }
            if (typeof t.number === "number") return sum + t.number;
            return sum;
          }, 0);
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | GWF dice-bump failed (non-fatal):`, err);
    }

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

    // v0.7.3 made showDiceAnimation non-async — it now returns undefined
    // synchronously, the DSN call inside is fire-and-forget. `await` on a
    // non-thenable is a no-op; we drop the await so it doesn't read as
    // "wait for DSN" (which it never did, even pre-v0.7.3).
    DamageConstants.showDiceAnimation(baseRoll);
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
        DamageConstants.showDiceAnimation(critRoll);
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
        DamageConstants.showDiceAnimation(critRoll);
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

    // ── Registry overrides (v0.7.18) ──
    // Walk the nullification registry (spell effects, magic items, class /
    // racial / artifact features) and fold any damage-type overrides in.
    // Most-restrictive wins: immune > resistant > normal > vulnerable.
    // This is what gives Brooch of Shielding force resistance, Stoneskin
    // its nonmagical-B/P/S resistance, Ring of Cold Resistance its cold
    // resistance, etc. — beyond just the bare traits block.
    try {
      const nullifications = NullificationWalker.walk(actor, { item });
      const rank = { vulnerable: 0, normal: 1, resistant: 2, immune: 3 };
      for (const [type, mod] of Object.entries(nullifications.damage ?? {})) {
        const existingMod = modifiers[type]?.modifier ?? "normal";
        if ((rank[mod] ?? 1) > (rank[existingMod] ?? 1)) {
          modifiers[type] = {
            modifier: mod,
            reason: `${nullifications.damageSources?.[type] ?? "registry"} → ${mod}`,
          };
        }
      }
    } catch (err) {
      // Non-blocking — registry import failed or walker threw. Bare traits still work.
      console.warn(`${MODULE_ID} | DamageCalculator: NullificationWalker fold failed (non-blocking):`, err?.message ?? err);
    }

    return modifiers;
  }
}
