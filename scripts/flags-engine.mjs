// ─── ACE: QOL — Flags Engine + Optional Bonus Prompts ─────────────────────────
// General-purpose flags system that replaces Midi-QOL's flag architecture.
// Active Effects on actors/items set flags under `flags.ace-qol.*`, and this
// engine reads them at every roll point.
//
// Also provides an Optional Bonus Prompt system: when a roll happens and the
// actor has optional modifiers available (Bardic Inspiration, Lucky, Guided
// Strike, Precision Attack, etc.), a compact prompt appears for the player.
//
// Backward-compatible: reads BOTH `flags.ace-qol.*` AND `flags.midi-qol.*`
// so existing items with Midi-QOL flags continue to work without migration.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

// ─── Constants ──────────────────────────────────────────────────────────────
const MIDI_ID = "midi-qol";

/** All action types for attack rolls */
const ACTION_TYPES = ["mwak", "rwak", "msak", "rsak"];

/** All ability abbreviations for saves/checks */
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

/** Default timeout for optional prompts (ms) — overridden by setting */
const DEFAULT_PROMPT_TIMEOUT = 8000;

// ═══════════════════════════════════════════════════════════════════════════════
//  Part 1: General-Purpose Flags System
// ═══════════════════════════════════════════════════════════════════════════════

export class FlagsEngine {

  // ─────────────────────────────────────────────────────────────────────────
  //  Core flag reader — checks ace-qol first, falls back to midi-qol
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check whether ANY of the given flag paths are truthy on the actor.
   * Each path is tried under both MODULE_ID and MIDI_ID namespaces.
   *
   * @param {Actor} actor        - The actor to check flags on
   * @param {string[]} paths     - Flag paths relative to the module namespace
   *                               e.g. ["advantage.attack.all", "advantage.attack.mwak"]
   * @returns {boolean} true if any path is truthy under either namespace
   */
  static _checkFlag(actor, ...paths) {
    if (!actor) return false;

    // Check midi-qol compatibility setting — if disabled, skip midi-qol flags
    let midiCompat = true;
    try { midiCompat = game.settings.get(MODULE_ID, "midiCompatibility"); } catch { /* not registered yet */ }

    for (const path of paths) {
      // Check our flags first (highest priority)
      try {
        const val = actor.getFlag(MODULE_ID, path);
        if (val) return true;
      } catch { /* flag not set */ }

      // Fall back to midi-qol flags for backward compatibility
      if (midiCompat) {
        try {
          const val = actor.getFlag(MIDI_ID, path);
          if (val) return true;
        } catch { /* flag not set */ }
      }
    }
    return false;
  }

