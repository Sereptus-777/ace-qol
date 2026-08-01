// ─── ACE: QOL — Target State Assessment Engine ───────────────────────────────
// Before any damage is applied, EVERY target gets a full state assessment.
// Checks conditions, resistances, immunities, creature type, save modifiers,
// Evasion, magic resistance, Slayer matches, buffs, and everything else.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { ExtendedEffects } from "./extended-effects.mjs";
import { FlagsEngine } from "./flags-engine.mjs";
import { CombatState } from "./combat-state.mjs";
import { Situation } from "./situation.mjs";
import { NullificationWalker } from "./target-state-registry/walker.mjs";

// ─── Conditions that affect combat ──────────────────────────────────────────
const CONDITION_EFFECTS = {
  prone:        { meleeAdvantage: true, rangedDisadvantage: true, atkDisadvantage: true },
  restrained:   { atkAdvantageVs: true, atkDisadvantage: true, dexSaveDisadvantage: true },
  paralyzed:    { autoCritMelee: true, autoFailStrDex: true, atkAdvantageVs: true },
  stunned:      { autoFailStrDex: true, atkAdvantageVs: true },
  unconscious:  { autoCritMelee: true, autoFailStrDex: true, atkAdvantageVs: true },
  blinded:      { atkDisadvantage: true, atkAdvantageVs: true },
  poisoned:     { atkDisadvantage: true, checkDisadvantage: true },
  frightened:   { atkDisadvantage: true, checkDisadvantage: true },
  petrified:    { resistAll: true, autoFailStrDex: true, atkAdvantageVs: true },
  invisible:    { atkAdvantage: true, atkDisadvantageVs: true },
  incapacitated: { noActions: true },
  grappled:     { speedZero: true },
  charmed:      { noAttackCharmer: true },
  deafened:     { },
};

// ─── Standard D&D 5e damage types ───────────────────────────────────────────
const PHYSICAL_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

export class TargetState {

