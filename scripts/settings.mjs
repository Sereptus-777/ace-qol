// ─── ACE: QOL — Settings Registration ─────────────────────────────────────────
// Everything ON by default. Toggle OFF if you want.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class QolSettings {

  static register() {
    const s = (key, opts) => game.settings.register(MODULE_ID, key, opts);

    // ═══════════════════════════════════════════════════════════════════════════
    //  COMBAT WORKFLOW — all ON by default
    // ═══════════════════════════════════════════════════════════════════════════

    s("autoCheckHit", {
      name:    "Auto-Check Hit vs AC",
      hint:    "Automatically compare attack rolls against target AC, factoring in cover, conditions, and buffs.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("autoTargetTemplates", {
      name:    "Auto-Target Tokens in Templates",
      hint:    "When a measured template is placed (Fireball, Moonbeam, etc.), automatically target all tokens inside it.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("damageTypeSeparation", {
      name:    "Separate Damage by Type",
      hint:    "Roll and display each damage type separately (slashing, cold, fire, etc.) so resistances apply per type.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("autoCheckResistances", {
      name:    "Check Resistances/Immunities",
      hint:    "Automatically check target resistances, immunities, and vulnerabilities for each damage type.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("halfDamageOnSave", {
      name:    "Half Damage on Save",
      hint:    "Automatically detect 'half damage on save' from spell descriptions and apply accordingly.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("concentrationTracking", {
      name:    "Concentration Tracking",
      hint:    "Track concentration spells, prompt saves on damage, remove effects when concentration breaks.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("concentrationWidget", {
      name:    "Floating Concentration Widget",
      hint:    "Show a persistent floating card for active concentration spells with Re-apply Damage button.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("batchResultsCard", {
      name:    "Batch Combat Results Card",
      hint:    "Show all targets in one consolidated damage card instead of individual cards per target.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("targetStateAssessment", {
      name:    "Full Target State Assessment",
      hint:    "Assess every condition, buff, resistance, creature type, and modifier on every target before damage.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("slayerAutoDetect", {
      name:    "Slayer Weapon Auto-Detect",
      hint:    "Automatically detect Slayer weapons (Giant Slayer, Dragon Slayer) and apply bonus damage vs matching creature types.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("flanking", {
      name:    "Flanking (Optional Rule)",
      hint:    "Melee attackers get advantage when an ally is on the opposite side of the target. Uses the line-through method — a line from attacker through target must reach an ally.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    s("autoApplyConditions", {
      name:    "Auto-Apply Conditions",
      hint:    "Automatically apply conditions (prone, grappled, restrained, etc.) to targets when they fail saves. When OFF, conditions show in the results card but must be applied manually.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  CRITICAL HIT RULES
    // ═══════════════════════════════════════════════════════════════════════════

    s("critRule", {
      name:    "Critical Hit Damage Rule",
      hint:    "How critical hits calculate bonus damage. RAW Double Dice: roll all dice twice (2d8 becomes 4d8). Max + Roll: take max value of normal dice + roll crit dice (guarantees strong crits). Max All: max value of ALL dice (most generous, brutal crits).",
      scope:   "world",
      config:  true,
      type:    String,
      default: "maxPlusRoll",
      choices: {
        doubleDice:   "RAW Double Dice — roll twice as many dice (e.g., 2d8 → 4d8)",
        maxPlusRoll:  "Max + Roll — normal dice maxed + roll bonus crit dice (e.g., 8 + 1d8)",
        maxAll:       "Max All Dice — all dice maxed (most generous, e.g., 8 + 8 = 16)",
      },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  EXTENDED ACTIVE EFFECTS (replaces DAE)
    // ═══════════════════════════════════════════════════════════════════════════

    s("extendedEffects", {
      name:    "Extended Active Effects",
      hint:    "Enable extended effect keys, formula evaluation, and macros on apply/remove (replaces DAE).",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("effectTransferRules", {
      name:    "Effect Transfer Rules",
      hint:    "Control when item effects transfer to actors (equip, attune, always). Extends vanilla Foundry behavior.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEBUG
    // ═══════════════════════════════════════════════════════════════════════════

    s("debugMode", {
      name:    "Debug Mode",
      hint:    "Log detailed combat resolution info to console.",
      scope:   "client",
      config:  true,
      type:    Boolean,
      default: false,
    });

    console.log(`${MODULE_ID} | Settings registered (all combat features ON by default)`);
  }

  /** Quick helper to read a setting */
  static get(key) {
    return game.settings.get(MODULE_ID, key);
  }
}
