// ─── ACE: QOL — Condition & Effect Library ──────────────────────────────────
// Comprehensive library of pre-built Active Effects for all SRD conditions,
// common spell effects, and class features. Replaces DFreds Convenient Effects.
//
// Every condition includes correct mechanical Active Effect changes using the
// flags.ace-qol.* flag system recognized by ExtendedEffects, TargetState,
// and the combat pipeline.
//
// Usage:
//   ConditionLibrary.applyEffect(actor, "bless");
//   ConditionLibrary.toggleEffect(actor, "prone");
//   ConditionLibrary.hasEffect(actor, "haste");
//   ConditionLibrary.search("hold");
//
// Public API registered at: game.modules.get("ace-qol").api.conditions
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { CombatState } from "./combat-state.mjs";

// ─── Shorthand for Active Effect modes ──────────────────────────────────────
// Resolved at call time via getter so CONST is available
const _M = () => CONST.ACTIVE_EFFECT_MODES;

// ═══════════════════════════════════════════════════════════════════════════════
//  SRD CONDITIONS — All 15 core conditions + exhaustion levels 1-6
// ═══════════════════════════════════════════════════════════════════════════════

const CONDITIONS = {

  // ── Blinded ────────────────────────────────────────────────────────────────
  blinded: {
    name: "Blinded",
    icon: "icons/svg/blind.svg",
    statusId: "blinded",
    description: "Can't see. Auto-fail sight-based ability checks. Attack rolls have disadvantage. Attack rolls against the creature have advantage.",
    changes: [
      { key: "flags.ace-qol.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.ability.check.prc", mode: 0, value: "1" },
    ],
  },

  // ── Charmed ────────────────────────────────────────────────────────────────
  charmed: {
    name: "Charmed",
    icon: "icons/svg/heal.svg",
    statusId: "charmed",
    description: "Can't attack the charmer or target them with harmful abilities or magical effects. The charmer has advantage on social ability checks against the creature.",
    changes: [
      { key: "flags.ace-qol.charmed", mode: 0, value: "1" },
    ],
  },

  // ── Deafened ───────────────────────────────────────────────────────────────
  deafened: {
    name: "Deafened",
    icon: "icons/svg/deaf.svg",
    statusId: "deafened",
    description: "Can't hear. Automatically fails any ability check that requires hearing.",
    changes: [
      { key: "flags.ace-qol.fail.ability.check.hearing", mode: 0, value: "1" },
    ],
  },

  // ── Exhaustion Level 1 ────────────────────────────────────────────────────
  exhaustion1: {
    name: "Exhaustion 1",
    icon: "icons/svg/unconscious.svg",
    statusId: "exhaustion",
    description: "Exhaustion Level 1: Disadvantage on ability checks.",
    changes: [
      { key: "flags.ace-qol.disadvantage.ability.check.all", mode: 0, value: "1" },
    ],
  },

  // ── Exhaustion Level 2 ────────────────────────────────────────────────────
  exhaustion2: {
    name: "Exhaustion 2",
    icon: "icons/svg/unconscious.svg",
    statusId: "exhaustion",
    description: "Exhaustion Level 2: Disadvantage on ability checks. Speed halved.",
    changes: [
      { key: "flags.ace-qol.disadvantage.ability.check.all", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.fly", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.swim", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.climb", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.burrow", mode: 1, value: "0.5" },
    ],
  },

  // ── Exhaustion Level 3 ────────────────────────────────────────────────────
  exhaustion3: {
    name: "Exhaustion 3",
    icon: "icons/svg/unconscious.svg",
    statusId: "exhaustion",
    description: "Exhaustion Level 3: Disadvantage on ability checks and saving throws. Speed halved.",
    changes: [
      { key: "flags.ace-qol.disadvantage.ability.check.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.save.all", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.fly", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.swim", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.climb", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.burrow", mode: 1, value: "0.5" },
    ],
  },

  // ── Exhaustion Level 4 ────────────────────────────────────────────────────
  exhaustion4: {
    name: "Exhaustion 4",
    icon: "icons/svg/unconscious.svg",
    statusId: "exhaustion",
    description: "Exhaustion Level 4: Disadvantage on ability checks, attack rolls, and saving throws. Speed halved. HP maximum halved.",
    changes: [
      { key: "flags.ace-qol.disadvantage.ability.check.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.save.all", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.fly", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.swim", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.climb", mode: 1, value: "0.5" },
      { key: "system.attributes.movement.burrow", mode: 1, value: "0.5" },
      { key: "system.attributes.hp.max", mode: 1, value: "0.5" },
    ],
  },

  // ── Exhaustion Level 5 ────────────────────────────────────────────────────
  exhaustion5: {
    name: "Exhaustion 5",
    icon: "icons/svg/unconscious.svg",
    statusId: "exhaustion",
    description: "Exhaustion Level 5: Disadvantage on ability checks, attack rolls, and saving throws. Speed reduced to 0. HP maximum halved.",
    changes: [
      { key: "flags.ace-qol.disadvantage.ability.check.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.save.all", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "system.attributes.movement.fly", mode: 5, value: "0" },
      { key: "system.attributes.movement.swim", mode: 5, value: "0" },
      { key: "system.attributes.movement.climb", mode: 5, value: "0" },
      { key: "system.attributes.movement.burrow", mode: 5, value: "0" },
      { key: "system.attributes.hp.max", mode: 1, value: "0.5" },
    ],
  },

  // ── Exhaustion Level 6 ────────────────────────────────────────────────────
  exhaustion6: {
    name: "Exhaustion 6",
    icon: "icons/svg/skull.svg",
    statusId: "exhaustion",
    description: "Exhaustion Level 6: Death.",
    changes: [
      { key: "flags.ace-qol.dead", mode: 0, value: "1" },
      { key: "system.attributes.hp.value", mode: 5, value: "0" },
    ],
  },

  // ── Frightened ─────────────────────────────────────────────────────────────
  frightened: {
    name: "Frightened",
    icon: "icons/svg/terror.svg",
    statusId: "frightened",
    description: "Disadvantage on ability checks and attack rolls while the source of fear is within line of sight. Can't willingly move closer to the source.",
    changes: [
      { key: "flags.ace-qol.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.ability.check.all", mode: 0, value: "1" },
    ],
  },

  // ── Grappled ──────────────────────────────────────────────────────────────
  grappled: {
    name: "Grappled",
    icon: "icons/svg/net.svg",
    statusId: "grappled",
    description: "Speed becomes 0 and can't benefit from any bonus to speed.",
    changes: [
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "system.attributes.movement.fly", mode: 5, value: "0" },
      { key: "system.attributes.movement.swim", mode: 5, value: "0" },
      { key: "system.attributes.movement.climb", mode: 5, value: "0" },
      { key: "system.attributes.movement.burrow", mode: 5, value: "0" },
    ],
  },

  // ── Incapacitated ─────────────────────────────────────────────────────────
  incapacitated: {
    name: "Incapacitated",
    icon: "icons/svg/unconscious.svg",
    statusId: "incapacitated",
    description: "Can't take actions or reactions.",
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
    ],
  },

  // ── Invisible ─────────────────────────────────────────────────────────────
  invisible: {
    name: "Invisible",
    icon: "icons/svg/invisible.svg",
    statusId: "invisible",
    description: "Impossible to see without magic or special sense. Heavily obscured for hiding. Attack rolls have advantage. Attack rolls against have disadvantage.",
    changes: [
      { key: "flags.ace-qol.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
    ],
  },

  // ── Paralyzed ─────────────────────────────────────────────────────────────
  paralyzed: {
    name: "Paralyzed",
    icon: "icons/svg/paralysis.svg",
    statusId: "paralyzed",
    description: "Incapacitated. Can't move or speak. Auto-fails STR and DEX saves. Attacks have advantage. Melee hits within 5ft are auto-crits.",
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.autoCrit.melee", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "system.attributes.movement.fly", mode: 5, value: "0" },
      { key: "system.attributes.movement.swim", mode: 5, value: "0" },
      { key: "system.attributes.movement.climb", mode: 5, value: "0" },
      { key: "system.attributes.movement.burrow", mode: 5, value: "0" },
    ],
  },

  // ── Petrified ─────────────────────────────────────────────────────────────
  petrified: {
    name: "Petrified",
    icon: "icons/svg/statue.svg",
    statusId: "petrified",
    description: "Transformed into solid inanimate substance. Weight x10. No aging. Incapacitated, can't move or speak. Unaware of surroundings. Auto-fails STR/DEX saves. Resistance to all damage. Immune to poison and disease.",
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.resistAll", mode: 0, value: "1" },
      { key: "system.traits.di.value", mode: 2, value: "poison" },
      { key: "system.traits.ci.value", mode: 2, value: "poisoned" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "system.attributes.movement.fly", mode: 5, value: "0" },
      { key: "system.attributes.movement.swim", mode: 5, value: "0" },
      { key: "system.attributes.movement.climb", mode: 5, value: "0" },
      { key: "system.attributes.movement.burrow", mode: 5, value: "0" },
    ],
  },

  // ── Poisoned ──────────────────────────────────────────────────────────────
  poisoned: {
    name: "Poisoned",
    icon: "icons/svg/poison.svg",
    statusId: "poisoned",
    description: "Disadvantage on attack rolls and ability checks.",
    changes: [
      { key: "flags.ace-qol.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.ability.check.all", mode: 0, value: "1" },
    ],
  },

  // ── Prone ─────────────────────────────────────────────────────────────────
  prone: {
    name: "Prone",
    icon: "icons/svg/falling.svg",
    statusId: "prone",
    description: "Disadvantage on attack rolls. Melee attacks within 5ft have advantage against the creature. Ranged attacks against have disadvantage. Must crawl or use half movement to stand.",
    changes: [
      { key: "flags.ace-qol.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.melee", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.disadvantage.attack.ranged", mode: 0, value: "1" },
    ],
  },

  // ── Restrained ────────────────────────────────────────────────────────────
  restrained: {
    name: "Restrained",
    icon: "icons/svg/net.svg",
    statusId: "restrained",
    description: "Speed becomes 0. Attack rolls have disadvantage. Attacks against have advantage. Disadvantage on DEX saves.",
    changes: [
      { key: "flags.ace-qol.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.save.dex", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "system.attributes.movement.fly", mode: 5, value: "0" },
      { key: "system.attributes.movement.swim", mode: 5, value: "0" },
      { key: "system.attributes.movement.climb", mode: 5, value: "0" },
      { key: "system.attributes.movement.burrow", mode: 5, value: "0" },
    ],
  },

  // ── Stunned ───────────────────────────────────────────────────────────────
  stunned: {
    name: "Stunned",
    icon: "icons/svg/daze.svg",
    statusId: "stunned",
    description: "Incapacitated. Can't move, can only speak falteringly. Auto-fails STR and DEX saves. Attacks against have advantage.",
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
    ],
  },

  // ── Unconscious ───────────────────────────────────────────────────────────
  unconscious: {
    name: "Unconscious",
    icon: "icons/svg/unconscious.svg",
    statusId: "unconscious",
    description: "Incapacitated. Can't move or speak. Unaware of surroundings. Drops held items, falls prone. Auto-fails STR/DEX saves. Attacks have advantage. Melee hits within 5ft are auto-crits.",
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.autoCrit.melee", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "system.attributes.movement.fly", mode: 5, value: "0" },
      { key: "system.attributes.movement.swim", mode: 5, value: "0" },
      { key: "system.attributes.movement.climb", mode: 5, value: "0" },
      { key: "system.attributes.movement.burrow", mode: 5, value: "0" },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SPELL EFFECTS — 30+ most-used buffs and debuffs
// ═══════════════════════════════════════════════════════════════════════════════

const SPELL_EFFECTS = {

  // ── Bless (1st level, concentration) ──────────────────────────────────────
  bless: {
    name: "Bless",
    icon: "icons/magic/holy/prayer-hands-glowing-yellow.webp",
    description: "+1d4 to attack rolls and saving throws for up to 3 creatures.",
    changes: [
      { key: "system.bonuses.mwak.attack", mode: 2, value: "+1d4" },
      { key: "system.bonuses.rwak.attack", mode: 2, value: "+1d4" },
      { key: "system.bonuses.msak.attack", mode: 2, value: "+1d4" },
      { key: "system.bonuses.rsak.attack", mode: 2, value: "+1d4" },
      { key: "system.bonuses.abilities.save", mode: 2, value: "+1d4" },
    ],
    concentration: true,
    duration: { rounds: 100 }, // 1 minute = 10 rounds, but listed as up to 1 min
  },

  // ── Bane (1st level, concentration) ───────────────────────────────────────
  bane: {
    name: "Bane",
    icon: "icons/magic/unholy/strike-hand-glow-pink.webp",
    description: "-1d4 to attack rolls and saving throws (CHA save negates).",
    changes: [
      { key: "system.bonuses.mwak.attack", mode: 2, value: "-1d4" },
      { key: "system.bonuses.rwak.attack", mode: 2, value: "-1d4" },
      { key: "system.bonuses.msak.attack", mode: 2, value: "-1d4" },
      { key: "system.bonuses.rsak.attack", mode: 2, value: "-1d4" },
      { key: "system.bonuses.abilities.save", mode: 2, value: "-1d4" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Shield of Faith (1st level, concentration) ────────────────────────────
  shield_of_faith: {
    name: "Shield of Faith",
    icon: "icons/magic/defensive/shield-barrier-glowing-blue.webp",
    description: "+2 bonus to AC for the duration.",
    changes: [
      { key: "system.attributes.ac.bonus", mode: 2, value: "+2" },
    ],
    concentration: true,
    duration: { rounds: 100 }, // 10 minutes
  },

  // ── Heroism (1st level, concentration) ────────────────────────────────────
  heroism: {
    name: "Heroism",
    icon: "icons/magic/holy/angel-wings-gray.webp",
    description: "Immune to frightened. Gains temp HP equal to caster's spellcasting modifier at the start of each turn.",
    changes: [
      { key: "system.traits.ci.value", mode: 2, value: "frightened" },
      { key: "flags.ace-qol.heroism", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Haste (3rd level, concentration) ──────────────────────────────────────
  haste: {
    name: "Haste",
    icon: "icons/magic/control/buff-flight-wings-blue.webp",
    description: "Double speed, +2 AC, advantage on DEX saves, additional action (Attack/Dash/Disengage/Hide/Use Object). Lethargy on end.",
    changes: [
      { key: "system.attributes.movement.walk", mode: 1, value: "2" },
      { key: "system.attributes.ac.bonus", mode: 2, value: "+2" },
      { key: "flags.ace-qol.advantage.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.haste", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Slow (3rd level, concentration) ───────────────────────────────────────
  slow: {
    name: "Slow",
    icon: "icons/magic/time/hourglass-yellow-green.webp",
    description: "Halved speed, -2 AC, -2 DEX saves, can't use reactions. On turn: action or bonus action, not both. Spells require 2 turns to cast.",
    changes: [
      { key: "system.attributes.movement.walk", mode: 1, value: "0.5" },
      { key: "system.attributes.ac.bonus", mode: 2, value: "-2" },
      { key: "system.abilities.dex.bonuses.save", mode: 2, value: "-2" },
      { key: "flags.ace-qol.slow", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Hold Person (2nd level, concentration) ────────────────────────────────
  hold_person: {
    name: "Hold Person",
    icon: "icons/magic/control/debuff-chains-blue.webp",
    description: "Target is paralyzed (WIS save negates). Repeat save at end of each turn.",
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.autoCrit.melee", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Hold Monster (5th level, concentration) ───────────────────────────────
  hold_monster: {
    name: "Hold Monster",
    icon: "icons/magic/control/debuff-chains-purple.webp",
    description: "Target is paralyzed (WIS save negates). Works on any creature. Repeat save at end of each turn.",
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.autoCrit.melee", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Hex (1st level, concentration) ────────────────────────────────────────
  hex: {
    name: "Hex",
    icon: "icons/magic/unholy/orb-glowing-purple.webp",
    description: "+1d6 necrotic damage on hits against hexed target. Disadvantage on one chosen ability check.",
    changes: [
      { key: "flags.ace-qol.hex", mode: 0, value: "1" },
      { key: "flags.ace-qol.bonusDamage.necrotic", mode: 0, value: "1d6" },
    ],
    concentration: true,
    duration: { rounds: 10 }, // 1 hour base, simplified
  },

  // ── Hunter's Mark (1st level, concentration) ──────────────────────────────
  hunters_mark: {
    name: "Hunter's Mark",
    icon: "icons/magic/perception/eye-ringed-green.webp",
    description: "+1d6 damage on weapon attacks against marked target. Advantage on Survival/Perception to find it.",
    changes: [
      { key: "flags.ace-qol.huntersMark", mode: 0, value: "1" },
      { key: "flags.ace-qol.bonusDamage.force", mode: 0, value: "1d6" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Faerie Fire (1st level, concentration) ────────────────────────────────
  faerie_fire: {
    name: "Faerie Fire",
    icon: "icons/magic/fire/flame-burning-hand-purple.webp",
    description: "Outlined in light. Attacks against have advantage. Can't benefit from being invisible. (DEX save negates.)",
    changes: [
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.noInvisible", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Darkness (2nd level, concentration) ───────────────────────────────────
  darkness: {
    name: "Darkness",
    icon: "icons/magic/unholy/orb-glowing-purple.webp",
    description: "Magical darkness fills a 15ft sphere. Creatures with darkvision can't see through it. Light spells of 2nd level or lower are dispelled.",
    changes: [
      { key: "flags.ace-qol.darkness", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 100 }, // 10 minutes
  },

  // ── Blur (2nd level, concentration) ───────────────────────────────────────
  blur: {
    name: "Blur",
    icon: "icons/magic/control/silhouette-fall-slip-prone.webp",
    description: "Attacks against you have disadvantage (unless attacker has truesight or can see through illusions).",
    changes: [
      { key: "flags.ace-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Mirror Image (2nd level, NOT concentration) ───────────────────────────
  mirror_image: {
    name: "Mirror Image",
    icon: "icons/magic/defensive/illusion-evasion-echo-purple.webp",
    description: "Three illusory duplicates. When attacked, random chance to hit a duplicate instead (AC 10 + DEX mod). Duplicates destroyed on hit.",
    changes: [
      { key: "flags.ace-qol.mirrorImage", mode: 0, value: "3" },
    ],
    concentration: false,
    duration: { rounds: 10 },
  },

  // ── Mage Armor (1st level, NOT concentration) ─────────────────────────────
  mage_armor: {
    name: "Mage Armor",
    icon: "icons/magic/defensive/shield-barrier-glowing-triangle-purple-orange.webp",
    description: "Base AC becomes 13 + DEX modifier (requires no armor).",
    changes: [
      { key: "system.attributes.ac.flat", mode: 5, value: "13" },
      { key: "flags.ace-qol.mageArmor", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 28800 }, // 8 hours
  },

  // ── Shield (1st level, reaction, NOT concentration) ───────────────────────
  shield: {
    name: "Shield",
    icon: "icons/magic/defensive/shield-barrier-flaming-pentagon-blue.webp",
    description: "+5 to AC until the start of your next turn, including against the triggering attack. Immune to magic missile.",
    changes: [
      { key: "system.attributes.ac.bonus", mode: 2, value: "+5" },
      { key: "flags.ace-qol.shieldSpell", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 }, // Until start of next turn
    specialDuration: "turnStartSource",
  },

  // ── Barkskin (2nd level, concentration) ───────────────────────────────────
  barkskin: {
    name: "Barkskin",
    icon: "icons/magic/nature/root-vine-entangled-hand.webp",
    description: "Target's AC can't be less than 16, regardless of armor.",
    changes: [
      { key: "system.attributes.ac.flat", mode: 3, value: "16" },
    ],
    concentration: true,
    duration: { rounds: 10 }, // 1 hour
  },

  // ── Stoneskin (4th level, concentration) ──────────────────────────────────
  stoneskin: {
    name: "Stoneskin",
    icon: "icons/magic/earth/barrier-stone-brown-green.webp",
    description: "Resistance to nonmagical bludgeoning, piercing, and slashing damage.",
    changes: [
      { key: "system.traits.dr.value", mode: 2, value: "bludgeoning" },
      { key: "system.traits.dr.value", mode: 2, value: "piercing" },
      { key: "system.traits.dr.value", mode: 2, value: "slashing" },
      { key: "flags.ace-qol.stoneskin", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 }, // 1 hour
  },

  // ── Protection from Evil and Good (1st level, concentration) ──────────────
  protection_from_evil: {
    name: "Protection from Evil and Good",
    icon: "icons/magic/holy/barrier-shield-winged-cross.webp",
    description: "Aberrations, celestials, elementals, fey, fiends, and undead have disadvantage on attacks against the target. Target can't be charmed, frightened, or possessed by them.",
    changes: [
      { key: "flags.ace-qol.protectionFromEvil", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 100 }, // 10 minutes
  },

  // ── Enlarge (from Enlarge/Reduce, 2nd level, concentration) ───────────────
  enlarge: {
    name: "Enlarge",
    icon: "icons/magic/control/buff-strength-muscle-damage-red.webp",
    description: "Size doubles. Advantage on STR checks and saves. +1d4 weapon damage.",
    changes: [
      { key: "flags.ace-qol.advantage.ability.check.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.advantage.save.str", mode: 0, value: "1" },
      { key: "system.bonuses.mwak.damage", mode: 2, value: "+1d4" },
      { key: "system.bonuses.rwak.damage", mode: 2, value: "+1d4" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Reduce (from Enlarge/Reduce, 2nd level, concentration) ────────────────
  reduce: {
    name: "Reduce",
    icon: "icons/magic/control/debuff-chains-green.webp",
    description: "Size halves. Disadvantage on STR checks and saves. -1d4 weapon damage.",
    changes: [
      { key: "flags.ace-qol.disadvantage.ability.check.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.disadvantage.save.str", mode: 0, value: "1" },
      { key: "system.bonuses.mwak.damage", mode: 2, value: "-1d4" },
      { key: "system.bonuses.rwak.damage", mode: 2, value: "-1d4" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Fly (3rd level, concentration) ────────────────────────────────────────
  fly: {
    name: "Fly",
    icon: "icons/magic/control/buff-flight-wings-blue.webp",
    description: "Gain 60ft flying speed. Falls when spell ends.",
    changes: [
      { key: "system.attributes.movement.fly", mode: 5, value: "60" },
    ],
    concentration: true,
    duration: { rounds: 100 }, // 10 minutes
  },

  // ── Invisibility (2nd level, concentration) ───────────────────────────────
  invisibility: {
    name: "Invisibility",
    icon: "icons/magic/perception/eye-ringed-green.webp",
    description: "Target becomes invisible. Ends if the target attacks or casts a spell.",
    changes: [
      { key: "flags.ace-qol.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.invisible", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 }, // 1 hour
  },

  // ── Greater Invisibility (4th level, concentration) ───────────────────────
  greater_invisibility: {
    name: "Greater Invisibility",
    icon: "icons/magic/perception/shadow-stealth-eyes-purple.webp",
    description: "Target becomes invisible. Does NOT end on attack or spell.",
    changes: [
      { key: "flags.ace-qol.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.invisible", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Spirit Guardians (3rd level, concentration) ───────────────────────────
  spirit_guardians: {
    name: "Spirit Guardians",
    icon: "icons/magic/holy/saint-glass-portrait-halo.webp",
    description: "15ft radius: halves speed on entry, 3d8 radiant/necrotic damage (WIS save half) on enter or start of turn.",
    changes: [
      { key: "flags.ace-qol.spiritGuardians", mode: 0, value: "1" },
      { key: "flags.ace-qol.aura.damage", mode: 0, value: "3d8" },
      { key: "flags.ace-qol.aura.damageType", mode: 0, value: "radiant" },
      { key: "flags.ace-qol.aura.saveAbility", mode: 0, value: "wis" },
    ],
    concentration: true,
    duration: { rounds: 100 }, // 10 minutes
  },

  // ── Beacon of Hope (3rd level, concentration) ─────────────────────────────
  beacon_of_hope: {
    name: "Beacon of Hope",
    icon: "icons/magic/holy/prayer-hands-glowing-yellow.webp",
    description: "Advantage on WIS saves and death saves. Regain max HP from healing.",
    changes: [
      { key: "flags.ace-qol.advantage.save.wis", mode: 0, value: "1" },
      { key: "flags.ace-qol.advantage.save.death", mode: 0, value: "1" },
      { key: "flags.ace-qol.maxHealing", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Aura of Vitality (3rd level, concentration) ──────────────────────────
  aura_of_vitality: {
    name: "Aura of Vitality",
    icon: "icons/magic/holy/chalice-glowing-gold.webp",
    description: "30ft aura. Use bonus action to heal 2d6 HP to one creature in the aura.",
    changes: [
      { key: "flags.ace-qol.auraOfVitality", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Fire Shield (4th level, NOT concentration) ────────────────────────────
  fire_shield: {
    name: "Fire Shield",
    icon: "icons/magic/defensive/shield-barrier-flaming-pentagon-red.webp",
    description: "Resistance to cold (warm) or fire (chill). Melee attackers take 2d8 fire/cold damage. Sheds bright light 10ft, dim light 10ft.",
    changes: [
      { key: "system.traits.dr.value", mode: 2, value: "cold" },
      { key: "flags.ace-qol.fireShield", mode: 0, value: "warm" },
      { key: "flags.ace-qol.retaliationDamage", mode: 0, value: "2d8" },
      { key: "flags.ace-qol.retaliationDamageType", mode: 0, value: "fire" },
    ],
    concentration: false,
    duration: { rounds: 100 }, // 10 minutes
  },

  // ── Elemental Weapon (3rd level, concentration) ──────────────────────────
  elemental_weapon: {
    name: "Elemental Weapon",
    icon: "icons/magic/fire/dagger-rune-enchant-flame-blue.webp",
    description: "+1 to attack rolls, +1d4 elemental damage. Weapon becomes magical.",
    changes: [
      { key: "system.bonuses.mwak.attack", mode: 2, value: "+1" },
      { key: "system.bonuses.mwak.damage", mode: 2, value: "+1d4" },
      { key: "flags.ace-qol.elementalWeapon", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 }, // 1 hour
  },

  // ── Divine Favor (1st level, concentration) ───────────────────────────────
  divine_favor: {
    name: "Divine Favor",
    icon: "icons/magic/light/beam-strike-orange-gold.webp",
    description: "+1d4 radiant damage on weapon attacks.",
    changes: [
      { key: "system.bonuses.mwak.damage", mode: 2, value: "+1d4[radiant]" },
      { key: "system.bonuses.rwak.damage", mode: 2, value: "+1d4[radiant]" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Crusader's Mantle (3rd level, concentration) ─────────────────────────
  crusaders_mantle: {
    name: "Crusader's Mantle",
    icon: "icons/magic/holy/projectiles-blades-salvo-yellow.webp",
    description: "30ft aura: nonmagical weapon attacks deal an extra 1d4 radiant damage.",
    changes: [
      { key: "system.bonuses.mwak.damage", mode: 2, value: "+1d4[radiant]" },
      { key: "system.bonuses.rwak.damage", mode: 2, value: "+1d4[radiant]" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Smite spells (bonus action, concentration self-buffs that discharge ──
  //    on next melee weapon hit). The named-effect entries here are what the
  //    rider-engine's _hasConcentrationEffect looks for. No changes array
  //    needed — the rider-engine handles the discharge damage on hit.
  searing_smite: {
    name: "Searing Smite",
    icon: "icons/magic/fire/dagger-rune-enchant-flame-red.webp",
    description: "Next melee weapon hit deals extra fire damage. Save vs ignition (ongoing fire).",
    changes: [],
    concentration: true,
    duration: { minutes: 1 },
  },
  wrathful_smite: {
    name: "Wrathful Smite",
    icon: "icons/magic/control/fear-fright-shadow-monster-green.webp",
    description: "Next melee weapon hit deals extra psychic damage. WIS save or frightened.",
    changes: [],
    concentration: true,
    duration: { minutes: 1 },
  },
  thunderous_smite: {
    name: "Thunderous Smite",
    icon: "icons/magic/sonic/explosion-shock-wave-teal.webp",
    description: "Next melee weapon hit deals extra thunder damage. STR save or pushed + prone.",
    changes: [],
    concentration: true,
    duration: { minutes: 1 },
  },
  blinding_smite: {
    name: "Blinding Smite",
    icon: "icons/magic/light/beam-rays-yellow-blue.webp",
    description: "Next melee weapon hit deals extra radiant damage. CON save or blinded.",
    changes: [],
    concentration: true,
    duration: { minutes: 1 },
  },
  staggering_smite: {
    name: "Staggering Smite",
    icon: "icons/magic/control/silhouette-aura-energy.webp",
    description: "Next melee weapon hit deals extra psychic damage. WIS save or disadvantage on attacks/checks.",
    changes: [],
    concentration: true,
    duration: { minutes: 1 },
  },
  banishing_smite: {
    name: "Banishing Smite",
    icon: "icons/magic/holy/projectiles-blades-salvo-yellow.webp",
    description: "Next melee weapon hit deals extra force damage. Target ≤50 HP is banished to home plane.",
    changes: [],
    concentration: true,
    duration: { minutes: 1 },
  },

  // ── Dodge (action, not a spell but commonly needed) ───────────────────────
  dodge: {
    name: "Dodge",
    icon: "icons/svg/wing.svg",
    description: "Dodge action: attacks against you have disadvantage. Advantage on DEX saves. Lost if incapacitated or speed drops to 0.",
    changes: [
      { key: "flags.ace-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.advantage.save.dex", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },
    specialDuration: "turnStartSource",
  },

  // ── Sanctuary (1st level, bonus action) ───────────────────────────────────
  sanctuary: {
    name: "Sanctuary",
    icon: "icons/magic/holy/barrier-shield-winged-cross.webp",
    description: "Creatures targeting the warded creature must make a WIS save or choose a new target/lose the attack.",
    changes: [
      { key: "flags.ace-qol.sanctuary", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 10 },
  },

  // ── Longstrider (1st level) ───────────────────────────────────────────────
  longstrider: {
    name: "Longstrider",
    icon: "icons/magic/movement/trail-streak-impact-blue.webp",
    description: "+10ft walking speed for 1 hour.",
    changes: [
      { key: "system.attributes.movement.walk", mode: 2, value: "10" },
    ],
    concentration: false,
    duration: { seconds: 3600 },
  },

  // ── Freedom of Movement (4th level) ───────────────────────────────────────
  freedom_of_movement: {
    name: "Freedom of Movement",
    icon: "icons/magic/movement/abstract-ribbons-red-orange.webp",
    description: "Immune to paralyzed and restrained conditions. Difficult terrain costs no extra movement. Can spend 5ft to escape nonmagical restraints/grapples.",
    changes: [
      { key: "system.traits.ci.value", mode: 2, value: "paralyzed" },
      { key: "system.traits.ci.value", mode: 2, value: "restrained" },
      { key: "system.traits.ci.value", mode: 2, value: "grappled" },
      { key: "flags.ace-qol.freedomOfMovement", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 3600 },
  },

  // ── Death Ward (4th level) ────────────────────────────────────────────────
  death_ward: {
    name: "Death Ward",
    icon: "icons/magic/holy/barrier-shield-winged-cross.webp",
    description: "First time the target drops to 0 HP, it drops to 1 HP instead. Also negates instant-death effects once.",
    changes: [
      { key: "flags.ace-qol.deathWard", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 28800 }, // 8 hours
  },

  // ── Warding Bond (2nd level) ──────────────────────────────────────────────
  warding_bond: {
    name: "Warding Bond",
    icon: "icons/magic/defensive/shield-barrier-glowing-triangle-orange.webp",
    description: "+1 to AC and saving throws. Resistance to all damage. Caster takes same damage as target.",
    changes: [
      { key: "system.attributes.ac.bonus", mode: 2, value: "+1" },
      { key: "system.bonuses.abilities.save", mode: 2, value: "+1" },
      { key: "flags.ace-qol.resistAll", mode: 0, value: "1" },
      { key: "flags.ace-qol.wardingBond", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 3600 },
  },

  // ─── v0.7.20 PHASE 2.5 — additional spell effect keys for save-single + self pipeline ───

  // ── Aid (2nd level, 8 hours, NOT concentration) ──
  aid: {
    name: "Aid",
    icon: "icons/magic/light/beam-rays-yellow.webp",
    description: "Max HP and current HP +5 (more at higher levels). Lasts 8 hours.",
    changes: [
      { key: "system.attributes.hp.tempmax", mode: 2, value: "+5" },
      { key: "system.attributes.hp.bonuses.overall", mode: 2, value: "+5" },
    ],
    concentration: false,
    duration: { seconds: 28800 },
  },

  // ── Charm Person (1st level, 1 hour, NOT concentration) ──
  charm_person: {
    name: "Charmed by Caster",
    icon: "icons/magic/control/silhouette-grow-shrink-blue.webp",
    description: "Charmed by the caster — treats them as a friendly acquaintance. Ends if harmed.",
    statuses: ["charmed"],
    changes: [
      { key: "flags.ace-qol.charmedByCaster", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 3600 },
  },

  // ── Suggestion (2nd level, 8 hours, concentration) ──
  suggestion: {
    name: "Suggestion",
    icon: "icons/magic/control/mouth-smile-deception-purple.webp",
    description: "Magically influenced to follow a course of action. Ends if asked to do something harmful.",
    statuses: ["charmed"],
    changes: [
      { key: "flags.ace-qol.suggestionActive", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { seconds: 28800 },
  },

  // ── Banishment (4th level, 1 min, concentration) ──
  banishment: {
    name: "Banished",
    icon: "icons/magic/movement/portal-vortex-orange.webp",
    description: "Banished to a harmless demiplane. Incapacitated and unable to be targeted.",
    statuses: ["incapacitated"],
    changes: [
      { key: "flags.ace-qol.banished", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Polymorph (4th level, 1 hour, concentration) ──
  polymorph: {
    name: "Polymorphed",
    icon: "icons/magic/nature/wolf-paw-glow-teal-blue.webp",
    description: "Transformed into a beast of CR equal to your level or lower. New stats but retain alignment, personality, Int/Wis/Cha.",
    changes: [
      { key: "flags.ace-qol.polymorphed", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { seconds: 3600 },
  },

  // ── Dominate Person (5th level, 1 min, concentration) ──
  dominate_person: {
    name: "Dominated by Caster",
    icon: "icons/magic/control/hypnosis-mesmerism-eye-tan.webp",
    description: "Charmed and follows caster's mental commands. New save when taking damage.",
    statuses: ["charmed"],
    changes: [
      { key: "flags.ace-qol.dominatedByCaster", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Dominate Monster (8th level, 1 hour, concentration) ──
  dominate_monster: {
    name: "Dominated (Monster)",
    icon: "icons/magic/control/hypnosis-mesmerism-eye.webp",
    description: "Any creature is charmed and follows caster's mental commands. New save when taking damage.",
    statuses: ["charmed"],
    changes: [
      { key: "flags.ace-qol.dominatedByCaster", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { seconds: 3600 },
  },

  // ── Feeblemind (8th level, until cured) ──
  feeblemind: {
    name: "Feebleminded",
    icon: "icons/magic/control/silhouette-aura-energy.webp",
    description: "Int and Cha drop to 1. Can't cast spells, activate magic items, understand language, or communicate intelligibly.",
    changes: [
      { key: "system.abilities.int.value", mode: 5, value: "1" },
      { key: "system.abilities.cha.value", mode: 5, value: "1" },
      { key: "flags.ace-qol.feebleminded", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 86400 * 30 },  // until cured (~30 days placeholder)
  },

  // ── Tasha's Hideous Laughter (1st level, 1 min, concentration) ──
  tashas_hideous_laughter: {
    name: "Tasha's Hideous Laughter",
    icon: "icons/magic/control/buff-strength-muscle-damage.webp",
    description: "Falls prone and is incapacitated, unable to stand, due to uncontrollable laughter.",
    statuses: ["prone", "incapacitated"],
    changes: [
      { key: "flags.ace-qol.proneIncapacitated", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Crown of Madness (2nd level, 1 min, concentration) ──
  crown_of_madness: {
    name: "Crown of Madness",
    icon: "icons/magic/control/fear-fright-monster-purple-blue.webp",
    description: "Wears a twisted iron crown. On its turn, must use action to attack a creature the caster chooses.",
    statuses: ["charmed"],
    changes: [
      { key: "flags.ace-qol.crownOfMadness", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Bestow Curse (3rd level, 1 min, concentration) ──
  bestow_curse: {
    name: "Cursed",
    icon: "icons/magic/death/skull-energy-light-purple.webp",
    description: "Cursed — disadvantage on chosen-ability checks/saves, or attacks vs caster have advantage, or various other curses.",
    changes: [
      { key: "flags.ace-qol.cursed", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Fly (3rd level, 10 min, concentration) — when cast on someone else ──
  fly: {
    name: "Fly",
    icon: "icons/magic/control/buff-flight-wings-blue.webp",
    description: "Flying speed of 60 ft for the duration. Falls if concentration breaks while aloft.",
    changes: [
      { key: "system.attributes.movement.fly", mode: 5, value: "60" },
      { key: "flags.ace-qol.canFly", mode: 0, value: "1" },
    ],
    concentration: true,
    duration: { rounds: 100 },
  },

  // ── Foresight (9th level, 8 hours, NOT concentration) ──
  foresight: {
    name: "Foresight",
    icon: "icons/magic/perception/orb-eye-scrying.webp",
    description: "Advantage on attacks, ability checks, and saves. Attackers have disadvantage. Can't be surprised.",
    changes: [
      { key: "flags.midi-qol.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.midi-qol.advantage.ability.check.all", mode: 0, value: "1" },
      { key: "flags.midi-qol.advantage.ability.save.all", mode: 0, value: "1" },
      { key: "flags.midi-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.foresightActive", mode: 0, value: "1" },
      { key: "flags.ace-qol.cantBeSurprised", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 28800 },
  },

  // ─── v0.7.20 PHASE 3.A — minimal effect entries for long-tail spells ───
  // These are bare-minimum entries (name, icon, duration). Full mechanical
  // changes can be added later via the nullification registry. The name
  // matches what the nullification walker looks for.

  true_strike: {
    name: "True Strike",
    icon: "icons/magic/perception/eye-slit-pink.webp",
    description: "Advantage on next attack against the target.",
    changes: [{ key: "flags.ace-qol.trueStrike", mode: 0, value: "1" }],
    concentration: true, duration: { rounds: 1 },
  },
  detect_magic: {
    name: "Detect Magic", icon: "icons/magic/perception/eye-ringed-green.webp",
    description: "Sense magic within 30 ft.",
    changes: [], concentration: true, duration: { rounds: 100 },
  },
  detect_evil_and_good: {
    name: "Detect Evil and Good", icon: "icons/magic/perception/orb-eye-scrying.webp",
    description: "Sense aberrations, celestials, elementals, fey, fiends, undead within 30 ft.",
    changes: [], concentration: true, duration: { rounds: 100 },
  },
  see_invisibility: {
    name: "See Invisibility", icon: "icons/magic/perception/eye-ringed-green.webp",
    description: "See invisible creatures and objects.",
    changes: [{ key: "flags.ace-qol.seesInvisible", mode: 0, value: "1" }],
    concentration: false, duration: { rounds: 100 },
  },
  comprehend_languages: {
    name: "Comprehend Languages", icon: "icons/skills/social/diplomacy-handshake-yellow.webp",
    description: "Understand any spoken language.",
    changes: [], concentration: false, duration: { rounds: 600 },
  },
  disguise_self: {
    name: "Disguise Self", icon: "icons/magic/control/silhouette-grow-shrink-blue.webp",
    description: "Appearance changes to fit your wishes.",
    changes: [], concentration: false, duration: { rounds: 600 },
  },
  longstrider: {
    name: "Longstrider", icon: "icons/skills/movement/figure-running-gray.webp",
    description: "+10 ft movement speed.",
    changes: [{ key: "system.attributes.movement.walk", mode: 2, value: "+10" }],
    concentration: false, duration: { rounds: 600 },
  },
  spider_climb: {
    name: "Spider Climb", icon: "icons/creatures/invertebrates/spider-mandibles-brown.webp",
    description: "Climbing speed equal to walking speed; can climb difficult surfaces.",
    changes: [{ key: "system.attributes.movement.climb", mode: 5, value: "30" }],
    concentration: true, duration: { rounds: 600 },
  },
  misty_step: {
    name: "Misty Step", icon: "icons/magic/movement/abstract-ribbons-red-orange.webp",
    description: "Teleport up to 30 ft.",
    changes: [], concentration: false, duration: { rounds: 0 },
  },
  dimension_door: {
    name: "Dimension Door", icon: "icons/magic/movement/portal-vortex-orange.webp",
    description: "Teleport up to 500 ft.",
    changes: [], concentration: false, duration: { rounds: 0 },
  },
  death_ward: {
    name: "Death Ward", icon: "icons/magic/holy/chalice-glowing-gold.webp",
    description: "Next reduction to 0 HP becomes 1 HP instead. Spell ends after triggering.",
    changes: [{ key: "flags.ace-qol.deathWard", mode: 0, value: "1" }],
    concentration: false, duration: { seconds: 28800 },
  },
  mind_blank: {
    name: "Mind Blank", icon: "icons/magic/control/silhouette-aura-energy.webp",
    description: "Immune to psychic damage, charmed, and mind-reading.",
    changes: [
      { key: "system.traits.di.value", mode: 2, value: "psychic" },
      { key: "system.traits.ci.value", mode: 2, value: "charmed" },
      { key: "flags.ace-qol.mindBlankActive", mode: 0, value: "1" },
    ],
    concentration: false, duration: { seconds: 86400 },
  },
  etherealness: {
    name: "Etherealness", icon: "icons/magic/movement/portal-vortex-orange.webp",
    description: "Step into the Ethereal Plane.",
    changes: [{ key: "flags.ace-qol.ethereal", mode: 0, value: "1" }],
    concentration: false, duration: { seconds: 28800 },
  },
  time_stop: {
    name: "Time Stop", icon: "icons/magic/time/clock-spinning-gold-pink.webp",
    description: "1d4+1 additional turns in a row.",
    changes: [], concentration: false, duration: { rounds: 5 },
  },
  haste: {
    name: "Haste", icon: "icons/magic/time/clock-stopwatch-white-blue.webp",
    description: "Speed doubled, +2 AC, advantage on Dex saves, +1 action per turn.",
    changes: [
      { key: "system.attributes.ac.bonus", mode: 2, value: "+2" },
      { key: "flags.ace-qol.hasted", mode: 0, value: "1" },
    ],
    concentration: true, duration: { rounds: 10 },
  },
  haste_lethargy: {
    name: "Haste Lethargy",
    icon: "icons/magic/time/hourglass-tilted-gray.webp",
    description: "Can't move or take actions until the end of the next turn — the post-Haste lethargy crashes through them (PHB Haste).",
    statuses: ["incapacitated"],
    changes: [
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "flags.ace-qol.hasteLethargy", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },  // until end of next turn
  },
  pass_without_trace: {
    name: "Pass Without Trace", icon: "icons/skills/movement/feet-spurred-boots-brown.webp",
    description: "+10 Stealth, leave no trace.",
    changes: [{ key: "system.skills.ste.bonuses.check", mode: 2, value: "+10" }],
    concentration: true, duration: { rounds: 600 },
  },
  resistance: {
    name: "Resistance", icon: "icons/magic/defensive/shield-barrier-flaming-pentagon-blue.webp",
    description: "Add 1d4 to one saving throw.",
    changes: [{ key: "system.bonuses.abilities.save", mode: 2, value: "+1d4" }],
    concentration: true, duration: { rounds: 10 },
  },
  guidance: {
    name: "Guidance", icon: "icons/magic/light/orb-shadow-blue.webp",
    description: "Add 1d4 to one ability check.",
    changes: [{ key: "system.bonuses.abilities.check", mode: 2, value: "+1d4" }],
    concentration: true, duration: { rounds: 10 },
  },
  heroes_feast: {
    name: "Heroes' Feast", icon: "icons/consumables/food/cooked-drumstick-turkey-brown.webp",
    description: "Immune to poison and fear. Advantage on Wisdom saves. Temp HP.",
    changes: [
      { key: "system.traits.ci.value", mode: 2, value: "poisoned" },
      { key: "system.traits.ci.value", mode: 2, value: "frightened" },
      { key: "system.traits.di.value", mode: 2, value: "poison" },
      { key: "flags.ace-qol.heroesFeast", mode: 0, value: "1" },
    ],
    concentration: false, duration: { seconds: 86400 },
  },
  tongues: {
    name: "Tongues", icon: "icons/skills/social/diplomacy-handshake-yellow.webp",
    description: "Understand and speak any spoken language.",
    changes: [], concentration: false, duration: { rounds: 600 },
  },
  water_breathing: {
    name: "Water Breathing", icon: "icons/magic/water/bubbles-air-water-blue.webp",
    description: "Breathe underwater.",
    changes: [{ key: "flags.ace-qol.waterBreathing", mode: 0, value: "1" }],
    concentration: false, duration: { seconds: 86400 },
  },
  magic_weapon: {
    name: "Magic Weapon", icon: "icons/weapons/swords/sword-runed-glowing.webp",
    description: "Weapon becomes magical with +1 (or +2/+3 at higher levels).",
    changes: [], concentration: true, duration: { rounds: 100 },
  },
  elemental_weapon: {
    name: "Elemental Weapon", icon: "icons/magic/fire/dagger-rune-enchant-flame-orange.webp",
    description: "Weapon becomes magical with +1 and +1d4 elemental damage (more at higher levels).",
    changes: [], concentration: true, duration: { rounds: 100 },
  },
  crusaders_mantle: {
    name: "Crusader's Mantle", icon: "icons/magic/light/beam-rays-yellow.webp",
    description: "30 ft aura grants +1d4 radiant damage to allies' weapon attacks.",
    changes: [{ key: "flags.ace-qol.crusadersMantleActive", mode: 0, value: "1" }],
    concentration: true, duration: { rounds: 10 },
  },
  spirit_shroud: {
    name: "Spirit Shroud", icon: "icons/magic/death/projectile-skull-flaming-yellow.webp",
    description: "+1d8 radiant/necrotic/cold damage to attacks within 10 ft.",
    changes: [{ key: "flags.ace-qol.spiritShroudActive", mode: 0, value: "1" }],
    concentration: true, duration: { rounds: 10 },
  },
  maze: {
    name: "Maze", icon: "icons/magic/movement/portal-vortex-orange.webp",
    description: "Banished to a labyrinthine demiplane.",
    statuses: ["incapacitated"],
    changes: [{ key: "flags.ace-qol.maze", mode: 0, value: "1" }],
    concentration: true, duration: { rounds: 100 },
  },
  imprisonment: {
    name: "Imprisoned", icon: "icons/magic/control/debuff-chains-shackles-movement-blue.webp",
    description: "Magically imprisoned. Lasts until the spell is dispelled.",
    statuses: ["paralyzed"],
    changes: [{ key: "flags.ace-qol.imprisoned", mode: 0, value: "1" }],
    concentration: false, duration: { seconds: 86400 * 365 },
  },
  geas: {
    name: "Geas", icon: "icons/magic/control/debuff-chains-shackles-movement-purple.webp",
    description: "Compelled to carry out or refrain from a course of action. Takes psychic damage if violated.",
    changes: [{ key: "flags.ace-qol.geas", mode: 0, value: "1" }],
    concentration: false, duration: { seconds: 86400 * 30 },
  },
  modify_memory: {
    name: "Modify Memory", icon: "icons/magic/control/silhouette-aura-energy.webp",
    description: "Up to 10 minutes of memory modified.",
    changes: [], concentration: false, duration: { rounds: 0 },
  },
  power_word_stun: {
    name: "Power Word Stun", icon: "icons/magic/lightning/bolt-beam-strike-blue.webp",
    description: "Stunned. CON save at end of each turn to recover.",
    statuses: ["stunned"],
    changes: [{ key: "flags.ace-qol.powerWordStun", mode: 0, value: "1" }],
    concentration: false, duration: { rounds: 10 },
  },
  dead: {
    name: "Dead", icon: "icons/svg/skull.svg",
    description: "Killed by magic.",
    statuses: ["dead"],
    changes: [], concentration: false, duration: { rounds: 0 },
  },
  unconscious: {
    name: "Unconscious (Sleep)", icon: "icons/svg/unconscious.svg",
    description: "Magically asleep. Damage from any source wakes target.",
    statuses: ["unconscious"],
    changes: [], concentration: false, duration: { rounds: 10 },
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
//  CLASS FEATURE EFFECTS — Rage, Reckless, Sneak Attack, etc.
// ═══════════════════════════════════════════════════════════════════════════════

const FEATURE_EFFECTS = {

  // ── Barbarian: Rage ───────────────────────────────────────────────────────
  rage: {
    name: "Rage",
    icon: "icons/skills/melee/strike-sword-blood-red.webp",
    description: "Advantage on STR checks/saves, +2 damage (scales with level), resistance to bludgeoning/piercing/slashing.",
    changes: [
      { key: "flags.ace-qol.advantage.ability.check.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.advantage.save.str", mode: 0, value: "1" },
      { key: "system.bonuses.mwak.damage", mode: 2, value: "+2" },
      { key: "system.traits.dr.value", mode: 2, value: "bludgeoning" },
      { key: "system.traits.dr.value", mode: 2, value: "piercing" },
      { key: "system.traits.dr.value", mode: 2, value: "slashing" },
    ],
    concentration: false,
    duration: { rounds: 10 },
  },

  // ── Barbarian: Reckless Attack ────────────────────────────────────────────
  reckless_attack: {
    name: "Reckless Attack",
    icon: "icons/skills/melee/strike-polearm-light-orange.webp",
    description: "Advantage on melee STR attack rolls this turn. Attacks against you have advantage until your next turn.",
    changes: [
      { key: "flags.ace-qol.advantage.attack.mwak", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },
    specialDuration: "turnStartSource",
  },

  // ── Rogue: Sneak Attack (marker flag — damage calculated by pipeline) ────
  sneak_attack: {
    name: "Sneak Attack",
    icon: "icons/skills/melee/strike-dagger-poison-green.webp",
    description: "Extra damage on attacks with advantage or when ally is adjacent to target. Damage scales with rogue level.",
    changes: [
      { key: "flags.ace-qol.sneakAttack", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },
    specialDuration: "turnStartSource",
  },

  // ── Paladin: Divine Smite (marker — damage handled by rider engine) ──────
  divine_smite: {
    name: "Divine Smite",
    icon: "icons/magic/light/explosion-star-glow-yellow.webp",
    description: "Expend spell slot for +2d8 radiant (+1d8 per slot above 1st, +1d8 vs undead/fiend). Max 5d8.",
    changes: [
      { key: "flags.ace-qol.divineSmite", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 0 },
  },

  // ── Monk: Patient Defense ─────────────────────────────────────────────────
  patient_defense: {
    name: "Patient Defense",
    icon: "icons/magic/defensive/shield-barrier-glowing-blue.webp",
    description: "Take the Dodge action as a bonus action. Attacks against have disadvantage, advantage on DEX saves.",
    changes: [
      { key: "flags.ace-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.advantage.save.dex", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },
    specialDuration: "turnStartSource",
  },

  // ── Monk: Stunning Strike (marker — condition applied on failed save) ────
  stunning_strike: {
    name: "Stunning Strike",
    icon: "icons/skills/melee/strike-blade-knife-blue-red.webp",
    description: "On hit, target must make CON save or be stunned until the end of your next turn.",
    changes: [
      { key: "flags.ace-qol.stunningStrike", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },
    specialDuration: "turnEndSource",
  },

  // ── Fighter: Action Surge (marker) ────────────────────────────────────────
  action_surge: {
    name: "Action Surge",
    icon: "icons/skills/melee/blade-tips-triple-steel.webp",
    description: "One additional action this turn.",
    changes: [
      { key: "flags.ace-qol.actionSurge", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 0 },
  },

  // ── Fighter: Second Wind (marker) ─────────────────────────────────────────
  second_wind: {
    name: "Second Wind",
    icon: "icons/magic/life/heart-cross-strong-blue.webp",
    description: "Regain 1d10 + fighter level HP as a bonus action.",
    changes: [
      { key: "flags.ace-qol.secondWind", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 0 },
  },

  // ── Paladin: Aura of Protection ──────────────────────────────────────────
  aura_of_protection: {
    name: "Aura of Protection",
    icon: "icons/magic/holy/barrier-shield-winged-blue.webp",
    description: "+CHA modifier to all saving throws for allies within 10ft (30ft at 18th level).",
    changes: [
      { key: "system.bonuses.abilities.save", mode: 2, value: "+@abilities.cha.mod" },
    ],
    concentration: false,
    duration: { seconds: -1 }, // Permanent while active
  },

  // ── Druid: Wild Shape (marker) ────────────────────────────────────────────
  wild_shape: {
    name: "Wild Shape",
    icon: "icons/magic/nature/wolf-paw-glow-teal-blue.webp",
    description: "Transform into a beast form. Stats replaced by beast stats. Revert when form's HP reaches 0.",
    changes: [
      { key: "flags.ace-qol.wildShape", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: 7200 }, // scales with level, 2 hours base
  },

  // ── Ranger: Favored Foe (TCoE optional) ──────────────────────────────────
  favored_foe: {
    name: "Favored Foe",
    icon: "icons/magic/perception/eye-ringed-green.webp",
    description: "Mark a creature: first hit each turn deals +1d4 damage (scales: 1d6 at 6th, 1d8 at 14th).",
    changes: [
      { key: "flags.ace-qol.favoredFoe", mode: 0, value: "1" },
      { key: "flags.ace-qol.bonusDamage.none", mode: 0, value: "1d4" },
    ],
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Cleric: Blessed Strikes ──────────────────────────────────────────────
  blessed_strikes: {
    name: "Blessed Strikes",
    icon: "icons/magic/light/explosion-star-glow-yellow.webp",
    description: "+1d8 radiant damage once per turn on weapon attack or cantrip damage.",
    changes: [
      { key: "flags.ace-qol.blessedStrikes", mode: 0, value: "1" },
      { key: "flags.ace-qol.bonusDamage.radiant", mode: 0, value: "1d8" },
    ],
    concentration: false,
    duration: { seconds: -1 },
  },

  // ── Warlock: Hex Warrior ─────────────────────────────────────────────────
  hex_warrior: {
    name: "Hex Warrior",
    icon: "icons/skills/melee/weapons-crossed-swords-purple.webp",
    description: "Use CHA instead of STR/DEX for weapon attacks with a chosen weapon. Proficiency with medium armor, shields, martial weapons.",
    changes: [
      { key: "flags.ace-qol.hexWarrior", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { seconds: -1 },
  },

  // ── Sorcerer: Twinned Spell (marker) ─────────────────────────────────────
  twinned_spell: {
    name: "Twinned Spell",
    icon: "icons/magic/symbols/runes-star-magenta.webp",
    description: "Spend sorcery points to target a second creature with a single-target spell.",
    changes: [
      { key: "flags.ace-qol.twinnedSpell", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 0 },
  },
};


// ═══════════════════════════════════════════════════════════════════════════════
//  COMBINED REGISTRY — all effects indexed by key
// ═══════════════════════════════════════════════════════════════════════════════

const ALL_EFFECTS = {};
for (const [key, def] of Object.entries(CONDITIONS))       ALL_EFFECTS[key] = { ...def, category: "condition" };
for (const [key, def] of Object.entries(SPELL_EFFECTS))    ALL_EFFECTS[key] = { ...def, category: "spell" };
for (const [key, def] of Object.entries(FEATURE_EFFECTS))  ALL_EFFECTS[key] = { ...def, category: "feature" };


// ═══════════════════════════════════════════════════════════════════════════════
//  ConditionLibrary — Public API
// ═══════════════════════════════════════════════════════════════════════════════

export class ConditionLibrary {

  // ─── Lookup ─────────────────────────────────────────────────────────────

  /**
   * Get a condition/effect definition by key.
   * @param {string} key — e.g., "blinded", "bless", "rage"
   * @returns {object|null} — the effect definition or null if not found
   */
  static get(key) {
    return ALL_EFFECTS[key] ?? null;
  }

  /**
   * Get all SRD condition definitions.
   * @returns {object} — { blinded: {...}, charmed: {...}, ... }
   */
  static getAllConditions() {
    return { ...CONDITIONS };
  }

  /**
   * Get all spell effect definitions.
   * @returns {object} — { bless: {...}, bane: {...}, ... }
   */
  static getAllSpellEffects() {
    return { ...SPELL_EFFECTS };
  }

  /**
   * Get all class feature effect definitions.
   * @returns {object} — { rage: {...}, reckless_attack: {...}, ... }
   */
  static getAllFeatureEffects() {
    return { ...FEATURE_EFFECTS };
  }

  /**
   * Get every registered effect.
   * @returns {object} — all effects keyed by their lookup key
   */
  static getAll() {
    return { ...ALL_EFFECTS };
  }

  // ─── Apply / Remove / Toggle ───────────────────────────────────────────

  /**
   * Apply an effect to an actor. Creates the Active Effect with all correct
   * changes, duration, flags, and status.
   *
   * @param {Actor} actor — the target actor
   * @param {string} key — e.g., "blinded", "bless", "rage"
   * @param {object} [options={}] — optional overrides
   * @param {object} [options.duration] — override duration { rounds, turns, seconds }
   * @param {string} [options.origin] — origin UUID (e.g., caster's item UUID)
   * @param {boolean} [options.overlay] — show as overlay on token (default false)
   * @param {number} [options.combatRound] — current combat round for duration stamping
   * @param {number} [options.combatTurn] — current combat turn for duration stamping
   * @returns {ActiveEffect|null} — the created effect, or null if definition not found
   */
  static async applyEffect(actor, key, options = {}) {
    const def = ALL_EFFECTS[key];
    if (!def) {
      console.warn(`${MODULE_ID} | ConditionLibrary: unknown effect key "${key}"`);
      return null;
    }

    // Resolve actual CONST values at runtime (not import time)
    const changes = def.changes.map(c => ({
      key: c.key,
      mode: c.mode,
      value: c.value,
      priority: c.priority ?? 20,
    }));

    // Build duration data
    const durationData = options.duration ?? def.duration ?? {};
    const combat = game.combat;
    const duration = {};
    if (durationData.rounds != null) duration.rounds = durationData.rounds;
    if (durationData.turns != null)  duration.turns = durationData.turns;
    if (durationData.seconds != null) duration.seconds = durationData.seconds;
    // Stamp combat start for tracking
    if (combat) {
      duration.startRound = options.combatRound ?? combat.round ?? 0;
      duration.startTurn  = options.combatTurn ?? combat.turn ?? 0;
      duration.combat     = combat.id;
    }

    // Build statuses set for conditions (links to Foundry's status system)
    const statuses = [];
    if (def.statusId) statuses.push(def.statusId);

    // Build the effect data
    const effectData = {
      name: def.name,
      icon: def.icon,
      origin: options.origin ?? null,
      changes,
      duration,
      statuses,
      flags: {
        [MODULE_ID]: {
          conditionKey: key,
          category: def.category,
          concentration: def.concentration ?? false,
          specialDuration: options.specialDuration ?? def.specialDuration ?? null,
          description: def.description,
        },
      },
    };

    // Overlay mode (big icon on token)
    if (options.overlay) {
      effectData.flags.core = { overlay: true };
    }

    // ── Same-key dedupe (RAW: same-name effects don't stack) ──
    // Casting Bless twice on the same target shouldn't create two +1d4
    // effects. The 5e rule is "the more potent effect applies; same effect
    // doesn't stack with itself". Replace any existing effect with the
    // same library key BEFORE creating the new one — that way:
    //   - Concentration timers reset (new caster takes over)
    //   - Source-actor / origin updates to the new caster
    //   - No duplicate +1d4 stacking
    // Pass `options.allowStack: true` to opt out (rare cases where dedupe
    // is wrong — none in the standard SRD library).
    if (!options.allowStack) {
      try {
        const existing = ConditionLibrary._findEffect(actor, key);
        if (existing) {
          await existing.delete();
          ConditionLibrary._debug(`Replaced existing "${def.name}" on ${actor.name} (dedupe)`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | applyEffect dedupe failed (non-fatal):`, err);
      }
    }

    // Create the effect
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    const effect = created?.[0] ?? null;

    if (effect) {
      ConditionLibrary._debug(`Applied "${def.name}" to ${actor.name} (key=${key})`);
    }

    return effect;
  }

  /**
   * Remove an effect from an actor by its library key.
   *
   * @param {Actor} actor — the target actor
   * @param {string} key — e.g., "blinded", "bless", "rage"
   * @returns {boolean} — true if an effect was removed
   */
  static async removeEffect(actor, key) {
    const effect = ConditionLibrary._findEffect(actor, key);
    if (!effect) {
      ConditionLibrary._debug(`No effect "${key}" found on ${actor.name} to remove`);
      return false;
    }

    await effect.delete();
    ConditionLibrary._debug(`Removed "${key}" from ${actor.name}`);
    return true;
  }

  /**
   * Toggle an effect on an actor — apply if absent, remove if present.
   *
   * @param {Actor} actor — the target actor
   * @param {string} key — e.g., "blinded", "bless", "rage"
   * @param {object} [options={}] — passed to applyEffect if applying
   * @returns {ActiveEffect|boolean} — the new effect if applied, true if removed, null/false on error
   */
  static async toggleEffect(actor, key, options = {}) {
    if (ConditionLibrary.hasEffect(actor, key)) {
      return await ConditionLibrary.removeEffect(actor, key);
    } else {
      return await ConditionLibrary.applyEffect(actor, key, options);
    }
  }

  /**
   * Check if an actor currently has an effect from this library.
   *
   * @param {Actor} actor — the actor to check
   * @param {string} key — e.g., "blinded", "bless", "rage"
   * @returns {boolean}
   */
  static hasEffect(actor, key) {
    return !!ConditionLibrary._findEffect(actor, key);
  }

  /**
   * Get the active effect instance on an actor, if it exists.
   *
   * @param {Actor} actor — the actor to check
   * @param {string} key — e.g., "blinded", "bless", "rage"
   * @returns {ActiveEffect|null}
   */
  static getEffect(actor, key) {
    return ConditionLibrary._findEffect(actor, key);
  }

  // ─── Search ─────────────────────────────────────────────────────────────

  /**
   * Search all effects by name (case-insensitive, partial match).
   *
   * @param {string} query — search term, e.g., "hold", "rage", "blind"
   * @returns {Array<{key: string, ...def}>} — matching effect definitions with their keys
   */
  static search(query) {
    if (!query) return [];
    const q = query.toLowerCase().trim();
    const results = [];

    for (const [key, def] of Object.entries(ALL_EFFECTS)) {
      const nameMatch = def.name.toLowerCase().includes(q);
      const keyMatch = key.includes(q);
      const descMatch = def.description?.toLowerCase().includes(q);
      if (nameMatch || keyMatch || descMatch) {
        results.push({ key, ...def });
      }
    }

    // Sort: exact name matches first, then key matches, then description matches
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === q ? 0 : 1;
      const bExact = b.name.toLowerCase() === q ? 0 : 1;
      return aExact - bExact || a.name.localeCompare(b.name);
    });

    return results;
  }

  // ─── Batch Operations ──────────────────────────────────────────────────

  /**
   * Apply multiple effects to an actor at once.
   *
   * @param {Actor} actor — the target actor
   * @param {string[]} keys — array of effect keys
   * @param {object} [options={}] — shared options for all effects
   * @returns {ActiveEffect[]} — array of created effects
   */
  static async applyMultiple(actor, keys, options = {}) {
    const results = [];
    for (const key of keys) {
      const effect = await ConditionLibrary.applyEffect(actor, key, options);
      if (effect) results.push(effect);
    }
    return results;
  }

  /**
   * Remove all library-managed effects from an actor.
   *
   * @param {Actor} actor — the target actor
   * @returns {number} — count of effects removed
   */
  static async removeAll(actor) {
    const toDelete = [];
    for (const effect of actor.effects) {
      if (effect.flags?.[MODULE_ID]?.conditionKey) {
        toDelete.push(effect.id);
      }
    }
    if (toDelete.length > 0) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", toDelete);
      ConditionLibrary._debug(`Removed ${toDelete.length} library effects from ${actor.name}`);
    }
    return toDelete.length;
  }

  // ─── API Registration ──────────────────────────────────────────────────

  /**
   * Register the ConditionLibrary on the module's public API.
   * Called during module ready.
   */
  static registerAPI() {
    const mod = game.modules.get(MODULE_ID);
    if (mod) {
      mod.api = { ...(mod.api ?? {}), conditions: ConditionLibrary };
      console.debug(`${MODULE_ID} | ConditionLibrary registered on module API`);
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────

  /**
   * Find an active effect on an actor by its library key.
   * Checks our custom flag first, then falls back to name matching.
   * @private
   */
  static _findEffect(actor, key) {
    if (!actor?.effects) return null;

    // Primary: match by our conditionKey flag
    for (const effect of actor.effects) {
      if (effect.flags?.[MODULE_ID]?.conditionKey === key) return effect;
    }

    // Fallback: match by statusId (for system-applied conditions)
    const def = ALL_EFFECTS[key];
    if (def?.statusId) {
      for (const effect of actor.effects) {
        if (effect.statuses?.has(def.statusId)) return effect;
      }
    }

    // Fallback: match by exact name
    if (def?.name) {
      for (const effect of actor.effects) {
        if (effect.name === def.name) return effect;
      }
    }

    return null;
  }

  /**
   * Apply a condition to an actor by name. Handles the exhaustion special
   * case correctly — exhaustion is a 1-6 LEVEL counter in 5e, not a binary
   * status, so a simple `toggleStatusEffect("exhaustion", {active:true})`
   * always sets it to level 1 (or removes it if already on). Sword of
   * Sharpness's "gains 1 Exhaustion level" rider needs INCREMENT, not toggle.
   *
   * For all other conditions, falls through to the standard Foundry
   * `actor.toggleStatusEffect(key, {active:true})` call.
   *
   * @param {Actor} actor
   * @param {string} conditionKey - lowercase condition name (e.g., "prone",
   *   "frightened", "exhaustion")
   * @returns {Promise<{ok: boolean, applied: string, level?: number}>}
   */
  static async applyByName(actor, conditionKey, options = {}) {
    if (!actor || !conditionKey) return { ok: false, applied: null };
    const key = String(conditionKey).toLowerCase().trim();

    // ── Exhaustion special case (edition-aware level cap) ──
    // 2014 RAW: 6-level model — clamp to 6.
    // 2024 RAW: 10-level model — clamp to 10.
    if (key === "exhaustion" || key.startsWith("exhaustion ")) {
      try {
        const current = Number(actor.system?.attributes?.exhaustion ?? 0);
        // Detect explicit level if the condition says "exhaustion 2", "exhaustion level 3" etc.
        const levelMatch = key.match(/exhaustion(?:\s+level)?\s*(\d+)/);
        const requestedLevel = levelMatch ? parseInt(levelMatch[1], 10) : (current + 1);
        const maxLevel = CombatState.getActiveEdition(actor) === "2024" ? 10 : 6;
        const newLevel = Math.min(maxLevel, Math.max(0, requestedLevel));
        if (newLevel === current) return { ok: true, applied: "exhaustion", level: newLevel };
        await actor.update({ "system.attributes.exhaustion": newLevel });
        console.log(`${MODULE_ID} | Exhaustion: ${actor.name} ${current} → ${newLevel} (cap ${maxLevel})`);
        return { ok: true, applied: "exhaustion", level: newLevel };
      } catch (err) {
        console.warn(`${MODULE_ID} | Exhaustion increment failed for ${actor.name}:`, err);
        return { ok: false, applied: null };
      }
    }

    // ── Standard binary status condition ──
    try {
      if (typeof actor.toggleStatusEffect === "function") {
        await actor.toggleStatusEffect(key, { active: true });
      }

      // ── Stamp concentration linkage ──
      // When a concentration spell's failed-save condition is being applied,
      // link the resulting effect back to the caster + spell so we can clean
      // it up automatically when the caster's concentration ends. Without
      // this, casting Hold Person on Goblin B leaves Goblin A paralyzed
      // forever even though concentration moved.
      //
      // We use TWO mechanisms in parallel for maximum robustness:
      //   1. dnd5e native dependent system — set `flags.dnd5e.dependentOn` on
      //      the placed effect, pointing to the caster's Concentrating effect
      //      UUID. dnd5e's `ActiveEffect._onDelete` calls `getDependents()`
      //      which auto-deletes us when concentration ends, by ANY path (chat
      //      card "End", effects panel X, manual delete, system-initiated end,
      //      replace-cast, etc.). This is the system's own mechanism.
      //   2. ace-qol concentrationOrigin tag — fallback for any path that
      //      bypasses the dependent system. Our deleteActiveEffect hook
      //      sweeps actors and deletes any ace-qol-tagged effects matching
      //      caster+spell. Belt-and-braces.
      if (options.concentrationOrigin?.casterId && options.concentrationOrigin?.spellName) {
        try {
          // Find the effect we just created/toggled. statusId match on Foundry
          // status effects, fallback to name. Same lookup as _findEffect uses.
          const def = ALL_EFFECTS[key];
          const statusId = def?.statusId ?? key;
          const placed = actor.effects.contents.find(e =>
            e.statuses?.has?.(statusId) || e.name === def?.name || e.name?.toLowerCase() === key
          );
          if (placed) {
            // ── Resolve the caster's Concentrating effect for this spell ──
            const caster = game.actors.get(options.concentrationOrigin.casterId);
            let concEffect = null;
            if (caster) {
              const spellNameLc = String(options.concentrationOrigin.spellName).toLowerCase();
              const spellItemId = options.concentrationOrigin.spellItemId ?? null;
              concEffect = caster.effects.contents.find(e => {
                if (!e.statuses?.has?.("concentrating")) return false;
                // Match by name pattern "Concentrating: Hold Person"
                const eNameLc = String(e.name ?? "").toLowerCase();
                if (eNameLc.includes(spellNameLc)) return true;
                // Or match by dnd5e flag origin/item
                const cf = e.flags?.dnd5e?.concentration;
                if (cf?.item && spellItemId && cf.item === spellItemId) return true;
                if (cf?.origin && spellItemId && String(cf.origin).includes(spellItemId)) return true;
                return false;
              });
            }

            // ── Build the update payload (BOTH flags in one update) ──
            const updateData = {
              [`flags.${MODULE_ID}.concentrationOrigin`]: {
                casterId:    options.concentrationOrigin.casterId,
                spellName:   options.concentrationOrigin.spellName,
                spellItemId: options.concentrationOrigin.spellItemId ?? null,
                concEffectUuid: concEffect?.uuid ?? null,
                stampedAt:   Date.now(),
              },
            };
            if (concEffect?.uuid) {
              updateData["flags.dnd5e.dependentOn"] = concEffect.uuid;
            }

            // ── Repeating-save metadata (Hold Person, Banishment, etc.) ──
            // If the caller passed in `repeatingSave`, stamp it on the placed
            // effect so the RepeatingSaveEngine can fire end-of-turn re-rolls.
            //
            // We also stash:
            //   - castWorldTime: game.time.worldTime at apply moment, so OOC
            //     batch saves can compute remaining spell duration (math-
            //     correct cap — Hold Person at round 5 only has 5 saves left
            //     in its 10-round duration, not a fresh 10).
            //   - durationSeconds: total spell duration in seconds. Pulled
            //     from the spell item by save-engine.mjs.
            if (options.repeatingSave?.trigger
              && options.repeatingSave?.ability
              && Number.isFinite(options.repeatingSave?.dc)) {
              updateData[`flags.${MODULE_ID}.repeatingSave`] = {
                ability:        String(options.repeatingSave.ability).toLowerCase(),
                dc:             Number(options.repeatingSave.dc),
                trigger:        String(options.repeatingSave.trigger),
                spellName:      options.concentrationOrigin?.spellName ?? null,
                castWorldTime:  Number(options.repeatingSave.castWorldTime ?? game.time?.worldTime ?? 0),
                durationSeconds: Number(options.repeatingSave.durationSeconds) || null,
                stampedAt:      Date.now(),
              };
            }

            await placed.update(updateData);

            if (concEffect?.uuid) {
              console.log(`${MODULE_ID} | Linked ${actor.name}'s ${key} to ${caster?.name ?? "caster"}'s Concentrating: ${options.concentrationOrigin.spellName} (dnd5e dependentOn=${concEffect.uuid}, also ace-qol tag)`);
            } else {
              console.warn(`${MODULE_ID} | Could NOT find Concentrating effect on caster ${options.concentrationOrigin.casterId} for spell "${options.concentrationOrigin.spellName}" — applied ace-qol tag only (sweep-based cleanup)`);
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to tag concentration origin on ${actor.name}'s ${key}:`, err);
        }
      }

      return { ok: true, applied: key };
    } catch (err) {
      console.warn(`${MODULE_ID} | toggleStatusEffect failed for "${key}" on ${actor.name}:`, err);
      return { ok: false, applied: null };
    }
  }

  /**
   * Sweep every actor's effects and remove ones tagged as concentration-linked
   * to the given caster + spell name. Called when the caster's concentrating
   * effect is deleted (RAW: dropping concentration ends all linked effects).
   *
   * Usage: ConditionLibrary.dropConcentrationLinkedEffects({ casterId, spellName });
   *
   * Matches loosely on spellName (string equality, case-sensitive) since the
   * concentrating effect's name is "Concentrating: Hold Person" — we extract
   * the trailing spell name at the call site.
   */
  static async dropConcentrationLinkedEffects({ casterId, spellName }) {
    if (!casterId) return 0;

    // ── Race-condition guard ──
    // When dnd5e replaces concentration (Cast Hold Person on Goblin B while
    // already concentrating on Goblin A), the sequence is:
    //   1. Old concentrating effect deleted → THIS sweep starts
    //   2. dnd5e creates new concentrating effect
    //   3. save-engine applies paralyzed to Goblin B (NEW timestamp)
    //   4. THIS sweep is still iterating actors → it would catch B's new
    //      paralyzed (same casterId + spellName) and delete it. WRONG.
    // Solution: capture a sweep-start timestamp. Skip any effect whose
    // concentrationOrigin.stampedAt is AFTER the sweep started — those were
    // applied by the new cast and shouldn't be cleaned up by old-cast sweep.
    const sweepStartedAt = Date.now();
    const SWEEP_GRACE_MS = 50; // small buffer for clock skew

    let removed = 0;
    let skippedRecent = 0;
    // Iterate every actor in the world (concentration links can target any
    // actor, including unlinked synthetic clones on tokens).
    const allActors = [];
    // World actors
    for (const a of game.actors?.contents ?? []) allActors.push(a);
    // Synthetic actors on the active scene (unlinked tokens)
    if (canvas?.scene) {
      for (const t of canvas.scene.tokens?.contents ?? []) {
        if (t.actor && !allActors.includes(t.actor)) allActors.push(t.actor);
      }
    }

    for (const actor of allActors) {
      const linked = (actor.effects?.contents ?? []).filter(e => {
        const tag = e.flags?.[MODULE_ID]?.concentrationOrigin;
        if (!tag) return false;
        if (tag.casterId !== casterId) return false;
        if (spellName && tag.spellName !== spellName) return false;
        return true;
      });
      for (const eff of linked) {
        const stamped = eff.flags?.[MODULE_ID]?.concentrationOrigin?.stampedAt ?? 0;
        // Skip effects that were applied AFTER this sweep started — those
        // belong to the NEW cast that's replacing the old concentration.
        if (stamped > sweepStartedAt + SWEEP_GRACE_MS) {
          skippedRecent++;
          console.log(`${MODULE_ID} | Sweep skipped "${eff.name}" on ${actor.name} — applied AFTER sweep start (new cast)`);
          continue;
        }
        // Re-check existence right before deleting. dnd5e tracks concentration
        // dependents natively and may have already removed this effect when
        // its own endConcentration cleanup ran (race with our hook). If the
        // effect is no longer in the actor's collection, count it as removed
        // and move on quietly.
        const stillPresent = actor.effects?.get?.(eff.id);
        if (!stillPresent) {
          removed++;
          console.log(`${MODULE_ID} | Concentration ended → "${eff.name}" already cleaned up by dnd5e on ${actor.name}`);
          continue;
        }
        try {
          await eff.delete();
          removed++;
          console.log(`${MODULE_ID} | Concentration ended → removed "${eff.name}" from ${actor.name}`);
        } catch (err) {
          // "does not exist" = dnd5e raced us and won — that's a successful
          // outcome, not a failure. Don't spam the console.
          const msg = String(err?.message ?? err ?? "");
          if (/does not exist/i.test(msg)) {
            removed++;
            console.log(`${MODULE_ID} | Concentration ended → "${eff.name}" was concurrently deleted (race with dnd5e — benign)`);
          } else {
            console.warn(`${MODULE_ID} | Failed to remove concentration-linked effect "${eff.name}" from ${actor.name}:`, err);
          }
        }
      }
    }

    if (skippedRecent > 0) {
      console.log(`${MODULE_ID} | Sweep complete — removed ${removed}, skipped ${skippedRecent} recent (race protection)`);
    }
    return removed;
  }

  /**
   * Debug logging helper.
   * @private
   */
  static _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | CL | ${msg}`);
      }
    } catch { /* settings not ready yet */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STUNNING STRIKE — Save card + edition-aware condition application
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a Stunning Strike save card. GM-whispered. Two buttons:
   *   • Save FAILED → applies stunned with edition-aware duration
   *   • Save PASSED → resolves the card with a "save passed" note
   *
   * Edition awareness lives on the data-edition attribute and is read back
   * when the FAILED button is clicked. 2014 = stunned until end of monk's
   * next turn (turnEndSource). 2024 = stunned until start of monk's next
   * turn (turnStartSource).
   *
   * @param {Actor} monk     - the Monk who used Stunning Strike
   * @param {Actor} target   - the target who must save
   * @param {object} saveReq - { ability: "con", dc: number }
   */
  static async postStunningStrikeSaveCard(monk, target, saveReq) {
    if (!monk || !target || !saveReq) return;
    const edition = CombatState.getActiveEdition(monk);
    const durationText = edition === "2024"
      ? `until the start of ${monk.name}'s next turn`
      : `until the end of ${monk.name}'s next turn`;
    const abilityLabel = String(saveReq.ability ?? "con").toUpperCase();
    const dc = Number(saveReq.dc ?? 10);

    const html = `
      <div class="ace-qol-stunning-strike-card" style="background:linear-gradient(180deg,#1a1416 0%,#2a1f30 100%);border:2px solid #d4af37;border-radius:6px;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <i class="fas fa-hand-fist" style="color:#d4af37;font-size:18px;"></i>
          <strong style="color:#ffd87a;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Stunning Strike</strong>
        </div>
        <div style="color:#cfcfd0;font-size:13px;line-height:1.5;margin-bottom:8px;">
          <strong>${target.name}</strong> must make a <strong>DC ${dc} ${abilityLabel}</strong> save or be <strong style="color:#ffd87a;">Stunned</strong> ${durationText}.
        </div>
        <div style="color:#888;font-size:11px;font-style:italic;margin-bottom:8px;">(${edition} RAW)</div>
        <div style="display:flex;gap:6px;">
          <button type="button" class="ace-qol-btn"
                  data-action="aceQolStunningStrikeFailed"
                  data-target-id="${target.id}"
                  data-monk-id="${monk.id}"
                  data-edition="${edition}"
                  style="background:#3a0e0e;color:#ffd0d0;border:1px solid #d44a4a;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;font-weight:600;">
            <i class="fas fa-times-circle"></i> Save FAILED
          </button>
          <button type="button" class="ace-qol-btn"
                  data-action="aceQolStunningStrikePassed"
                  style="background:#0e3a14;color:#d0ffd0;border:1px solid #4ad44a;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:12px;font-weight:600;">
            <i class="fas fa-check-circle"></i> Save PASSED
          </button>
        </div>
      </div>
    `;

    // GM-whisper: only the GM clicks the save outcome.
    const recipients = new Set();
    for (const u of game.users ?? []) if (u.isGM) recipients.add(u.id);

    await ChatMessage.create({
      content: html,
      speaker: ChatMessage.getSpeaker({ actor: monk }),
      whisper: [...recipients],
      flags: { [MODULE_ID]: { type: "stunningStrikeSave", monkId: monk.id, targetId: target.id, edition, status: "pending" } },
    });
  }

  /**
   * Apply the Stunned condition to the target with edition-aware duration
   * metadata so the duration-tracker expires it at the correct moment
   * relative to the monk's next turn.
   *
   *   2014: specialDuration = "turnEndSource" → end of monk's next turn.
   *   2024: specialDuration = "turnStartSource" → start of monk's next turn.
   *
   * The source actor flag points to the monk so the duration tracker can
   * locate them in the combat order.
   */
  static async applyStunnedFromStunningStrike(target, monk, edition) {
    if (!target || !monk) return;
    try {
      // Toggle the standard stunned status on so the system applies the
      // baked-in stunned effects (auto-fail STR/DEX saves, incapacitated, etc).
      if (typeof target.toggleStatusEffect === "function") {
        await target.toggleStatusEffect("stunned", { active: true });
      }
      // Find the just-placed stunned effect.
      const stunnedEffect = (target.effects?.contents ?? []).find(e =>
        e.statuses?.has?.("stunned") || e.name?.toLowerCase() === "stunned"
      );
      if (!stunnedEffect) return;

      const specialDuration = edition === "2024" ? "turnStartSource" : "turnEndSource";
      const combat = game.combat;
      const startRound = combat?.round ?? 0;

      await stunnedEffect.update({
        name: `Stunned (Stunning Strike: ${monk.name})`,
        [`flags.${MODULE_ID}.sourceActorId`]: monk.id,
        [`flags.${MODULE_ID}.specialDuration`]: specialDuration,
        "duration.rounds": 1,
        "duration.startRound": startRound,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Stunning Strike condition apply failed:`, err);
    }
  }

  /**
   * Resolve a posted Stunning Strike save card. Updates the card content
   * to a read-only resolved state on either path.
   */
  static async _resolveStunningStrikeCard(messageId, outcome) {
    const msg = game.messages?.get?.(messageId);
    if (!msg) return;
    const flags = msg.flags?.[MODULE_ID];
    if (flags?.type !== "stunningStrikeSave") return;
    if (flags?.status && flags.status !== "pending") return;

    const monkId = flags.monkId;
    const targetId = flags.targetId;
    const edition = flags.edition ?? "2014";
    const monk = game.actors?.get?.(monkId);
    const target = game.actors?.get?.(targetId);

    if (outcome === "failed" && monk && target) {
      await ConditionLibrary.applyStunnedFromStunningStrike(target, monk, edition);
    }

    // Rewrite the card content to a resolved state.
    const verdictHtml = outcome === "failed"
      ? `<div style="color:#ff7676;font-weight:600;font-size:12px;margin-top:4px;"><i class="fas fa-times-circle"></i> Save FAILED — ${target?.name ?? "Target"} is Stunned (${edition === "2024" ? "to start of monk's next turn" : "to end of monk's next turn"}).</div>`
      : `<div style="color:#76ff76;font-weight:600;font-size:12px;margin-top:4px;"><i class="fas fa-check-circle"></i> Save PASSED — no effect.</div>`;

    const newHtml = `
      <div class="ace-qol-stunning-strike-card" style="background:linear-gradient(180deg,#1a1416 0%,#2a1f30 100%);border:2px solid #d4af37;border-radius:6px;padding:10px 12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <i class="fas fa-hand-fist" style="color:#d4af37;font-size:18px;"></i>
          <strong style="color:#ffd87a;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">Stunning Strike</strong>
        </div>
        <div style="color:#cfcfd0;font-size:12px;line-height:1.4;">
          <strong>${target?.name ?? "Target"}</strong> vs Stunning Strike (${edition} RAW).
        </div>
        ${verdictHtml}
      </div>
    `;
    try {
      await msg.update({
        content: newHtml,
        [`flags.${MODULE_ID}.status`]: outcome,
        [`flags.${MODULE_ID}.resolvedAt`]: Date.now(),
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Stunning Strike card resolve failed:`, err);
    }
  }
}

// ── Bind Stunning Strike save-card buttons via renderChatMessage(HTML) ───────
const _bindStunningStrikeButtons = (message, html) => {
  try {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root || typeof root.querySelectorAll !== "function") return;
    const failedBtn = root.querySelector('[data-action="aceQolStunningStrikeFailed"]');
    const passedBtn = root.querySelector('[data-action="aceQolStunningStrikePassed"]');
    if (!failedBtn && !passedBtn) return;
    const handleClick = async (ev, outcome) => {
      ev.preventDefault();
      const btn = ev.currentTarget;
      btn.disabled = true;
      const chatEl = btn.closest?.(".chat-message");
      const msgId = message?.id ?? chatEl?.dataset?.messageId;
      if (!msgId) {
        console.warn(`${MODULE_ID} | Stunning Strike resolve: no messageId`);
        btn.disabled = false;
        return;
      }
      try {
        await ConditionLibrary._resolveStunningStrikeCard(msgId, outcome);
      } catch (err) {
        console.error(`${MODULE_ID} | Stunning Strike resolve threw:`, err);
        btn.disabled = false;
      }
    };
    // dataset.wired guard prevents duplicate listeners on chat re-renders.
    // Without it, every chat-message re-render (scroll, resize, V13 fires
    // both renderChatMessage AND renderChatMessageHTML) attaches another
    // click handler — clicking "Failed" once could fire it 5+ times across
    // a long session, double-applying the stun and corrupting state.
    if (failedBtn && !failedBtn.dataset.wired) {
      failedBtn.dataset.wired = "1";
      failedBtn.addEventListener("click", (ev) => handleClick(ev, "failed"));
    }
    if (passedBtn && !passedBtn.dataset.wired) {
      passedBtn.dataset.wired = "1";
      passedBtn.addEventListener("click", (ev) => handleClick(ev, "passed"));
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Stunning Strike bind threw:`, err);
  }
};
Hooks.on("renderChatMessage",     _bindStunningStrikeButtons); // V12
Hooks.on("renderChatMessageHTML", _bindStunningStrikeButtons); // V13
