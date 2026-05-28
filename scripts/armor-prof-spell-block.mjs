// ─── ACE QOL — Non-Proficient Armor Effects ────────────────────────────────
//
// RAW (PHB p.144): "If you wear armor that you lack proficiency with, you
// have disadvantage on any ability check, saving throw, or attack roll
// that involves Strength or Dexterity, AND YOU CAN'T CAST SPELLS."
//
// Four consequences from this rule. ace-qol handles each in its natural
// pipeline:
//
//   1. Attack-roll disadvantage  → combat-state.assess (v0.7.6)
//   2. Spell-cast block          → this file's _onPreUseActivity (v0.7.7)
//   3. STR/DEX ability check     → this file's _onPreAbilityCheck (v0.7.13)
//      / save disadvantage         + _onPreSavingThrow
//
// PC-only — NPCs typically have no populated `armorProf` array, so we'd
// false-positive on every spellcasting monster (every Lich, every Mage,
// every dragon with armored hide). Skip.
//
// Toggles:
//   - armorProfSpellBlock  (default ON, RAW-strict)
//   - armorProfCheckSaveDisadvantage  (NEW v0.7.13, default ON)
// ───────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// dnd5e 5.x stores armor item type as a long-form string ("light" /
// "medium" / "heavy") and the matching proficiency key as short-form
// ("lgt" / "med" / "hvy"). Same mapping used in combat-state.mjs.
const ARMOR_TYPE_TO_PROF = { light: "lgt", medium: "med", heavy: "hvy" };

// STR + DEX — the abilities affected by armor-proficiency disadvantage.
// Ability ID strings as used by dnd5e: "str", "dex".
const STR_DEX_ABILITIES = new Set(["str", "dex"]);

/**
 * Find equipped body armor whose proficiency the actor lacks.
 * Returns the offending Item document, OR null if the actor is fully
 * armor-proficient (or wearing nothing armor-typed). PC-gated by caller.
 */
function _findUnproficientArmor(actor) {
  if (!actor || actor.type !== "character") return null;
  let equippedArmor = null;
  try {
    equippedArmor = actor.items?.find?.(it =>
      it.type === "equipment"
      && it.system?.equipped === true
      && ARMOR_TYPE_TO_PROF[it.system?.armor?.type]
    ) ?? null;
  } catch (_) { return null; }
  if (!equippedArmor) return null;
  const profKey = ARMOR_TYPE_TO_PROF[equippedArmor.system.armor.type];
  const profs = actor.system?.traits?.armorProf?.value;
  const hasProf = (profs?.has?.(profKey) === true)
               || (Array.isArray(profs) && profs.includes(profKey));
  return hasProf ? null : equippedArmor;
}

export class ArmorProfSpellBlock {

  static init() {
    // ── Spell-cast block (existing, v0.7.7) ───────────────────────────
    Hooks.on("dnd5e.preUseActivity", (activity /*, usageConfig, dialogConfig, messageConfig */) => {
      try {
        if (QolSettings.get?.("armorProfSpellBlock") === false) return;

        const item = activity?.item;
        if (!item || item.type !== "spell") return;
        const actor = activity?.actor ?? item?.actor;
        if (!actor) return;
        const equippedArmor = _findUnproficientArmor(actor);
        if (!equippedArmor) return;

        ui.notifications?.error(
          `${actor.name} cannot cast spells while wearing ${equippedArmor.name} ` +
          `— no ${equippedArmor.system.armor.type}-armor proficiency (RAW PHB p.144).`
        );
        console.log(`${MODULE_ID} | ArmorProfSpellBlock: blocked ${actor.name} from casting "${item.name}" — wearing ${equippedArmor.name} (no ${equippedArmor.system.armor.type} proficiency)`);
        return false;
      } catch (err) {
        console.warn(`${MODULE_ID} | ArmorProfSpellBlock check threw — fail-open (cast permitted):`, err);
      }
    });

    // ── STR/DEX ability check disadvantage (NEW v0.7.13) ──────────────
    // Hooks both the V2 (dnd5e 5.x) and legacy hook paths to cover all
    // supported dnd5e versions. The V2 path is the one that fires in
    // dnd5e 5.x and what 99% of users will hit.
    Hooks.on("dnd5e.preRollAbilityCheckV2", (config /*, dialog, message */) => {
      ArmorProfSpellBlock._applyAbilityCheckDisadvantage(config);
    });
    Hooks.on("dnd5e.preRollAbilityCheck", (actor, config, abilityId) => {
      ArmorProfSpellBlock._applyAbilityCheckDisadvantageLegacy(actor, config, abilityId);
    });

    // ── STR/DEX saving throw disadvantage (NEW v0.7.13) ───────────────
    Hooks.on("dnd5e.preRollSavingThrowV2", (config /*, dialog, message */) => {
      ArmorProfSpellBlock._applySaveDisadvantage(config);
    });
    Hooks.on("dnd5e.preRollSavingThrow", (actor, config, abilityId) => {
      ArmorProfSpellBlock._applySaveDisadvantageLegacy(actor, config, abilityId);
    });
  }

