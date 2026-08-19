// ─── ACE: QOL — Extended Active Effects Engine ───────────────────────────────
// Replaces DAE. Extends Foundry's Active Effect system with:
//   1. Formula evaluation in effect values (@abilities.con.mod, @prof, etc.)
//   2. Extra effect keys (damage bonuses, speed, senses, skill mods)
//   3. Transfer rules (equip, attune, always, never)
//   4. Macros on apply/remove
//   5. Upgrade/Downgrade effect modes
//   6. Condition-aware effect application
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

// ─── Custom Effect Modes (beyond Foundry's 5 built-in) ──────────────────────
// Foundry v12+ already has ADD(2), MULTIPLY(1), OVERRIDE(5), UPGRADE(3), DOWNGRADE(4), CUSTOM(0)
// We reference them at runtime via CONST.ACTIVE_EFFECT_MODES to avoid import-time issues

// ─── Extended Effect Keys ────────────────────────────────────────────────────
// Keys that vanilla Foundry can't resolve but we handle
const EXTENDED_KEYS = new Set([
  // ── Damage bonuses (per attack type) ──
  "system.bonuses.mwak.attack",
  "system.bonuses.mwak.damage",
  "system.bonuses.rwak.attack",
  "system.bonuses.rwak.damage",
  "system.bonuses.msak.attack",
  "system.bonuses.msak.damage",
  "system.bonuses.rsak.attack",
  "system.bonuses.rsak.damage",
  "system.bonuses.abilities.save",
  "system.bonuses.abilities.check",
  "system.bonuses.spell.dc",
  "system.bonuses.spell.all.damage",

  // ── AC modifications ──
  "system.attributes.ac.bonus",
  "system.attributes.ac.flat",

  // ── Speed modifications ──
  "system.attributes.movement.walk",
  "system.attributes.movement.fly",
  "system.attributes.movement.swim",
  "system.attributes.movement.climb",
  "system.attributes.movement.burrow",

  // ── Senses (D&D 5e 5.2.x paths) ──
  "system.attributes.senses.darkvision",
  "system.attributes.senses.blindsight",
  "system.attributes.senses.tremorsense",
  "system.attributes.senses.truesight",
  // ── Senses (D&D 5e 5.3.0+ paths — moved under .ranges) ──
  "system.attributes.senses.ranges.darkvision",
  "system.attributes.senses.ranges.blindsight",
  "system.attributes.senses.ranges.tremorsense",
  "system.attributes.senses.ranges.truesight",

  // ── Damage traits ──
  "system.traits.dr.value",    // resistance
  "system.traits.di.value",    // immunity
  "system.traits.dv.value",    // vulnerability
  "system.traits.ci.value",    // condition immunity

  // ── HP modifications ──
  "system.attributes.hp.max",
  "system.attributes.hp.temp",
  "system.attributes.hp.tempmax",

  // ── Ability scores ──
  "system.abilities.str.value",
  "system.abilities.dex.value",
  "system.abilities.con.value",
  "system.abilities.int.value",
  "system.abilities.wis.value",
  "system.abilities.cha.value",

  // ── Save bonuses ──
  "system.abilities.str.bonuses.save",
  "system.abilities.dex.bonuses.save",
  "system.abilities.con.bonuses.save",
  "system.abilities.int.bonuses.save",
  "system.abilities.wis.bonuses.save",
  "system.abilities.cha.bonuses.save",

  // ── ACE QOL custom flags ──
  "flags.ace-qol.advantage.attack.all",
  "flags.ace-qol.advantage.attack.mwak",
  "flags.ace-qol.advantage.attack.rwak",
  "flags.ace-qol.advantage.attack.msak",
  "flags.ace-qol.advantage.attack.rsak",
  "flags.ace-qol.disadvantage.attack.all",
  "flags.ace-qol.disadvantage.attack.mwak",
  "flags.ace-qol.disadvantage.attack.rwak",
  "flags.ace-qol.disadvantage.attack.msak",
  "flags.ace-qol.disadvantage.attack.rsak",
  "flags.ace-qol.advantage.save.all",
  "flags.ace-qol.advantage.save.str",
  "flags.ace-qol.advantage.save.dex",
  "flags.ace-qol.advantage.save.con",
  "flags.ace-qol.advantage.save.int",
  "flags.ace-qol.advantage.save.wis",
  "flags.ace-qol.advantage.save.cha",
  "flags.ace-qol.disadvantage.save.all",
  "flags.ace-qol.disadvantage.save.str",
  "flags.ace-qol.disadvantage.save.dex",
  "flags.ace-qol.disadvantage.save.con",
  "flags.ace-qol.disadvantage.save.int",
  "flags.ace-qol.disadvantage.save.wis",
  "flags.ace-qol.disadvantage.save.cha",
  "flags.ace-qol.magicResistance",
  "flags.ace-qol.superSaver.dex",        // Evasion
  "flags.ace-qol.semiSuperSaver.dex",    // Shield Master
  "flags.ace-qol.slayerType",
  "flags.ace-qol.slayerDamage",

  // ── Grants (target-side modifiers) ──
  "flags.ace-qol.grants.advantage.attack.all",
  "flags.ace-qol.grants.advantage.attack.mwak",
  "flags.ace-qol.grants.advantage.attack.rwak",
  "flags.ace-qol.grants.advantage.attack.msak",
  "flags.ace-qol.grants.advantage.attack.rsak",
  "flags.ace-qol.grants.disadvantage.attack.all",
  "flags.ace-qol.grants.disadvantage.attack.mwak",
  "flags.ace-qol.grants.disadvantage.attack.rwak",
  "flags.ace-qol.grants.disadvantage.attack.msak",
  "flags.ace-qol.grants.disadvantage.attack.rsak",

  // ── Critical hit modifiers ──
  "flags.ace-qol.critical.all",
  "flags.ace-qol.critical.mwak",
  "flags.ace-qol.critical.rwak",
  "flags.ace-qol.critical.msak",
  "flags.ace-qol.critical.rsak",
  "flags.ace-qol.noCritical.all",
  "flags.ace-qol.noCritical.mwak",
  "flags.ace-qol.noCritical.rwak",
  "flags.ace-qol.noCritical.msak",
  "flags.ace-qol.noCritical.rsak",
  "flags.ace-qol.grants.critical.all",
  "flags.ace-qol.grants.critical.mwak",
  "flags.ace-qol.grants.critical.rwak",
  "flags.ace-qol.grants.critical.msak",
  "flags.ace-qol.grants.critical.rsak",

  // ── Save modifiers (long-form path for midi-qol compat) ──
  "flags.ace-qol.advantage.ability.save.all",
  "flags.ace-qol.advantage.ability.save.str",
  "flags.ace-qol.advantage.ability.save.dex",
  "flags.ace-qol.advantage.ability.save.con",
  "flags.ace-qol.advantage.ability.save.int",
  "flags.ace-qol.advantage.ability.save.wis",
  "flags.ace-qol.advantage.ability.save.cha",
  "flags.ace-qol.disadvantage.ability.save.all",
  "flags.ace-qol.disadvantage.ability.save.str",
  "flags.ace-qol.disadvantage.ability.save.dex",
  "flags.ace-qol.disadvantage.ability.save.con",
  "flags.ace-qol.disadvantage.ability.save.int",
  "flags.ace-qol.disadvantage.ability.save.wis",
  "flags.ace-qol.disadvantage.ability.save.cha",
  "flags.ace-qol.fail.ability.save.all",
  "flags.ace-qol.fail.ability.save.str",
  "flags.ace-qol.fail.ability.save.dex",
  "flags.ace-qol.fail.ability.save.con",
  "flags.ace-qol.fail.ability.save.int",
  "flags.ace-qol.fail.ability.save.wis",
  "flags.ace-qol.fail.ability.save.cha",

  // ── Damage modifiers ──
  "flags.ace-qol.min.damage.all",
  "flags.ace-qol.min.damage.mwak",
  "flags.ace-qol.min.damage.rwak",
  "flags.ace-qol.min.damage.msak",
  "flags.ace-qol.min.damage.rsak",
  "flags.ace-qol.max.damage.all",
  "flags.ace-qol.max.damage.mwak",
  "flags.ace-qol.max.damage.rwak",
  "flags.ace-qol.max.damage.msak",
  "flags.ace-qol.max.damage.rsak",
  "flags.ace-qol.bonusDamage.all",
  "flags.ace-qol.bonusDamage.mwak",
  "flags.ace-qol.bonusDamage.rwak",
  "flags.ace-qol.bonusDamage.msak",
  "flags.ace-qol.bonusDamage.rsak",

  // ── Special features ──
  "flags.ace-qol.sculptSpell",
  "flags.ace-qol.carefulSpell",
  "flags.ace-qol.evasion",
]);

