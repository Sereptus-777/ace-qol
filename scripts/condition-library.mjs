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
import { registerChatCardHandler } from "./chat-render-utils.mjs";
import { CombatState } from "./combat-state.mjs";
import { CombatContext } from "./combat-context.mjs";
// His rule, months old: nothing lands before the dice that decided it. The gate
// lives in its own leaf so this file can hold to it too (road/dice-gate.mjs).
import { untilDiceLand } from "./road/dice-gate.mjs";
// And ACE's picture of a condition waits for the card that announces it.
import { holdConditionArt } from "./condition-visuals.mjs";

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
    description: "Incapacitated. Can't move or speak. Auto-fails STR and DEX saves. Attacks have advantage. Melee hits within 5 feet are auto-crits.",
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
    description: "Disadvantage on attack rolls. Melee attacks within 5 feet have advantage against the creature. Ranged attacks against have disadvantage. Must crawl or use half movement to stand.",
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
    description: "Incapacitated. Can't move or speak. Unaware of surroundings. Drops held items, falls prone. Auto-fails STR/DEX saves. Attacks have advantage. Melee hits within 5 feet are auto-crits.",
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
  // ⚠️ REMOVED: dead duplicate `haste` — its changes were merged into the
  // surviving definition further down. See the note there.

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
    // THE PARALYZED STATUS IS THE MECHANIC (audit fix, 2026-07-27). Without it
    // the target was never actually paralyzed: the can-act gate reads STATUSES
    // (Situation.readStatuses), `flags.ace-qol.incapacitated` has ZERO readers
    // anywhere in the module, condition immunity is skipped entirely when the
    // statuses array is empty (so Freedom of Movement / immune creatures were
    // still held), and no token icon showed. A held creature could act, attack
    // and cast. `statuses` also auto-expands to the incapacitated rider.
    statuses: ["paralyzed"],
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
    // See hold_person — the paralyzed STATUS is what actually holds them.
    statuses: ["paralyzed"],
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
    description: "Magical darkness fills a 15 feet sphere. Creatures with darkvision can't see through it. Light spells of 2nd level or lower are dispelled.",
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
    description: "Target's AC can't be less than 16 (2014) / 17 (2024), regardless of armor.",
    changes: [
      { key: "system.attributes.ac.flat", mode: 3, value: "16" },   // 2014 base: AC floor 16
    ],
    concentration: true,
    duration: { rounds: 10 }, // 1 hour
    // 2024 RAW raised the AC floor to 17. Merged in by the edition-aware def
    // logic at the top of applyEffect. (Audit 2026-06-27.)
    byEdition: {
      "2024": {
        changes: [
          { key: "system.attributes.ac.flat", mode: 3, value: "17" },
        ],
      },
    },
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
  // ⚠️ REMOVED: a SECOND `fly:` key was defined here (2026-08-18 audit).
  // JavaScript object literals take the LAST definition of a duplicate key
  // silently — no error, no warning — so this earlier one had never been
  // live. It also lacked the `flags.ace-qol.canFly` marker the later
  // definition carries, meaning anyone "fixing" a bug by editing this copy
  // would have been editing dead code and watching nothing change. The
  // surviving definition is further down with the other spell effects.

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
    statuses: ["invisible"],   // drives the token fade + CombatState's adv/dis (the flags alone weren't enough)
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
    statuses: ["invisible"],   // drives the token fade + CombatState's adv/dis (the flags alone weren't enough)
    concentration: true,
    duration: { rounds: 10 },
  },

  // ── Spirit Guardians (3rd level, concentration) ───────────────────────────
  spirit_guardians: {
    name: "Spirit Guardians",
    icon: "icons/magic/holy/saint-glass-portrait-halo.webp",
    description: "15 feet radius: halves speed on entry, 3d8 radiant/necrotic damage (WIS save half) on enter or start of turn.",
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
    description: "30 feet aura. Use bonus action to heal 2d6 HP to one creature in the aura.",
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
    description: "Resistance to cold (warm) or fire (chill). Melee attackers take 2d8 fire/cold damage. Sheds bright light 10 feet, dim light 10 feet.",
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
    description: "30 feet aura: nonmagical weapon attacks deal an extra 1d4 radiant damage.",
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
  // ⚠️ REMOVED: dead duplicate `longstrider` — an identical/equivalent
  // definition lower in this file was the one JavaScript kept.

  // ── Freedom of Movement (4th level) ───────────────────────────────────────
  freedom_of_movement: {
    name: "Freedom of Movement",
    icon: "icons/magic/movement/abstract-ribbons-red-orange.webp",
    description: "Immune to paralyzed and restrained conditions. Difficult terrain costs no extra movement. Can spend 5 feet to escape nonmagical restraints/grapples.",
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
  // ⚠️ REMOVED: dead duplicate `death_ward` — an identical/equivalent
  // definition lower in this file was the one JavaScript kept.

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
  // ── Guiding Bolt (1st level) — the rider, not the damage ──
  // ⚠️ `.once`, NOT `.all`. RAW: "the next attack roll made against this target
  // before the end of your next turn has advantage." ONE attack. Using the
  // persistent `.all` flag here — which is what Faerie Fire correctly uses —
  // would give the party advantage on every attack for a round. one-shot-grants
  // deletes this the moment an attack resolves against the target, hit or miss.
  guiding_bolt: {
    name: "Guiding Bolt — Outlined",
    icon: "icons/magic/light/beam-rays-yellow.webp",
    description: "Wreathed in shimmering light. The NEXT attack roll against this creature has advantage — hit or miss, it is then spent.",
    statuses: [],
    changes: [
      { key: "flags.ace-qol.grants.advantage.attack.once", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },
  },

  // ── Command (1st level, 1 round) ──
  // ⚠️ NOT a `charmed` status. Command does not charm — it compels one action on
  // the creature's next turn. Stamping charmed here would make every
  // charm-immunity check wrongly negate it, and would light up "charmed" on the
  // token for something that is not that condition.
  command: {
    name: "Commanded",
    icon: "icons/magic/control/energy-stream-link-teal.webp",
    description: "Compelled to obey a one-word command on its next turn, then the spell ends. RAW: no effect on undead, on a creature that does not understand the caster's language, or if the command is directly harmful.",
    statuses: [],
    changes: [
      { key: "flags.ace-qol.commanded", mode: 0, value: "1" },
    ],
    concentration: false,
    duration: { rounds: 1 },
  },

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
    description: "Flying speed of 60 feet for the duration. Falls if concentration breaks while aloft.",
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
    // Audit 2026-06-27: these were `flags.midi-qol.*` keys → INERT (midi-qol
    // isn't installed; ACE replaces it), so Foresight granted no advantage at all.
    // Switched to ACE's own flag namespace (registered in extended-effects.mjs).
    changes: [
      { key: "flags.ace-qol.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.advantage.ability.check.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.advantage.save.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.disadvantage.attack.all", mode: 0, value: "1" },
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

  // ⚠️ 2014 ONLY. Lives on the TARGET, not the caster — the whole spell is
  // "advantage against THAT creature", and a flag on the caster cannot say
  // which one. Uses the same one-shot grant the attack pipeline already reads
  // for Guiding Bolt, so the advantage is spent by the first attack roll and
  // gone, hit or miss, exactly as RAW says.
  true_strike: {
    name: "True Strike — Marked",
    icon: "icons/magic/perception/eye-slit-pink.webp",
    description: "The caster's first attack roll against this creature on their next turn has advantage. Spent on that roll, hit or miss.",
    changes: [
      { key: "flags.ace-qol.grants.advantage.attack.once", mode: 0, value: "1" },
      { key: "flags.ace-qol.trueStrike", mode: 0, value: "1" },
    ],
    concentration: true, duration: { rounds: 1 },
  },
  detect_magic: {
    name: "Detect Magic", icon: "icons/magic/perception/eye-ringed-green.webp",
    description: "Sense magic within 30 feet.",
    changes: [], concentration: true, duration: { rounds: 100 },
  },
  detect_evil_and_good: {
    name: "Detect Evil and Good", icon: "icons/magic/perception/orb-eye-scrying.webp",
    description: "Sense aberrations, celestials, elementals, fey, fiends, undead within 30 feet.",
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
    description: "+10 feet movement speed.",
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
    description: "Teleport up to 30 feet.",
    changes: [], concentration: false, duration: { rounds: 0 },
  },
  dimension_door: {
    name: "Dimension Door", icon: "icons/magic/movement/portal-vortex-orange.webp",
    description: "Teleport up to 500 feet.",
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
  // ⚠️ HASTE WAS DEFINED TWICE AND THE LIVE COPY DID TWO-THIRDS OF NOTHING
  // (2026-08-18 audit). A duplicate key higher in this file carried the speed
  // doubling and the Dex-save advantage; JavaScript silently keeps the LAST
  // definition, so this one won — and it granted only +2 AC. Its own
  // description promised "Speed doubled, advantage on Dex saves" while the
  // changes array delivered neither. Nothing errored, and reading either copy
  // in isolation looked correct.
  //
  // The two copies also used DIFFERENT flag names (`haste` vs `hasted`), so
  // any future consumer written against the dead copy's flag would silently
  // never fire either.
  haste: {
    name: "Haste", icon: "icons/magic/time/clock-stopwatch-white-blue.webp",
    description: "Speed doubled, +2 AC, advantage on Dex saves, +1 action per turn.",
    changes: [
      { key: "system.attributes.movement.walk", mode: 1, value: "2" },   // doubled
      { key: "system.attributes.ac.bonus", mode: 2, value: "+2" },
      { key: "flags.ace-qol.advantage.save.dex", mode: 0, value: "1" },
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
    // Audit 2026-06-27: was `changes: []` → the spell applied an icon but NO
    // actual bonus. Restore +1 to attack + damage for melee AND ranged weapon
    // attacks. (Upcast +2/+3 scaling is a follow-up; the base +1 is correct.)
    changes: [
      { key: "system.bonuses.mwak.attack", mode: 2, value: "+1" },
      { key: "system.bonuses.mwak.damage", mode: 2, value: "+1" },
      { key: "system.bonuses.rwak.attack", mode: 2, value: "+1" },
      { key: "system.bonuses.rwak.damage", mode: 2, value: "+1" },
      { key: "flags.ace-qol.magicWeapon", mode: 0, value: "1" },
    ],
    concentration: true, duration: { rounds: 100 },
  },
  // NOTE (audit 2026-06-27): duplicate `elemental_weapon` and `crusaders_mantle`
  // defs used to sit here with `changes: []` / a marker-only change. Being LATER
  // in merge order they silently OVERRODE the real defs above (elemental_weapon
  // ~L728 = +1 / +1d4 elemental; crusaders_mantle ~L755 = +1d4 radiant) — so both
  // spells did nothing mechanically. Removed the empty duplicates; the real defs win.
  spirit_shroud: {
    name: "Spirit Shroud", icon: "icons/magic/death/projectile-skull-flaming-yellow.webp",
    description: "+1d8 radiant/necrotic/cold damage to attacks within 10 feet.",
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
  // ── Sleep (1st level, 1 min, NOT concentration) ──
  // KEY RENAMED from "unconscious" → "sleep_unconscious" so we don't
  // clobber the SRD unconscious condition during the ALL_EFFECTS merge.
  // Carries the full RAW unconscious mechanical changes (incapacitated,
  // auto-fail STR/DEX, auto-crit melee, zero movement) PLUS a sleep
  // marker that condition-raw-hooks.mjs watches: any damage wakes the
  // sleeper (RAW PHB 277).
  sleep_unconscious: {
    name: "Sleep",
    icon: "icons/svg/unconscious.svg",
    description: "Magically asleep. Incapacitated, can't move/speak, auto-fails STR/DEX saves, melee hits in 5 feet are auto-crits. Any damage wakes target.",
    // statuses:["unconscious"] is REQUIRED — combat-state.mjs reads the literal
    // "unconscious" status for melee auto-crit + attack advantage (PHB). dnd5e
    // auto-spawns prone + incapacitated RIDER conditions from it (on every effect
    // create), but those rider conditions are NOT linked back to us for cleanup, so
    // they linger after our effect ends — that's the stuck "Prone / Incapacitated"
    // rows. The deleteActiveEffect rider-cleanup in condition-raw-hooks.mjs removes
    // them when this effect is deleted. (2026-06-24.)
    statuses: ["unconscious"],
    changes: [
      { key: "flags.ace-qol.incapacitated", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.str", mode: 0, value: "1" },
      { key: "flags.ace-qol.fail.save.dex", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.advantage.attack.all", mode: 0, value: "1" },
      { key: "flags.ace-qol.grants.autoCrit.melee", mode: 0, value: "1" },
      { key: "flags.ace-qol.sleepSpell", mode: 0, value: "1" },
      { key: "system.attributes.movement.walk", mode: 5, value: "0" },
      { key: "system.attributes.movement.fly",  mode: 5, value: "0" },
      { key: "system.attributes.movement.swim", mode: 5, value: "0" },
      { key: "system.attributes.movement.climb", mode: 5, value: "0" },
      { key: "system.attributes.movement.burrow", mode: 5, value: "0" },
    ],
    concentration: false,
    duration: { rounds: 10 },
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
    description: "+CHA modifier to all saving throws for allies within 10 feet (30 feet at 18th level).",
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

/**
 * The five words Command can carry, and what each one does.
 *
 * ⚠️🔴 THE EFFECT SAID "COMMANDED" AND NOTHING ELSE. A GM looking at the
 * token could see a creature was under a Command with no way to learn WHICH
 * one - which is the only part that matters, because the whole spell is the
 * difference between dropping a sword and falling prone.
 *
 * Johnny, 2026-08-27: "it didn't say what he was commanded to do... let's add
 * some descriptions, like grovel: Firaxis is groveling at the feet of the Lich."
 *
 * ⚠️ RAW, AND THE SAME FIVE IN BOTH EDITIONS. 2014 and 2024 print the same
 * list with the same effects, so this needs no edition branch. The wording is
 * the printed effect rather than a paraphrase.
 */
export const COMMAND_WORDS = {
  approach: "moves toward you by the shortest and most direct route, ending its turn if it moves within 5 feet of you.",
  drop:     "drops whatever it is holding and then ends its turn.",
  flee:     "spends its turn moving away from you by the fastest available means.",
  grovel:   "falls prone and then ends its turn.",
  halt:     "doesn't move and takes no actions. A flying creature stays aloft if it is able to — if it must move to stay aloft, it flies the minimum distance needed.",
};

/**
 * Which of the five words is this, if any?
 *
 * ⚠️ MATCHED FROM THE ACTIVITY NAME, because dnd5e ships Command with one
 * ACTIVITY PER WORD and that is where the GM's choice actually lands. Reading
 * the spell's own name could only ever return "Command".
 */
export function commandWordFrom(name) {
  const n = String(name ?? "").toLowerCase();
  for (const word of Object.keys(COMMAND_WORDS)) {
    if (n.includes(word)) return word;
  }
  return null;
}

/**
 * WHAT A CREATURE NOW IS, IN THE WORDS THE TABLE USES.
 *
 * His card, 2026-09-29: "Charmed — 1 hour", and "No 'Charm_person' death row."
 *
 * A key is not a name. Charm Person lands through the registry key `charm_person`,
 * and every card that printed what landed printed that key with its underscore and
 * a capital letter bolted on. What the creature IS is the STATUS the definition
 * carries: charmed. So the status wins, then the definition's own name, and only a
 * key nothing knows about falls back to being tidied up.
 *
 * @param {string} key  a condition or registry effect key
 * @returns {string} "Charmed", "Prone", "Charmed by Caster", "Faerie Fire"
 */
export function conditionDisplayName(key) {
  const k = String(key ?? "").toLowerCase().trim();
  if (!k) return "";
  const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
  try {
    const def = ALL_EFFECTS[k];
    const st = [...(def?.statuses ?? [])].map(s => String(s).toLowerCase()).filter(Boolean);
    // The status the creature is under, named the way the books name it.
    if (st.length === 1) {
      const label = CONFIG.DND5E?.conditionTypes?.[st[0]]?.label
        ?? CONFIG.statusEffects?.find(e => e.id === st[0])?.name
        ?? st[0];
      return cap(String(label));
    }
    // Several statuses, or none: the definition's own name says it best.
    if (def?.name) return String(def.name);
  } catch (_) { /* fall through to the key */ }
  // An unknown key, tidied: never an underscore in front of the table.
  return k.split(/[_\s]+/).filter(Boolean).map(cap).join(" ");
}

/**
 * HOW LONG A CONDITION'S OWN DEFINITION SAYS IT LASTS, in seconds.
 *
 * The last fallback for the line that says what landed: a spell states its own
 * duration on the item, which is the right answer when it has one, and a few
 * conditions carry theirs in the definition instead. 0 when neither does, so the
 * line simply names the condition rather than inventing a time for it.
 */
export function conditionDurationSeconds(key) {
  try {
    const d = ALL_EFFECTS[String(key ?? "").toLowerCase().trim()]?.duration;
    if (!d) return 0;
    const sec = Number(d.seconds);
    if (Number.isFinite(sec) && sec > 0) return sec;
    const rounds = Number(d.rounds);
    if (Number.isFinite(rounds) && rounds > 0) return rounds * 6;
    const turns = Number(d.turns);
    return (Number.isFinite(turns) && turns > 0) ? turns * 6 : 0;
  } catch (_) { return 0; }
}

/**
 * WHAT A CONDITION KEY ACTUALLY PUTS ON A CREATURE, as status ids.
 *
 * `charm_person` is a library key, not a status: what it puts on is `charmed`.
 * The animator asks this so it can tell an on-token picture of a condition ACE
 * already draws from a cast flourish (animation/spell-animator.mjs), and the
 * card's "what landed" line reads the same answer.
 */
export function conditionStatuses(key) {
  try {
    const k = String(key ?? "").toLowerCase().trim();
    if (!k) return [];
    const def = ALL_EFFECTS[k];
    const list = def?.statuses ?? (def?.statusId ? [def.statusId] : [k]);
    return [...list].map(s => String(s).toLowerCase().trim()).filter(Boolean);
  } catch (_) { return []; }
}

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
  /**
   * THE STATUS READER (2026-07-28). Library keys are not status ids — 20 of 20
   * core entries declare `statusId` and no `statuses` array, which is exactly
   * why the original immunity guard never ran for any condition. Anything that
   * needs to know "what status(es) does this library key actually represent"
   * asks HERE, so the derivation can never drift between call sites again.
   *
   * @param   {string} key   library key, e.g. "petrified"
   * @returns {string[]}     status ids, lowercased; empty if the key is unknown
   */
  static statusesFor(key) {
    const def = ALL_EFFECTS[key];
    if (!def) return [];
    const out = (Array.isArray(def.statuses) && def.statuses.length)
      ? def.statuses.map(s => String(s).toLowerCase())
      : [];
    if (def.statusId) {
      const sid = String(def.statusId).toLowerCase();
      if (!out.includes(sid)) out.push(sid);
    }
    return out;
  }

  /**
   * Is `actor` immune to EVERY status this library key represents? Unknown keys
   * and empty status lists answer false — never block an application on a fact
   * we couldn't read.
   */
  static immuneTo(actor, key) {
    const statuses = ConditionLibrary.statusesFor(key);
    if (!statuses.length) return false;
    return statuses.every(s => CombatContext.conditionImmune(actor, s));
  }

  static async applyEffect(actor, key, options = {}) {
    let def = ALL_EFFECTS[key];
    if (!def) {
      console.warn(`${MODULE_ID} | ConditionLibrary: unknown effect key "${key}"`);
      return null;
    }
    await ConditionLibrary._beforeItLands(actor, key, options);

    // Edition-aware def overrides (e.g. Barkskin's AC floor: 16 in 2014, 17 in
    // 2024). GUARDED — a no-op for the ~all defs that have no `byEdition` block,
    // so it can't affect anything but the handful that opt in. Keyed by
    // getActiveEdition's "2014"/"2024". (Audit 2026-06-27, 2024-edition pass.)
    try {
      const _ed = CombatState.getActiveEdition?.(actor);
      if (_ed && def.byEdition?.[_ed]) def = { ...def, ...def.byEdition[_ed] };
    } catch (_) { /* keep base def */ }

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
    // seconds OR the longer wall-clock units (minutes/hours/days) → convert to
    // seconds so they're actually honoured. (Audit 2026-06-27: minutes/hours/days
    // were silently dropped here, producing no-duration → effectively PERMANENT
    // effects that the duration-tracker never expired.)
    let _secs = Number(durationData.seconds) || 0;
    if (durationData.minutes != null) _secs += Number(durationData.minutes) * 60;
    if (durationData.hours   != null) _secs += Number(durationData.hours)   * 3600;
    if (durationData.days    != null) _secs += Number(durationData.days)    * 86400;
    if (_secs > 0) duration.seconds = _secs;
    // Stamp combat start for tracking
    if (combat) {
      duration.startRound = options.combatRound ?? combat.round ?? 0;
      duration.startTurn  = options.combatTurn ?? combat.turn ?? 0;
      duration.combat     = combat.id;
    }

    // Build statuses set for conditions (links to Foundry's status system).
    // Effect defs may use EITHER `statusId` (single) OR `statuses` (array) — we
    // must honour BOTH. (Bug fixed 2026-06-23: only statusId was read, so every
    // array-form control effect — Hold Person/Monster paralyzed, Power Word
    // Stun, Sleep unconscious, charmed/incapacitated/prone/stunned/dead — landed
    // its flag but NEVER its Foundry status, so the attack pipeline's
    // actor.statuses gate let held/stunned/asleep creatures still act.)
    // ── DERIVE FROM statusId WHEN NO EXPLICIT LIST (2026-07-28) ──
    // This used to read ONLY `def.statuses`, leaving it empty for every entry
    // that declares a single `statusId` instead — which is most of them,
    // Petrified included. The immunity guard below is gated on
    // `statuses.length`, so an empty list meant the guard NEVER RAN: ACE
    // happily applied Petrified to an Earth Elemental that is flatly immune to
    // it, dnd5e silently refused the status, and the chat card announced a
    // petrification that never happened. Johnny caught the lie on the card.
    //
    // This gap was found once before and patched on TWO entries by hand (Hold
    // Person, Hold Monster) rather than at the source, so every other entry
    // kept the hole. Deriving it here fixes the whole class at once.
    // Derivation lives in ONE place now — ConditionLibrary.statusesFor() — so
    // this guard, the repeating-save voider, and anything added later can never
    // disagree about which statuses a library key represents.
    const statuses = ConditionLibrary.statusesFor(key);

    // ── Condition immunity (RAW, both editions) ──
    // Don't apply a condition the target is flatly immune to — undead vs Charmed/
    // Poisoned, a construct vs Paralyzed, etc. If the target is immune to EVERY
    // primary status this effect represents, skip it entirely so no phantom
    // condition lands. Checked BEFORE the rider auto-expand below. Returns null,
    // same as the unknown-key path, so callers that already handle a null result
    // (e.g. the wasted-concentration drop) treat "immune" as "nothing applied".
    if (statuses.length && statuses.every(s => CombatContext.conditionImmune(actor, s))) {
      ConditionLibrary._debug?.(`"${def.name}" not applied — ${actor.name} is immune to ${statuses.join("/")}.`);
      return null;
    }

    // Auto-expand RAW sub-conditions so this ONE effect carries them all, labeled by
    // THIS effect — e.g. unconscious also makes the target prone + incapacitated.
    // Paired with the createRiderConditions patch (ace-qol.mjs), dnd5e then does NOT
    // spawn its own separate generic rider effects; the token shows ONLY our labeled
    // condition, and deleting it removes everything cleanly. (2026-06-24.)
    const STATUS_RIDERS = {
      unconscious: ["prone", "incapacitated"],
      paralyzed:   ["incapacitated"],
      stunned:     ["incapacitated"],
      petrified:   ["incapacitated"],
    };
    for (const s of [...statuses]) {
      for (const rider of (STATUS_RIDERS[s] ?? [])) {
        if (!statuses.includes(rider)) statuses.push(rider);
      }
    }

    // Build the effect data. NOTE: we deliberately do NOT set
    // flags.dnd5e.riders.statuses — dnd5e's createRiderConditions() already
    // spawns separate shared rider effects (dnd5eprone, dnd5eincapacitated…)
    // straight from `this.statuses`, and adding the flag only made it spawn a
    // duplicate of the status itself too. Rider lifecycle is handled by the
    // deleteActiveEffect cleanup in condition-raw-hooks.mjs instead. (2026-06-24.)
    const effectData = {
      name: options.nameOverride ?? ConditionLibrary._nameFor(def, options),
      // ⚠️ BOTH FIELD NAMES. Foundry renamed ActiveEffect#icon to #img at
      // v11 and has carried a shim since. ACE reads both everywhere and wrote
      // only the old one, which is a silent-no-op waiting for the release that
      // drops the shim - the effect would simply lose its picture and nothing
      // would say why.
      icon: def.icon,
      img: def.icon,
      // ⚠️🔴 THE DESCRIPTION WENT INTO OUR OWN FLAG AND NOWHERE ELSE.
      // ActiveEffect has had a real `description` field since v11 and it is what
      // the sheet shows when you expand an effect. So every ACE condition
      // carried a perfectly good sentence that no player could ever read:
      // Johnny, 2026-08-27, on a Commanded creature - "if you press under the
      // effects and it says Command and had no description".
      //
      // The flag copy stays; other ACE code reads it and moving it would be a
      // second change for no gain.
      description: options.descriptionOverride ?? def.description ?? "",
      origin: options.origin ?? null,
      changes,
      duration,
      statuses,
      flags: {
        [MODULE_ID]: {
          conditionKey: key,
          // ⚠️ WHAT PUT IT ON, AND WHO, kept ON the effect. Without the name, "one
          // write per source" had no way to tell one power landing twice from two
          // powers stacking. Without the CASTER it cannot tell Lamia's Charm Person
          // from another creature's: his rule, 2026-09-30, "A different caster may
          // charm him too. That is a second source, not a second copy of Lamia's."
          source: options.source ?? null,
          sourceActorId: options.sourceActorId ?? null,
          category: def.category,
          concentration: def.concentration ?? false,
          specialDuration: options.specialDuration ?? def.specialDuration ?? null,
          description: def.description,
          // Caller-supplied extras, merged in at CREATION time rather than
          // patched on afterwards. That ordering matters: a staged condition
          // (gaze engine) stamps its `repeatingSave` directive here, and if it
          // were applied as a follow-up update a turn could end in between and
          // the re-save would be missed entirely.
          ...(options.extraFlags ?? {}),
        },
      },
    };

    // Overlay mode (big icon on token)
    if (options.overlay) {
      effectData.flags.core = { overlay: true };
    }

    // ── Option B: unify the concentration marker (Johnny 2026-07-13) ──
    // For a CONCENTRATION spell the caster casts on THEMSELVES (Detect Magic,
    // Blur, Fly, …), don't stack OUR marker on top of dnd5e's "Concentrating: X"
    // effect — that double is exactly what Johnny wants gone. Instead RE-DRESS
    // dnd5e's concentration effect AS our marker (our name / icon / description /
    // flags) while it keeps its concentration status + dnd5e flags, so
    // break-on-damage and dependent-cleanup keep working untouched. One marker,
    // looks like ours, carries our data for the coming time-tracking, mechanics
    // intact. dnd5e creates the concentration effect (beginConcentrating) BEFORE
    // the usage message that fires our pipeline dispatch (dnd5e.mjs 16870 vs
    // 16884), so it always exists by the time we get here — no race. Scoped to a
    // SELF marker (spellItem owned by the same actor), never a debuff on a target.
    // Gate: unifyConcentrationMarker.
    const _spellItem = options.spellItem ?? null;
    if (def.concentration === true && _spellItem && _spellItem.actor?.id === actor?.id
        && game.settings.get(MODULE_ID, "unifyConcentrationMarker") !== false) {
      const concEffect = ConditionLibrary._findConcentrationEffectForSpell(actor, _spellItem);
      if (concEffect) {
        // A pre-existing SEPARATE marker (e.g. cast before this setting was on)
        // is found now, BEFORE we stamp our key onto the concentration effect,
        // so it can't match the concentration effect itself.
        let stale = null;
        try { stale = ConditionLibrary._findEffect(actor, key); } catch (_) { /* none */ }
        try {
          await concEffect.update({
            name: def.name,
            ...(def.icon ? { img: def.icon } : {}),
            [`flags.${MODULE_ID}.conditionKey`]:         key,
            [`flags.${MODULE_ID}.category`]:             def.category,
            [`flags.${MODULE_ID}.concentration`]:        true,
            [`flags.${MODULE_ID}.description`]:          def.description,
            [`flags.${MODULE_ID}.spellName`]:            _spellItem.name,
            [`flags.${MODULE_ID}.unifiedConcentration`]: true,
          });
          if (stale && stale.id !== concEffect.id) { try { await stale.delete(); } catch (_) { /* non-fatal */ } }
          ConditionLibrary._debug(`Unified "${def.name}" onto ${actor.name}'s concentration marker (Option B — single marker; dnd5e's re-dressed as ours).`);
          return concEffect;
        } catch (err) {
          console.warn(`${MODULE_ID} | concentration-marker unify failed (falling back to a separate marker):`, err);
        }
      }
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
    //
    // ⚠️🔴 AND ONLY A COPY FROM THE SAME SOURCE (his rule, 2026-09-30). This
    // asked `_findEffect` and deleted whatever came back, so Kasimir's Charm
    // Person deleted Lamia's: one caster's hour ended because another cast the
    // same spell. See _copiesBySource above. A different caster's copy stays and
    // this one goes on beside it.
    if (!options.allowStack) {
      try {
        const { mine, others } = ConditionLibrary._copiesBySource(actor, key, options);
        for (const existing of mine) {
          // ⚠️ THE MARKER RIDES ON THIS DELETE TOO. `aceReplacing` is how a
          // watcher tells "the condition ended" from "the same condition landed
          // again": the presence engine's 24-hour immunity and the prone artwork
          // both turn on that difference. applyByName has always passed it and
          // this path never did, so the same delete meant two different things
          // depending on which apply path a condition happened to take.
          await existing.delete({ aceReplacing: key });
          ConditionLibrary._debug(`Replaced existing "${def.name}" on ${actor.name} (dedupe, same source)`);
        }
        if (others.length) ConditionLibrary._saySecondSource(actor, key, others, options);
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
   * Find the actor's dnd5e concentration effect for a given spell (Option B
   * marker-unify). Matches by concentration status + name-contains + dnd5e item
   * flag / origin, so it still resolves after we rename it to the spell's name.
   */
  static _findConcentrationEffectForSpell(actor, spellItem) {
    const nameLc = String(spellItem?.name ?? "").toLowerCase();
    return (actor?.effects?.contents ?? []).find(e => {
      const isConc = e.statuses?.has?.("concentration") || e.statuses?.has?.("concentrating");
      if (!isConc) return false;
      if (nameLc && String(e.name ?? "").toLowerCase().includes(nameLc)) return true;
      const ci = e.flags?.dnd5e?.item;
      if (ci?.id && spellItem?.id && ci.id === spellItem.id) return true;
      const origin = e.origin ?? e.flags?.dnd5e?.origin;
      if (origin && spellItem?.id && String(origin).includes(spellItem.id)) return true;
      return false;
    }) ?? null;
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
    return ConditionLibrary._matchingEffects(actor, key)[0] ?? null;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     AN EFFECT IS NAMED FOR WHO PUT IT THERE

     His rule, 2026-09-30: *"Never 'Charmed by Caster'. Name it 'Charmed by
     Lamia', 'Charmed by Kasimir' — the actor's name. Same caster recasts →
     refresh that one. Still named for them. Different caster → second named
     effect. Both stay. One hearts clip."*

     Two sources of the same condition now live side by side on one creature, so
     "Charmed by Caster" twice on Escher's sheet tells him nothing about which is
     Lamia's hour and which is Kasimir's. The name is the only thing on the
     effects panel that can carry it.

     ⚠️ THE CASTER IS ASKED OF THE ITEM FIRST. `spellItem.actor` is the caster
     that cast this, already resolved and correct for an unlinked token; a bare
     `sourceActorId` may name a synthetic token actor that `game.actors` has
     never heard of, which is why the id is the second question and the canvas
     the third.

     ⚠️ AND IF NOBODY CAN BE NAMED, THE DEFINITION'S OWN NAME STANDS. A name is
     better wrong-shaped than invented.
     ═══════════════════════════════════════════════════════════════════════ */

  /** Who cast this, by name, or null when it cannot be said. */
  static casterNameFrom(options = {}) {
    try {
      const fromItem = options?.spellItem?.actor?.name ?? options?.item?.actor?.name ?? null;
      if (fromItem) return String(fromItem);
      const id = String(options?.sourceActorId ?? "").trim();
      if (!id) return null;
      const world = game.actors?.get(id)?.name;
      if (world) return String(world);
      // An unlinked token's synthetic actor is not in game.actors; the board is.
      for (const tok of (canvas?.tokens?.placeables ?? [])) {
        if (tok?.actor?.id === id) return String(tok.name ?? tok.actor.name);
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  /** The definition's name, with "by Caster" replaced by who it actually was. */
  static _nameFor(def, options = {}) {
    const base = String(def?.name ?? "");
    if (!/\bby Caster\b/i.test(base)) return base;
    const who = ConditionLibrary.casterNameFrom(options);
    if (!who) return base;
    return base.replace(/\bby Caster\b/i, `by ${who}`);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     THE ORDER A CONDITION ARRIVES IN

     His rule, 2026-09-30: *"Dice land. Then the condition. Then the card. Then
     the animation. The hearts must not start before the die or the card."*

     ⚠️🔴 TWO THINGS WERE LETTING THE PICTURE IN FIRST.

     1  THE DICE. The condition door read `dice = false` by default, which the
        gate honours as "the caller thought about it and nothing was thrown", so
        a condition from a save landed while the d20 was still tumbling. And the
        save resolver does not reach the door at all — it calls this library
        straight (one of the section-9 side doors) — so even fixing the door
        would have left this path ungated. The gate is HERE now, at the one
        chokepoint both paths go through, and it costs nothing when the screen is
        still: `untilDiceLand` returns on the same tick with nothing in the air.

     2  THE PICTURE. ACE draws a condition on the body the instant its effect is
        created, which is before the card that announces it. So the drawing is
        held from here until the card is on screen (condition-visuals' hold,
        released by the chrome pass), and the order he asked for is what he sees:
        the die, the card, then the hearts.
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * The two things that must be true before a condition lands: its dice have
   * settled, and its picture is held until the card.
   *
   * @param {Actor}  actor
   * @param {string} key
   * @param {object} options  `dice: false` says nothing was thrown; leaving it
   *   out asks the screen, per the gate's own rule.
   */
  static async _beforeItLands(actor, key, options = {}) {
    try {
      await untilDiceLand(options?.dice);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not wait for the dice before "${key}" landed on `
        + `${actor?.name}, so it lands now:`, err);
    }
    try {
      // ⚠️ ONLY WHEN A CARD IS COMING. A condition that arrives from a cast, an
      // item or a feature is announced by one; a GM's own toggle on the token is
      // not, and holding that would leave every hand-set condition waiting two
      // seconds for a card that was never going to be written.
      const fromSomething = !!(options?.source || options?.sourceActorId
        || options?.spellItem || options?.origin || options?.item);
      if (fromSomething) holdConditionArt(actor?.id, `${key} on ${actor?.name}`);
    } catch (err) {
      console.debug(`${MODULE_ID} | could not hold the picture of "${key}" until its card:`,
        err?.message ?? err);
    }
  }

  /**
   * EVERY copy of this thing on the creature, not just the first.
   *
   * ⚠️ THE NET IS `_findEffect`'S, UNCHANGED, because that net is the proven
   * answer to "is this already on him" and both apply paths deduped with it. The
   * only new thing is that a creature may now carry more than one, so the callers
   * need all of them rather than whichever came first.
   *
   * @private
   */
  static _matchingEffects(actor, key) {
    if (!actor?.effects) return [];
    const def = ALL_EFFECTS[key];
    const out = [];
    const take = (e) => { if (e && !out.includes(e)) out.push(e); };

    /* ⚠️🔴 A STATUS LIST IS NOT ALWAYS A Set, AND A THROW HERE LOSES THE WHOLE
       APPLY. `_findEffect` read `effect.statuses?.has(key)`, which guards against
       there being no statuses and NOT against them being an array — `.has` is
       then undefined and calling it throws. That throw landed in applyByName's
       outer catch, which returns not-ok, so a condition that had been placed
       perfectly was reported as "it did not take" and the card said so. Latent in
       `_findEffect` for months; reading every match instead of the first one is
       what finally reached it, and the replay caught it before his table did. */
    const carries = (e, st) => {
      const held = e?.statuses;
      if (!held || !st) return false;
      if (typeof held.has === "function") return held.has(st);
      if (Array.isArray(held)) return held.includes(st);
      return false;
    };

    // Primary: our conditionKey flag
    for (const effect of actor.effects) {
      if (effect.flags?.[MODULE_ID]?.conditionKey === key) take(effect);
    }
    // Fallback: the key ITSELF as a status (frightened/prone/etc. are their own
    // status id) — catches a native toggled status carrying no ACE flag, so the
    // two apply paths cross-dedup (2026-07-11).
    for (const effect of actor.effects) {
      if (carries(effect, key)) take(effect);
    }
    // Fallback: statusId (system-applied conditions)
    if (def?.statusId) {
      for (const effect of actor.effects) {
        if (carries(effect, def.statusId)) take(effect);
      }
    }
    // Fallback: the name, however it is capitalised.
    //
    // ⚠️🔴 CASE MATTERS AND IT MUST NOT. `_findEffect` compared names exactly
    // while applyByName's own net lowercased both sides, and when the two were
    // merged into this one the exact comparison won. A dnd5e status effect is
    // named from its localised label, so "Frightened" against a definition's
    // "frightened" stopped matching, the verify concluded nothing had been
    // placed, and two replay pins reported "ACE tried to put frightened on it,
    // and it did not take" over a condition that had landed. The replay caught
    // it; his table did not have to.
    //
    // ⚠️ AND THE KEY COUNTS AS A NAME, which is the other half of what the old
    // net did: a condition placed by something that knew the key and not the
    // definition still answers to it.
    const names = [def?.name, key].filter(Boolean).map(n => String(n).toLowerCase().trim());
    if (names.length) {
      for (const effect of actor.effects) {
        const n = String(effect.name ?? "").toLowerCase().trim();
        if (n && names.includes(n)) take(effect);
      }
    }
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     A SECOND CASTER DOES NOT DELETE THE FIRST

     His table, 2026-09-30: *"Lamia charmed Escher. Kasimir charmed Escher. The
     sweeper removed 'Charmed' and killed the clip... Two sources. One Charmed.
     One ACE hearts clip. The first source stays until its hour ends or that
     caster (or their allies) damages him. The door adds Kasimir's effect. It
     does not delete Lamia's."*

     ⚠️🔴 WHY 0.63.0's GUARD NEVER GOT A SAY. Both apply paths open with a
     caster-blind dedupe — `_findEffect(actor, key)` then `delete()` — and it
     runs BEFORE the caster-aware twin check I added. So Kasimir's Charm Person
     found Lamia's, deleted it, and the refresh logic below had nothing left to
     look at. `applyEffect`, the path a registry effect like `charm_person`
     actually takes, had no twin check at all. The guard was downstream of the
     delete it was written to prevent.

     One question now, asked by both paths: IS THIS COPY MINE?

       · same caster            → mine. Refresh or replace it. One effect.
       · a different caster     → theirs. Leave it. A second effect goes on.
       · caster unknown         → treat as mine, so nothing regresses for the
                                  many conditions that never stamp one (a native
                                  status, a GM's toggle, anything pre-0.62).

     ⚠️ ONE STATUS AND ONE CLIP EITHER WAY. condition-visuals draws from the
     token's STATUS set, so two charm effects are one pink coat and one set of
     hearts, and the status only drops when the last of them is gone. Two
     durations, one picture.
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * The copies of this thing already on the creature, split by whose they are.
   *
   * @param {Actor}  actor
   * @param {string} key      the library key being applied
   * @param {object} options  the apply options (`sourceActorId` names the caster)
   * @returns {{mine: ActiveEffect[], others: ActiveEffect[]}}
   * @private
   */
  static _copiesBySource(actor, key, options = {}) {
    const caster = String(options?.sourceActorId ?? "").trim();
    const mine = [], others = [];
    for (const e of ConditionLibrary._matchingEffects(actor, key)) {
      const theirs = String(e.flags?.[MODULE_ID]?.sourceActorId ?? "").trim();
      // Unknown on either side is not a disagreement: only two KNOWN casters
      // that differ make this somebody else's.
      if (caster && theirs && theirs !== caster) others.push(e);
      else mine.push(e);
    }
    return { mine, others };
  }

  /** What to say when a second source lands beside a first. */
  static _saySecondSource(actor, key, others, options = {}) {
    try {
      const whose = others.map(e => {
        const id = String(e.flags?.[MODULE_ID]?.sourceActorId ?? "");
        return game.actors?.get(id)?.name ?? e.flags?.[MODULE_ID]?.source ?? "somebody else";
      });
      console.log(`${MODULE_ID} | ${actor?.name} already carries "${key}" from ${whose.join(", ")}. `
        + `That is a different source, so it stays with its own duration and this one goes on `
        + `beside it. Two sources, one condition on the token, one clip.`);
    } catch (_) { /* the log is a nicety */ }
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
  /**
   * HOW LONG THIS APPLICATION LASTS, in seconds: what the caller says first, then
   * the condition's own definition. 0 when neither names one, and a refresh then
   * leaves the duration it already had rather than clearing it.
   */
  static _durationSecondsFor(key, options = {}) {
    try {
      const d = options?.duration ?? null;
      const fromCaller = Number(d?.seconds) > 0 ? Number(d.seconds)
        : Number(d?.rounds) > 0 ? Number(d.rounds) * 6
        : Number(d?.turns) > 0 ? Number(d.turns) * 6 : 0;
      if (fromCaller > 0) return fromCaller;
      const def = ALL_EFFECTS[String(key ?? "").toLowerCase()]?.duration ?? null;
      if (!def) return 0;
      if (Number(def.seconds) > 0) return Number(def.seconds);
      if (Number(def.rounds) > 0) return Number(def.rounds) * 6;
      if (Number(def.turns) > 0) return Number(def.turns) * 6;
      return 0;
    } catch (_) { return 0; }
  }

  static async applyByName(actor, conditionKey, options = {}) {
    if (!actor || !conditionKey) return { ok: false, applied: null };
    const key = String(conditionKey).toLowerCase().trim();
    await ConditionLibrary._beforeItLands(actor, key, options);

    // ── Condition immunity (RAW, both editions) ──
    // Don't apply a condition the target is immune to (undead vs Charmed/Poisoned,
    // many creatures vs Exhaustion, etc.). Mirrors the applyEffect chokepoint so
    // BOTH application paths honor immunity. First word handles "exhaustion 2".
    if (CombatContext.conditionImmune(actor, key.split(/\s+/)[0])) {
      ConditionLibrary._debug?.(`"${key}" not applied — ${actor.name} is immune.`);
      return { ok: false, applied: null, immune: true };
    }

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

    // ── SAME SOURCE, SAME CONDITION: REFRESH IT ─────────────────────
    //
    // ⚠️🔴 THIS USED TO RUN SECOND, AND THAT IS WHY IT NEVER FIRED. The dedupe
    // that now sits BELOW it deleted the very effect this block exists to
    // refresh, before this block could look for it. Same caster, so the refresh
    // never happened and a create fired an animation; different caster, so
    // Kasimir's Charm Person ended Lamia's hour. The order is the fix, and the
    // dedupe below asks whose copy it is (_copiesBySource).
    //
    // His table, 2026-09-30: "Jeth was already Charmed. A second Charm Person from
    // Lamia put a second charmed on him and played a second animation. Same source,
    // same condition: refresh the duration. One effect. One clip."
    //
    // ⚠️🔴 AND WHY THE 0.56 GUARD MISSED IT. That version found its twin only by
    // the `source` flag it had itself stamped, so anything already on a creature
    // from before that version was invisible to it — which is exactly Jeth, who was
    // charmed in an earlier test. A guard that can only see its own handiwork is no
    // guard at all on a live world.
    //
    // So a twin is recognised three ways, any one of which means "this creature
    // already carries this thing":
    //
    //   · the same `conditionKey` — ACE put it there, whatever version did it
    //   · the same source NAME — stamped from 0.56 on
    //   · the same ORIGIN item — the effect came from this very item
    //
    // ⚠️ AND THE CASTER DECIDES WHETHER IT IS THE SAME SOURCE AT ALL. Two creatures
    // can both cast Charm Person on him and each keeps its own duration. When BOTH
    // the existing effect and this call know their caster and they differ, it is a
    // second source and a second effect. When the existing one does not know (older
    // than 0.62), the name or key match stands, because refreshing the one he has is
    // closer to right than stacking a second copy on top of it.
    //
    // A REFRESH IS NOT A WRITE. The effect is updated in place, so nothing is
    // created, nothing is deleted, and Automated Animations — which fires once per
    // effect CREATED — has nothing new to play. That is the second clip, gone.
    try {
      const _wantStatuses = [...(ALL_EFFECTS[key]?.statuses ?? [key])]
        .map(x => String(x).toLowerCase()).filter(Boolean);
      const _src = String(options?.source ?? "").toLowerCase().trim();
      const _caster = String(options?.sourceActorId ?? "").trim();
      const _originItem = String(options?.origin ?? "").trim();

      const _twin = (actor.effects?.contents ?? []).find(e => {
        if (e.disabled) return false;
        // It must already put on everything this would put on.
        if (_wantStatuses.length && !_wantStatuses.every(st => e.statuses?.has?.(st))) return false;
        const f = e.flags?.["ace-qol"] ?? {};
        const from = String(f.source ?? f.spellEffect?.spellName ?? f.concentrationOrigin?.spellName ?? "")
          .toLowerCase().trim();
        const sameThing = (f.conditionKey && String(f.conditionKey).toLowerCase() === key)
          || (!!_src && from === _src)
          || (!!_originItem && String(e.origin ?? "") === _originItem);
        if (!sameThing) return false;
        // A caster on both sides that disagrees makes this a DIFFERENT source.
        const theirs = String(f.sourceActorId ?? "").trim();
        if (_caster && theirs && theirs !== _caster) return false;
        return true;
      });

      if (_twin) {
        const seconds = ConditionLibrary._durationSecondsFor(key, options);
        let refreshed = false;
        try {
          const update = { disabled: false };
          if (seconds > 0) {
            update["duration.seconds"] = seconds;
            update["duration.startTime"] = game.time?.worldTime ?? 0;
            if (game.combat) {
              update["duration.startRound"] = game.combat.round ?? null;
              update["duration.startTurn"] = game.combat.turn ?? null;
            }
          }
          // Whoever cast it THIS time owns it now, so a later cast from somebody
          // else is correctly seen as a different source.
          if (_src) update["flags.ace-qol.source"] = options.source;
          if (_caster) update["flags.ace-qol.sourceActorId"] = options.sourceActorId;
          // ⚠️ AND IT STAYS NAMED FOR THEM (his rule, 2026-09-30). A refresh is
          // the same caster recasting, so the name does not change — but one
          // placed before 0.71.0 still says "by Caster", and this is the moment
          // it can be told who that was.
          const _want = ConditionLibrary._nameFor(ALL_EFFECTS[key], options);
          if (_want && _want !== _twin.name && /\bby Caster\b/i.test(String(_twin.name ?? ""))) {
            update.name = _want;
          }
          await _twin.update(update);
          refreshed = true;
        } catch (err) {
          console.warn(`ace-qol | could not refresh "${_twin.name}" on ${actor.name}, so it keeps `
            + `the duration it had:`, err);
        }
        console.log(`ace-qol | ${actor.name} already carries "${_twin.name}"`
          + `${options?.source ? ` from ${options.source}` : ""}, which puts on `
          + `${_wantStatuses.join(", ") || key}. ONE EFFECT: `
          + `${refreshed ? (seconds > 0 ? `its duration is refreshed to ${seconds}s` : "it is left in place")
                         : "it stands as it was"}, nothing is created, and there is no second animation.`);
        return { ok: true, applied: _twin.name, refreshed, duplicate: true };
      }
    } catch (err) {
      console.warn(`ace-qol | could not check whether ${actor?.name} already carries what "${key}" `
        + `puts on, so it is applied as it always was:`, err);
    }

    // ── Same-condition dedupe (RAW: conditions don't stack) ──
    // Mirror applyEffect so a condition already placed by EITHER path (an ACE
    // effect OR a native status) is replaced, never doubled. Ghostly Howl
    // failed twice = ONE Frightened, not two (live-fire 2026-07-11: the chasme
    // stacked Frightened from two howls). Exhaustion already returned above.
    //
    // ⚠️🔴 A COPY FROM ANOTHER CASTER IS NOT A DUPLICATE (his rule, 2026-09-30).
    // It stays, with its own duration, and this one goes on beside it. Same
    // caster, or a copy that names no caster, is still replaced.
    if (!options.allowStack) {
      try {
        const { mine, others } = ConditionLibrary._copiesBySource(actor, key, options);
        for (const existing of mine) {
          // ⚠️🔴 A REPLACEMENT IS NOT AN ENDING, AND SOMETHING WAS WATCHING
          // (his table, 2026-09-20). Conditions do not stack, so the old one is
          // deleted and a fresh one goes on — and every listener on
          // `deleteActiveEffect` sees that as the condition ENDING. The
          // presence engine's watch turned each of those into "the fear ended,
          // so it is immune for 24 hours", which is how one creature ended up
          // frightened AND immune, four lines deep on the card. The flag rides
          // on the delete so a watcher can tell the two apart.
          await existing.delete({ aceReplacing: key });
          ConditionLibrary._debug?.(`applyByName: replaced existing "${key}" on ${actor.name} (dedupe, same source)`);
        }
        if (others.length) ConditionLibrary._saySecondSource(actor, key, others, options);
      } catch (_) { /* dedupe is best-effort — never block the application */ }
    }

    // ── Standard binary status condition ──
    try {
      /* ⚠️🔴 DO NOT TOGGLE A STATUS THAT IS ALREADY THERE (his table,
         2026-09-30: "applyByName tried toggleStatusEffect with id
         dnd5echarmed0000. That id was already there from the first Charm.
         Foundry threw. The card treated the throw as failure.").

         dnd5e creates a status effect with a FIXED id — `dnd5echarmed0000` —
         and `keepId: true`, so asking for one the creature already has is not a
         no-op, it throws "already exists within the parent collection". Two
         casters charming one creature is now normal, so this is the ordinary
         case and not an edge.

         A status is one flag on the creature, not a count. If it is already on,
         there is nothing to toggle and nothing wrong. */
      const _wants = conditionStatuses(key);
      const _held = actor.statuses instanceof Set ? actor.statuses : new Set();
      const _alreadyOn = _wants.length > 0 && _wants.every(st => _held.has(st));
      if (_alreadyOn) {
        console.log(`${MODULE_ID} | ${actor.name} already has ${_wants.join(", ")}, so nothing is `
          + `toggled for "${key}" — a status is one flag on the creature, not a count. Its own `
          + `record still goes on below.`);
      }
      if (!_alreadyOn && typeof actor.toggleStatusEffect === "function") {
        try {
          await actor.toggleStatusEffect(key, { active: true });
        } catch (toggleErr) {
          // "Invalid status ID" → `key` is a custom ACE effect (faerie_fire and
          // other registry effects), NOT a Foundry status. CONTAIN the throw here
          // so it doesn't leap over the applyEffect fallback below (step 4) to the
          // outer catch. The fallback then builds the effect from its definition.
          console.debug(`${MODULE_ID} | applyByName: "${key}" isn't a Foundry status id; placing via applyEffect instead (${toggleErr?.message ?? toggleErr}).`);
        }
      }

      // ── Ensure the condition is PRESENT *and* ENABLED ──────────────────
      // Two silent failure modes this guards against, both of which made
      // applyByName claim success while the token did nothing:
      //   1. toggleStatusEffect NO-OPS on an unknown status id → nothing lands.
      //   2. toggleStatusEffect NO-OPS when a *disabled* copy of the status is
      //      already present (common after repeated testing / a prior toggle-
      //      off) → it stays DISABLED, i.e. inert: no mechanics, no token icon.
      // We confirm an ENABLED matching effect exists; create one if missing,
      // and force-enable any disabled copies.
      /* ⚠️🔴 AND THE VERIFY ASKS THE RIGHT QUESTION. His table: "Both are on
         the sheet. The second card printed 'ACE put nothing on it.' That line is
         a lie."

         It was. This test read `_def.statusId ?? key`, and a registry effect like
         `charm_person` has no statusId, so it looked for a creature carrying the
         status "charm_person" — which nothing ever does; what that key puts on is
         `charmed`. The only half that ever matched was the effect's NAME against
         the definition's, and 0.71.0 renamed these for their caster, so
         "Charmed by Kasimir" stopped matching "Charmed by Caster" and the last
         match went with it. The effect was created correctly and then reported
         as a failure, which is what reached the card.

         `_matchingEffects` is the net both apply paths already dedupe with, and
         it finds an effect by the conditionKey FLAG first — the one marker ACE
         stamps itself and the one that cannot drift with a name or a status id.
         `_copiesBySource` then answers his rule exactly: if "Charmed by THIS
         caster" is on the actor, the apply succeeded. */
      const _def = ALL_EFFECTS[key];
      const _matches = () => ConditionLibrary._copiesBySource(actor, key, options).mine;

      // 1) Exists at all? If not, build it from the Foundry status definition.
      //
      // ⚠️ AND NOT WHEN THE STATUS IS ALREADY ON THE CREATURE. `fromStatusEffect`
      // builds the same fixed-id record the toggle does, so it collides the same
      // way. Its own record still goes on through applyEffect in step 3, which
      // creates a document with a fresh id and can therefore sit beside another
      // caster's.
      const _statusId = _def?.statusId ?? key;
      if (!_matches().length && !_alreadyOn) {
        try {
          const cls = CONFIG.ActiveEffect?.documentClass;
          if (cls?.fromStatusEffect) {
            const eff = await cls.fromStatusEffect(_statusId);
            await actor.createEmbeddedDocuments("ActiveEffect", [eff.toObject()]);
            console.log(`${MODULE_ID} | applyByName: "${key}" placed via fromStatusEffect fallback on ${actor.name}.`);
          }
        } catch (e2) {
          // Expected for custom non-status effects (faerie_fire) — the applyEffect
          // fallback in step 4 places them. Debug-level so it isn't error noise.
          console.debug(`${MODULE_ID} | applyByName fromStatusEffect skipped for "${_statusId}" on ${actor.name} (not a Foundry status): ${e2?.message ?? e2}`);
        }
      }

      // 2) Force-enable any disabled copies — the actual "inert condition" fix.
      const _disabled = _matches().filter(e => e.disabled).map(e => ({ _id: e.id, disabled: false }));
      if (_disabled.length) {
        try {
          await actor.updateEmbeddedDocuments("ActiveEffect", _disabled);
          console.log(`${MODULE_ID} | applyByName: re-enabled ${_disabled.length} inert "${key}" effect(s) on ${actor.name}.`);
        } catch (e3) {
          console.warn(`${MODULE_ID} | applyByName re-enable failed for "${key}" on ${actor.name}:`, e3);
        }
      }

      // 3) Final verify — there must be at least one ENABLED matching effect.
      //    If the status-effect path couldn't place one, this key is a CUSTOM
      //    ACE effect (faerie_fire, etc.) that ISN'T a Foundry status effect —
      //    toggleStatusEffect + fromStatusEffect both no-op on it. Fall back to
      //    applyEffect, which builds the effect straight from its CONDITIONS def
      //    (the same path the multi-buff resolver uses successfully). Then fall
      //    through to the concentration-linkage stamping below so the effect is
      //    still cleaned up when the caster's concentration ends.
      if (!_matches().some(e => !e.disabled)) {
        try {
          await ConditionLibrary.applyEffect(actor, key, options);
          console.log(`${MODULE_ID} | applyByName: "${key}" placed via applyEffect fallback (custom non-status effect) on ${actor.name}.`);
        } catch (e4) {
          console.warn(`${MODULE_ID} | applyByName applyEffect fallback threw for "${key}" on ${actor.name}:`, e4);
        }
        if (!_matches().some(e => !e.disabled)) {
          // ⚠️ SAY WHAT IT LOOKED FOR AND WHAT IS THERE. "both failed" sent me
          // hunting twice; the creature's actual effects are the answer.
          const _have = [...(actor.effects ?? [])].map(e =>
            `"${e?.name}"${e?.disabled ? " (off)" : ""} [${[...(e?.statuses ?? [])].join("/") || "no status"}]`
            + `${e?.flags?.[MODULE_ID]?.conditionKey ? ` key=${e.flags[MODULE_ID].conditionKey}` : ""}`);
          console.warn(`${MODULE_ID} | applyByName: could NOT place an ENABLED "${key}" on `
            + `${actor.name} (status + applyEffect both failed). It puts on `
            + `${conditionStatuses(key).join(", ") || "nothing named"}; the creature carries `
            + `${_have.join(", ") || "no effects at all"}.`);
          return { ok: false, applied: null };
        }
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
      if (options.concentrationOrigin?.casterId || options.repeatingSave?.trigger || options.breakFree?.ability
          || options.duration || options.extraFlags) {
        try {
          // Find the effect we just created/toggled OR re-enabled. statusId match
          // on Foundry status effects, fallback to name. This now runs for
          // concentration AND non-concentration powers — break-free / repeating-
          // save tags must land on Entangling Rope, the Net, etc. too. The find
          // also covers the "re-enabled inert effect" path.
          const def = ALL_EFFECTS[key];
          const statusId = def?.statusId ?? key;
          const placed = actor.effects.contents.find(e =>
            e.statuses?.has?.(statusId) || e.name === def?.name || e.name?.toLowerCase() === key
          );
          if (placed) {
            const updateData = {};
            let caster = null, concEffect = null;

            // ── Its own duration, when the spell's effect states one ──
            // Prismatic Wall's Blinding Save is "Blinded for 1 minute". Foundry
            // places the status with no duration of its own, so without this the
            // blindness lasted until somebody removed it by hand (2026-09-11).
            for (const k of ["seconds", "rounds", "turns"]) {
              const v = Number(options.duration?.[k]);
              if (Number.isFinite(v) && v > 0) updateData[`duration.${k}`] = v;
            }

            // ── Concentration linkage (concentration spells only) ──
            if (options.concentrationOrigin?.casterId && options.concentrationOrigin?.spellName) {
              caster = game.actors.get(options.concentrationOrigin.casterId);
              if (caster) {
                const spellNameLc = String(options.concentrationOrigin.spellName).toLowerCase();
                const spellItemId = options.concentrationOrigin.spellItemId ?? null;
                concEffect = caster.effects.contents.find(e => {
                  if (!e.statuses?.has?.("concentration") && !e.statuses?.has?.("concentrating")) return false;
                  const eNameLc = String(e.name ?? "").toLowerCase();
                  if (eNameLc.includes(spellNameLc)) return true;
                  const cf = e.flags?.dnd5e?.concentration;
                  if (cf?.item && spellItemId && cf.item === spellItemId) return true;
                  if (cf?.origin && spellItemId && String(cf.origin).includes(spellItemId)) return true;
                  return false;
                });
              }
              updateData[`flags.${MODULE_ID}.concentrationOrigin`] = {
                casterId:    options.concentrationOrigin.casterId,
                spellName:   options.concentrationOrigin.spellName,
                spellItemId: options.concentrationOrigin.spellItemId ?? null,
                concEffectUuid: concEffect?.uuid ?? null,
                stampedAt:   Date.now(),
              };
              if (concEffect?.uuid) updateData["flags.dnd5e.dependentOn"] = concEffect.uuid;
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
                spellName:      options.repeatingSave.spellName ?? options.concentrationOrigin?.spellName ?? null,
                castWorldTime:  Number(options.repeatingSave.castWorldTime ?? game.time?.worldTime ?? 0),
                durationSeconds: Number(options.repeatingSave.durationSeconds) || null,
                stampedAt:      Date.now(),
                // Staged-condition escalation (petrifying gaze): a failed re-save
                // ADVANCES to a worse condition rather than merely persisting, and
                // skipFirstEndOfTurn grants the RAW one-turn grace before the first
                // re-save. Passed straight through so the save-engine's ITEM path
                // gets the same two-stage behavior the gaze engine builds directly.
                // (This stamp used to hard-drop both fields — that's why the active
                // Petrifying Gaze item never staged, 2026-07-24.)
                ...(options.repeatingSave.onFailureApply ? { onFailureApply: String(options.repeatingSave.onFailureApply) } : {}),
                ...(options.repeatingSave.skipFirstEndOfTurn ? { skipFirstEndOfTurn: true } : {}),
              };
            }

            // If the caller passed `breakFree`, stamp it so the BreakFreeEngine
            // can prompt an action-to-escape at the start of the creature's
            // turn. appliedRound/Turn lets the engine skip the turn it was
            // applied (the initial save already happened on the cast).
            if (options.breakFree?.ability && Number.isFinite(options.breakFree?.dc)) {
              updateData[`flags.${MODULE_ID}.breakFree`] = {
                ability:      String(options.breakFree.ability).toLowerCase(),
                dc:           Number(options.breakFree.dc),
                label:        options.breakFree.label ?? null,
                appliedRound: game.combat?.round ?? null,
                appliedTurn:  game.combat?.turn ?? null,
                stampedAt:    Date.now(),
              };
            }

            // ⚠️ THE CALLER'S OWN MARK. An engine that needs to recognise the
            // effect it caused later (the presence engine, so a creature is not
            // frightened twice by the same dragon, and so the 24-hour immunity
            // is written when the fear ends) stamps it here rather than
            // hunting for "the effect that just appeared" afterwards, which is
            // a race every time two land in the same tick.
            if (options.extraFlags && typeof options.extraFlags === "object") {
              for (const [k, v] of Object.entries(options.extraFlags)) {
                updateData[`flags.${MODULE_ID}.${k}`] = v;
              }
            }

            if (Object.keys(updateData).length) await placed.update(updateData);

            if (updateData[`flags.${MODULE_ID}.breakFree`]) {
              console.log(`${MODULE_ID} | Stamped break-free (${options.breakFree.ability} DC ${options.breakFree.dc}) on ${actor.name}'s ${key}.`);
            }
            if (options.concentrationOrigin?.casterId) {
              if (concEffect?.uuid) {
                console.log(`${MODULE_ID} | Linked ${actor.name}'s ${key} to ${caster?.name ?? "caster"}'s Concentrating: ${options.concentrationOrigin.spellName} (dnd5e dependentOn=${concEffect.uuid}, also ace-qol tag)`);
              } else {
                console.warn(`${MODULE_ID} | Could NOT find Concentrating effect on caster ${options.concentrationOrigin.casterId} for spell "${options.concentrationOrigin.spellName}" — applied ace-qol tag only (sweep-based cleanup)`);
              }
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to stamp linkage/break-free on ${actor.name}'s ${key}:`, err);
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
          <strong>${target.name}</strong> must make a <span class="ace-qol-dc" data-dc-roller="${target?.id ?? ""}"><strong>DC ${dc} </strong></span><strong>${abilityLabel}</strong> save or be <strong style="color:#ffd87a;">Stunned</strong> ${durationText}.
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
// Both render hooks + a sweep of cards that were drawn before this
// registered. See chat-render-utils — the raw hooks leave those
// undecorated forever, which is how GM-only content reached a player.
registerChatCardHandler(_bindStunningStrikeButtons, "stunning-strike cards");