  /**
   * Common worker — apply disadvantage to the roll config IF the ability
   * is STR/DEX AND the actor is wearing unproficient armor.
   *
   * @param {object} config  — dnd5e roll config (has rolls[0].options)
   * @param {Actor}  actor   — resolved actor (V2 derives from config.subject)
   * @param {string} ability — "str", "dex", etc.
   * @param {string} rollLabel — for the log line ("check" / "save")
   * @private
   */
  static _maybeAddDisadvantage(config, actor, ability, rollLabel) {
    try {
      if (QolSettings.get?.("armorProfCheckSaveDisadvantage") === false) return;
      if (!STR_DEX_ABILITIES.has(String(ability ?? "").toLowerCase())) return;
      const equippedArmor = _findUnproficientArmor(actor);
      if (!equippedArmor) return;

      // dnd5e v3.x V2 hook: roll options carry advantageMode (1=adv, -1=disadv).
      // We want to force at least -1 (disadvantage). If advantage is currently
      // set (1), drop to 0 (cancels out per RAW). If disadvantage is already
      // -1, stay at -1. If neutral (0), set to -1.
      const opts = config?.rolls?.[0]?.options;
      if (opts) {
        const current = Number(opts.advantageMode ?? 0);
        if (current === 1)        opts.advantageMode = 0;   // adv + disadv → normal
        else if (current === 0)   opts.advantageMode = -1;  // normal → disadv
        // current === -1: already disadv, no change
      }
      // Legacy v12 path: config.disadvantage flag
      if (typeof config?.disadvantage !== "undefined") {
        config.disadvantage = true;
      }
      console.log(`${MODULE_ID} | ArmorProfDisadvantage: ${actor.name} ${ability.toUpperCase()} ${rollLabel} → disadvantage (wearing ${equippedArmor.name}, no ${equippedArmor.system.armor.type} proficiency)`);
    } catch (err) {
      console.warn(`${MODULE_ID} | ArmorProfDisadvantage threw — fail-open:`, err);
    }
  }

  /** V2 ability-check hook. @private */
  static _applyAbilityCheckDisadvantage(config) {
    const actor   = config?.subject?.parent ?? config?.subject ?? config?.actor;
    const ability = config?.ability ?? config?.rolls?.[0]?.options?.ability;
    ArmorProfSpellBlock._maybeAddDisadvantage(config, actor, ability, "check");
  }

  /** Legacy ability-check hook. @private */
  static _applyAbilityCheckDisadvantageLegacy(actor, config, abilityId) {
    ArmorProfSpellBlock._maybeAddDisadvantage(config, actor, abilityId, "check");
  }

  /** V2 saving-throw hook. @private */
  static _applySaveDisadvantage(config) {
    const actor   = config?.subject?.parent ?? config?.subject ?? config?.actor;
    const ability = config?.ability ?? config?.rolls?.[0]?.options?.ability;
    ArmorProfSpellBlock._maybeAddDisadvantage(config, actor, ability, "save");
  }

  /** Legacy saving-throw hook. @private */
  static _applySaveDisadvantageLegacy(actor, config, abilityId) {
    ArmorProfSpellBlock._maybeAddDisadvantage(config, actor, abilityId, "save");
  }
}