export class ExtendedEffects {

  constructor() {
    this._macroCache = new Map();   // effectId → macro function
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Initialization — hook into Foundry's effect pipeline
  // ═══════════════════════════════════════════════════════════════════════════

  init() {
    // ── Hook: Before effects are applied, evaluate formulas ──
    Hooks.on("applyActiveEffect", (actor, change, current, delta, changes) => {
      this._onApplyEffect(actor, change, current, delta, changes);
    });

    // ── Hook: Effect created — run onApply macro ──
    Hooks.on("createActiveEffect", (effect, options, userId) => {
      this._onEffectCreated(effect, options, userId);
    });

    // ── Hook: Effect deleted — run onRemove macro ──
    Hooks.on("deleteActiveEffect", (effect, options, userId) => {
      this._onEffectDeleted(effect, options, userId);
    });

    // ── Hook: Effect toggled (enabled/disabled) ──
    Hooks.on("updateActiveEffect", (effect, changes, options, userId) => {
      if ("disabled" in changes) {
        if (changes.disabled) {
          this._runMacro(effect, "onRemove");
        } else {
          this._runMacro(effect, "onApply");
        }
      }
    });

    // ── Hook: Item equipped/attuned — handle transfer rules ──
    Hooks.on("updateItem", (item, changes, options, userId) => {
      this._onItemUpdated(item, changes, options, userId);
    });

    console.debug(`${MODULE_ID} | Extended Active Effects engine initialized`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Formula Evaluation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called by Foundry's applyActiveEffect hook.
   * Evaluates formulas like @abilities.con.mod, @prof, @attributes.spelldc
   * before the effect value is applied.
   */
  _onApplyEffect(actor, change, current, delta, changes) {
    if (!change?.value || typeof change.value !== "string") return;

    // Check if this is a formula that needs evaluation
    if (!change.value.includes("@")) return;

    try {
      const rollData = actor.getRollData?.() ?? {};
      const evaluated = this._evaluateFormula(change.value, rollData);
      change.value = evaluated;
      // Only log non-trivial formula evaluations (skip "0" → 0 spam)
      if (evaluated !== 0 && evaluated !== "0") {
        this._debug(`Formula evaluated: "${change.value}" → ${evaluated} on ${actor.name}`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Formula evaluation failed for "${change.value}":`, err.message);
    }
  }

  /**
   * Evaluate a formula string using actor roll data.
   * Handles: @abilities.con.mod, @prof, @attributes.spelldc, @details.level, etc.
   * Also handles simple arithmetic: @prof + 2, @abilities.str.mod * 2
   */
  _evaluateFormula(formula, rollData) {
    // Replace @references with actual values
    let resolved = formula.replace(/@([a-zA-Z0-9_.]+)/g, (match, path) => {
      const value = this._resolvePath(rollData, path);
      if (value === undefined || value === null) {
        return "0";
      }
      return String(value);
    });

    // If it's purely numeric after resolution, return as-is
    if (/^-?\d+(\.\d+)?$/.test(resolved.trim())) {
      return resolved.trim();
    }

    // If it contains arithmetic, evaluate safely
    if (/^[\d\s+\-*/().]+$/.test(resolved)) {
      try {
        // Safe eval — only numbers and arithmetic operators
        const result = Function(`"use strict"; return (${resolved})`)();
        return String(Math.floor(result));
      } catch {
        return resolved;
      }
    }

    // Contains dice notation (2d6, 1d8+@mod) — return as roll formula string
    return resolved;
  }

  /**
   * Resolve a dot-path on an object: "abilities.con.mod" → obj.abilities.con.mod
   */
  _resolvePath(obj, path) {
    return path.split(".").reduce((o, key) => o?.[key], obj);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Transfer Rules — control when item effects flow to actors
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When an item is updated (equipped, attuned, etc.), check if its effects
   * should be transferred or removed from the owning actor.
   */
  _onItemUpdated(item, changes, options, userId) {
    if (game.userId !== userId) return;  // Only process on the user who made the change
    const actor = item.parent;
    if (!actor || actor.documentName !== "Actor") return;

    // Check if equipped or attuned state changed
    const equippedChanged = "system" in changes && "equipped" in (changes.system ?? {});
    const attunedChanged  = "system" in changes && "attuned" in (changes.system ?? {});
    if (!equippedChanged && !attunedChanged) return;

    const effects = item.effects ?? [];
    for (const effect of effects) {
      const transferRule = this._getTransferRule(effect);
      const shouldBeActive = this._shouldEffectBeActive(item, transferRule);

      // If the effect's disabled state doesn't match what it should be, update it
      if (effect.disabled === shouldBeActive) {
        effect.update({ disabled: !shouldBeActive });
        this._debug(`Transfer rule: ${effect.name} on ${item.name} → ${shouldBeActive ? "ACTIVE" : "DISABLED"} (rule: ${transferRule})`);
      }
    }
  }

  /**
   * Determine the transfer rule for an effect.
   * Reads from our flag first, falls back to the effect's transfer property.
   */
  _getTransferRule(effect) {
    // Check our custom flag first
    const rule = effect.getFlag?.(MODULE_ID, "transferRule");
    if (rule) return rule;  // "equip", "attune", "always", "never"

    // Fall back to vanilla transfer behavior
    if (effect.transfer === true) return "equip";
    return "never";
  }

  /**
   * Should an effect be active based on the item's current state and the transfer rule?
   */
  _shouldEffectBeActive(item, rule) {
    switch (rule) {
      case "always":  return true;
      case "never":   return false;
      case "equip":   return item.system?.equipped === true;
      case "attune":  return item.system?.attuned === true || item.system?.attunement === "attuned";
      default:        return item.system?.equipped === true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Macros on Apply/Remove
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When an effect is created, run its onApply macro if it has one.
   */
  _onEffectCreated(effect, options, userId) {
    if (game.userId !== userId) return;
    this._runMacro(effect, "onApply");
  }

  /**
   * When an effect is deleted, run its onRemove macro if it has one.
   */
  _onEffectDeleted(effect, options, userId) {
    if (game.userId !== userId) return;
    this._runMacro(effect, "onRemove");
  }

  /**
   * Execute a macro stored in an effect's flags.
   *
   * Flags structure:
   *   flags.ace-qol.macro.onApply = "macro name or UUID"
   *   flags.ace-qol.macro.onRemove = "macro name or UUID"
   *   flags.ace-qol.macro.command = "inline JS code"
   *
   * The macro receives: { actor, effect, item, token }
   */
  async _runMacro(effect, trigger) {
    const macroRef = effect.getFlag?.(MODULE_ID, `macro.${trigger}`);
    const inlineCommand = effect.getFlag?.(MODULE_ID, "macro.command");

    if (!macroRef && !inlineCommand) return;

    const actor = effect.parent;
    const item = effect.parent?.documentName === "Item" ? effect.parent : null;
    const ownerActor = item?.parent ?? actor;
    const token = ownerActor?.getActiveTokens?.()?.[0] ?? null;

    const scope = { actor: ownerActor, effect, item, token, trigger };

    try {
      if (macroRef) {
        // Try to find macro by name or UUID
        let macro = game.macros.getName(macroRef);
        if (!macro) macro = await fromUuid(macroRef);
        if (macro) {
          await macro.execute(scope);
          this._debug(`Macro executed: "${macroRef}" (${trigger}) on ${ownerActor?.name}`);
        } else {
          console.warn(`${MODULE_ID} | Macro not found: "${macroRef}"`);
        }
      } else if (inlineCommand && trigger === "onApply") {
        // ⚠️🔴 INLINE SCRIPT = eval, AND THE SOURCE IS ACTOR DATA (2026-08-19).
        //
        // `new Function(...)` on a string pulled from an Active Effect flag runs
        // arbitrary code with full Foundry privileges. That flag can arrive from
        // a compendium, a shared adventure, a Discord .json, a DDB import, or
        // anything a player can write to on an actor they own. Nobody reads an
        // effect's flags before dragging an item onto their sheet.
        //
        // On a GM's client that is total control of the world: read every key
        // in settings, rewrite actors, post as anyone, hit the network.
        //
        // ⚠️ A SETTING WOULD NOT MAKE THIS SAFE. The person who imports the
        // content is not the person who wrote it, so "GM opted in" does not
        // mean "GM read this script". Macros are the supported path precisely
        // because a Macro document is visible, reviewable, and permissioned.
        //
        // The inline path is therefore REFUSED, loudly, with the effect and the
        // actor named so the GM can convert it into a real macro. Silently
        // ignoring it would leave people wondering why their effect stopped.
        console.error(`${MODULE_ID} | REFUSED an inline script on effect "${effect?.name}" ` +
          `(actor: ${ownerActor?.name}). ACE does not execute code stored in actor data. ` +
          `Move it into a Macro and reference it by name or UUID.`);
        if (game.user?.isGM) {
          ui.notifications?.warn(
            `ACE: "${effect?.name}" tried to run an inline script. Blocked — put it in a Macro instead.`,
            { permanent: true });
        }
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Macro execution failed (${trigger}):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Utility: Check if an effect key is extended (handled by us)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a key is in our extended set.
   */
  static isExtendedKey(key) {
    return EXTENDED_KEYS.has(key);
  }

  /**
   * Get all registered extended keys (for UI pickers, etc.)
   */
  static getExtendedKeys() {
    return [...EXTENDED_KEYS];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Utility: Read ACE QOL flags from an actor/effect
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if an actor has advantage on a specific save ability.
   * Checks all active effects for our advantage flags.
   */
  static hasAdvantage(actor, type, subtype) {
    // type = "attack" | "save" | "check"
    // subtype = "all" | "mwak" | "str" | "dex" etc.
    const allFlag = actor.getFlag(MODULE_ID, `advantage.${type}.all`);
    const specificFlag = actor.getFlag(MODULE_ID, `advantage.${type}.${subtype}`);
    return !!(allFlag || specificFlag);
  }

  /**
   * Check if an actor has disadvantage on a specific save/attack.
   */
  static hasDisadvantage(actor, type, subtype) {
    const allFlag = actor.getFlag(MODULE_ID, `disadvantage.${type}.all`);
    const specificFlag = actor.getFlag(MODULE_ID, `disadvantage.${type}.${subtype}`);
    return !!(allFlag || specificFlag);
  }

  /**
   * Check if an actor has magic resistance (advantage on saves vs spells).
   */
  static hasMagicResistance(actor) {
    return !!actor.getFlag(MODULE_ID, "magicResistance");
  }

  /**
   * Check if an actor has Evasion (DEX save success = 0 damage).
   */
  static hasSuperSaver(actor, ability = "dex") {
    return !!actor.getFlag(MODULE_ID, `superSaver.${ability}`);
  }

  /**
   * Check if an actor has Shield Master-style feature (DEX save = quarter damage).
   */
  static hasSemiSuperSaver(actor, ability = "dex") {
    return !!actor.getFlag(MODULE_ID, `semiSuperSaver.${ability}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug logging
  // ═══════════════════════════════════════════════════════════════════════════

  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | FX | ${msg}`);
      }
    } catch { /* settings not ready yet */ }
  }
}