  /**
   * Assess everything about a target that could affect combat resolution.
   *
   * @param {Token} targetToken      — the target token on canvas
   * @param {Actor} attackerActor    — the actor making the attack/casting the spell
   * @param {Item}  item             — the weapon/spell being used
   * @param {string[]} damageTypes   — damage types being dealt (e.g., ["slashing", "cold"])
   * @param {object} opts            — { saveAbility, isSpell, isMelee, rangeToTarget }
   * @returns {object} — comprehensive target state
   */
  static assess(targetToken, attackerActor, item, damageTypes = [], opts = {}) {
    const actor = targetToken.actor;
    if (!actor) return null;

    const sys = actor.system ?? {};
    const traits = sys.traits ?? {};
    const attrs = sys.attributes ?? {};
    const details = sys.details ?? {};
    const hp = attrs.hp ?? {};
    // THE status reader (Rule #1 convergence, 2026-07-27). This path used to
    // read `actor.statuses` alone — narrower than the attack flow, which also
    // unioned live effect statuses. That asymmetry is exactly how the two
    // flows drifted (the Magic Resistance lesson); both now read identically.
    const statuses = Situation.readStatuses(actor);
    const itemProps = item?.system?.properties ?? new Set();
    const isSpell = opts.isSpell ?? (item?.type === "spell");
    const isMelee = opts.isMelee ?? ["mwak", "msak"].includes(item?.system?.actionType);
    const saveAbility = opts.saveAbility ?? null;

    // ── Active conditions ──
    const conditions = new Set();
    for (const [cond] of Object.entries(CONDITION_EFFECTS)) {
      if (statuses.has(cond)) conditions.add(cond);
    }

    // ── Condition immunities ──
    const conditionImmunities = new Set(traits.ci?.value ?? []);

    // ── Damage modifiers per type ──
    const resistances = new Set(traits.dr?.value ?? []);
    const immunities = new Set(traits.di?.value ?? []);
    const vulnerabilities = new Set(traits.dv?.value ?? []);

    const isMagical = itemProps.has("mgc") || !!item?.system?.magicAvailable;
    const isSilvered = itemProps.has("sil");
    const isAdamantine = itemProps.has("ada");

    // Build bypass sets from the creature's actual trait data
    const drBypasses = new Set(traits.dr?.bypasses ?? []);
    const diBypasses = new Set(traits.di?.bypasses ?? []);

    const damageModifiers = {};
    for (const type of damageTypes) {
      let modifier = "normal";
      let reason = null;

      // Check immunity first (highest priority)
      if (immunities.has(type)) {
        // Physical damage types may be bypassed by magical/silvered/adamantine weapons
        if (PHYSICAL_TYPES.has(type) && diBypasses.size > 0) {
          const bypassed = (diBypasses.has("mgc") && isMagical)
                        || (diBypasses.has("sil") && isSilvered)
                        || (diBypasses.has("ada") && isAdamantine);
          if (bypassed) {
            modifier = "normal";
            reason = `${type} immunity BYPASSED (${isMagical ? "magical" : isSilvered ? "silvered" : "adamantine"} weapon)`;
          } else {
            modifier = "immune";
            reason = `${actor.name} is immune to ${type}`;
          }
        } else {
          modifier = "immune";
          reason = `${actor.name} is immune to ${type}`;
        }
      }
      // Check resistance
      else if (resistances.has(type)) {
        // Physical damage bypass check — use creature's actual bypasses array
        if (PHYSICAL_TYPES.has(type) && drBypasses.size > 0) {
          const bypassed = (drBypasses.has("mgc") && isMagical)
                        || (drBypasses.has("sil") && isSilvered)
                        || (drBypasses.has("ada") && isAdamantine);
          if (bypassed) {
            modifier = "normal";
            reason = `${type} resistance BYPASSED (${isMagical ? "magical" : isSilvered ? "silvered" : "adamantine"} weapon)`;
          } else {
            modifier = "resistant";
            reason = `${actor.name} resists ${type} (nonmagical)`;
          }
        } else if (PHYSICAL_TYPES.has(type) && drBypasses.size === 0) {
          // No bypasses defined — physical resistance applies to all weapons
          modifier = "resistant";
          reason = `${actor.name} resists ${type}`;
        } else {
          modifier = "resistant";
          reason = `${actor.name} resists ${type}`;
        }
      }
      // Check vulnerability
      else if (vulnerabilities.has(type)) {
        modifier = "vulnerable";
        reason = `${actor.name} is vulnerable to ${type}`;
      }

      // Petrified = resistance to ALL damage
      if (conditions.has("petrified") && modifier === "normal") {
        modifier = "resistant";
        reason = `${actor.name} is petrified (resists all damage)`;
      }

      damageModifiers[type] = { modifier, reason };
    }

    // ── Save modifiers ──
    let saveAdvantage = false;
    let saveDisadvantage = false;
    let saveBonuses = [];
    let autoFailSave = false;

    if (saveAbility) {
      // Check flags via FlagsEngine (checks ace-qol + midi-qol automatically)
      saveAdvantage = FlagsEngine.hasSaveAdvantage(actor, saveAbility)
                   || ExtendedEffects.hasAdvantage(actor, "save", saveAbility)
                   || ExtendedEffects.hasAdvantage(actor, "save", "all");
      saveDisadvantage = FlagsEngine.hasSaveDisadvantage(actor, saveAbility)
                      || ExtendedEffects.hasDisadvantage(actor, "save", saveAbility)
                      || ExtendedEffects.hasDisadvantage(actor, "save", "all");

      // Auto-fail saves from flags (e.g., custom effects)
      if (FlagsEngine.autoFailsSave(actor, saveAbility)) {
        autoFailSave = true;
      }

      // Magic resistance — advantage on saves vs spells. Checks the FLAG paths
      // AND the printed sheet FEATURE (every MM monster with "Magic Resistance"
      // in its statblock). The feature check was missing here while the
      // attack-side badge (combat-state) had it — so statblock monsters rolled
      // saves vs spells with NO advantage. (Audit find, 2026-07-27.)
      const magicRes = FlagsEngine.hasMagicResistance(actor)
                    || ExtendedEffects.hasMagicResistance(actor)
                    || CombatState._hasFeature(actor, "Magic Resistance");
      if (magicRes && isSpell) {
        saveAdvantage = true;
      }

      // Condition-based save modifiers
      if (["str", "dex"].includes(saveAbility)) {
        if (conditions.has("paralyzed") || conditions.has("stunned") || conditions.has("unconscious") || conditions.has("petrified")) {
          autoFailSave = true;
        }
        if (conditions.has("restrained") && saveAbility === "dex") {
          saveDisadvantage = true;
        }
      }

      // Bless check — look for active effect adding to saves
      const blessBonus = sys.bonuses?.abilities?.save;
      if (blessBonus) saveBonuses.push(blessBonus);

      // Per-ability save bonus
      const abilitySaveBonus = sys.abilities?.[saveAbility]?.bonuses?.save;
      if (abilitySaveBonus) saveBonuses.push(abilitySaveBonus);
    }

    // ── Evasion / Shield Master ──
    const superSaver = FlagsEngine.hasEvasion(actor)
                    || ExtendedEffects.hasSuperSaver(actor, saveAbility);
    const semiSuperSaver = ExtendedEffects.hasSemiSuperSaver(actor, saveAbility)
                        || FlagsEngine._checkFlag(actor, `semiSuperSaver.${saveAbility}`);

    // ── Creature type ──
    const creatureType = details.type?.value ?? "";
    const creatureSubtype = details.type?.subtype ?? "";
    const creatureSize = details.size ?? "medium";
    const isUndead = creatureType === "undead";
    const isFiend = creatureType === "fiend";
    const isCelestial = creatureType === "celestial";
    const isDragon = creatureType === "dragon";
    const isGiant = creatureType === "giant";

    // ── Slayer weapon check ──
    const slayerType = item?.getFlag?.("ace-artificer", "slayerType")
                    || item?.getFlag?.("ace-qol", "slayerType")
                    || null;
    const slayerDamage = item?.getFlag?.("ace-artificer", "slayerDamage")
                      || item?.getFlag?.("ace-qol", "slayerDamage")
                      || null;
    let slayerMatch = false;
    if (slayerType && creatureType) {
      slayerMatch = creatureType === slayerType
                 || creatureSubtype?.toLowerCase().includes(slayerType)
                 || creatureType?.toLowerCase().includes(slayerType);
    }

    // ── Attack advantage/disadvantage vs this target ──
    let atkAdvantageVsTarget = false;
    let atkDisadvantageVsTarget = false;

    for (const cond of conditions) {
      const fx = CONDITION_EFFECTS[cond];
      if (!fx) continue;
      if (fx.atkAdvantageVs) atkAdvantageVsTarget = true;
      if (fx.atkDisadvantageVs) atkDisadvantageVsTarget = true;
      // Prone: advantage if melee, disadvantage if ranged
      if (cond === "prone") {
        if (isMelee) atkAdvantageVsTarget = true;
        else atkDisadvantageVsTarget = true;
      }
    }

    // ── Auto-crit conditions ──
    const autoCritMelee = isMelee && (conditions.has("paralyzed") || conditions.has("unconscious"));

    // ── Concentration ──
    const isConcentrating = statuses.has("concentration") || statuses.has("concentrating");
    let concentrationSpell = null;
    if (isConcentrating) {
      // Try to find what spell they're concentrating on
      for (const effect of actor.effects ?? []) {
        if (effect.statuses?.has("concentration") || effect.statuses?.has("concentrating")) {
          concentrationSpell = effect.name || "Unknown spell";
          break;
        }
      }
    }

    // ── Legendary Resistance ──
    const legendaryResistance = sys.resources?.legres?.value ?? 0;
    const legendaryResistanceMax = sys.resources?.legres?.max ?? 0;

    // ── AC ──
    const ac = attrs.ac?.value ?? 10;

    // ── Nullification walk (v0.7.18) ──
    // Walks the registry of spell-effect / magic-item / class-feature /
    // racial / artifact / background nullifications against this actor.
    // Merges results into damageModifiers + saveAdvantage/disadvantage +
    // a new `nullifications` block for spell-specific immunities
    // (Shield vs MM, Brooch of Shielding, etc.) the damage code respects.
    let nullifications = NullificationWalker._emptyNullifications();
    try {
      nullifications = NullificationWalker.walk(actor, { item, isSpell, isMelee, damageTypes });
    } catch (err) {
      console.warn(`${MODULE_ID} | TargetState: NullificationWalker threw (non-blocking):`, err);
    }

    // Fold null-walker damage overrides into damageModifiers (most-restrictive wins).
    // The walker uses "immune" | "resistant" | "normal" | "vulnerable"; damageModifiers
    // uses the same vocabulary, so direct merge works.
    const rank = { vulnerable: 0, normal: 1, resistant: 2, immune: 3 };
    for (const [type, mod] of Object.entries(nullifications.damage ?? {})) {
      const existing = damageModifiers[type]?.modifier ?? "normal";
      if ((rank[mod] ?? 1) > (rank[existing] ?? 1)) {
        damageModifiers[type] = {
          modifier: mod,
          reason: `${nullifications.damageSources?.[type] ?? "registry"} → ${mod}`,
        };
      }
    }

    // Fold null-walker save advantages/disadvantages into save modifiers.
    // (saveAdvReasons isn't declared in this scope — assess() doesn't track
    // per-source reason strings for save mods; the registry's `_matchedSources`
    // list serves that purpose.)
    for (const tag of (nullifications.saves?.advantage ?? [])) {
      if (tag === "all" || tag === saveAbility || (isSpell && tag === "spell")) {
        saveAdvantage = true;
      }
    }
    for (const tag of (nullifications.saves?.disadvantage ?? [])) {
      if (tag === "all" || tag === saveAbility || (isSpell && tag === "spell")) {
        saveDisadvantage = true;
      }
    }

    // ── Build result ──
    const state = {
      token: targetToken,
      actor,
      name: actor.name,
      img: targetToken.document?.texture?.src ?? actor.img,

      // Defenses
      ac: ac + (nullifications.ac?.bonus ?? 0),  // include registry AC bonuses
      conditions,
      conditionImmunities,

      // Damage modifiers per type
      damageModifiers,
      magicalBypass: isMagical,
      silveredBypass: isSilvered,
      adamantineBypass: isAdamantine,

      // ── NEW (v0.7.18): registry nullifications block ──
      // Spell-by-name immunities (e.g. "magic missile" from Brooch of
      // Shielding / active Shield), feature flags (evasion, lucky, etc.),
      // and sourced match list for the damage-card "why" tooltips.
      nullifications,

      // Save modifiers
      saveAbility,
      saveAdvantage,
      saveDisadvantage,
      autoFailSave,
      saveBonuses,
      magicResistance: (FlagsEngine.hasMagicResistance(actor) || ExtendedEffects.hasMagicResistance(actor) || CombatState._hasFeature(actor, "Magic Resistance")) && isSpell,

      // Evasion / Shield Master
      superSaver,
      semiSuperSaver,

      // Creature info
      creatureType,
      creatureSubtype,
      creatureSize,
      isUndead,
      isFiend,
      isCelestial,
      isDragon,
      isGiant,

      // Slayer
      slayerMatch,
      slayerDamage,
      slayerType,

      // Attack modifiers vs this target
      atkAdvantageVsTarget,
      atkDisadvantageVsTarget,
      autoCritMelee,

      // Concentration
      isConcentrating,
      concentrationSpell,

      // Legendary
      legendaryResistance,
      legendaryResistanceMax,

      // HP state
      currentHP: hp.value ?? 0,
      maxHP: hp.max ?? 0,
      tempHP: hp.temp ?? 0,
    };

    TargetState._debug(targetToken, state, damageTypes);
    return state;
  }

