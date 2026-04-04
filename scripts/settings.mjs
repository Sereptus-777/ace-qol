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
    //  REACTION AUTOMATION
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableReactions", {
      name:    "Enable Reaction Automation",
      hint:    "Master toggle for all automated reaction prompts (Shield, Counterspell, Absorb Elements, Legendary Resistance, Silvery Barbs, Cutting Words).",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("reactionTimeout", {
      name:    "Reaction Prompt Timeout (seconds)",
      hint:    "How long players have to respond to a reaction prompt before it auto-declines. Default: 10 seconds.",
      scope:   "world",
      config:  true,
      type:    Number,
      default: 10,
      range:   { min: 5, max: 30, step: 1 },
    });

    s("autoShield", {
      name:    "Auto-Prompt Shield Spell",
      hint:    "When an attack hits a target that has Shield prepared and a spell slot, prompt them to cast it.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("autoCounterspell", {
      name:    "Auto-Prompt Counterspell",
      hint:    "When a creature casts a spell, prompt eligible opponents within 60ft to Counterspell.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("autoAbsorbElements", {
      name:    "Auto-Prompt Absorb Elements",
      hint:    "When a creature takes elemental damage (acid/cold/fire/lightning/thunder), prompt for Absorb Elements.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("autoLegendaryResistance", {
      name:    "Auto-Prompt Legendary Resistance",
      hint:    "When an NPC fails a save and has Legendary Resistance uses, prompt the GM to use one.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  SPEED ROLLS — one-click attacks from character sheet
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableSpeedRolls", {
      name:    "Speed Item Rolls",
      hint:    "Click a weapon/spell on the character sheet to immediately roll the attack with no dialog. Ctrl+click to show the normal dialog. Alt+click for advantage.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("speedRollBehavior", {
      name:    "Speed Roll Behavior",
      hint:    "What happens when you click an item on the character sheet. Fast Forward: rolls immediately, no dialog. Dialog: always shows the roll dialog. Disabled: normal Foundry behavior.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "fastForward",
      choices: {
        fastForward: "Fast Forward — roll immediately, no dialog",
        dialog:      "Dialog — always show the roll configuration dialog",
        disabled:    "Disabled — use default Foundry behavior",
      },
    });

    s("speedRollAdvantageKey", {
      name:    "Speed Roll Advantage Key",
      hint:    "Which modifier key grants advantage on speed rolls. Alt: Alt+click = advantage, Ctrl+Alt = disadvantage. Shift: Shift+click = advantage, Ctrl+Shift = disadvantage.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "alt",
      choices: {
        alt:   "Alt — Alt+click = advantage, Ctrl+Alt = disadvantage",
        shift: "Shift — Shift+click = advantage, Ctrl+Shift = disadvantage",
      },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  MERGE CARD — combined attack + damage display
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableMergeCard", {
      name:    "Merge Attack + Damage Cards",
      hint:    "Combine the attack and damage results into a single chat card instead of separate messages. Opt-in — disabled by default.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    s("mergeCardStyle", {
      name:    "Merge Card Style",
      hint:    "Detailed: shows full dice formulas and type breakdowns. Compact: minimal display with just totals.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "detailed",
      choices: {
        detailed: "Detailed — full dice formulas and type breakdowns",
        compact:  "Compact — minimal display with totals only",
      },
    });

    s("showAttackFormula", {
      name:    "Show Attack Roll Formula (Merge Card)",
      hint:    "Display the attack roll breakdown (d20 + ability + proficiency + magic) in merge cards.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("showDamageFormula", {
      name:    "Show Damage Roll Formula (Merge Card)",
      hint:    "Display the damage dice breakdown (individual die results + modifiers) in merge cards.",
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
    //  HOOK API & OVERTIME EFFECTS
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableOnUseHooks", {
      name:    "Enable OnUse Hook API",
      hint:    "Fire ace-qol.* hooks at every phase of the combat workflow. Allows third-party modules and macros to extend behavior (damage bonuses, custom conditions, etc.).",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("enableOverTimeEffects", {
      name:    "Enable OverTime Effects",
      hint:    "Process recurring Active Effects (damage, saves) at the start/end of a creature's combat turn. Reads flags.ace-qol.OverTime and flags.midi-qol.OverTime.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("autoApplyOverTimeDamage", {
      name:    "Auto-Apply OverTime Damage",
      hint:    "When ON, OverTime damage is applied to HP automatically. When OFF, the GM must click APPLY on the chat card.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  FLAGS ENGINE + OPTIONAL PROMPTS
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableFlagsSystem", {
      name:    "Flags System",
      hint:    "Enable the general-purpose flags system. Active Effects can set flags under flags.ace-qol.* to control advantage, disadvantage, auto-crit, save modifiers, damage bonuses, and more.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("enableOptionalPrompts", {
      name:    "Optional Bonus Prompts",
      hint:    "When a roll happens and the actor has optional modifiers available (Bardic Inspiration, Lucky, Guided Strike, Precision Attack, etc.), show a prompt to the player.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("optionalPromptTimeout", {
      name:    "Optional Prompt Timeout (seconds)",
      hint:    "How many seconds the optional bonus prompt stays open before auto-declining. 0 = no timeout.",
      scope:   "world",
      config:  true,
      type:    Number,
      default: 8,
      range:   { min: 0, max: 30, step: 1 },
    });

    s("midiCompatibility", {
      name:    "Midi-QOL Flag Compatibility",
      hint:    "Also read flags.midi-qol.* on actors for backward compatibility with existing items that have Midi-QOL flags set. Disable if you have fully migrated to ace-qol flags.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  CONDITION LIBRARY & DURATION TRACKER
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableDurationTracker", {
      name:    "Effect Duration Tracker",
      hint:    "Automatically track and expire Active Effects when their duration runs out (replaces Times Up module).",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("expireEffectsOnTurnChange", {
      name:    "Expire Effects on Turn Change",
      hint:    "Automatically check for and remove expired effects when combat turns/rounds advance.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("notifyOnExpiry", {
      name:    "Notify on Effect Expiry",
      hint:    "Post a chat notification when an effect expires during combat.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("expiryNotifyAll", {
      name:    "Expiry Notifications Visible to All",
      hint:    "When ON, effect expiry notifications are visible to all players. When OFF, they are whispered to GM only.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  COVER CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableCoverCalculation", {
      name:    "Auto-Calculate Cover",
      hint:    "Automatically calculate cover between attacker and target using wall/obstacle ray casting. Adds AC bonus to target before hit determination.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("coverCalculationMethod", {
      name:    "Cover Calculation Method",
      hint:    "How cover is calculated. Corners: casts 16 rays from attacker corners to target corners (DMG variant, more accurate). Center: single ray from center to center (simpler, faster).",
      scope:   "world",
      config:  true,
      type:    String,
      default: "corners",
      choices: {
        corners: "Corner-to-Corner (16 rays, DMG variant)",
        center:  "Center-to-Center (1 ray, simplified)",
      },
    });

    s("creatureAsCover", {
      name:    "Creatures Provide Cover (Optional Rule)",
      hint:    "Other creatures in the line of attack provide half cover (+2 AC) to the target. PHB optional rule.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    s("showCoverIndicator", {
      name:    "Show Cover Indicator",
      hint:    "Display a scrolling text indicator on the target showing the cover level when an attack is made.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("ignoreCoverForAdjacent", {
      name:    "Ignore Cover for Adjacent Targets",
      hint:    "Targets within 5ft of the attacker ignore cover (they are too close for obstacles to matter).",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  BLOODIED & DEATH INDICATORS
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableBloodied", {
      name:    "Bloodied Indicator",
      hint:    "Show a visual indicator when a token drops to half HP or below.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("bloodiedThreshold", {
      name:    "Bloodied Threshold",
      hint:    "Percentage of max HP at or below which a creature is considered bloodied. Default 0.5 = half HP.",
      scope:   "world",
      config:  true,
      type:    Number,
      default: 0.5,
      range:   { min: 0.1, max: 0.9, step: 0.05 },
    });

    s("bloodiedIndicatorStyle", {
      name:    "Bloodied Indicator Style",
      hint:    "Visual style for the bloodied indicator on tokens.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "border",
      choices: {
        border:  "Red Border Ring (default, most visible)",
        overlay: "Blood Splatter Overlay Icon",
        tint:    "Red Tint on Token Image",
      },
    });

    s("announceBloodied", {
      name:    "Announce Bloodied in Chat",
      hint:    "Post a chat message when a creature becomes bloodied.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    s("bloodiedVisibleTo", {
      name:    "Bloodied Visible To",
      hint:    "Who can see the bloodied indicator on tokens and in chat.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "gm",
      choices: {
        gm:  "GM Only",
        all: "All Players",
      },
    });

    s("enableDeadMarker", {
      name:    "Auto Dead Marker",
      hint:    "Automatically apply the dead status effect (skull overlay) when a creature drops to 0 HP.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  ROLL VISIBILITY CONTROLS
    // ═══════════════════════════════════════════════════════════════════════════

    s("npcAttackVisibility", {
      name:    "NPC Attack Roll Visibility",
      hint:    "What players see when NPCs make attack rolls. Public: full details. Result Only: Hit/Miss but not the number. GM Only: players see nothing.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "public",
      choices: {
        public:     "Public — players see full roll details",
        resultOnly: "Result Only — players see Hit/Miss, not the roll",
        gmOnly:     "GM Only — hidden from players entirely",
      },
    });

    s("npcDamageVisibility", {
      name:    "NPC Damage Roll Visibility",
      hint:    "What players see when NPCs deal damage. Public: full details. Result Only: damage type but not the number. GM Only: hidden.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "public",
      choices: {
        public:     "Public — players see full damage details",
        resultOnly: "Result Only — players see type labels, not totals",
        gmOnly:     "GM Only — hidden from players entirely",
      },
    });

    s("npcSaveVisibility", {
      name:    "NPC Save Roll Visibility",
      hint:    "What players see when NPCs make saving throws.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "public",
      choices: {
        public:     "Public — players see full save details",
        resultOnly: "Result Only — players see Pass/Fail, not the roll",
        gmOnly:     "GM Only — hidden from players entirely",
      },
    });

    s("hideSaveDC", {
      name:    "Hide Save DC from Players",
      hint:    "Replace save DCs with 'DC ???' in chat messages visible to players. Prevents metagaming save difficulty.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    s("hideNPCNames", {
      name:    "Hide NPC Names in Rolls",
      hint:    "Replace NPC names with '???' in attack/damage/save cards. Prevents players from identifying unknown creatures.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: false,
    });

    s("playersSeeBloodied", {
      name:    "Players See Bloodied Indicators",
      hint:    "Whether players can see bloodied visual indicators on NPC tokens. Independent of the Bloodied Visible To setting for chat announcements.",
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
