// ─── ACE: QOL — Combat State Assessment Engine (COMPREHENSIVE) ──────────────
// Reads BOTH the attacker AND the target COMPLETELY, cross-references both
// sides, and determines ALL combat modifiers for this specific attack.
//
// This is the intelligence layer — EVERY D&D 5e rule that affects advantage,
// disadvantage, AC, saves, auto-crit, damage, and conditions is checked here.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { ExtendedEffects } from "./extended-effects.mjs";
import { QolSettings } from "./settings.mjs";
import { FlagsEngine } from "./flags-engine.mjs";

// ─── Physical damage types (bypass checks) ──────────────────────────────────
const PHYSICAL_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

export class CombatState {

  /**
   * Full combat assessment — EVERY rule checked.
   */
  static assess(attackerActor, targetToken, item, opts = {}) {
    const targetActor = targetToken?.actor;
    if (!attackerActor || !targetActor) return null;

    const isSpell = opts.isSpell ?? (item?.type === "spell");
    const actionType = item?.system?.actionType ?? "mwak";
    const itemProps = item?.system?.properties ?? new Set();

    // ── Smart melee/ranged detection ────────────────────────────────────
    // Don't just trust actionType — cross-check weapon type, properties, and range.
    // Catches misconfigured items (e.g., longbow with actionType "mwak")
    const actuallyRanged = CombatState._isActuallyRanged(item, actionType);
    const isMelee = opts.isMelee ?? !actuallyRanged;
    const isRanged = !isMelee;

    const damageTypes = opts.damageTypes ?? CombatState._getItemDamageTypes(item);
    const saveAbility = opts.saveAbility ?? null;

    // Collect all advantage/disadvantage sources with reasons
    const advantageSources = [];
    const disadvantageSources = [];

    // ═════════════════════════════════════════════════════════════════════════
    //  ATTACKER STATE
    // ═════════════════════════════════════════════════════════════════════════
    const atkStatuses = CombatState._getStatuses(attackerActor);
    const atkConditions = new Set();

    // ── Attacker Conditions ──────────────────────────────────────────────
    if (atkStatuses.has("blinded") || atkStatuses.has("blind")) {
      atkConditions.add("blinded");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is BLINDED → attack disadvantage" });
    }
    if (atkStatuses.has("poisoned")) {
      atkConditions.add("poisoned");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is POISONED → attack disadvantage" });
    }
    if (atkStatuses.has("frightened")) {
      atkConditions.add("frightened");
      // Only applies if source of fear is visible — we assume it is for now
      disadvantageSources.push({ source: "attacker", reason: "Attacker is FRIGHTENED → attack disadvantage" });
    }
    if (atkStatuses.has("restrained")) {
      atkConditions.add("restrained");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is RESTRAINED → attack disadvantage" });
    }
    if (atkStatuses.has("prone")) {
      atkConditions.add("prone");
      disadvantageSources.push({ source: "attacker", reason: "Attacker is PRONE → attack disadvantage" });
    }
    if (atkStatuses.has("invisible")) {
      atkConditions.add("invisible");
      advantageSources.push({ source: "attacker", reason: "Attacker is INVISIBLE → attack advantage" });
    }

    // ── Exhaustion ───────────────────────────────────────────────────────
    const exhaustion = attackerActor.system?.attributes?.exhaustion ?? 0;
    if (exhaustion >= 3) {
      disadvantageSources.push({ source: "attacker", reason: `Attacker EXHAUSTION ${exhaustion} → attack disadvantage` });
    }

    // ── Reckless Attack (Barbarian) ─────────────────────────────────────
    const reckless = attackerActor.getFlag(MODULE_ID, "recklessAttack")
                  || atkStatuses.has("reckless");
    if (reckless && isMelee) {
      advantageSources.push({ source: "attacker", reason: "RECKLESS ATTACK → melee advantage (enemies get advantage back)" });
    }

    // ── Pack Tactics ────────────────────────────────────────────────────
    if (CombatState._hasFeature(attackerActor, "Pack Tactics")) {
      if (CombatState._isAllyNearTarget(attackerActor, targetToken, 5)) {
        advantageSources.push({ source: "attacker", reason: "PACK TACTICS → ally within 5ft of target" });
      }
    }

    // ── Flanking (optional rule, line-through method) ────────────────────
    try {
      if (isMelee && QolSettings.get("flanking")) {
        const flankAlly = CombatState._isFlanking(attackerActor, targetToken);
        if (flankAlly) {
          advantageSources.push({
            source: "attacker",
            reason: `FLANKING → ${flankAlly} on opposite side of target`,
          });
        }
      }
    } catch { /* setting not registered yet */ }

    // ── Ranged attack within 5ft of a hostile → disadvantage (PHB 195) ───
    // RAW: "You have disadvantage on a ranged attack roll if you are within
    // 5 feet of a hostile creature who can see you and who isn't
    // incapacitated."
    try {
      if (isRanged && QolSettings.get?.("rangedInMeleeDisadvantage")) {
        if (CombatState._hasHostileWithinReach(attackerActor, 5)) {
          disadvantageSources.push({
            source: "attacker",
            reason: "RANGED IN MELEE → hostile within 5ft (PHB 195)",
          });
        }
      }
    } catch { /* setting not registered yet */ }

    // ── Hidden attacker → advantage (PHB 195, ace-qol StealthEngine) ─────
    // If the attacker is hidden from this target, gain advantage.
    try {
      const StealthEngine = game.aceQol?.StealthEngine;
      const attackerToken = attackerActor.getActiveTokens?.()?.[0];
      if (StealthEngine?.attackerHiddenFromTarget?.(attackerToken, targetToken)) {
        advantageSources.push({
          source: "attacker",
          reason: "HIDDEN → unseen attacker (PHB 195)",
        });
      }
    } catch { /* StealthEngine not loaded yet */ }

    // ── Advantage/Disadvantage from Active Effects + Flags ───────────────
    const atkType = actionType;
    if (FlagsEngine.hasAttackAdvantage(attackerActor, atkType)
     || ExtendedEffects.hasAdvantage(attackerActor, "attack", atkType)
     || ExtendedEffects.hasAdvantage(attackerActor, "attack", "all")) {
      advantageSources.push({ source: "attacker", reason: "Effect/feature grants attack advantage" });
    }
    if (FlagsEngine.hasAttackDisadvantage(attackerActor, atkType)
     || ExtendedEffects.hasDisadvantage(attackerActor, "attack", atkType)
     || ExtendedEffects.hasDisadvantage(attackerActor, "attack", "all")) {
      disadvantageSources.push({ source: "attacker", reason: "Effect/feature grants attack disadvantage" });
    }

    // ── Grants from target flags (target grants advantage/disadvantage) ──
    if (FlagsEngine.grantsAttackAdvantage(targetActor, atkType)) {
      advantageSources.push({ source: "target", reason: "Target grants attack advantage (flag)" });
    }
    if (FlagsEngine.grantsAttackDisadvantage(targetActor, atkType)) {
      disadvantageSources.push({ source: "target", reason: "Target grants attack disadvantage (flag)" });
    }

    // ── Heavy Weapon + Small Creature ───────────────────────────────────
    const atkSize = attackerActor.system?.traits?.size ?? attackerActor.system?.details?.size ?? "medium";
    if (["tiny", "sm"].includes(atkSize) && itemProps.has("hvy")) {
      disadvantageSources.push({ source: "attacker", reason: "SMALL CREATURE + HEAVY WEAPON → attack disadvantage" });
    }

    // ── Non-proficient Armor ────────────────────────────────────────────
    // TODO: detect if wearing armor without proficiency

    // ═════════════════════════════════════════════════════════════════════════
    //  TARGET STATE
    // ═════════════════════════════════════════════════════════════════════════
    const tgtStatuses = CombatState._getStatuses(targetActor, targetToken);
    const tgtSys = targetActor.system ?? {};
    const tgtTraits = tgtSys.traits ?? {};
    const tgtAttrs = tgtSys.attributes ?? {};
    const tgtDetails = tgtSys.details ?? {};
    const tgtConditions = new Set();

    // ── Target Conditions → Attack Modifiers ─────────────────────────────

    // PRONE
    if (tgtStatuses.has("prone")) {
      tgtConditions.add("prone");
      if (isMelee) {
        advantageSources.push({ source: "target", reason: "Target is PRONE → melee attack advantage" });
      } else {
        disadvantageSources.push({ source: "target", reason: "Target is PRONE → ranged attack disadvantage" });
      }
    }

    // RESTRAINED
    if (tgtStatuses.has("restrained")) {
      tgtConditions.add("restrained");
      advantageSources.push({ source: "target", reason: "Target is RESTRAINED → attack advantage" });
    }

    // PARALYZED
    if (tgtStatuses.has("paralyzed")) {
      tgtConditions.add("paralyzed");
      advantageSources.push({ source: "target", reason: "Target is PARALYZED → attack advantage" });
    }

    // STUNNED
    if (tgtStatuses.has("stunned")) {
      tgtConditions.add("stunned");
      advantageSources.push({ source: "target", reason: "Target is STUNNED → attack advantage" });
    }

    // UNCONSCIOUS
    if (tgtStatuses.has("unconscious")) {
      tgtConditions.add("unconscious");
      advantageSources.push({ source: "target", reason: "Target is UNCONSCIOUS → attack advantage" });
    }

    // BLINDED
    if (tgtStatuses.has("blinded") || tgtStatuses.has("blind")) {
      tgtConditions.add("blinded");
      advantageSources.push({ source: "target", reason: "Target is BLINDED → attack advantage" });
    }

    // INVISIBLE
    if (tgtStatuses.has("invisible")) {
      tgtConditions.add("invisible");
      disadvantageSources.push({ source: "target", reason: "Target is INVISIBLE → attack disadvantage" });
    }

    // PETRIFIED
    if (tgtStatuses.has("petrified")) {
      tgtConditions.add("petrified");
      advantageSources.push({ source: "target", reason: "Target is PETRIFIED → attack advantage" });
    }

    // DODGING
    if (tgtStatuses.has("dodging") || tgtStatuses.has("dodge")) {
      tgtConditions.add("dodging");
      disadvantageSources.push({ source: "target", reason: "Target is DODGING → attack disadvantage" });
    }

    // POISONED, FRIGHTENED, CHARMED, GRAPPLED, INCAPACITATED, DEAFENED
    if (tgtStatuses.has("poisoned")) tgtConditions.add("poisoned");
    if (tgtStatuses.has("frightened")) tgtConditions.add("frightened");
    if (tgtStatuses.has("charmed")) tgtConditions.add("charmed");
    if (tgtStatuses.has("grappled")) tgtConditions.add("grappled");
    if (tgtStatuses.has("incapacitated")) tgtConditions.add("incapacitated");
    if (tgtStatuses.has("deafened") || tgtStatuses.has("deaf")) tgtConditions.add("deafened");

    // ── Ranged Attack Within 5ft of Hostile ─────────────────────────────
    if (isRanged) {
      const hostileNear = CombatState._isHostileNearAttacker(attackerActor, targetToken, 5);
      if (hostileNear) {
        disadvantageSources.push({ source: "situation", reason: "RANGED ATTACK within 5ft of hostile creature → disadvantage" });
      }
    }

    // ── Ranged Attack at Long Range ─────────────────────────────────────
    if (isRanged && targetToken && attackerActor.getActiveTokens?.()?.[0]) {
      const atkToken = attackerActor.getActiveTokens()[0];
      const distance = CombatState._getDistance(atkToken, targetToken);
      const normalRange = item?.system?.range?.value ?? 0;
      const longRange = item?.system?.range?.long ?? 0;
      if (normalRange && distance > normalRange && longRange && distance <= longRange) {
        disadvantageSources.push({ source: "situation", reason: `RANGED at LONG RANGE (${Math.round(distance)}ft > ${normalRange}ft normal) → disadvantage` });
      }
    }

    // ── Faerie Fire on Target ───────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Faerie Fire")) {
      advantageSources.push({ source: "target", reason: "Target affected by FAERIE FIRE → attack advantage" });
    }