  /**
   * Assess all currently targeted tokens.
   */
  static assessAll(attackerActor, item, damageTypes = [], opts = {}) {
    const targets = game.user.targets;
    const results = [];
    for (const token of targets) {
      const state = TargetState.assess(token, attackerActor, item, damageTypes, opts);
      if (state) results.push(state);
    }
    return results;
  }

  /**
   * Get human-readable summary tags showing WHAT EACH CONDITION MEANS
   * for this specific attack context — not just the condition name.
   *
   * @param {object} state — target state from assess()
   * @param {object} opts  — { isMelee, isSpell, isRanged }
   */
  static getSummaryTags(state, opts = {}) {
    const tags = [];
    const isMelee = opts.isMelee ?? false;
    const isRanged = !isMelee;

    // ── Condition implications (what it MEANS for THIS attack) ──
    if (state.conditions.has("prone")) {
      if (isMelee) {
        tags.push({ label: "PRONE → ATK ADVANTAGE", type: "bonus", icon: "fa-arrow-up" });
      } else {
        tags.push({ label: "PRONE → ATK DISADVANTAGE", type: "debuff", icon: "fa-arrow-down" });
      }
    }
    if (state.conditions.has("restrained")) {
      tags.push({ label: "RESTRAINED → ATK ADVANTAGE", type: "bonus", icon: "fa-arrow-up" });
      tags.push({ label: "RESTRAINED → DEX SAVE DISADV", type: "debuff", icon: "fa-arrow-down" });
    }
    if (state.conditions.has("paralyzed")) {
      tags.push({ label: "PARALYZED → ATK ADVANTAGE", type: "bonus", icon: "fa-arrow-up" });
      if (isMelee) tags.push({ label: "PARALYZED → AUTO-CRIT", type: "danger", icon: "fa-skull-crossbones" });
      tags.push({ label: "PARALYZED → AUTO-FAIL STR/DEX SAVES", type: "danger", icon: "fa-circle-xmark" });
    }
    if (state.conditions.has("stunned")) {
      tags.push({ label: "STUNNED → ATK ADVANTAGE", type: "bonus", icon: "fa-arrow-up" });
      tags.push({ label: "STUNNED → AUTO-FAIL STR/DEX SAVES", type: "danger", icon: "fa-circle-xmark" });
    }
    if (state.conditions.has("unconscious")) {
      tags.push({ label: "UNCONSCIOUS → ATK ADVANTAGE", type: "bonus", icon: "fa-arrow-up" });
      if (isMelee) tags.push({ label: "UNCONSCIOUS → AUTO-CRIT", type: "danger", icon: "fa-skull-crossbones" });
      tags.push({ label: "UNCONSCIOUS → AUTO-FAIL STR/DEX SAVES", type: "danger", icon: "fa-circle-xmark" });
    }
    if (state.conditions.has("blinded")) {
      tags.push({ label: "BLINDED → ATK ADVANTAGE", type: "bonus", icon: "fa-arrow-up" });
    }
    if (state.conditions.has("invisible")) {
      tags.push({ label: "INVISIBLE → ATK DISADVANTAGE", type: "debuff", icon: "fa-arrow-down" });
    }
    if (state.conditions.has("poisoned")) {
      tags.push({ label: "POISONED → TARGET ATK DISADV", type: "info", icon: "fa-skull" });
    }
    if (state.conditions.has("frightened")) {
      tags.push({ label: "FRIGHTENED → TARGET ATK/CHECK DISADV", type: "info", icon: "fa-ghost" });
    }
    if (state.conditions.has("petrified")) {
      tags.push({ label: "PETRIFIED → RESIST ALL DMG", type: "resistant", icon: "fa-gem" });
      tags.push({ label: "PETRIFIED → AUTO-FAIL STR/DEX SAVES", type: "danger", icon: "fa-circle-xmark" });
    }

    // ── Damage modifiers ──
    for (const [type, mod] of Object.entries(state.damageModifiers)) {
      if (mod.modifier === "immune") tags.push({ label: `IMMUNE: ${type}`, type: "immune", icon: "fa-shield" });
      if (mod.modifier === "resistant") tags.push({ label: `RESIST: ${type}${mod.reason?.includes("bypassed") ? " (BYPASSED)" : ""}`, type: mod.reason?.includes("bypassed") ? "info" : "resistant", icon: "fa-shield-halved" });
      if (mod.modifier === "vulnerable") tags.push({ label: `VULNERABLE: ${type} (×2)`, type: "vulnerable", icon: "fa-heart-crack" });
    }

    // ── Special features ──
    if (state.magicResistance) tags.push({ label: "MAGIC RESIST → SAVE ADVANTAGE vs SPELLS", type: "buff", icon: "fa-hat-wizard" });
    if (state.superSaver) tags.push({ label: "EVASION → DEX SAVE PASS = 0 DMG", type: "buff", icon: "fa-person-running" });
    if (state.semiSuperSaver) tags.push({ label: "SHIELD MASTER → DEX SAVE PASS = ¼ DMG", type: "buff", icon: "fa-shield" });
    if (state.slayerMatch) tags.push({ label: `SLAYER → +${state.slayerDamage} vs ${state.slayerType}`, type: "bonus", icon: "fa-crosshairs" });
    if (state.isConcentrating) tags.push({ label: `CONCENTRATING: ${state.concentrationSpell}`, type: "info", icon: "fa-brain" });
    if (state.legendaryResistance > 0) tags.push({ label: `LEGENDARY RESIST: ${state.legendaryResistance}/${state.legendaryResistanceMax} left`, type: "legendary", icon: "fa-crown" });

    // ── Save modifiers (for spells) ──
    if (state.saveAdvantage) tags.push({ label: "SAVE ADVANTAGE", type: "buff", icon: "fa-arrow-up" });
    if (state.saveDisadvantage) tags.push({ label: "SAVE DISADVANTAGE", type: "debuff", icon: "fa-arrow-down" });
    if (state.saveBonuses.length) tags.push({ label: `SAVE BONUS: ${state.saveBonuses.join(" + ")}`, type: "buff", icon: "fa-plus" });

    return tags;
  }

  /**
   * Debug logging
   */
  static _debug(token, state, damageTypes) {
    try {
      if (!game.settings.get(MODULE_ID, "debugMode")) return;
    } catch { return; }

    const mods = Object.entries(state.damageModifiers)
      .map(([type, m]) => `${type}=${m.modifier}`)
      .join(", ");
    const conds = [...state.conditions].join(", ") || "none";

    console.log(`${MODULE_ID} | TARGET: ${state.name} | AC:${state.ac} | HP:${state.currentHP}/${state.maxHP} | Conditions:[${conds}] | DamageMods:[${mods}] | Type:${state.creatureType} | Slayer:${state.slayerMatch ? "YES" : "no"}`);
  }
}