  /**
   * Read a flag value (not just truthy check) — returns first truthy value found.
   * Checks ace-qol first, then midi-qol.
   *
   * @param {Actor} actor   - The actor to read from
   * @param {string} path   - Flag path relative to module namespace
   * @returns {*} The flag value or undefined
   */
  static _readFlag(actor, path) {
    if (!actor) return undefined;

    try {
      const val = actor.getFlag(MODULE_ID, path);
      if (val !== undefined && val !== null) return val;
    } catch { /* not set */ }

    let midiCompat = true;
    try { midiCompat = game.settings.get(MODULE_ID, "midiCompatibility"); } catch (err) { console.warn("ace-qol | FlagsEngine._readFlag midiCompatibility setting read failed:", err); }
    if (midiCompat) {
      try {
        const val = actor.getFlag(MIDI_ID, path);
        if (val !== undefined && val !== null) return val;
      } catch { /* not set */ }
    }
    return undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Attack Roll Modifiers (attacker-side)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if an actor has advantage on attack rolls.
   * Checks both the "all" flag and the specific action-type flag.
   *
   * @param {Actor} actor       - The attacking actor
   * @param {string} actionType - "mwak", "rwak", "msak", or "rsak"
   * @returns {boolean}
   */
  static hasAttackAdvantage(actor, actionType) {
    return FlagsEngine._checkFlag(actor,
      "advantage.attack.all",
      `advantage.attack.${actionType}`
    );
  }

  /**
   * Check if an actor has disadvantage on attack rolls.
   *
   * @param {Actor} actor       - The attacking actor
   * @param {string} actionType - "mwak", "rwak", "msak", or "rsak"
   * @returns {boolean}
   */
  static hasAttackDisadvantage(actor, actionType) {
    return FlagsEngine._checkFlag(actor,
      "disadvantage.attack.all",
      `disadvantage.attack.${actionType}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Grants (target-side modifiers — the target grants these to attackers)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if a target grants advantage to attacks against it.
   * Used for effects like "Restrained" active effect with grants flag,
   * or custom "all attacks have advantage against this creature" effects.
   *
   * @param {Actor} targetActor - The target being attacked
   * @param {string} actionType - "mwak", "rwak", "msak", or "rsak"
   * @returns {boolean}
   */
  static grantsAttackAdvantage(targetActor, actionType) {
    return FlagsEngine._checkFlag(targetActor,
      "grants.advantage.attack.all",
      `grants.advantage.attack.${actionType}`
    );
  }

  /**
   * Check if a target grants disadvantage to attacks against it.
   * Used for effects like Blur, Protection from Evil/Good, etc.
   *
   * @param {Actor} targetActor - The target being attacked
   * @param {string} actionType - "mwak", "rwak", "msak", or "rsak"
   * @returns {boolean}
   */
  static grantsAttackDisadvantage(targetActor, actionType) {
    return FlagsEngine._checkFlag(targetActor,
      "grants.disadvantage.attack.all",
      `grants.disadvantage.attack.${actionType}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Critical Hit Modifiers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if an actor auto-crits on all or a specific action type.
   * Used for features that guarantee critical hits (not condition-based,
   * which are handled separately in CombatState).
   *
   * @param {Actor} actor       - The attacking actor
   * @param {string} actionType - "mwak", "rwak", "msak", or "rsak"
   * @returns {boolean}
   */
  static hasAutoCrit(actor, actionType) {
    return FlagsEngine._checkFlag(actor,
      "critical.all",
      `critical.${actionType}`
    );
  }

  /**
   * Check if a target prevents critical hits against it.
   * Used for Adamantine Armor ("noCritical" flag) and similar effects.
   *
   * @param {Actor} targetActor - The target being attacked
   * @param {string} actionType - "mwak", "rwak", "msak", or "rsak"
   * @returns {boolean}
   */
  static preventsCritical(targetActor, actionType) {
    return FlagsEngine._checkFlag(targetActor,
      "noCritical.all",
      `noCritical.${actionType}`
    );
  }

  /**
   * Check if a target grants auto-crit to attackers.
   * Used for Paralyzed-within-5ft or similar generic flags.
   *
   * @param {Actor} targetActor - The target
   * @param {string} actionType - "mwak", "rwak", "msak", or "rsak"
   * @returns {boolean}
   */
  static grantsAutoCrit(targetActor, actionType) {
    return FlagsEngine._checkFlag(targetActor,
      "grants.critical.all",
      `grants.critical.${actionType}`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Saving Throw Modifiers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if an actor has advantage on a saving throw.
   *
   * @param {Actor} actor    - The actor making the save
   * @param {string} ability - "str", "dex", "con", "int", "wis", "cha"
   * @returns {boolean}
   */
  static hasSaveAdvantage(actor, ability) {
    return FlagsEngine._checkFlag(actor,
      "advantage.ability.save.all",
      `advantage.ability.save.${ability}`,
      // Also check the shorter path format used by ExtendedEffects
      "advantage.save.all",
      `advantage.save.${ability}`
    );
  }

  /**
   * Check if an actor has disadvantage on a saving throw.
   *
   * @param {Actor} actor    - The actor making the save
   * @param {string} ability - "str", "dex", "con", "int", "wis", "cha"
   * @returns {boolean}
   */
  static hasSaveDisadvantage(actor, ability) {
    return FlagsEngine._checkFlag(actor,
      "disadvantage.ability.save.all",
      `disadvantage.ability.save.${ability}`,
      "disadvantage.save.all",
      `disadvantage.save.${ability}`
    );
  }

  /**
   * Check if an actor auto-fails a saving throw.
   * Used for conditions that cause automatic save failure
   * (set via Active Effects, not condition detection which is separate).
   *
   * @param {Actor} actor    - The actor making the save
   * @param {string} ability - "str", "dex", "con", "int", "wis", "cha"
   * @returns {boolean}
   */
  static autoFailsSave(actor, ability) {
    return FlagsEngine._checkFlag(actor,
      "fail.ability.save.all",
      `fail.ability.save.${ability}`
    );
  }

  /**
   * Check if an actor has Magic Resistance (advantage on saves vs spells).
   *
   * @param {Actor} actor - The actor to check
   * @returns {boolean}
   */
  static hasMagicResistance(actor) {
    return FlagsEngine._checkFlag(actor, "magicResistance");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Ability Check / Skill Check Modifiers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if an actor has advantage on ability checks.
   * @param {Actor} actor    - The actor making the check
   * @param {string} ability - "str", "dex", "con", "int", "wis", "cha"
   * @returns {boolean}
   */
  static hasAbilityCheckAdvantage(actor, ability) {
    return FlagsEngine._checkFlag(actor,
      "advantage.ability.check.all",
      `advantage.ability.check.${ability}`
    );
  }

  /**
   * Check if an actor has disadvantage on ability checks.
   * @param {Actor} actor    - The actor making the check
   * @param {string} ability - "str", "dex", "con", "int", "wis", "cha"
   * @returns {boolean}
   */
  static hasAbilityCheckDisadvantage(actor, ability) {
    return FlagsEngine._checkFlag(actor,
      "disadvantage.ability.check.all",
      `disadvantage.ability.check.${ability}`
    );
  }

  /**
   * Check if an actor has advantage on a specific skill check.
   * Checks skill-specific flag first, then falls back to the ability's check flags.
   * @param {Actor} actor    - The actor making the check
   * @param {string} skill   - Skill id (e.g., "ste", "per", "ath", "acr")
   * @param {string} ability - The ability used for this skill
   * @returns {boolean}
   */
  static hasSkillAdvantage(actor, skill, ability) {
    if (FlagsEngine._checkFlag(actor, `advantage.skill.all`, `advantage.skill.${skill}`)) return true;
    return FlagsEngine.hasAbilityCheckAdvantage(actor, ability);
  }

  /**
   * Check if an actor has disadvantage on a specific skill check.
   * @param {Actor} actor    - The actor making the check
   * @param {string} skill   - Skill id
   * @param {string} ability - The ability used for this skill
   * @returns {boolean}
   */
  static hasSkillDisadvantage(actor, skill, ability) {
    if (FlagsEngine._checkFlag(actor, `disadvantage.skill.all`, `disadvantage.skill.${skill}`)) return true;
    return FlagsEngine.hasAbilityCheckDisadvantage(actor, ability);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Roll Hook Registration — ability checks, skill checks, tool checks
  //  Hooks into dnd5e's pre-roll hooks to inject advantage/disadvantage
  //  from Active Effect flags.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register dnd5e roll hooks for ability checks, skill checks, and tool checks.
   * Called once from ace-qol.mjs ready hook.
   */
  static registerRollHooks() {
    // ── Ability Checks ──
    // dnd5e v3.x uses preRollAbilityCheckV2, older versions use preRollAbilityCheck
    Hooks.on("dnd5e.preRollAbilityCheckV2", (config, dialog, message) => {
      FlagsEngine._onPreRollAbilityCheck(config, dialog);
    });
    Hooks.on("dnd5e.preRollAbilityCheck", (actor, config, abilityId) => {
      FlagsEngine._onPreRollAbilityCheckLegacy(actor, config, abilityId);
    });

    // ── Skill Checks ──
    Hooks.on("dnd5e.preRollSkillV2", (config, dialog, message) => {
      FlagsEngine._onPreRollSkill(config, dialog);
    });
    Hooks.on("dnd5e.preRollSkill", (actor, config, skillId) => {
      FlagsEngine._onPreRollSkillLegacy(actor, config, skillId);
    });

    // ── Tool Checks ──
    Hooks.on("dnd5e.preRollToolCheckV2", (config, dialog, message) => {
      FlagsEngine._onPreRollToolCheck(config, dialog);
    });
    Hooks.on("dnd5e.preRollToolCheck", (actor, config, toolId) => {
      FlagsEngine._onPreRollToolCheckLegacy(actor, config, toolId);
    });

    console.debug(`${MODULE_ID} | FlagsEngine: ability/skill/tool check hooks registered`);
  }

  /**
   * dnd5e v3.x ability check hook handler.
   * config.rolls[0].options.advantageMode controls advantage: 1=adv, -1=dis, 0=normal
   * @private
   */
  static _onPreRollAbilityCheck(config, dialog) {
    try {
      if (!game.settings.get(MODULE_ID, "enableFlagsSystem")) return;
    } catch { return; }

    const actor = config.subject?.parent ?? config.actor;
    const ability = config.ability ?? config.rolls?.[0]?.options?.ability;
    if (!actor || !ability) return;

    const hasAdv = FlagsEngine.hasAbilityCheckAdvantage(actor, ability);
    const hasDis = FlagsEngine.hasAbilityCheckDisadvantage(actor, ability);

    if (hasAdv || hasDis) {
      FlagsEngine._applyAdvantageMode(config, hasAdv, hasDis, `ability check (${ability})`);
    }
  }

  /** Legacy (dnd5e v12) ability check hook. @private */
  static _onPreRollAbilityCheckLegacy(actor, config, abilityId) {
    try {
      if (!game.settings.get(MODULE_ID, "enableFlagsSystem")) return;
    } catch { return; }
    if (!actor || !abilityId) return;

    const hasAdv = FlagsEngine.hasAbilityCheckAdvantage(actor, abilityId);
    const hasDis = FlagsEngine.hasAbilityCheckDisadvantage(actor, abilityId);

    if (hasAdv && !hasDis) config.advantage = true;
    else if (hasDis && !hasAdv) config.disadvantage = true;
  }

  /** dnd5e v3.x skill check hook. @private */
  static _onPreRollSkill(config, dialog) {
    try {
      if (!game.settings.get(MODULE_ID, "enableFlagsSystem")) return;
    } catch { return; }

    const actor = config.subject?.parent ?? config.actor;
    const skill = config.skill ?? config.rolls?.[0]?.options?.skill;
    const ability = config.ability ?? config.rolls?.[0]?.options?.ability;
    if (!actor || !skill) return;

    const hasAdv = FlagsEngine.hasSkillAdvantage(actor, skill, ability ?? "");
    const hasDis = FlagsEngine.hasSkillDisadvantage(actor, skill, ability ?? "");

    if (hasAdv || hasDis) {
      FlagsEngine._applyAdvantageMode(config, hasAdv, hasDis, `skill check (${skill})`);
    }
  }

  /** Legacy (dnd5e v12) skill check hook. @private */
  static _onPreRollSkillLegacy(actor, config, skillId) {
    try {
      if (!game.settings.get(MODULE_ID, "enableFlagsSystem")) return;
    } catch { return; }
    if (!actor || !skillId) return;

    // Get the ability for this skill from dnd5e config
    const ability = CONFIG.DND5E?.skills?.[skillId]?.ability ?? "";
    const hasAdv = FlagsEngine.hasSkillAdvantage(actor, skillId, ability);
    const hasDis = FlagsEngine.hasSkillDisadvantage(actor, skillId, ability);

    if (hasAdv && !hasDis) config.advantage = true;
    else if (hasDis && !hasAdv) config.disadvantage = true;
  }

  /** dnd5e v3.x tool check hook. Treated as an ability check with the tool's ability. @private */
  static _onPreRollToolCheck(config, dialog) {
    try {
      if (!game.settings.get(MODULE_ID, "enableFlagsSystem")) return;
    } catch { return; }

    const actor = config.subject?.parent ?? config.actor;
    const ability = config.ability ?? config.rolls?.[0]?.options?.ability;
    if (!actor || !ability) return;

    // Tool checks use the same ability check flags
    const hasAdv = FlagsEngine.hasAbilityCheckAdvantage(actor, ability);
    const hasDis = FlagsEngine.hasAbilityCheckDisadvantage(actor, ability);

    if (hasAdv || hasDis) {
      FlagsEngine._applyAdvantageMode(config, hasAdv, hasDis, `tool check (${ability})`);
    }
  }

  /** Legacy (dnd5e v12) tool check hook. @private */
  static _onPreRollToolCheckLegacy(actor, config, toolId) {
    try {
      if (!game.settings.get(MODULE_ID, "enableFlagsSystem")) return;
    } catch { return; }
    if (!actor) return;

    const ability = config.ability ?? "";
    const hasAdv = FlagsEngine.hasAbilityCheckAdvantage(actor, ability);
    const hasDis = FlagsEngine.hasAbilityCheckDisadvantage(actor, ability);

    if (hasAdv && !hasDis) config.advantage = true;
    else if (hasDis && !hasAdv) config.disadvantage = true;
  }

  /**
   * Apply advantage/disadvantage mode to a dnd5e v3.x roll config.
   * dnd5e v3.x uses config.rolls[0].options.advantageMode: 1=adv, -1=dis, 0=normal
   * @private
   */
  static _applyAdvantageMode(config, hasAdv, hasDis, label) {
    // If both → they cancel out → normal (don't override existing state)
    if (hasAdv && hasDis) return;

    const mode = hasAdv ? 1 : -1;

    // v3.x format: config.rolls array
    if (config.rolls?.length) {
      for (const roll of config.rolls) {
        const opts = roll.options ?? (roll.options = {});
        // Don't downgrade existing advantage/disadvantage — only upgrade
        const current = opts.advantageMode ?? 0;
        if (hasAdv && current < 1) opts.advantageMode = 1;
        else if (hasDis && current > -1) opts.advantageMode = -1;
      }
      return;
    }

    // Fallback: direct config properties
    if (hasAdv) config.advantage = true;
    else if (hasDis) config.disadvantage = true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Damage Modifiers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if actor has minimum damage flag (e.g., Great Weapon Fighting rerolls).
   * Returns the minimum threshold or false.
   *
   * @param {Actor} actor       - The actor dealing damage
   * @param {string} actionType - "mwak", "rwak", "msak", "rsak"
   * @returns {number|false} The minimum value, or false if not set
   */
  static getMinDamage(actor, actionType) {
    const all = FlagsEngine._readFlag(actor, "min.damage.all");
    const specific = FlagsEngine._readFlag(actor, `min.damage.${actionType}`);
    const val = specific ?? all;
    return val ? Number(val) : false;
  }

  /**
   * Check if actor has maximize damage flag (e.g., Overchannel).
   *
   * @param {Actor} actor       - The actor dealing damage
   * @param {string} actionType - "mwak", "rwak", "msak", "rsak"
   * @returns {boolean}
   */
  static getMaxDamage(actor, actionType) {
    return FlagsEngine._checkFlag(actor,
      "max.damage.all",
      `max.damage.${actionType}`
    );
  }

  /**
   * Get flat bonus damage from flags.
   * Returns the bonus formula string or null.
   *
   * @param {Actor} actor       - The actor dealing damage
   * @param {string} actionType - "mwak", "rwak", "msak", "rsak"
   * @returns {string|null} Bonus damage formula, or null
   */
  static getBonusDamage(actor, actionType) {
    const specific = FlagsEngine._readFlag(actor, `bonusDamage.${actionType}`);
    if (specific) return String(specific);
    const all = FlagsEngine._readFlag(actor, "bonusDamage.all");
    if (all) return String(all);
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Special Features (formalized flags)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Sculpt Spells (Evocation Wizard) — allies auto-succeed AoE saves, take 0 damage.
   * @param {Actor} actor - The caster
   * @returns {boolean}
   */
  static hasSculptSpell(actor) {
    return FlagsEngine._checkFlag(actor, "sculptSpell");
  }

  /**
   * Careful Spell (Sorcerer Metamagic) — chosen creatures auto-succeed save.
   * @param {Actor} actor - The caster
   * @returns {boolean}
   */
  static hasCarefulSpell(actor) {
    return FlagsEngine._checkFlag(actor, "carefulSpell");
  }

  /**
   * Evasion — DEX save success = 0 damage, fail = half damage.
   * @param {Actor} actor - The actor to check
   * @returns {boolean}
   */
  static hasEvasion(actor) {
    return FlagsEngine._checkFlag(actor, "superSaver.dex");
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Enabled check — respects the master toggle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if the flags system is enabled.
   * @returns {boolean}
   */
  static get enabled() {
    try { return game.settings.get(MODULE_ID, "enableFlagsSystem"); }
    catch (err) { console.warn("ace-qol | FlagsEngine.enabled setting read failed:", err); return true; }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  Part 2: Optional Bonus Prompts
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Scan an actor for all available optional bonus flags.
   * Returns an array of optional bonus descriptors, each with:
   *   { name, label, formula, rollType, count, countPath }
   *
   * @param {Actor} actor     - The actor to scan
   * @param {string} rollType - "attack", "damage", "save", or "check"
   * @param {string} [subtype] - For attacks: "mwak"/"rwak"/etc. For saves: "str"/"dex"/etc.
   * @returns {object[]} Available optional bonuses
   */
  static getAvailableOptionals(actor, rollType, subtype = null) {
    if (!actor) return [];

    // Check if optional prompts are enabled
    try {
      if (!game.settings.get(MODULE_ID, "enableOptionalPrompts")) return [];
    } catch { /* setting not registered, allow */ }

    const results = [];

    // Scan both ace-qol and midi-qol optional flags
    const namespaces = [MODULE_ID];
    let midiCompat = true;
    try { midiCompat = game.settings.get(MODULE_ID, "midiCompatibility"); } catch (err) { console.warn("ace-qol | FlagsEngine.getAvailableOptionals midiCompatibility setting read failed:", err); }
    if (midiCompat) namespaces.push(MIDI_ID);

    for (const ns of namespaces) {
      const optionalRoot = actor.flags?.[ns]?.optional;
      if (!optionalRoot || typeof optionalRoot !== "object") continue;

      for (const [name, data] of Object.entries(optionalRoot)) {
        if (!data || typeof data !== "object") continue;

        // Check if this optional has a formula for the requested roll type
        let formula = data[rollType] ?? null;

        // For skills, check skill-specific key: optional.NAME.skill.perception
        if (rollType === "check" && subtype && data.skill?.[subtype]) {
          formula = data.skill[subtype];
        }

        if (!formula) continue;

        // Check uses remaining
        const count = data.count;
        if (count !== undefined && count !== null && count !== "each-turn") {
          const numCount = Number(count);
          if (!isNaN(numCount) && numCount <= 0) continue; // exhausted
        }

        // Build the descriptor
        results.push({
          name,
          namespace: ns,
          label: data.label || FlagsEngine._humanize(name),
          formula: String(formula),
          rollType,
          count: data.count,
          countPath: `optional.${name}.count`,
          isReroll: String(formula).toLowerCase() === "reroll",
        });
      }
    }

    return results;
  }

  /**
   * Show the optional bonus prompt dialog to the player.
   * Displays all available optionals for this roll and lets the player
   * choose which ones to activate.
   *
   * @param {Actor} actor          - The actor who owns the optionals
   * @param {object[]} optionals   - Available optionals from getAvailableOptionals()
   * @param {object} rollContext    - { rollTotal, rollType, d20Result, formula }
   * @returns {Promise<object[]>} Selected optionals, each with { name, formula, rolled, total }
   */
  static async showOptionalPrompt(actor, optionals, rollContext = {}) {
    if (!optionals.length) return [];

    const timeout = FlagsEngine._getPromptTimeout();
    const { rollTotal = 0, rollType = "attack", d20Result = null } = rollContext;
    const rollTypeLabel = rollType.charAt(0).toUpperCase() + rollType.slice(1);

    // ── Build dialog HTML ──────────────────────────────────────────────
    let html = `<div class="ace-qol-optional-prompt">`;

    // Current roll display
    html += `<div class="ace-qol-optional-current">`;
    html += `<span class="ace-qol-optional-current-label">${rollTypeLabel} Roll</span>`;
    html += `<span class="ace-qol-optional-current-total">${rollTotal}</span>`;
    html += `</div>`;

    // Each optional as a row
    for (let i = 0; i < optionals.length; i++) {
      const opt = optionals[i];
      const countDisplay = opt.count === "each-turn" ? "1/turn"
                         : (opt.count !== undefined && opt.count !== null)
                           ? `${opt.count} left`
                           : "";
      const formulaDisplay = opt.isReroll ? "Reroll d20" : `+ ${opt.formula}`;

      html += `<div class="ace-qol-optional-row" data-index="${i}">`;
      html += `  <div class="ace-qol-optional-info">`;
      html += `    <span class="ace-qol-optional-label">${opt.label}</span>`;
      html += `    <span class="ace-qol-optional-formula">${formulaDisplay}</span>`;
      if (countDisplay) {
        html += `  <span class="ace-qol-optional-count">${countDisplay}</span>`;
      }
      html += `  </div>`;
      html += `  <div class="ace-qol-optional-buttons">`;
      html += `    <button class="ace-qol-optional-yes" data-index="${i}"><i class="fas fa-check"></i> Use</button>`;
      html += `    <button class="ace-qol-optional-no" data-index="${i}"><i class="fas fa-xmark"></i> Skip</button>`;
      html += `  </div>`;
      html += `</div>`;
    }

    // Timeout bar
    html += `<div class="ace-qol-optional-timer">`;
    html += `  <div class="ace-qol-optional-timer-bar"></div>`;
    html += `</div>`;

    // Dismiss all
    html += `<div class="ace-qol-optional-dismiss">`;
    html += `  <button class="ace-qol-optional-dismiss-all"><i class="fas fa-forward"></i> Skip All</button>`;
    html += `</div>`;

    html += `</div>`;

    // ── Show dialog and collect results ────────────────────────────────
    return new Promise((resolve) => {
      // Guard against double-resolve
      let resolved = false;
      const safeResolve = (val) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      const selected = new Map(); // index → true/false
      let dialog = null;

      // Auto-decline after timeout
      const timer = setTimeout(() => {
        FlagsEngine._debug("Optional prompt timed out — auto-declining all");
        safeResolve([]);
        if (dialog) dialog.close();
      }, timeout);

      dialog = new Dialog({
        title: `${rollTypeLabel} Bonuses Available`,
        content: html,
        buttons: {},
        render: (jq) => {
          const el = jq[0] ?? jq;

          // Start the timeout bar animation
          const timerBar = el.querySelector(".ace-qol-optional-timer-bar");
          if (timerBar) {
            timerBar.style.transition = `width ${timeout}ms linear`;
            requestAnimationFrame(() => { timerBar.style.width = "0%"; });
          }

          // Wire "Use" buttons
          el.querySelectorAll(".ace-qol-optional-yes").forEach(btn => {
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              const idx = Number(btn.dataset.index);
              selected.set(idx, true);
              // Visual feedback
              const row = btn.closest(".ace-qol-optional-row");
              if (row) {
                row.classList.add("ace-qol-optional-accepted");
                row.querySelectorAll("button").forEach(b => b.disabled = true);
              }
              // Check if all have been decided
              if (selected.size === optionals.length) {
                clearTimeout(timer);
                FlagsEngine._resolveOptionals(actor, optionals, selected).then(safeResolve);
                dialog.close();
              }
            });
          });

          // Wire "Skip" buttons
          el.querySelectorAll(".ace-qol-optional-no").forEach(btn => {
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              const idx = Number(btn.dataset.index);
              selected.set(idx, false);
              const row = btn.closest(".ace-qol-optional-row");
              if (row) {
                row.classList.add("ace-qol-optional-declined");
                row.querySelectorAll("button").forEach(b => b.disabled = true);
              }
              if (selected.size === optionals.length) {
                clearTimeout(timer);
                FlagsEngine._resolveOptionals(actor, optionals, selected).then(safeResolve);
                dialog.close();
              }
            });
          });

          // Wire "Skip All" button
          const dismissBtn = el.querySelector(".ace-qol-optional-dismiss-all");
          if (dismissBtn) {
            dismissBtn.addEventListener("click", (e) => {
              e.preventDefault();
              clearTimeout(timer);
              safeResolve([]);
              dialog.close();
            });
          }
        },
        close: () => {
          clearTimeout(timer);
          // If dialog closed without resolving (X button, escape, etc.), decline all
          safeResolve([]);
        },
      }, {
        width: 380,
        classes: ["ace-qol-dialog", "ace-qol-optional-dialog"],
      });

      dialog.render(true);
    });
  }

  /**
   * Process selected optionals: roll formulas, decrement counts, return results.
   *
   * @param {Actor} actor          - The actor
   * @param {object[]} optionals   - Full optionals array
   * @param {Map<number,boolean>} selected - Map of index → accepted
   * @returns {Promise<object[]>} Results for accepted optionals
   */
  static async _resolveOptionals(actor, optionals, selected) {
    const results = [];

    for (const [idx, accepted] of selected) {
      if (!accepted) continue;
      const opt = optionals[idx];
      if (!opt) continue;

      let rolled = null;
      let total = 0;

      if (opt.isReroll) {
        // Special: reroll the d20 — caller handles picking higher
        try {
          const reroll = new Roll("1d20");
          await reroll.evaluate();
          rolled = reroll;
          total = reroll.total;
        } catch (err) {
          console.error(`${MODULE_ID} | Optional reroll failed:`, err);
          continue;
        }
      } else {
        // Roll the bonus formula
        try {
          const bonusRoll = new Roll(opt.formula);
          await bonusRoll.evaluate();
          rolled = bonusRoll;
          total = bonusRoll.total;
        } catch (err) {
          console.error(`${MODULE_ID} | Optional bonus roll failed for "${opt.formula}":`, err);
          continue;
        }
      }

      // Decrement uses
      await FlagsEngine._decrementOptionalCount(actor, opt);

      results.push({
        name: opt.name,
        label: opt.label,
        formula: opt.formula,
        isReroll: opt.isReroll,
        rolled,
        total,
      });

      FlagsEngine._debug(`Optional "${opt.label}" used: ${opt.isReroll ? "reroll" : "+"} ${total}`);
    }

    return results;
  }

  /**
   * Decrement the count for an optional bonus after use.
   * Handles numeric counts and "each-turn" (no decrement needed for each-turn,
   * as that resets automatically via the combat turn system).
   *
   * @param {Actor} actor - The actor
   * @param {object} opt  - The optional descriptor
   */
  static async _decrementOptionalCount(actor, opt) {
    if (opt.count === "each-turn" || opt.count === undefined || opt.count === null) return;

    const currentCount = Number(opt.count);
    if (isNaN(currentCount) || currentCount <= 0) return;

    const newCount = currentCount - 1;

    try {
      // Update the flag on the actor
      await actor.setFlag(opt.namespace, opt.countPath, newCount);
      FlagsEngine._debug(`Decremented ${opt.label} count: ${currentCount} → ${newCount}`);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to decrement optional count for "${opt.name}":`, err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Optional Bonus Integration Points
  //  These are called from the attack pipeline, save engine, etc.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check and prompt for optional attack bonuses after an attack roll.
   * Called from AttackPipeline after the d20 is rolled.
   *
   * @param {Actor} actor        - The attacking actor
   * @param {string} actionType  - "mwak", "rwak", "msak", "rsak"
   * @param {number} rollTotal   - The current attack total
   * @param {number} d20Result   - The natural d20 result
   * @returns {Promise<{newTotal: number, bonuses: object[]}>}
   */
  static async checkAttackOptionals(actor, actionType, rollTotal, d20Result) {
    const optionals = FlagsEngine.getAvailableOptionals(actor, "attack", actionType);
    if (!optionals.length) return { newTotal: rollTotal, bonuses: [] };

    const bonuses = await FlagsEngine.showOptionalPrompt(actor, optionals, {
      rollTotal,
      rollType: "attack",
      d20Result,
    });

    let newTotal = rollTotal;
    for (const b of bonuses) {
      if (b.isReroll) {
        // For reroll (Lucky): the player picks the higher d20, then we
        // recalculate the total. The difference from the original d20 is applied.
        // Caller must handle the d20 swap logic.
      } else {
        newTotal += b.total;
      }
    }

    return { newTotal, bonuses };
  }

  /**
   * Check and prompt for optional save bonuses after a saving throw.
   *
   * @param {Actor} actor     - The actor making the save
   * @param {string} ability  - "str", "dex", "con", "int", "wis", "cha"
   * @param {number} rollTotal - The current save total
   * @returns {Promise<{newTotal: number, bonuses: object[]}>}
   */
  static async checkSaveOptionals(actor, ability, rollTotal) {
    const optionals = FlagsEngine.getAvailableOptionals(actor, "save", ability);
    if (!optionals.length) return { newTotal: rollTotal, bonuses: [] };

    const bonuses = await FlagsEngine.showOptionalPrompt(actor, optionals, {
      rollTotal,
      rollType: "save",
    });

    let newTotal = rollTotal;
    for (const b of bonuses) {
      if (!b.isReroll) newTotal += b.total;
    }

    return { newTotal, bonuses };
  }

  /**
   * Check and prompt for optional damage bonuses after a damage roll.
   *
   * @param {Actor} actor        - The actor dealing damage
   * @param {string} actionType  - "mwak", "rwak", "msak", "rsak"
   * @param {number} rollTotal   - The current damage total
   * @returns {Promise<{newTotal: number, bonuses: object[]}>}
   */
  static async checkDamageOptionals(actor, actionType, rollTotal) {
    const optionals = FlagsEngine.getAvailableOptionals(actor, "damage", actionType);
    if (!optionals.length) return { newTotal: rollTotal, bonuses: [] };

    const bonuses = await FlagsEngine.showOptionalPrompt(actor, optionals, {
      rollTotal,
      rollType: "damage",
    });

    let newTotal = rollTotal;
    for (const b of bonuses) {
      if (!b.isReroll) newTotal += b.total;
    }

    return { newTotal, bonuses };
  }

  /**
   * Check and prompt for optional ability check bonuses.
   *
   * @param {Actor} actor      - The actor making the check
   * @param {string} ability   - "str", "dex", etc.
   * @param {number} rollTotal - The current check total
   * @param {string} [skill]   - Optional skill name for skill-specific bonuses
   * @returns {Promise<{newTotal: number, bonuses: object[]}>}
   */
  static async checkAbilityOptionals(actor, ability, rollTotal, skill = null) {
    const optionals = FlagsEngine.getAvailableOptionals(actor, "check", skill || ability);
    if (!optionals.length) return { newTotal: rollTotal, bonuses: [] };

    const bonuses = await FlagsEngine.showOptionalPrompt(actor, optionals, {
      rollTotal,
      rollType: "check",
    });

    let newTotal = rollTotal;
    for (const b of bonuses) {
      if (!b.isReroll) newTotal += b.total;
    }

    return { newTotal, bonuses };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Socket-based prompts for correct player routing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Route an optional prompt to the correct player via socket.
   * If the actor is owned by the current user, show locally.
   * Otherwise, send a socket message to the owning player.
   *
   * @param {Actor} actor        - The actor
   * @param {string} rollType    - "attack", "damage", "save", "check"
   * @param {string} subtype     - Action type or ability
   * @param {number} rollTotal   - Current roll total
   * @param {number} [d20Result] - Natural d20 result (for attacks)
   * @returns {Promise<{newTotal: number, bonuses: object[]}>}
   */
  static async routeOptionalPrompt(actor, rollType, subtype, rollTotal, d20Result = null) {
    if (!FlagsEngine.enabled) return { newTotal: rollTotal, bonuses: [] };

    const optionals = FlagsEngine.getAvailableOptionals(actor, rollType, subtype);
    if (!optionals.length) return { newTotal: rollTotal, bonuses: [] };

    // Determine the owning user
    const ownerUser = FlagsEngine._getActorOwner(actor);

    // If we ARE the owner (or GM controlling an NPC), show locally
    if (!ownerUser || ownerUser.id === game.user.id) {
      return FlagsEngine._dispatchLocalPrompt(actor, rollType, subtype, rollTotal, d20Result);
    }

    // Otherwise, route via socket to the owning player
    // The socket handler on the player's client will show the prompt
    // and send the result back via socket.
    return FlagsEngine._dispatchSocketPrompt(actor, ownerUser, rollType, subtype, rollTotal, d20Result);
  }

  /**
   * Show the optional prompt locally (current client).
   * @private
   */
  static async _dispatchLocalPrompt(actor, rollType, subtype, rollTotal, d20Result) {
    switch (rollType) {
      case "attack":  return FlagsEngine.checkAttackOptionals(actor, subtype, rollTotal, d20Result);
      case "damage":  return FlagsEngine.checkDamageOptionals(actor, subtype, rollTotal);
      case "save":    return FlagsEngine.checkSaveOptionals(actor, subtype, rollTotal);
      case "check":   return FlagsEngine.checkAbilityOptionals(actor, subtype, rollTotal);
      default:        return { newTotal: rollTotal, bonuses: [] };
    }
  }

  /**
   * Send an optional prompt request to a specific player via socket.
   * Returns a promise that resolves when the player responds.
   * @private
   */
  static _dispatchSocketPrompt(actor, ownerUser, rollType, subtype, rollTotal, d20Result) {
    return new Promise((resolve) => {
      const requestId = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timeout = FlagsEngine._getPromptTimeout();

      // Timeout fallback — auto-decline if player doesn't respond
      const timer = setTimeout(() => {
        FlagsEngine._pendingPrompts.delete(requestId);
        FlagsEngine._debug(`Socket optional prompt timed out for ${actor.name} (${requestId})`);
        resolve({ newTotal: rollTotal, bonuses: [] });
      }, timeout + 2000); // Add 2s buffer for network latency

      // Store the pending request so the socket handler can resolve it
      FlagsEngine._pendingPrompts.set(requestId, { resolve, timer, rollTotal });

      // Send to the owning player
      const socketName = `module.${MODULE_ID}`;
      game.socket.emit(socketName, {
        action: "showOptionalPrompt",
        requestId,
        userId: ownerUser.id,
        actorId: actor.id,
        rollType,
        subtype,
        rollTotal,
        d20Result,
      });

      FlagsEngine._debug(`Sent optional prompt to ${ownerUser.name} for ${actor.name} (${requestId})`);
    });
  }

  /**
   * Handle incoming socket messages for the optional prompt system.
   * Called from the main ace-qol.mjs socket setup.
   *
   * @param {object} payload - Socket message payload
   */
  static async handleSocketMessage(payload) {
    if (!payload?.action) return;

    // ── Player side: GM asks us to show an optional prompt ──
    if (payload.action === "showOptionalPrompt" && payload.userId === game.user.id) {
      const actor = game.actors.get(payload.actorId);
      if (!actor) return;

      FlagsEngine._debug(`Received optional prompt request for ${actor.name} (${payload.requestId})`);

      const result = await FlagsEngine._dispatchLocalPrompt(
        actor, payload.rollType, payload.subtype, payload.rollTotal, payload.d20Result
      );

      // Send result back to GM
      const socketName = `module.${MODULE_ID}`;
      game.socket.emit(socketName, {
        action: "optionalPromptResult",
        requestId: payload.requestId,
        newTotal: result.newTotal,
        bonuses: result.bonuses.map(b => ({
          name: b.name,
          label: b.label,
          formula: b.formula,
          isReroll: b.isReroll,
          total: b.total,
        })),
      });
      return;
    }

    // ── GM side: player responds to our optional prompt ──
    if (payload.action === "optionalPromptResult") {
      const pending = FlagsEngine._pendingPrompts.get(payload.requestId);
      if (!pending) return;

      clearTimeout(pending.timer);
      FlagsEngine._pendingPrompts.delete(payload.requestId);

      FlagsEngine._debug(`Received optional prompt result (${payload.requestId}): +${payload.newTotal - pending.rollTotal}`);
      pending.resolve({
        newTotal: payload.newTotal,
        bonuses: payload.bonuses ?? [],
      });
      return;
    }
  }

  /** Pending socket prompts waiting for player responses (GM side) */
  static _pendingPrompts = new Map();

  // ─────────────────────────────────────────────────────────────────────────
  //  Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the primary owning user for an actor (first non-GM owner, or GM).
   * @param {Actor} actor
   * @returns {User|null}
   */
  static _getActorOwner(actor) {
    if (!actor) return null;

    // Check for an active non-GM owner first (player-owned characters)
    for (const user of game.users) {
      if (user.isGM || !user.active) continue;
      if (actor.testUserPermission(user, "OWNER")) return user;
    }

    // Fall back to GM
    return game.user.isGM ? game.user : null;
  }

  /**
   * Convert a camelCase flag name to a human-readable label.
   * "bardicInspiration" → "Bardic Inspiration"
   * @param {string} name
   * @returns {string}
   */
  static _humanize(name) {
    return name
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, s => s.toUpperCase())
      .trim();
  }

  /**
   * Get the prompt timeout from settings (in milliseconds).
   * @returns {number}
   */
  static _getPromptTimeout() {
    try {
      return (game.settings.get(MODULE_ID, "optionalPromptTimeout") ?? 8) * 1000;
    } catch {
      return DEFAULT_PROMPT_TIMEOUT;
    }
  }

  /**
   * Debug logging — only when debug mode is on.
   * @param {string} msg
   */
  static _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | FLAGS | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}
