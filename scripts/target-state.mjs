// ─── ACE: QOL — Target State Assessment Engine ───────────────────────────────
// Before any damage is applied, EVERY target gets a full state assessment.
// Checks conditions, resistances, immunities, creature type, save modifiers,
// Evasion, magic resistance, Slayer matches, buffs, and everything else.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { ExtendedEffects } from "./extended-effects.mjs";

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
    const statuses = actor.statuses ?? new Set();
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

    const damageModifiers = {};
    for (const type of damageTypes) {
      let modifier = "normal";
      let reason = null;

      // Check immunity first (highest priority)
      if (immunities.has(type)) {
        modifier = "immune";
        reason = `${actor.name} is immune to ${type}`;
      }
      // Check resistance
      else if (resistances.has(type)) {
        // Physical damage bypass check
        if (PHYSICAL_TYPES.has(type)) {
          // Many monsters resist "nonmagical bludgeoning/piercing/slashing"
          // If weapon is magical, silvered, or adamantine, bypass may apply
          if (isMagical) {
            modifier = "normal";
            reason = `Resistance bypassed (magical weapon)`;
          } else if (isSilvered) {
            modifier = "normal";
            reason = `Resistance bypassed (silvered weapon)`;
          } else {
            modifier = "resistant";
            reason = `${actor.name} resists ${type} (nonmagical)`;
          }
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
      // Check our flags
      saveAdvantage = ExtendedEffects.hasAdvantage(actor, "save", saveAbility)
                   || ExtendedEffects.hasAdvantage(actor, "save", "all");
      saveDisadvantage = ExtendedEffects.hasDisadvantage(actor, "save", saveAbility)
                      || ExtendedEffects.hasDisadvantage(actor, "save", "all");

      // Magic resistance — advantage on saves vs spells
      const magicRes = ExtendedEffects.hasMagicResistance(actor)
                    || !!actor.getFlag("midi-qol", "magicResistance.all");  // backward compat
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
    const superSaver = ExtendedEffects.hasSuperSaver(actor, saveAbility)
                    || !!actor.getFlag("midi-qol", `superSaver.${saveAbility}`);
    const semiSuperSaver = ExtendedEffects.hasSemiSuperSaver(actor, saveAbility)
                        || !!actor.getFlag("midi-qol", `semiSuperSaver.${saveAbility}`);

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
    const isConcentrating = statuses.has("concentrating");
    let concentrationSpell = null;
    if (isConcentrating) {
      // Try to find what spell they're concentrating on
      for (const effect of actor.effects ?? []) {
        if (effect.statuses?.has("concentrating")) {
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

    // ── Build result ──
    const state = {
      token: targetToken,
      actor,
      name: actor.name,
      img: targetToken.document?.texture?.src ?? actor.img,

      // Defenses
      ac,
      conditions,
      conditionImmunities,

      // Damage modifiers per type
      damageModifiers,
      magicalBypass: isMagical,
      silveredBypass: isSilvered,
      adamantineBypass: isAdamantine,

      // Save modifiers
      saveAbility,
      saveAdvantage,
      saveDisadvantage,
      autoFailSave,
      saveBonuses,
      magicResistance: (ExtendedEffects.hasMagicResistance(actor) || !!actor.getFlag("midi-qol", "magicResistance.all")) && isSpell,

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
