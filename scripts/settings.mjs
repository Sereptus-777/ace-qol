// ─── ACE: QOL — Settings Registration ─────────────────────────────────────────
// Everything ON by default. Toggle OFF if you want.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

// ── Preset definitions: which settings each level sets ──────────────────────
const PRESETS = {
  recommended: {
    autoCheckHit: true, autoTargetTemplates: true, damageTypeSeparation: true,
    autoCheckResistances: true, halfDamageOnSave: true, concentrationTracking: true,
    concentrationWidget: true, batchResultsCard: true, targetStateAssessment: true,
    slayerAutoDetect: true, flanking: false, autoApplyConditions: true,
    autoRollDamage: false, autoApplyDamage: false,
    enableReactions: true, autoShield: true, autoCounterspell: true,
    autoAbsorbElements: true, autoLegendaryResistance: true,
    enableSpeedRolls: true, enableMergeCard: false, enableHealPipeline: true,
    extendedEffects: true, effectTransferRules: true,
    enableOnUseHooks: true, enableOverTimeEffects: true, autoApplyOverTimeDamage: false,
    enableFlagsSystem: true, enableOptionalPrompts: true, midiCompatibility: true,
    enableDurationTracker: true, expireEffectsOnTurnChange: true, notifyOnExpiry: true,
    expiryNotifyAll: false,
    enableCoverCalculation: true, creatureAsCover: false, showCoverIndicator: true,
    ignoreCoverForAdjacent: true,
    enableBloodied: true, announceBloodied: true, enableDeadMarker: true,
    hideSaveDC: false, hideNPCNames: false, playersSeeBloodied: true,
  },
  minimal: {
    autoCheckHit: true, autoTargetTemplates: false, damageTypeSeparation: true,
    autoCheckResistances: true, halfDamageOnSave: true, concentrationTracking: false,
    concentrationWidget: false, batchResultsCard: true, targetStateAssessment: false,
    slayerAutoDetect: false, flanking: false, autoApplyConditions: false,
    autoRollDamage: false, autoApplyDamage: false,
    enableReactions: false, autoShield: false, autoCounterspell: false,
    autoAbsorbElements: false, autoLegendaryResistance: false,
    enableSpeedRolls: true, enableMergeCard: false, enableHealPipeline: true,
    extendedEffects: false, effectTransferRules: false,
    enableOnUseHooks: false, enableOverTimeEffects: false, autoApplyOverTimeDamage: false,
    enableFlagsSystem: false, enableOptionalPrompts: false, midiCompatibility: false,
    enableDurationTracker: false, expireEffectsOnTurnChange: false, notifyOnExpiry: false,
    expiryNotifyAll: false,
    enableCoverCalculation: false, creatureAsCover: false, showCoverIndicator: false,
    ignoreCoverForAdjacent: true,
    enableBloodied: true, announceBloodied: false, enableDeadMarker: true,
    hideSaveDC: false, hideNPCNames: false, playersSeeBloodied: true,
  },
  full: {
    autoCheckHit: true, autoTargetTemplates: true, damageTypeSeparation: true,
    autoCheckResistances: true, halfDamageOnSave: true, concentrationTracking: true,
    concentrationWidget: true, batchResultsCard: true, targetStateAssessment: true,
    slayerAutoDetect: true, flanking: true, autoApplyConditions: true,
    autoRollDamage: true, autoApplyDamage: true,
    enableReactions: true, autoShield: true, autoCounterspell: true,
    autoAbsorbElements: true, autoLegendaryResistance: true,
    enableSpeedRolls: true, enableMergeCard: true,
    extendedEffects: true, effectTransferRules: true,
    enableOnUseHooks: true, enableOverTimeEffects: true, autoApplyOverTimeDamage: true,
    enableFlagsSystem: true, enableOptionalPrompts: true, midiCompatibility: true,
    enableDurationTracker: true, expireEffectsOnTurnChange: true, notifyOnExpiry: true,
    expiryNotifyAll: true,
    enableCoverCalculation: true, creatureAsCover: true, showCoverIndicator: true,
    ignoreCoverForAdjacent: true,
    enableBloodied: true, announceBloodied: true, enableDeadMarker: true,
    hideSaveDC: false, hideNPCNames: false, playersSeeBloodied: true,
  },
};

// ── Settings that presets control (hidden when not "custom") ────────────────
const PRESET_MANAGED_KEYS = new Set(Object.keys(PRESETS.recommended));

export class QolSettings {

  /**
   * Apply a preset by batch-setting all managed toggles.
   */
  static async applyPreset(presetName) {
    const preset = PRESETS[presetName];
    if (!preset) return;
    for (const [key, value] of Object.entries(preset)) {
      try { await game.settings.set(MODULE_ID, key, value); }
      catch (_) { /* setting may not exist yet */ }
    }
    ui.notifications?.info(`ACE QOL: Applied "${presetName}" automation preset.`);
  }

