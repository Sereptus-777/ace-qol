// ─── ACE: QOL — Spell Registry: Self Shape ────────────────────────────────────
// No picker — effect applies to caster directly via ConditionLibrary.applyEffect.
// Effect keys come from condition-library.mjs (or extended-effects).
// ──────────────────────────────────────────────────────────────────────────────

export const SELF_SPELLS = {

  "mage armor": {
    shape: "self",
    range: 0,
    effect: { key: "mage_armor", duration: { minutes: 480 } },  // 8 hours
    flavorOnConfirm: "A protective magical force surrounds you, granting AC 13 + Dex mod.",
  },

  "shield": {
    shape: "self",
    range: 0,
    effect: { key: "shield", duration: { rounds: 1 } },  // until start of next turn
    flavorOnConfirm: "An invisible barrier of magical force snaps into place — +5 AC and immunity to magic missile until your next turn.",
  },

  "mirror image": {
    shape: "self",
    range: 0,
    effect: { key: "mirror_image", duration: { minutes: 1 } },  // 1 minute
    flavorOnConfirm: "Three illusory duplicates of yourself appear in your space.",
  },

  "stoneskin": {
    shape: "self",
    range: 0,
    effect: { key: "stoneskin", duration: { hours: 1 } },
    flavorOnConfirm: "Your flesh hardens — resistance to nonmagical bludgeoning, piercing, and slashing damage.",
  },

  "blur": {
    shape: "self",
    range: 0,
    effect: { key: "blur", duration: { minutes: 1 } },
    flavorOnConfirm: "Your body becomes blurred and indistinct — attackers have disadvantage against you.",
  },

  "greater invisibility": {
    shape: "self",
    range: 0,
    effect: { key: "greater_invisibility", duration: { minutes: 1 } },
    flavorOnConfirm: "You become invisible and remain so even when you attack or cast spells.",
  },

  "foresight": {
    shape: "self",
    range: 0,
    effect: { key: "foresight", duration: { minutes: 480 } },  // 8 hours
    flavorOnConfirm: "You touch a willing creature, granting them advantage on attack rolls, ability checks, and saves; attackers have disadvantage against them.",
  },

  "fly": {
    shape: "self",
    range: 5,
    effect: { key: "fly", duration: { minutes: 10 } },
    flavorOnConfirm: "You gain a flying speed of 60 feet for the duration.",
  },
};