    // ── Guiding Bolt on Target (next attack advantage) ──────────────────
    if (CombatState._hasEffect(targetActor, "Guiding Bolt")) {
      advantageSources.push({ source: "target", reason: "Target marked by GUIDING BOLT → attack advantage" });
    }

    // ── Protection from Evil/Good on Target ─────────────────────────────
    if (CombatState._hasEffect(targetActor, "Protection from Evil and Good")) {
      const atkType = attackerActor.system?.details?.type?.value ?? "";
      if (["aberration", "celestial", "elemental", "fey", "fiend", "undead"].includes(atkType)) {
        disadvantageSources.push({ source: "target", reason: `Target has PROTECTION FROM EVIL/GOOD → disadvantage (attacker is ${atkType})` });
      }
    }

    // ── Blur on Target ──────────────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Blur")) {
      disadvantageSources.push({ source: "target", reason: "Target has BLUR → attack disadvantage" });
    }

    // ── Foresight on Target ─────────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Foresight")) {
      disadvantageSources.push({ source: "target", reason: "Target has FORESIGHT → attacks against have disadvantage" });
    }

    // ── Holy Aura on Target ─────────────────────────────────────────────
    if (CombatState._hasEffect(targetActor, "Holy Aura")) {
      disadvantageSources.push({ source: "target", reason: "Target has HOLY AURA → attacks against have disadvantage" });
    }

    // ── Foresight on Attacker ───────────────────────────────────────────
    if (CombatState._hasEffect(attackerActor, "Foresight")) {
      advantageSources.push({ source: "attacker", reason: "Attacker has FORESIGHT → attack advantage" });
    }

    // ── Otto's Irresistible Dance on Target ─────────────────────────────
    if (CombatState._hasEffect(targetActor, "Irresistible Dance") || CombatState._hasEffect(targetActor, "Otto")) {
      advantageSources.push({ source: "target", reason: "Target affected by IRRESISTIBLE DANCE → attack advantage" });
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  AUTO-CRIT CONDITIONS
    // ═════════════════════════════════════════════════════════════════════════
    let autoCrit = false;
    const autoCritReasons = [];

    if (isMelee && (tgtConditions.has("paralyzed") || tgtConditions.has("unconscious"))) {
      autoCrit = true;
      autoCritReasons.push(`Melee vs ${tgtConditions.has("paralyzed") ? "PARALYZED" : "UNCONSCIOUS"} = AUTO-CRIT`);
    }

    // Auto-crit from flags (attacker-side)
    if (FlagsEngine.hasAutoCrit(attackerActor, actionType)) {
      autoCrit = true;
      autoCritReasons.push("Flag grants AUTO-CRIT");
    }

    // Auto-crit from target grants flags
    if (FlagsEngine.grantsAutoCrit(targetActor, actionType)) {
      autoCrit = true;
      autoCritReasons.push("Target grants AUTO-CRIT (flag)");
    }

    // Prevent critical from target flags (Adamantine Armor)
    if (FlagsEngine.preventsCritical(targetActor, actionType)) {
      autoCrit = false;
      autoCritReasons.length = 0;
      autoCritReasons.push("CRITS PREVENTED (Adamantine Armor or similar)");
    }

    // Assassinate — attacker is Assassin rogue, target hasn't acted in combat
    if (CombatState._hasFeature(attackerActor, "Assassinate")) {
      const combat = game.combat;
      if (combat?.started) {
        const targetCombatant = combat.combatants?.find(c => c.actorId === targetActor.id);
        if (targetCombatant && !targetCombatant.hasActed) {
          autoCrit = true;
          autoCritReasons.push("ASSASSINATE → target hasn't acted yet = AUTO-CRIT");
          advantageSources.push({ source: "attacker", reason: "ASSASSINATE → advantage vs creature that hasn't acted" });
        }
      }
    }

    // Expanded crit range — Hexblade's Curse (19-20), Champion Improved Critical (19-20 or 18-20)
    let critRange = 20;
    if (CombatState._hasEffect(attackerActor, "Hexblade") || attackerActor.getFlag(MODULE_ID, "hexbladeCurse")) {
      critRange = 19;
    }
    if (CombatState._hasFeature(attackerActor, "Improved Critical")) {
      critRange = 19;
    }
    if (CombatState._hasFeature(attackerActor, "Superior Critical")) {
      critRange = 18;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  DAMAGE MODIFIERS PER TYPE
    // ═════════════════════════════════════════════════════════════════════════
    const resistances = new Set(tgtTraits.dr?.value ?? []);
    const immunities = new Set(tgtTraits.di?.value ?? []);
    const vulnerabilities = new Set(tgtTraits.dv?.value ?? []);
    const isMagical = itemProps.has("mgc") || !!item?.system?.magicAvailable;
    const isSilvered = itemProps.has("sil");
    const isAdamantine = itemProps.has("ada");

    // Build bypass sets from the creature's actual trait data
    const drBypasses = new Set(tgtTraits.dr?.bypasses ?? []);
    const diBypasses = new Set(tgtTraits.di?.bypasses ?? []);

    const damageModifiers = {};
    for (const type of damageTypes) {
      let modifier = "normal";
      let reason = null;

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
            reason = `Immune to ${type}`;
          }
        } else {
          modifier = "immune";
          reason = `Immune to ${type}`;
        }
      } else if (resistances.has(type)) {
        if (PHYSICAL_TYPES.has(type) && drBypasses.size > 0) {
          const bypassed = (drBypasses.has("mgc") && isMagical)
                        || (drBypasses.has("sil") && isSilvered)
                        || (drBypasses.has("ada") && isAdamantine);
          if (bypassed) {
            modifier = "normal";
            reason = `${type} resistance BYPASSED (${isMagical ? "magical" : isSilvered ? "silvered" : "adamantine"} weapon)`;
          } else {
            modifier = "resistant";
            reason = `Resists ${type} (half damage)`;
          }
        } else if (PHYSICAL_TYPES.has(type) && drBypasses.size === 0) {
          modifier = "resistant";
          reason = `Resists ${type} (half damage)`;
        } else {
          modifier = "resistant";
          reason = `Resists ${type} (half damage)`;
        }
      } else if (vulnerabilities.has(type)) {
        modifier = "vulnerable";
        reason = `VULNERABLE to ${type} (double damage)`;
      }

      // Petrified = resist all
      if (tgtConditions.has("petrified") && modifier === "normal") {
        modifier = "resistant";
        reason = "PETRIFIED → resists all damage";
      }

      damageModifiers[type] = { modifier, reason };
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  SAVING THROW MODIFIERS ON TARGET
    // ═════════════════════════════════════════════════════════════════════════
    let saveAdvantage = false;
    let saveDisadvantage = false;
    let autoFailSave = false;
    const saveBonuses = [];
    const saveAdvReasons = [];
    const saveDisadvReasons = [];

    if (saveAbility) {
      // Auto-fail STR/DEX saves
      if (["str", "dex"].includes(saveAbility)) {
        if (tgtConditions.has("paralyzed") || tgtConditions.has("stunned")
         || tgtConditions.has("unconscious") || tgtConditions.has("petrified")) {
          autoFailSave = true;
        }
      }

      // Restrained → disadvantage on DEX saves
      if (tgtConditions.has("restrained") && saveAbility === "dex") {
        saveDisadvantage = true;
        saveDisadvReasons.push("RESTRAINED → DEX save disadvantage");
      }

      // Exhaustion 3+ → disadvantage on ALL saves
      const tgtExhaustion = tgtSys.attributes?.exhaustion ?? 0;
      if (tgtExhaustion >= 3) {
        saveDisadvantage = true;
        saveDisadvReasons.push(`EXHAUSTION ${tgtExhaustion} → save disadvantage`);
      }

      // Dodge → advantage on DEX saves
      if (saveAbility === "dex" && tgtConditions.has("dodging")) {
        saveAdvantage = true;
        saveAdvReasons.push("DODGING → DEX save advantage");
      }

      // Magic Resistance → advantage on saves vs spells
      const magicRes = FlagsEngine.hasMagicResistance(targetActor)
                    || ExtendedEffects.hasMagicResistance(targetActor)
                    || CombatState._hasFeature(targetActor, "Magic Resistance");
      if (magicRes && isSpell) {
        saveAdvantage = true;
        saveAdvReasons.push("MAGIC RESISTANCE → advantage on saves vs spells");
      }

      // Gnome Cunning → advantage on INT/WIS/CHA saves vs magic
      if (["int", "wis", "cha"].includes(saveAbility) && isSpell) {
        if (CombatState._hasFeature(targetActor, "Gnome Cunning")) {
          saveAdvantage = true;
          saveAdvReasons.push("GNOME CUNNING → advantage on INT/WIS/CHA saves vs magic");
        }
      }

      // Danger Sense (Barbarian) → advantage on DEX saves you can see
      if (saveAbility === "dex" && CombatState._hasFeature(targetActor, "Danger Sense")) {
        if (!tgtConditions.has("blinded") && !tgtConditions.has("deafened") && !tgtConditions.has("incapacitated")) {
          saveAdvantage = true;
          saveAdvReasons.push("DANGER SENSE → DEX save advantage");
        }
      }

      // Haste → advantage on DEX saves
      if (saveAbility === "dex" && CombatState._hasEffect(targetActor, "Haste")) {
        saveAdvantage = true;
        saveAdvReasons.push("HASTE → DEX save advantage");
      }

      // Foresight → advantage on ALL saves
      if (CombatState._hasEffect(targetActor, "Foresight")) {
        saveAdvantage = true;
        saveAdvReasons.push("FORESIGHT → advantage on all saves");
      }

      // Holy Aura → advantage on ALL saves
      if (CombatState._hasEffect(targetActor, "Holy Aura")) {
        saveAdvantage = true;
        saveAdvReasons.push("HOLY AURA → advantage on all saves");
      }

      // Beacon of Hope → advantage on WIS saves
      if (saveAbility === "wis" && CombatState._hasEffect(targetActor, "Beacon of Hope")) {
        saveAdvantage = true;
        saveAdvReasons.push("BEACON OF HOPE → WIS save advantage");
      }

      // ACE QOL flags (FlagsEngine checks ace-qol + midi-qol automatically)
      if (FlagsEngine.hasSaveAdvantage(targetActor, saveAbility)
       || ExtendedEffects.hasAdvantage(targetActor, "save", saveAbility)
       || ExtendedEffects.hasAdvantage(targetActor, "save", "all")) {
        saveAdvantage = true;
        saveAdvReasons.push("Effect grants save advantage");
      }
      if (FlagsEngine.hasSaveDisadvantage(targetActor, saveAbility)
       || ExtendedEffects.hasDisadvantage(targetActor, "save", saveAbility)
       || ExtendedEffects.hasDisadvantage(targetActor, "save", "all")) {
        saveDisadvantage = true;
        saveDisadvReasons.push("Effect grants save disadvantage");
      }

      // Auto-fail saves from flags
      if (FlagsEngine.autoFailsSave(targetActor, saveAbility)) {
        autoFailSave = true;
      }

      // Bless → +1d4 to saves (bonus, not advantage)
      const blessBonus = tgtSys.bonuses?.abilities?.save;
      if (blessBonus) saveBonuses.push({ value: blessBonus, label: "Bless" });

      // Per-ability save bonus
      const abilitySaveBonus = tgtSys.abilities?.[saveAbility]?.bonuses?.save;
      if (abilitySaveBonus) saveBonuses.push({ value: abilitySaveBonus, label: `${saveAbility.toUpperCase()} bonus` });

      // Aura of Protection (Paladin) — CHA mod to saves for nearby allies
      // Check all nearby friendly tokens for a paladin with this feature
      const auraBonus = CombatState._getAuraOfProtectionBonus(targetToken);
      if (auraBonus > 0) saveBonuses.push({ value: `+${auraBonus}`, label: "Aura of Protection" });
    }

    // ── Evasion / Shield Master ─────────────────────────────────────────
    const superSaver = FlagsEngine.hasEvasion(targetActor)
                    || ExtendedEffects.hasSuperSaver(targetActor, saveAbility)
                    || (saveAbility === "dex" && CombatState._hasFeature(targetActor, "Evasion"));
    const semiSuperSaver = FlagsEngine._checkFlag(targetActor, `semiSuperSaver.${saveAbility}`)
                        || ExtendedEffects.hasSemiSuperSaver(targetActor, saveAbility)
                        || (saveAbility === "dex" && CombatState._hasFeature(targetActor, "Shield Master"));

    // ═════════════════════════════════════════════════════════════════════════
    //  CREATURE TYPE + SLAYER
    // ═════════════════════════════════════════════════════════════════════════
    const creatureType = tgtDetails.type?.value ?? "";
    const creatureSubtype = tgtDetails.type?.subtype ?? "";
    const creatureSize = tgtDetails.size ?? "medium";

    const slayerType = item?.getFlag?.("ace-artificer", "slayerType")
                    || item?.getFlag?.("ace-qol", "slayerType") || null;
    const slayerDamage = item?.getFlag?.("ace-artificer", "slayerDamage")
                      || item?.getFlag?.("ace-qol", "slayerDamage") || null;
    let slayerMatch = false;
    if (slayerType && creatureType) {
      slayerMatch = creatureType === slayerType
                 || creatureSubtype?.toLowerCase().includes(slayerType)
                 || creatureType?.toLowerCase().includes(slayerType);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ATTACKER BONUS DAMAGE FEATURES
    // ═════════════════════════════════════════════════════════════════════════
    const attackerBonuses = [];

    // Sneak Attack
    const sneakAttack = CombatState._checkSneakAttack(attackerActor, targetToken, item, isMelee, advantageSources.length > 0);
    if (sneakAttack.eligible) attackerBonuses.push(sneakAttack);

    // Hex
    if (CombatState._hasEffect(attackerActor, "Hex")) {
      attackerBonuses.push({ name: "Hex", formula: "1d6", type: "necrotic", reason: "Hex → +1d6 necrotic per hit" });
    }

    // Hunter's Mark
    if (CombatState._hasEffect(attackerActor, "Hunter's Mark") || CombatState._hasEffect(attackerActor, "Hunter")) {
      attackerBonuses.push({ name: "Hunter's Mark", formula: "1d6", type: damageTypes[0] ?? "force", reason: "Hunter's Mark → +1d6 per hit" });
    }

    // Hexblade's Curse
    if (CombatState._hasEffect(attackerActor, "Hexblade") || attackerActor.getFlag(MODULE_ID, "hexbladeCurse")) {
      const prof = attackerActor.system?.attributes?.prof ?? 2;
      attackerBonuses.push({ name: "Hexblade's Curse", formula: `${prof}`, type: damageTypes[0] ?? "force", reason: `Hexblade's Curse → +${prof} damage` });
    }

    // Rage damage (Barbarian)
    if (CombatState._hasEffect(attackerActor, "Rage") && isMelee) {
      const rageBonus = CombatState._getRageDamageBonus(attackerActor);
      if (rageBonus > 0) {
        attackerBonuses.push({ name: "Rage", formula: `${rageBonus}`, type: damageTypes[0] ?? "bludgeoning", reason: `Rage → +${rageBonus} melee damage` });
      }
    }

    // Improved Divine Smite / Radiant Strikes (Paladin 11+)
    if (isMelee && (CombatState._hasFeature(attackerActor, "Improved Divine Smite") || CombatState._hasFeature(attackerActor, "Radiant Strikes") || CombatState._getClassLevel(attackerActor, "paladin") >= 11)) {
      attackerBonuses.push({ name: "Improved Divine Smite", formula: "1d8", type: "radiant", reason: "Improved Divine Smite → +1d8 radiant on melee hits" });
    }

    // Divine Strike / Blessed Strikes (Cleric 8+)
    if (CombatState._hasFeature(attackerActor, "Divine Strike") || CombatState._hasFeature(attackerActor, "Blessed Strikes")) {
      const blessedStrikes = CombatState._hasFeature(attackerActor, "Blessed Strikes");
      attackerBonuses.push({ name: blessedStrikes ? "Blessed Strikes" : "Divine Strike", formula: "1d8", type: "radiant", reason: `${blessedStrikes ? "Blessed Strikes" : "Divine Strike"} → +1d8 radiant (once per turn)` });
    }

    // Colossus Slayer (Hunter Ranger)
    if (CombatState._hasFeature(attackerActor, "Colossus Slayer")) {
      const tgtCurrentHP = tgtSys.attributes?.hp?.value ?? 0;
      const tgtMaxHP = tgtSys.attributes?.hp?.max ?? 0;
      if (tgtCurrentHP < tgtMaxHP) {
        attackerBonuses.push({ name: "Colossus Slayer", formula: "1d8", type: damageTypes[0] ?? "untyped", reason: "Colossus Slayer → +1d8 (target below max HP)" });
      }
    }

    // Dread Ambusher (Gloom Stalker)
    if (CombatState._hasFeature(attackerActor, "Dread Ambusher") && game.combat?.round === 1) {
      const rangerLevel = CombatState._getClassLevel(attackerActor, "ranger");
      const hasStalkerFlurry = CombatState._hasFeature(attackerActor, "Stalker's Flurry") || rangerLevel >= 11;
      const dreadFormula = hasStalkerFlurry ? "2d8" : "1d8";
      attackerBonuses.push({ name: "Dread Ambusher", formula: dreadFormula, type: damageTypes[0] ?? "untyped", reason: `Dread Ambusher → +${dreadFormula} damage (first round of combat)` });
    }

    // Divine Fury (Zealot Barbarian)
    if (CombatState._hasFeature(attackerActor, "Divine Fury") && CombatState._hasEffect(attackerActor, "Rage")) {
      const barbarianLevel = CombatState._getClassLevel(attackerActor, "barbarian");
      const furyBonus = Math.floor(barbarianLevel / 2);
      attackerBonuses.push({ name: "Divine Fury", formula: `1d6 + ${furyBonus}`, type: "radiant", reason: `Divine Fury → +1d6+${furyBonus} radiant (first hit while raging)` });
    }

    // Lifedrinker (Warlock invocation)
    if (CombatState._hasFeature(attackerActor, "Lifedrinker")) {
      attackerBonuses.push({ name: "Lifedrinker", formula: "1d6", type: "necrotic", reason: "Lifedrinker → +1d6 necrotic per hit" });
    }

    // Spirit Shroud (active spell)
    // TODO: Should also check distance to target <= 10ft
    if (CombatState._hasEffect(attackerActor, "Spirit Shroud")) {
      attackerBonuses.push({ name: "Spirit Shroud", formula: "1d8", type: "radiant", reason: "Spirit Shroud → +1d8 radiant per hit (within 10ft)" });
    }

    // Holy Weapon (active spell)
    if (CombatState._hasEffect(attackerActor, "Holy Weapon")) {
      attackerBonuses.push({ name: "Holy Weapon", formula: "2d8", type: "radiant", reason: "Holy Weapon → +2d8 radiant per hit" });
    }

    // Elemental Weapon (active spell)
    if (CombatState._hasEffect(attackerActor, "Elemental Weapon")) {
      attackerBonuses.push({ name: "Elemental Weapon", formula: "1d4", type: "fire", reason: "Elemental Weapon → +1d4 elemental damage per hit" });
    }

    // Crusader's Mantle (active spell aura)
    if (CombatState._hasEffect(attackerActor, "Crusader's Mantle") || CombatState._hasEffect(attackerActor, "Crusader")) {
      attackerBonuses.push({ name: "Crusader's Mantle", formula: "1d4", type: "radiant", reason: "Crusader's Mantle → +1d4 radiant per hit" });
    }

    // Absorb Elements (active spell buff, melee only)
    if (CombatState._hasEffect(attackerActor, "Absorb Elements") && isMelee) {
      attackerBonuses.push({ name: "Absorb Elements", formula: "1d6", type: "fire", reason: "Absorb Elements → +1d6 elemental damage (next melee hit)" });
    }

    // Great Weapon Master +PB (2024 feat, heavy weapons only)
    if (CombatState._hasFeature(attackerActor, "Great Weapon Master")) {
      const hasHeavy = item?.system?.properties?.has?.("hvy") || item?.system?.properties?.hvy;
      if (hasHeavy) {
        const prof = attackerActor.system?.attributes?.prof ?? 2;
        attackerBonuses.push({ name: "Great Weapon Master", formula: `${prof}`, type: damageTypes[0] ?? "untyped", reason: `Great Weapon Master → +${prof} damage (proficiency bonus)` });
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  CONCENTRATION STATE
    // ═════════════════════════════════════════════════════════════════════════
    const isConcentrating = tgtStatuses.has("concentrating");
    let concentrationSpell = null;
    if (isConcentrating) {
      for (const effect of targetActor.effects ?? []) {
        if (effect.statuses?.has("concentrating")) {
          concentrationSpell = effect.name || "Unknown spell";
          break;
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  LEGENDARY RESISTANCE
    // ═════════════════════════════════════════════════════════════════════════
    const legendaryResistance = tgtSys.resources?.legres?.value ?? 0;
    const legendaryResistanceMax = tgtSys.resources?.legres?.max ?? 0;

    // ═════════════════════════════════════════════════════════════════════════
    //  FINAL ROLL MODE DETERMINATION
    // ═════════════════════════════════════════════════════════════════════════
    const hasAdvantage = advantageSources.length > 0;
    const hasDisadvantage = disadvantageSources.length > 0;

    // D&D 5e rule: any amount of advantage + any amount of disadvantage = normal
    let finalRollMode = "normal";
    if (hasAdvantage && hasDisadvantage) {
      finalRollMode = "normal"; // they cancel
    } else if (hasAdvantage) {
      finalRollMode = "advantage";
    } else if (hasDisadvantage) {
      finalRollMode = "disadvantage";
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  BUILD RESULT
    // ═════════════════════════════════════════════════════════════════════════
    return {
      attackerActor, targetToken, targetActor, item,
      isMelee, isRanged, isSpell, actionType,

      attacker: {
        name: attackerActor.token?.name ?? attackerActor.getActiveTokens?.()?.[0]?.name ?? attackerActor.name,
        conditions: atkConditions,
        exhaustion,
        reckless: !!reckless,
        bonuses: attackerBonuses,
      },

      target: {
        name: targetToken.document?.name ?? targetToken.name ?? targetActor.name,
        img: targetToken.document?.texture?.src ?? targetActor.img,
        ac: tgtAttrs.ac?.value ?? 10,
        conditions: tgtConditions,
        conditionImmunities: new Set(tgtTraits.ci?.value ?? []),
        currentHP: tgtSys.attributes?.hp?.value ?? 0,
        maxHP: tgtSys.attributes?.hp?.max ?? 0,
        tempHP: tgtSys.attributes?.hp?.temp ?? 0,
        creatureType, creatureSubtype, creatureSize,
        isConcentrating, concentrationSpell,
        legendaryResistance, legendaryResistanceMax,
      },

      damageModifiers,
      magicalBypass: isMagical, silveredBypass: isSilvered, adamantineBypass: isAdamantine,
      damageTypes,

      finalRollMode,
      advantageSources,
      disadvantageSources,
      autoCrit,
      autoCritReasons,
      critRange,

      saveAbility, saveAdvantage, saveDisadvantage, autoFailSave,
      saveBonuses, saveAdvReasons, saveDisadvReasons,
      superSaver, semiSuperSaver,
      magicResistance: (FlagsEngine.hasMagicResistance(targetActor) || ExtendedEffects.hasMagicResistance(targetActor) || CombatState._hasFeature(targetActor, "Magic Resistance")) && isSpell,

      slayerMatch, slayerDamage, slayerType,
    };
  }

  /**
   * Assess all currently targeted tokens.
   */
  static assessAll(attackerActor, item, opts = {}) {
    const results = [];
    for (const token of game.user.targets) {
      const state = CombatState.assess(attackerActor, token, item, opts);
      if (state) results.push(state);
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Summary Tags for Chat Card
  // ═══════════════════════════════════════════════════════════════════════════

  static getSummaryTags(state) {
    const tags = [];

    // Roll mode
    if (state.finalRollMode === "advantage") {
      tags.push({ label: "ROLL: ADVANTAGE", type: "bonus", icon: "fa-angles-up" });
    } else if (state.finalRollMode === "disadvantage") {
      tags.push({ label: "ROLL: DISADVANTAGE", type: "debuff", icon: "fa-angles-down" });
    } else if (state.advantageSources.length > 0 && state.disadvantageSources.length > 0) {
      tags.push({ label: "ADV + DISADV = NORMAL (cancelled)", type: "info", icon: "fa-equals" });
    }

    // Why advantage
    for (const src of state.advantageSources) {
      tags.push({ label: src.reason, type: "bonus", icon: "fa-arrow-up" });
    }

    // Why disadvantage
    for (const src of state.disadvantageSources) {
      tags.push({ label: src.reason, type: "debuff", icon: "fa-arrow-down" });
    }

    // Auto-crit
    for (const reason of (state.autoCritReasons ?? [])) {
      tags.push({ label: reason, type: "danger", icon: "fa-skull-crossbones" });
    }

    // Expanded crit range
    if (state.critRange < 20) {
      tags.push({ label: `CRIT RANGE: ${state.critRange}-20`, type: "danger", icon: "fa-crosshairs" });
    }

    // Damage modifiers
    for (const [type, mod] of Object.entries(state.damageModifiers)) {
      if (mod.modifier === "immune") tags.push({ label: `IMMUNE: ${type}`, type: "immune", icon: "fa-shield" });
      if (mod.modifier === "resistant" && mod.reason) tags.push({ label: mod.reason, type: mod.reason.includes("BYPASS") ? "info" : "resistant", icon: "fa-shield-halved" });
      if (mod.modifier === "vulnerable") tags.push({ label: mod.reason || `VULNERABLE: ${type}`, type: "vulnerable", icon: "fa-heart-crack" });
    }

    // Attacker bonuses
    for (const bonus of state.attacker.bonuses) {
      tags.push({ label: `${bonus.name}: +${bonus.formula} ${bonus.type}`, type: "bonus", icon: "fa-plus" });
    }

    // Slayer
    if (state.slayerMatch) {
      tags.push({ label: `SLAYER → +${state.slayerDamage} vs ${state.slayerType}`, type: "bonus", icon: "fa-crosshairs" });
    }

    // Target special
    if (state.target.isConcentrating) {
      tags.push({ label: `CONCENTRATING: ${state.target.concentrationSpell}`, type: "info", icon: "fa-brain" });
    }
    if (state.target.legendaryResistance > 0) {
      tags.push({ label: `LEG RESIST: ${state.target.legendaryResistance}/${state.target.legendaryResistanceMax}`, type: "legendary", icon: "fa-crown" });
    }

    // Save modifiers
    if (state.autoFailSave) tags.push({ label: "TARGET AUTO-FAILS STR/DEX SAVE", type: "danger", icon: "fa-circle-xmark" });
    for (const reason of (state.saveAdvReasons ?? [])) {
      tags.push({ label: reason, type: "buff", icon: "fa-arrow-up" });
    }
    for (const reason of (state.saveDisadvReasons ?? [])) {
      tags.push({ label: reason, type: "debuff", icon: "fa-arrow-down" });
    }
    if (state.superSaver) tags.push({ label: "EVASION → SAVE PASS = 0 DMG", type: "buff", icon: "fa-person-running" });
    if (state.semiSuperSaver) tags.push({ label: "SHIELD MASTER → SAVE PASS = 0 DMG (reaction)", type: "buff", icon: "fa-shield" });
    if (state.magicResistance) tags.push({ label: "MAGIC RESISTANCE → SAVE ADVANTAGE vs SPELLS", type: "buff", icon: "fa-hat-wizard" });

    for (const bonus of (state.saveBonuses ?? [])) {
      tags.push({ label: `SAVE BONUS: ${bonus.value} (${bonus.label})`, type: "buff", icon: "fa-plus" });
    }

    return tags;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Smart detection: is this ACTUALLY a ranged weapon/attack?
   * Cross-checks weapon type, properties, and range against actionType.
   * Catches misconfigured items like a longbow set to "mwak".
   */
  static _isActuallyRanged(item, actionType) {
    if (!item) return false;
    const sys = item.system ?? {};
    const props = sys.properties ?? new Set();

    // If actionType already says ranged, trust it
    if (["rwak", "rsak"].includes(actionType)) return true;

    // Check weapon type classification
    const weaponType = sys.type?.value ?? "";
    if (["simpleR", "martialR"].includes(weaponType)) return true;

    // Check for ammunition property (bows, crossbows)
    if (props.has("amm")) return true;

    // Thrown weapons (spear, javelin, handaxe, dagger) are fundamentally MELEE
    // weapons that can optionally be thrown. Their range values (20/60, 30/120)
    // must NOT override the melee classification. When actually thrown, the
    // system sets actionType to "rwak" — caught by the check above.
    if (props.has("thr")) return false;

    // Check range — if normal range is significantly more than melee range, it's ranged
    const normalRange = sys.range?.value ?? 0;
    const longRange = sys.range?.long ?? 0;
    if (normalRange > 10 && longRange > 0) return true;
    // Even without long range, if normal range > 30ft it's clearly ranged
    if (normalRange > 30) return true;

    // If it's a spell with range > 10ft and actionType is msak, could be ranged
    // But msak is explicitly melee spell attack, so leave it
    if (item.type === "spell" && ["rsak"].includes(actionType)) return true;

    return false;
  }

  /** Get all statuses from an actor — checks actor.statuses + effects + token */
  static _getStatuses(actor, token = null) {
    const statuses = new Set(actor.statuses ?? []);
    // Also check effects directly
    for (const effect of actor.effects ?? []) {
      if (effect.disabled) continue;
      for (const s of (effect.statuses ?? [])) statuses.add(s);
    }
    // Check token document
    if (token?.document?.hasStatusEffect) {
      // Can't iterate all, but at least we have the Set from above
    }
    return statuses;
  }

  /**
   * Flanking check — line-through method.
   * Draw a line from attacker through target center. If an ally is within
   * 5ft of the target on the opposite side of that line, flanking applies.
   */
  /**
   * @returns {string|null} Name of the flanking ally if found, else null.
   */
  static _isFlanking(attackerActor, targetToken) {
    if (!canvas.tokens?.placeables) return null;

    const atkToken = attackerActor.getActiveTokens?.()?.[0];
    if (!atkToken) return null;

    const atkCenter = atkToken.center;
    const tgtCenter = targetToken.center;
    const atkDisposition = atkToken.document?.disposition ?? 1;

    // Normalized vector from target to attacker
    const atkDx = atkCenter.x - tgtCenter.x;
    const atkDy = atkCenter.y - tgtCenter.y;
    const atkLen = Math.hypot(atkDx, atkDy);
    if (atkLen < 1) return null;
    const atkNx = atkDx / atkLen;
    const atkNy = atkDy / atkLen;

    // Angle threshold scales with target size — small creatures are strict
    // (perfect geometry from adjacent squares), large ones get more leeway
    // because tokens can't always land exactly opposite across a 3x3 / 4x4 body.
    //   Medium (1x1): ±32° (-0.85)  — RAW-tight
    //   Large  (2x2): ±40° (-0.77)
    //   Huge   (3x3): ±50° (-0.64)
    //   Garg   (4x4+): ±60° (-0.5)
    const targetSize = Math.max(
      targetToken.document?.width  ?? 1,
      targetToken.document?.height ?? 1,
    );
    const FLANK_DOT_THRESHOLD =
        targetSize <= 1 ? -0.85
      : targetSize <= 2 ? -0.77
      : targetSize <= 3 ? -0.64
      :                   -0.5;

    // Per RAW (DMG p251): both attackers must be ADJACENT to the target (5ft).
    // _getDistance() measures edge-to-edge, so this works for ALL target sizes:
    //   - Medium target: ally must be in one of the 8 adjacent squares (5ft)
    //   - Gargantuan target: ally must be touching one of its edges (0–5ft)
    // Reach weapons explicitly do NOT grant flanking per RAW.
    const FLANK_MAX_DISTANCE = 5;

    const dbg = game.settings.get(MODULE_ID, "debugMode");
    const log = (...args) => { if (dbg) console.log("ace-qol | FLANK |", ...args); };
    log(`Checking flanking for ${attackerActor.name} → ${targetToken.name}`);
    log(`  Attacker vector: (${atkNx.toFixed(2)}, ${atkNy.toFixed(2)})`);

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attackerActor.id) continue;
      if (token.id === targetToken.id) continue;

      const tokName = token.document?.name ?? token.name ?? token.actor?.name ?? "ally";

      // Must be same disposition (ally)
      if (token.document?.disposition !== atkDisposition) {
        log(`  ✗ ${tokName}: different disposition (${token.document?.disposition} vs ${atkDisposition})`);
        continue;
      }

      // ── Must be a CONSCIOUS, COMBAT-CAPABLE ally ──
      const ally = token.actor;
      const blockingStatuses = ["incapacitated", "unconscious", "dead", "paralyzed", "petrified", "stunned"];
      const blocker = blockingStatuses.find(s => ally.statuses?.has(s));
      if (blocker) { log(`  ✗ ${tokName}: status "${blocker}"`); continue; }

      const allyHp = ally.system?.attributes?.hp?.value;
      if (allyHp !== undefined && allyHp !== null && allyHp <= 0) {
        log(`  ✗ ${tokName}: HP ${allyHp}`); continue;
      }

      const combatant = game.combat?.combatants?.find(c => c.token?.id === token.document?.id);
      if (combatant?.defeated) { log(`  ✗ ${tokName}: marked defeated`); continue; }

      // Must be within melee reach of the target.
      // RAW (DMG p251): adjacent = 5ft. Houserule: if ally has a reach weapon
      // equipped (Glaive, Halberd, Pike, Whip, Lance, etc.), they can flank
      // from 10ft when the `flankingAllowReachWeapons` setting is on.
      const distToTarget = CombatState._getDistance(token, targetToken);
      let maxDist = FLANK_MAX_DISTANCE;
      let usedReach = false;
      try {
        if (game.settings.get(MODULE_ID, "flankingAllowReachWeapons")) {
          const hasEquippedReach = (ally.items?.contents ?? []).some(it => {
            if (it.type !== "weapon") return false;
            if (!it.system?.equipped) return false;
            const props = it.system?.properties;
            if (props?.has?.("rch"))     return true;  // Set
            if (Array.isArray(props) && props.includes("rch")) return true;
            if (props && typeof props === "object" && props.rch) return true;
            return false;
          });
          if (hasEquippedReach) { maxDist = 10; usedReach = true; }
        }
      } catch (_) { /* setting not registered yet */ }

      if (distToTarget > maxDist) {
        log(`  ✗ ${tokName}: distance ${distToTarget}ft > ${maxDist}ft (not in melee reach of target)`);
        continue;
      }

      // Angle check
      const allyCenter = token.center;
      const allyDx = allyCenter.x - tgtCenter.x;
      const allyDy = allyCenter.y - tgtCenter.y;
      const allyLen = Math.hypot(allyDx, allyDy);
      if (allyLen < 1) { log(`  ✗ ${tokName}: same position as target?`); continue; }
      const allyNx = allyDx / allyLen;
      const allyNy = allyDy / allyLen;
      const dot = (atkNx * allyNx) + (atkNy * allyNy);
      const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(0);

      if (dot <= FLANK_DOT_THRESHOLD) {
        log(`  ✓ ${tokName}: distance=${distToTarget}ft, ally-vector (${allyNx.toFixed(2)}, ${allyNy.toFixed(2)}), dot=${dot.toFixed(2)}, angle=${angleDeg}° → FLANKING`);
        return tokName;
      } else {
        log(`  ✗ ${tokName}: ally-vector (${allyNx.toFixed(2)}, ${allyNy.toFixed(2)}), dot=${dot.toFixed(2)}, angle=${angleDeg}° (need ≤ ${FLANK_DOT_THRESHOLD}, i.e. ≥ ~148°)`);
      }
    }

    log(`  → No flanking ally found.`);
    return null;
  }

  /** Check if actor has a named feature/feat */
  static _hasFeature(actor, name) {
    const lower = name.toLowerCase();
    return actor.items?.some(i =>
      (i.type === "feat" || i.type === "class") && i.name?.toLowerCase().includes(lower)
    ) ?? false;
  }

  /** Check if actor has a named active effect */
  static _hasEffect(actor, name) {
    const lower = name.toLowerCase();
    return actor.effects?.some(e =>
      !e.disabled && e.name?.toLowerCase().includes(lower)
    ) ?? false;
  }

  /** Check if a hostile creature is within range of the attacker */
  static _isHostileNearAttacker(attackerActor, targetToken, rangeFt = 5) {
    if (!canvas.tokens?.placeables) return false;
    const atkToken = attackerActor.getActiveTokens?.()?.[0];
    if (!atkToken) return false;

    const atkDisposition = atkToken.document?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attackerActor.id) continue;
      if (token.id === targetToken?.id) continue; // Target itself doesn't count for this rule

      const disp = token.document?.disposition ?? 0;
      // Hostile = opposite disposition
      if (disp === atkDisposition) continue; // Same team
      if (token.actor.statuses?.has("incapacitated") || token.actor.statuses?.has("unconscious")) continue;

      const dist = CombatState._getDistance(atkToken, token);
      if (dist <= rangeFt) return true;
    }
    return false;
  }

  /** Check if an ally is near a target */
  static _isAllyNearTarget(attacker, targetToken, rangeFt = 5) {
    if (!canvas.tokens?.placeables) return false;
    const atkDisposition = attacker.prototypeToken?.disposition ?? attacker.token?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attacker.id) continue;
      if (token.id === targetToken.id) continue;
      if (token.document?.disposition !== atkDisposition) continue;
      if (token.actor.statuses?.has("incapacitated") || token.actor.statuses?.has("unconscious")) continue;

      const dist = CombatState._getDistance(token, targetToken);
      if (dist <= rangeFt) return true;
    }
    return false;
  }

  /**
   * Check if any HOSTILE creature is within `rangeFt` of the attacker.
   * Used for ranged-attack-in-melee disadvantage (PHB 195): a hostile
   * within 5ft who can see you AND isn't incapacitated triggers it.
   */
  static _hasHostileWithinReach(attacker, rangeFt = 5) {
    if (!canvas.tokens?.placeables) return false;
    const atkDisposition = attacker.prototypeToken?.disposition ?? attacker.token?.disposition ?? 1;
    // Find the attacker's token on canvas
    const atkToken = attacker.getActiveTokens?.()?.[0]
                  ?? canvas.tokens.placeables.find(t => t.actor?.id === attacker.id);
    if (!atkToken) return false;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.actor.id === attacker.id) continue;
      // Hostile = opposite disposition
      if (token.document?.disposition === atkDisposition) continue;
      if (token.document?.disposition === 0) continue; // neutral doesn't trigger
      // RAW: hostile must be able to see + not incapacitated
      if (token.actor.statuses?.has("incapacitated") || token.actor.statuses?.has("unconscious")
       || token.actor.statuses?.has("paralyzed") || token.actor.statuses?.has("petrified")
       || token.actor.statuses?.has("stunned") || token.actor.statuses?.has("blinded")) continue;

      const dist = CombatState._getDistance(atkToken, token);
      if (dist <= rangeFt) return true;
    }
    return false;
  }

  /**
   * Get distance between two tokens using EDGE-TO-EDGE measurement.
   * D&D 5e rule: distance is from the nearest edge of one creature's
   * space to the nearest edge of the other's. This handles Large (2×2),
   * Huge (3×3), and Gargantuan (4×4) tokens correctly — adjacent tokens
   * are always 5ft apart regardless of size.
   */
  static _getDistance(token1, token2) {
    try {
      const gs = canvas.grid.size; // pixels per grid square
      const gd = canvas.dimensions?.distance ?? 5; // ft per grid square (usually 5)

      // Get occupied rectangle bounds in pixels
      const r1 = { left: token1.x, top: token1.y, right: token1.x + (token1.document?.width ?? 1) * gs, bottom: token1.y + (token1.document?.height ?? 1) * gs };
      const r2 = { left: token2.x, top: token2.y, right: token2.x + (token2.document?.width ?? 1) * gs, bottom: token2.y + (token2.document?.height ?? 1) * gs };

      // Calculate gap between rectangles on each axis
      const gapX = Math.max(0, r1.left - r2.right, r2.left - r1.right);
      const gapY = Math.max(0, r1.top - r2.bottom, r2.top - r1.bottom);

      // Overlapping = same space
      if (gapX < 0 && gapY < 0) return 0;

      // Convert pixel gap to grid squares
      const sqX = Math.ceil(gapX / gs);
      const sqY = Math.ceil(gapY / gs);

      // 5e cell distance: nearest neighbor (touching) = 1 cell = 5ft
      // Gap of 0 cells (cells touching) → 1 cell distance → 5ft
      // Gap of 1 cell (1 cell between) → 2 cells distance → 10ft
      // D&D 5e diagonal counts as same (max, not Pythagorean)
      const gridDist = Math.max(sqX, sqY) + 1;
      return gridDist * gd;
    } catch (err) {
      // Fallback to center-to-center if anything fails
      console.warn("ace-qol | CombatState._getDistance grid calc failed:", err);
      try {
        return canvas.grid.measureDistance(token1.center, token2.center, { gridSpaces: true }) ?? 999;
      } catch (err2) { console.warn("ace-qol | CombatState._getDistance center fallback failed:", err2); return 999; }
    }
  }

  /** Get Aura of Protection bonus from nearby paladin */
  static _getAuraOfProtectionBonus(targetToken) {
    if (!canvas.tokens?.placeables) return 0;
    let bestBonus = 0;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor || token.id === targetToken.id) continue;
      // Same team
      if (token.document?.disposition !== targetToken.document?.disposition) continue;
      // Has Aura of Protection
      if (!CombatState._hasFeature(token.actor, "Aura of Protection")) continue;
      // Not incapacitated
      if (token.actor.statuses?.has("incapacitated")) continue;

      const dist = CombatState._getDistance(token, targetToken);
      // 10ft base, 30ft at 18th level
      const paladinLevel = token.actor.items?.find(i => i.type === "class" && i.name?.toLowerCase().includes("paladin"))?.system?.levels ?? 0;
      const auraRange = paladinLevel >= 18 ? 30 : 10;

      if (dist <= auraRange) {
        const chaMod = token.actor.system?.abilities?.cha?.mod ?? 0;
        if (chaMod > bestBonus) bestBonus = chaMod;
      }
    }
    return bestBonus;
  }

  /** Check Sneak Attack eligibility */
  static _checkSneakAttack(attacker, targetToken, item, isMelee, hasAdvantage) {
    const sneakFeature = attacker.items?.find(i =>
      i.type === "feat" && i.name?.toLowerCase().includes("sneak attack")
    );
    if (!sneakFeature) return { eligible: false };

    const props = item?.system?.properties ?? new Set();
    if (!props.has("fin") && !["rwak"].includes(item?.system?.actionType)) {
      return { eligible: false, reason: "Weapon not finesse or ranged" };
    }

    const allyNearby = CombatState._isAllyNearTarget(attacker, targetToken, 5);
    if (hasAdvantage || allyNearby) {
      const rogueClass = attacker.items?.find(i => i.type === "class" && i.name?.toLowerCase() === "rogue");
      const dice = Math.ceil((rogueClass?.system?.levels ?? 1) / 2);
      return {
        eligible: true, name: "Sneak Attack", formula: `${dice}d6`,
        type: item?.system?.damage?.parts?.[0]?.[1] ?? "piercing",
        reason: hasAdvantage ? "Sneak Attack (have advantage)" : "Sneak Attack (ally within 5ft)",
      };
    }
    return { eligible: false, reason: "No advantage and no ally near target" };
  }

  /** Get class level by name (e.g., "paladin", "barbarian") */
  static _getClassLevel(actor, className) {
    for (const item of actor.items ?? []) {
      if (item.type === "class" && item.name?.toLowerCase().includes(className.toLowerCase())) {
        return item.system?.levels ?? 0;
      }
    }
    return 0;
  }

  /** Get Rage damage bonus by barbarian level */
  static _getRageDamageBonus(actor) {
    const barbClass = actor.items?.find(i => i.type === "class" && i.name?.toLowerCase().includes("barbarian"));
    const level = barbClass?.system?.levels ?? 0;
    if (level >= 16) return 4;
    if (level >= 9) return 3;
    if (level >= 1) return 2;
    return 0;
  }

  /** Get all damage types from an item */
  static _getItemDamageTypes(item) {
    const types = new Set();
    const sys = item?.system ?? {};
    if (sys.activities) {
      const actList = (typeof sys.activities.forEach === "function")
        ? [...(sys.activities.values?.() ?? sys.activities)]
        : (typeof sys.activities === "object" ? Object.values(sys.activities) : []);
      for (const activity of actList) {
        if (!activity?.damage?.parts) continue;
        for (const part of activity.damage.parts) {
          if (part.types) for (const t of part.types) types.add(t);
        }
      }
    }
    if (sys.damage?.parts) {
      for (const part of sys.damage.parts) { if (part[1]) types.add(part[1]); }
    }
    return [...types];
  }

  /** Debug logging */
  static _debugLog(state) {
    try { if (!game.settings.get(MODULE_ID, "debugMode")) return; } catch { return; }
    const advSrc = state.advantageSources.map(s => s.reason).join("; ") || "none";
    const disSrc = state.disadvantageSources.map(s => s.reason).join("; ") || "none";
    console.log(`${MODULE_ID} | COMBAT STATE: ${state.attacker.name} → ${state.target.name}`);
    console.log(`  Roll: ${state.finalRollMode} | Adv: [${advSrc}] | Disadv: [${disSrc}]`);
    console.log(`  AutoCrit: ${state.autoCrit} | CritRange: ${state.critRange}-20 | Slayer: ${state.slayerMatch ? state.slayerType : "no"}`);
    console.log(`  Target AC: ${state.target.ac} | HP: ${state.target.currentHP}/${state.target.maxHP}`);
  }
}