  static register() {
    const s = (key, opts) => game.settings.register(MODULE_ID, key, opts);

    // ── Tabbed configuration panel — single button in module settings ──
    try {
      // Lazy import so we don't pull in ApplicationV2 before Foundry is ready
      import("./config-panel.mjs").then(({ AceQolConfigPanel }) => {
        game.settings.registerMenu(MODULE_ID, "configurePanel", {
          name:     "ACE QOL — Configuration Panel",
          label:    "Open Configuration",
          hint:     "Open the tabbed configuration panel — every setting organized by feature.",
          icon:     "fa-solid fa-cog",
          type:     AceQolConfigPanel,
          restricted: true,
        });
      }).catch(err => console.warn(`${MODULE_ID} | Config panel registration deferred:`, err));
    } catch (err) {
      console.warn(`${MODULE_ID} | Config panel menu registration failed:`, err);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  MODULE MASTER ENABLED — global kill-switch, sits at top of settings page
    // ═══════════════════════════════════════════════════════════════════════════

    s("moduleEnabled", {
      name:    "ACE QOL — Enabled",
      hint:    "Master on/off switch for the entire module. When OFF, all QOL automation and UI is skipped. Requires a world reload to take effect.",
      scope:   "world",
      config:  true,
      type:    Boolean,
      default: true,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  AUTOMATION LEVEL PRESET — controls 30+ toggles with one dropdown
    // ═══════════════════════════════════════════════════════════════════════════

    s("automationLevel", {
      name:    "Automation Level",
      hint:    "Quick preset for all combat automation. Use the 'Open Configuration' button above for full per-setting control via the tabbed panel.",
      scope:   "world",
      config:  true,
      type:    String,
      default: "recommended",
      choices: {
        recommended: "Recommended — sensible defaults, most features ON",
        minimal:     "Minimal — basic hit checking and damage only",
        full:        "Full Automation — everything ON, maximum automation",
        custom:      "Custom — leave individual settings as-is (use the panel)",
      },
      onChange: (value) => {
        if (value !== "custom") QolSettings.applyPreset(value);
      },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  COMBAT WORKFLOW — all ON by default
    // ═══════════════════════════════════════════════════════════════════════════

    s("autoCheckHit", {
      name:    "Auto-Check Hit vs AC",
      hint:    "Automatically compare attack rolls against target AC, factoring in cover, conditions, and buffs.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoTargetTemplates", {
      name:    "Auto-Target Tokens in Templates",
      hint:    "When a measured template is placed (Fireball, Moonbeam, etc.), automatically target all tokens inside it.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("damageTypeSeparation", {
      name:    "Separate Damage by Type",
      hint:    "Roll and display each damage type separately (slashing, cold, fire, etc.) so resistances apply per type.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoCheckResistances", {
      name:    "Check Resistances/Immunities",
      hint:    "Automatically check target resistances, immunities, and vulnerabilities for each damage type.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("halfDamageOnSave", {
      name:    "Half Damage on Save",
      hint:    "Automatically detect 'half damage on save' from spell descriptions and apply accordingly.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("concentrationTracking", {
      name:    "Concentration Tracking",
      hint:    "Track concentration spells, prompt saves on damage, remove effects when concentration breaks.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("concentrationWidget", {
      name:    "Floating Concentration Widget",
      hint:    "Show a persistent floating card for active concentration spells with Re-apply Damage button.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("concentrationOnDamage", {
      name:    "Concentration Save on Damage (RAW)",
      hint:    "When a concentrating actor takes damage, automatically prompt a Constitution saving throw with DC = max(10, floor(damage / 2)). On fail, the concentration effect is removed and dependent spells end. PHB 203.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("concentrationDamageMinDC", {
      name:    "Concentration Save Minimum DC",
      hint:    "Floor for the auto-fired concentration save DC. RAW says 10 — leave this alone unless your table uses a houserule. Damage of 21+ generates DC 11+ via the half-damage formula regardless of this setting.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 10,
      range:   { min: 5, max: 25, step: 1 },
    });

    s("bonusActionSpellRule", {
      name:    "Bonus Action Spell Rule (RAW)",
      hint:    "Enforce PHB 202: 'You can't cast another spell during the same turn, except for a cantrip with a casting time of 1 action.' Blocks leveled spells after a bonus-action leveled spell, and bonus-action leveled spells after any other spell on the same turn.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("bonusActionSpellStrict", {
      name:    "Bonus Action Spell Rule — Strict",
      hint:    "When ON, the rule BLOCKS the cast (sync-cancels via dnd5e.preUseActivity). When OFF, only WARNS via toast and lets the cast proceed (table-style override). Default ON.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ── Death Saves (PHB 197) ────────────────────────────────────────────
    s("autoDeathSaves", {
      name: "Auto-Roll Death Saves",
      hint: "When a PC at 0 HP starts their turn, automatically roll their death save.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("massiveDamageDeath", {
      name: "Massive Damage Instant Death (PHB 197)",
      hint: "If damage exceeds the target's HP maximum on a hit that would drop them to 0, they die instantly.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("autoResetOnHeal", {
      name: "Reset Death Save Tally on Heal",
      hint: "When a PC heals from 0 HP back to 1+ HP, clear their death save success/failure count.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Stealth / Hide / Surprise (PHB 192-194) ─────────────────────────
    s("autoSurpriseCheck", {
      name: "Auto Surprise Check at Combat Start",
      hint: "Compare each combatant's passive Perception against opposing-side stealth at combat start. Surprised combatants skip turn 1.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("hideActionEnabled", {
      name: "Hide Action Enabled",
      hint: "Allow the game.aceQol.StealthEngine.hide(token) API and the Hide token-toolbar action.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("hideRevealsOnAttack", {
      name: "Hide Reveals on Attack",
      hint: "When a hidden token makes an attack, automatically clear their hidden state (PHB 195).",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("hideRevealsOnDamage", {
      name: "Hide Reveals on Damage Taken",
      hint: "When a hidden token takes damage, automatically clear their hidden state.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Ranged-in-melee disadvantage (PHB 195) ──────────────────────────
    s("rangedInMeleeDisadvantage", {
      name: "Ranged in Melee = Disadvantage (PHB 195)",
      hint: "Disadvantage on ranged attack rolls when a hostile creature within 5ft can see the attacker (and isn't incapacitated/unconscious/etc).",
      scope: "world", config: false, type: Boolean, default: true,
    });

    // ── Critical Fumble (table rule, NOT RAW) ───────────────────────────
    s("criticalFumbleEnabled", {
      name: "Critical Fumble Table",
      hint: "OPTIONAL house rule. When an attack roll is a natural 1, post a fumble chat card with a rolled effect. Off by default — many tables don't use fumbles.",
      scope: "world", config: false, type: Boolean, default: false,
    });

    // ── Opportunity Attack Prompt (PHB 195) ─────────────────────────────
    s("opportunityAttackPrompt", {
      name: "Opportunity Attack Prompt",
      hint: "When a hostile creature moves out of an actor's reach, prompt the GM to take an OA on the actor's behalf.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("opportunityAttackReach", {
      name: "Opportunity Attack — Default Reach (ft)",
      hint: "Default reach distance for OA detection. Most actors use 5ft; reach weapons (10ft) handled per-weapon as a future enhancement.",
      scope: "world", config: false, type: Number, default: 5,
      range: { min: 5, max: 30, step: 5 },
    });

    // ── Initiative Tools ────────────────────────────────────────────────
    s("showInitiativeButtons", {
      name: "Show Initiative Buttons in Combat Tracker",
      hint: "Render Roll-All-NPCs / Roll-All-PCs buttons at the top of the combat tracker.",
      scope: "world", config: false, type: Boolean, default: true,
    });
    s("pcInitiativeAutoRoll", {
      name: "Auto-Roll PC Initiative",
      hint: "When ON, the Roll-All-PCs button rolls server-side. When OFF (default), it whispers each player a roll prompt — most tables prefer players rolling themselves.",
      scope: "world", config: false, type: Boolean, default: false,
    });

    s("excludeCasterFromTemplates", {
      name: "Exclude Caster From Auto-Targeted AOE Saves",
      hint: "When the caster is standing inside their own AOE template (Lightning Bolt line origin, Fireball self-cast, etc.), Foundry/dnd5e auto-targets them. By default ace-qol filters the caster OUT of the save target list. Turn this OFF if you actually want the caster to roll their own save (Evasion + half damage builds, etc.).",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("auraEngineEnabled", {
      name: "Aura Engine — Auto-Apply / Auto-Remove",
      hint: "Self-maintaining replacement for the (broken in dnd5e 5.x) ActiveAuras module. Watches token movement and dynamically applies/removes paladin aura marker effects on tokens within range. Catalog includes Aura of Protection / Warding / Courage / Hate / The Guardian and is easy to extend.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("auraVisualMode", {
      name: "Aura Visual Style",
      hint: "How to render aura range circles. RINGS = always show our reliable PIXI rings around source tokens. AUTO = defer to Automated Animations when it's active (less reliable — AA may only render on some tokens). OFF (default) = no ace-qol rings (rely on AA or nothing).",
      scope: "world", config: false, type: String, default: "off",
      choices: { off: "Off (default — no ace-qol rings)", rings: "PIXI rings (reliable)", auto: "Auto (defer to AA when active)" },
    });

    s("spellAutoDamageEnabled", {
      name: "Spell Auto-Damage Pipeline (Magic Missile, Fire Bolt, etc.)",
      hint: "When ON (default), ace-qol intercepts auto-hit damage spells (Magic Missile, Fire Bolt, etc.) and posts our unified ROLL DAMAGE card with per-target apply/undo + resistance/immunity gates. dnd5e's native damage popup is suppressed via prototype patch. Set to OFF for a clean fallback to vanilla dnd5e flow if our pipeline misbehaves.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("radiantSoulRiderEnabled", {
      name: "Radiant Soul Rider (Celestial Warlock 6+)",
      hint: "When ON (default), automatically adds CHA modifier to fire/radiant damage from spells and cantrips, once per turn. Triggers on Divine Smite (it's a spell in 2024 PHB), Sacred Flame, Spirit Shroud's radiant variant, Holy Weapon, Crusader's Mantle, etc. RAW: Celestial Warlock 6th-level feature. Set to OFF if your table runs the rider manually.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("descriptionOnKillRiderEnabled", {
      name: "On-Kill Description Riders (temp HP / self-heal on kill)",
      hint: "When ON (default), parses item descriptions for on-kill rewards like 'Reducing a target to zero hitpoints grants 2d6 temporary hitpoints' (Blood Halberd) or 'When you reduce a creature to 0 HP you regain Xd6 hit points' (life-leech weapons). Auto-rolls and applies to the attacker after each kill. Temp HP uses Math.max per RAW (doesn't stack). Set to OFF to handle these manually.",
      scope: "world", config: false, type: Boolean, default: true,
    });

    s("multiTargetMeleeFeatureIds", {
      name: "Multi-Target Melee Feature Allow-List (advanced)",
      hint: "Array of feature identifiers, item names, or UUIDs that authorize an actor to make a single melee swing against multiple targets (Cleave, Whirlwind, Great Weapon Master, etc.). Default detection uses dnd5e weapon-mastery 'cleave' property + standard identifiers (great-weapon-master, cleaving-attack, whirlwind-attack, improved-whirlwind-attack). Add homebrew or translated content here. Setting is consumed by AttackPipeline._actorHasMultiTargetMelee.",
      scope: "world", config: false, type: Array, default: [],
    });

    s("dsnRevealDelayMs", {
      name: "DSN Damage Reveal Delay (ms)",
      hint: "Pacing delay (in milliseconds) between Dice So Nice damage animations and the result card appearing in chat. Default 1500ms gives players time to see the dice land before damage totals are revealed. Set to 0 to skip the pause entirely. Setting is consumed by the damage card pipeline; no effect if DSN module isn't installed or is broken.",
      scope: "world", config: false, type: Number, default: 1500,
    });

    s("saveCardDelayAfterCastMs", {
      name: "Save Card Delay After Cast (ms)",
      hint: "Pause (in milliseconds) between the cast/template landing and the save card appearing in chat. Default 1500ms lets the spell animation play first so the save card doesn't pre-empt the dramatic beat. Set to 0 to post the save card immediately. Setting is consumed by SaveEngine._postLiveTargetCard and SaveEngine._fastResolveSingleNpcSave.",
      scope: "world", config: false, type: Number, default: 1500,
    });

    s("debugFlankLogging", {
      name: "Debug — Flanking Resolution Logs",
      hint: "Log detailed flanking-detection diagnostics to console (per-target, per-ally distance/disposition/reach checks). EXTREMELY verbose — typically 15-25 lines per attack roll. Off by default even when general Debug Mode is on. Turn on only when troubleshooting why a token does or doesn't get the flanking bonus.",
      scope: "client", config: false, type: Boolean, default: false,
    });

    s("showConcentrationWidget", {
      name: "Show Concentration Widget",
      hint: "Floating GM-side dashboard that pins all active persistent concentration AoE spells (Moonbeam, Spirit Guardians, Cloudkill, Spike Growth, etc.) with quick INFLICT DAMAGE buttons. Useful for big fights with overlapping AoEs as a glanceable summary and an off-cycle manual trigger if auto-detection misses an edge case. Independent of the chat-card save flow — saves still post automatically when tokens enter persistent areas regardless of this setting.",
      scope: "client", config: false, type: Boolean, default: true,
    });

    s("batchResultsCard", {
      name:    "Batch Combat Results Card",
      hint:    "Show all targets in one consolidated damage card instead of individual cards per target.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("targetStateAssessment", {
      name:    "Full Target State Assessment",
      hint:    "Assess every condition, buff, resistance, creature type, and modifier on every target before damage.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("slayerAutoDetect", {
      name:    "Slayer Weapon Auto-Detect",
      hint:    "Automatically detect Slayer weapons (Giant Slayer, Dragon Slayer) and apply bonus damage vs matching creature types.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("flanking", {
      name:    "Flanking (Optional Rule)",
      hint:    "Melee attackers get advantage when an ally is on the opposite side of the target. Uses the line-through method — a line from attacker through target must reach an ally.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoApplyConditions", {
      name:    "Auto-Apply Conditions",
      hint:    "Automatically apply conditions (prone, grappled, restrained, etc.) to targets when they fail saves. When OFF, conditions show in the results card but must be applied manually.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoRollDamage", {
      name:    "Auto-Roll Damage on Hit",
      hint:    "Automatically roll damage when an attack hits, instead of showing a ROLL DAMAGE button. Fastest combat flow — one click and damage appears.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoApplyDamage", {
      name:    "Auto-Apply Damage to HP",
      hint:    "Automatically apply rolled damage to target HP without waiting for the GM to click APPLY. The UNDO button remains available on the card. ⚠️ Full automation — damage is applied instantly.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  REACTION AUTOMATION
    // ═══════════════════════════════════════════════════════════════════════════

    s("enableReactions", {
      name:    "Enable Reaction Automation",
      hint:    "Master toggle for all automated reaction prompts (Shield, Counterspell, Absorb Elements, Legendary Resistance, Silvery Barbs, Cutting Words).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("reactionTimeout", {
      name:    "Reaction Prompt Timeout (seconds)",
      hint:    "How long players have to respond to a reaction prompt before it auto-declines. Default: 10 seconds.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 10,
      range:   { min: 5, max: 30, step: 1 },
    });

    s("autoShield", {
      name:    "Auto-Prompt Shield Spell",
      hint:    "When an attack hits a target that has Shield prepared and a spell slot, prompt them to cast it.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoCounterspell", {
      name:    "Auto-Prompt Counterspell",
      hint:    "When a creature casts a spell, prompt eligible opponents within 60ft to Counterspell.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoAbsorbElements", {
      name:    "Auto-Prompt Absorb Elements",
      hint:    "When a creature takes elemental damage (acid/cold/fire/lightning/thunder), prompt for Absorb Elements.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoLegendaryResistance", {
      name:    "Auto-Prompt Legendary Resistance",
      hint:    "When an NPC fails a save and has Legendary Resistance uses, prompt the GM to use one.",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("speedRollBehavior", {
      name:    "Speed Roll Behavior",
      hint:    "What happens when you click an item on the character sheet. Fast Forward: rolls immediately, no dialog. Dialog: always shows the roll dialog. Disabled: normal Foundry behavior.",
      scope:   "world",
      config:  false,
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
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ═════════════════════════════════════════════════════════════════════
    //  HEAL PIPELINE — custom heal flow (HealActivity interception)
    // ═════════════════════════════════════════════════════════════════════
    s("enableHealPipeline", {
      name:    "Custom Heal Pipeline",
      hint:    "Replaces the vanilla dnd5e heal usage card with a custom card: target picker popup (range-aware), one-click apply per target, temp HP support. Disable to fall back to vanilla dnd5e heal flow.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("mergeCardStyle", {
      name:    "Merge Card Style",
      hint:    "Detailed: shows full dice formulas and type breakdowns. Compact: minimal display with just totals.",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("showDamageFormula", {
      name:    "Show Damage Roll Formula (Merge Card)",
      hint:    "Display the damage dice breakdown (individual die results + modifiers) in merge cards.",
      scope:   "world",
      config:  false,
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
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("effectTransferRules", {
      name:    "Effect Transfer Rules",
      hint:    "Control when item effects transfer to actors (equip, attune, always). Extends vanilla Foundry behavior.",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableOverTimeEffects", {
      name:    "Enable OverTime Effects",
      hint:    "Process recurring Active Effects (damage, saves) at the start/end of a creature's combat turn. Reads flags.ace-qol.OverTime and flags.midi-qol.OverTime.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoApplyOverTimeDamage", {
      name:    "Auto-Apply OverTime Damage",
      hint:    "When ON, OverTime damage is applied to HP automatically. When OFF, the GM must click APPLY on the chat card.",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableOptionalPrompts", {
      name:    "Optional Bonus Prompts",
      hint:    "When a roll happens and the actor has optional modifiers available (Bardic Inspiration, Lucky, Guided Strike, Precision Attack, etc.), show a prompt to the player.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("optionalPromptTimeout", {
      name:    "Optional Prompt Timeout (seconds)",
      hint:    "How many seconds the optional bonus prompt stays open before auto-declining. 0 = no timeout.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 8,
      range:   { min: 0, max: 30, step: 1 },
    });

    s("midiCompatibility", {
      name:    "Midi-QOL Flag Compatibility",
      hint:    "Also read flags.midi-qol.* on actors for backward compatibility with existing items that have Midi-QOL flags set. Disable if you have fully migrated to ace-qol flags.",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("expireEffectsOnTurnChange", {
      name:    "Expire Effects on Turn Change",
      hint:    "Automatically check for and remove expired effects when combat turns/rounds advance.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("notifyOnExpiry", {
      name:    "Notify on Effect Expiry",
      hint:    "Post a chat notification when an effect expires during combat.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("expiryNotifyAll", {
      name:    "Expiry Notifications Visible to All",
      hint:    "When ON, effect expiry notifications are visible to all players. When OFF, they are whispered to GM only.",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("coverCalculationMethod", {
      name:    "Cover Calculation Method",
      hint:    "How cover is calculated. Corners: casts 16 rays from attacker corners to target corners (DMG variant, more accurate). Center: single ray from center to center (simpler, faster).",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("showCoverIndicator", {
      name:    "Show Cover Indicator",
      hint:    "Display a scrolling text indicator on the target showing the cover level when an attack is made.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("ignoreCoverForAdjacent", {
      name:    "Ignore Cover for Adjacent Targets",
      hint:    "Targets within 5ft of the attacker ignore cover (they are too close for obstacles to matter).",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("bloodiedThreshold", {
      name:    "Bloodied Threshold",
      hint:    "Percentage of max HP at or below which a creature is considered bloodied. Default 0.5 = half HP.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.5,
      range:   { min: 0.1, max: 0.9, step: 0.05 },
    });

    s("bloodiedIndicatorStyle", {
      name:    "Bloodied Indicator Style",
      hint:    "Visual style for the bloodied indicator on tokens.",
      scope:   "world",
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("bloodiedVisibleTo", {
      name:    "Bloodied Visible To",
      hint:    "Who can see the bloodied indicator on tokens and in chat.",
      scope:   "world",
      config:  false,
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
      config:  false,
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
      config:  false,
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
      config:  false,
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
      config:  false,
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
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("hideNPCNames", {
      name:    "Hide NPC Names in Rolls",
      hint:    "Replace NPC names with '???' in attack/damage/save cards. Prevents players from identifying unknown creatures.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("playersSeeBloodied", {
      name:    "Players See Bloodied Indicators",
      hint:    "Whether players can see bloodied visual indicators on NPC tokens. Independent of the Bloodied Visible To setting for chat announcements.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("npcSaveAnimationDelay", {
      name:    "NPC Save Dice Pacing — Single Target (ms)",
      hint:    "How long the engine waits while a SINGLE NPC's save d20 is animating before showing the result. Higher = more dramatic. Set to 0 to skip waiting entirely (result appears instantly while dice roll in background). Default: 1000ms.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 1000,
      range:   { min: 0, max: 5000, step: 100 },
    });

    s("npcSaveAnimationDelayMulti", {
      name:    "NPC Save Dice Pacing — Multi-Target (ms per save)",
      hint:    "When rolling saves for MULTIPLE NPCs at once (Fireball, Mass Suggestion, etc.), how long to pause per save. Lower = faster batch resolution. Default: 250ms per save (5 targets ≈ 1.25s total).",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 250,
      range:   { min: 0, max: 2000, step: 50 },
    });

    s("npcDamageAnimationDelay", {
      name:    "Spell Damage Dice Pacing (ms)",
      hint:    "How long the engine waits while spell damage dice (Fireball 8d6, Sacred Flame 1d8, etc.) are animating across the table before the merge card displays. Applies to BOTH NPC and PC casts since damage is rolled engine-side either way. Set to 0 to skip waiting entirely. Default: 1500ms.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 1500,
      range:   { min: 0, max: 8000, step: 100 },
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEBUG
    // ═══════════════════════════════════════════════════════════════════════════

    s("debugMode", {
      name:    "Debug Mode",
      hint:    "Log detailed combat resolution info to console.",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("requireTarget", {
      name:    "Require Target for Weapon Attacks",
      hint:    "Block weapon attacks when no target is selected. Shows a centered 'Please select a target' notice.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("advantagePrompt", {
      name:    "Advantage Prompt Before Weapon Attacks",
      hint:    "Show a centered popup with three buttons (Advantage / Normal / Disadvantage) before each weapon attack. The button ace-qol auto-detects is pre-focused; press Enter to accept it.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("suppressSystemCards", {
      name:    "Suppress D&D 5e System Chat Cards",
      hint:    "Hide the system's item-use and attack-roll chat cards entirely. Our ace-qol attack card embeds the item description (collapsed under a chevron) so nothing is lost. Disable to fall back to the legacy collapse behavior.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableEffectsPanel", {
      name:    "Enable Effects Panel",
      hint:    "Show a floating list of the currently selected token's active effects. Left-click an effect to read its description, right-click to disable/delete (with confirmation).",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("effectsPanelPosition", {
      name:    "Effects Panel Position",
      hint:    "Where the effects panel anchors on screen.",
      scope:   "client",
      config:  false,
      type:    String,
      choices: { "top-right": "Top Right", "top-left": "Top Left", "bottom-right": "Bottom Right", "bottom-left": "Bottom Left" },
      default: "top-right",
    });

    s("effectsPanelAction", {
      name:    "Effects Panel Right-Click Action",
      hint:    "What right-click does after the confirmation prompt: Disable (effect stays on the actor but inactive — reversible) or Delete (effect removed entirely — permanent).",
      scope:   "world",
      config:  false,
      type:    String,
      choices: { "disable": "Disable (recommended)", "delete": "Delete" },
      default: "disable",
    });

    s("effectsPanelFor", {
      name:    "Effects Panel Visibility",
      hint:    "Who sees the panel for which tokens. 'Default': GM sees panel for any token, players see only their own. 'Owned only': both GM and players see only tokens they own.",
      scope:   "world",
      config:  false,
      type:    String,
      choices: { "default": "Default (GM all, players owned)", "owned": "Owned tokens only" },
      default: "default",
    });

    s("effectsPanelShowAuras", {
      name:    "Effects Panel — Show Class Auras",
      hint:    "Detect and display class auras (Paladin Aura of Protection, Aura of Courage, etc.) computed from class levels — these are class features, not Active Effects, so they don't appear elsewhere.",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: true,
    });

    // ── Turn Marker (replaces combatbooster) ────────────────────────────
    s("enableTurnMarker", {
      name:    "Enable Turn Marker",
      hint:    "Rotating marker placed under the active combatant's token during combat.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("turnMarkerImage", {
      name:    "Turn Marker Image (Current)",
      hint:    "Image/webm under the active combatant. Default: JB2A red Evocation rune (loops automatically).",
      scope:   "world",
      config:  false,
      type:    String,
      default: "modules/JB2A_DnD5e/Library/Generic/Magic_Signs/Runes/EvocationRuneLoop_01_Regular_Red_400x400.webm",
      filePicker: "imagevideo",
    });

    s("turnMarkerImageNext", {
      name:    "Turn Marker Image (Next)",
      hint:    "Image/webm under the next combatant. Default: JB2A blue Abjuration rune (loops automatically).",
      scope:   "world",
      config:  false,
      type:    String,
      default: "modules/JB2A_DnD5e/Library/Generic/Magic_Signs/Runes/AbjurationRuneLoop_01_Regular_Blue_400x400.webm",
      filePicker: "imagevideo",
    });

    s("turnMarkerNextAlpha", {
      name:    "Next-Turn Marker Opacity",
      hint:    "Opacity of the next-combatant marker. Lower = more subtle.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.7,
      range:   { min: 0.1, max: 1, step: 0.05 },
    });

    s("turnMarkerScale", {
      name:    "Turn Marker Size",
      hint:    "Scale multiplier relative to the active token. 1.0 = same size, 1.5 = 50% larger.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 1.15,
      range:   { min: 0.5, max: 2.5, step: 0.05 },
    });

    s("turnMarkerSpeed", {
      name:    "Turn Marker Rotation Speed",
      hint:    "How fast the marker spins. 0 = no rotation, 1.0 = normal, 2.0 = fast.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.5,
      range:   { min: 0, max: 3, step: 0.1 },
    });

    s("turnMarkerAlpha", {
      name:    "Turn Marker Opacity",
      hint:    "How transparent the marker is. 1.0 = fully opaque.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.85,
      range:   { min: 0.1, max: 1, step: 0.05 },
    });

    s("enableNextTurnMarker", {
      name:    "Enable Next-Turn Marker",
      hint:    "Greyscale version of the marker placed under the next combatant's token (helps players prepare).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableYourTurnNotification", {
      name:    "Show 'Your Turn' Notification",
      hint:    "Display a centered popup for connected players when their turn begins.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("enableYourTurnSound", {
      name:    "Play 'Your Turn' Sound",
      hint:    "Play an audible alert for connected players when their turn begins.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("yourTurnSound", {
      name:    "Your Turn Sound File",
      hint:    "Sound played when it's a player's turn.",
      scope:   "world",
      config:  false,
      type:    String,
      default: "sounds/notify.wav",
      filePicker: "audio",
    });

    s("enableTurnMarkerAutoPan", {
      name:    "Auto-Pan Camera to Active Combatant",
      hint:    "Smoothly pan the camera to the current combatant when their turn begins.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    // ── Movement Tracker (colored squares while dragging tokens) ────────
    s("enableMovementTracker", {
      name:    "Enable Movement Tracker",
      hint:    "Show colored grid squares while dragging a token: green = within walk speed, yellow = within Dash (2× walk), red = beyond Dash.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("movementTrackerOnlyInCombat", {
      name:    "Movement Tracker — Only in Combat",
      hint:    "When on, the colored squares only appear during combat. Off = always visible while dragging.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("movementTrackerAlpha", {
      name:    "Movement Tracker Opacity",
      hint:    "How visible the colored squares are. 1.0 = solid color, 0.2 = very subtle.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 0.35,
      range:   { min: 0.1, max: 0.8, step: 0.05 },
    });

    s("flankingAllowReachWeapons", {
      name:    "Flanking — Allow Reach Weapons (Houserule)",
      hint:    "When ON, an ally with an equipped reach weapon (Glaive, Halberd, Pike, Whip, Lance, etc.) can grant flanking from 10ft. RAW only allows flanking at 5ft (adjacent).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("autoPostLootCard", {
      name:    "Auto-Post Loot Card on Death",
      hint:    "When ON (default), a public chat card listing the dead NPC's loot is posted automatically — items are draggable to PC sheets. Disable to suppress the chat card and rely solely on the tile loot dialog (single-click the dead-art tile).",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("lootHoverIconDelayMs", {
      name:    "Loot Hover-Icon Delay (ms)",
      hint:    "How long to hover over a corpse / container tile before the gold treasure-chest icon fades in. Set to 0 to disable the hover icon entirely. Default: 1000ms (1 second).",
      scope:   "client",
      config:  false,
      type:    Number,
      default: 1000,
      range:   { min: 0, max: 5000, step: 100 },
    });

    s("lootClickDebug", {
      name:    "Loot Click Debug Logging",
      hint:    "When ON, every left-click logs the lootable-tile detection result to console (world pos, layer, tile found?). Use this to diagnose click-doesn't-open-loot bugs. Default: OFF.",
      scope:   "client",
      config:  false,
      type:    Boolean,
      default: false,
    });

    s("enableXpDistribution", {
      name:    "Enable XP Distribution at Combat End",
      hint:    "When combat ends, prompt the GM to distribute XP from defeated NPCs. Only connected (active) PCs receive XP. Dead PCs are auto-skipped.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("reduceCoverForLargeTargets", {
      name:    "Reduce Cover for Large+ Targets (House Rule)",
      hint:    "Big creatures can't easily hide behind small obstacles. When ON: Large targets ignore Half cover and downgrade ¾ cover to Half. Huge targets ignore Half + ¾ cover entirely (only Full cover counts). Gargantuan: same as Huge. Disable to use strict 5e RAW.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("autoDeleteInstantTemplates", {
      name:    "Auto-Delete Instant Spell Templates",
      hint:    "After damage is rolled for an instantaneous spell (Fireball, Lightning Bolt, etc.), automatically delete the AOE template from the canvas. Templates for persistent spells (Fog Cloud, Spirit Guardians) are kept and remain draggable.",
      scope:   "world",
      config:  false,
      type:    Boolean,
      default: true,
    });

    s("dsnRevealDelayMs", {
      name:    "Delay Result Card After Dice Roll (ms)",
      hint:    "Hold the attack result card for this many milliseconds after the roll fires, so Dice So Nice dice finish tumbling before the result is revealed. Default 3000 (3 seconds). Set to 0 to disable the delay.",
      scope:   "world",
      config:  false,
      type:    Number,
      default: 3000,
      range:   { min: 0, max: 6000, step: 250 },
    });

    s("polymorphMode", {
      name:    "Polymorph Implementation",
      hint:    "Choose the engine that handles Polymorph spell + trap transformations. CUSTOM is ace-qol's own implementation: stat-override Active Effect + token swap, ~3 database writes, 1-3 seconds even on hosted servers. DND5E NATIVE uses the system's built-in transformInto API which creates a brand-new actor in the world; mechanically perfect RAW but slow on hosted servers (60-120 seconds when many modules listen on actor/token hooks).",
      scope:   "world",
      config:  false,
      type:    String,
      default: "custom",
      choices: {
        custom: "Custom — fast (ace-qol implementation, ~3s)",
        dnd5e:  "dnd5e Native — slow but RAW-perfect (transformInto)",
      },
    });

    s("tokenImageFolders", {
      name:    "Token Image Folders",
      hint:    "Folders ace-qol scans recursively to build the polymorph token-image cache. Each entry is a path relative to your Foundry user-data folder (e.g. 'NPCs' or 'assets/srd5e/img/bestiary/tokens/MM'). When empty, polymorph uses compendium-default images. Add/remove folders via the ace-qol config panel.",
      scope:   "world",
      config:  false,
      type:    Object,
      default: [],
    });

    s("tokenImageCacheData", {
      name:    "Token Image Cache Data (persisted)",
      hint:    "Internal — persisted snapshot of the scanned token-image map. Auto-managed by ace-qol; do not edit by hand. Cleared by 'Rescan' in the config panel.",
      scope:   "world",
      config:  false,
      type:    Object,
      default: { map: {}, paths: [], fileCount: 0, uniqueCount: 0, durationSec: 0, timestamp: 0 },
    });

    console.log(`${MODULE_ID} | Settings registered (all combat features ON by default)`);
  }

  /** Quick helper to read a setting */
  static get(key) {
    return game.settings.get(MODULE_ID, key);
  }

  /**
   * Hook into settings panel render to hide/show managed settings and add section headers.
   */
  static onRenderSettingsConfig(app, html) {
    const el = html[0] ?? html;
    const level = game.settings.get(MODULE_ID, "automationLevel");
    const isCustom = (level === "custom");

    // ── Hide/show managed settings based on preset ──
    for (const key of PRESET_MANAGED_KEYS) {
      const row = el.querySelector(`div.form-group:has([name="${MODULE_ID}.${key}"])`);
      if (!row) continue;
      row.style.display = isCustom ? "" : "none";
    }

    // ── Also hide non-boolean settings that are sub-options of hidden parents ──
    const subSettings = [
      "reactionTimeout", "speedRollBehavior", "speedRollAdvantageKey",
      "mergeCardStyle", "showAttackFormula", "showDamageFormula", "critRule",
      "optionalPromptTimeout", "coverCalculationMethod",
      "bloodiedThreshold", "bloodiedIndicatorStyle", "bloodiedVisibleTo",
      "npcAttackVisibility", "npcDamageVisibility", "npcSaveVisibility",
    ];
    for (const key of subSettings) {
      const row = el.querySelector(`div.form-group:has([name="${MODULE_ID}.${key}"])`);
      if (!row) continue;
      row.style.display = isCustom ? "" : "none";
    }

    // ── Add a summary note when not custom ──
    if (!isCustom) {
      const presetRow = el.querySelector(`div.form-group:has([name="${MODULE_ID}.automationLevel"])`);
      if (presetRow && !presetRow.querySelector(".ace-preset-note")) {
        const note = document.createElement("p");
        note.className = "ace-preset-note notes";
        note.style.cssText = "color:#999; font-style:italic; margin:4px 0 0 0; font-size:11px;";
        note.textContent = `Using "${level}" preset. Switch to "Custom" to see and edit all ${PRESET_MANAGED_KEYS.size}+ individual settings.`;
        presetRow.appendChild(note);
      }
    }

    // ── When in custom mode, add section headers ──
    if (isCustom) {
      const sections = {
        autoCheckHit:           "⚔️ Combat Workflow",
        enableReactions:        "🛡️ Reactions",
        enableSpeedRolls:       "⚡ Speed Rolls",
        enableMergeCard:        "📋 Merge Card",
        critRule:               "💥 Critical Hits",
        extendedEffects:        "✨ Active Effects",
        enableOnUseHooks:       "🔗 Hooks & OverTime",
        enableFlagsSystem:      "🚩 Flags & Optional Prompts",
        enableDurationTracker:  "⏱️ Duration Tracking",
        enableCoverCalculation: "🏰 Cover",
        enableBloodied:         "🩸 Bloodied & Death",
        npcAttackVisibility:    "👁️ Roll Visibility",
      };
      for (const [settingKey, label] of Object.entries(sections)) {
        const row = el.querySelector(`div.form-group:has([name="${MODULE_ID}.${settingKey}"])`);
        if (!row || row.previousElementSibling?.classList?.contains("ace-section-header")) continue;
        const header = document.createElement("h3");
        header.className = "ace-section-header";
        header.style.cssText = "border-bottom:1px solid #444; padding:8px 0 4px 0; margin:16px 0 6px 0; color:#d4af37; font-size:13px; font-weight:bold;";
        header.textContent = label;
        row.parentNode.insertBefore(header, row);
      }
    }
  }
}
