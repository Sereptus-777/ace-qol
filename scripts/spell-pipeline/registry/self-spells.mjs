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

  // ─── Phase 3.A additions — utility / movement / cantrip self-buffs ───

  "true strike": {
    shape: "self",
    range: 30,
    effect: { key: "true_strike", duration: { rounds: 1 } },
    flavorOnConfirm: "You gain advantage on your next attack roll against the target.",
  },

  "detect magic": {
    shape: "self",
    range: 0,
    effect: { key: "detect_magic", duration: { minutes: 10 } },
    flavorOnConfirm: "You sense the presence of magic within 30 feet.",
  },

  "detect evil and good": {
    shape: "self",
    range: 0,
    effect: { key: "detect_evil_and_good", duration: { minutes: 10 } },
    flavorOnConfirm: "You know if any aberration, celestial, elemental, fey, fiend, or undead is within 30 feet.",
  },

  "see invisibility": {
    shape: "self",
    range: 0,
    effect: { key: "see_invisibility", duration: { hours: 1 } },
    flavorOnConfirm: "You see invisible creatures and objects as if they were visible.",
  },

  "comprehend languages": {
    shape: "self",
    range: 0,
    effect: { key: "comprehend_languages", duration: { hours: 1 } },
    flavorOnConfirm: "You understand the literal meaning of any spoken language you hear.",
  },

  "disguise self": {
    shape: "self",
    range: 0,
    effect: { key: "disguise_self", duration: { hours: 1 } },
    flavorOnConfirm: "Your appearance changes — equipment, voice, and physical form alter to fit your wishes.",
  },

  "longstrider": {
    shape: "self",
    range: 5,
    effect: { key: "longstrider", duration: { hours: 1 } },
    flavorOnConfirm: "Your speed increases by 10 feet for the duration.",
  },

  "spider climb": {
    shape: "self",
    range: 5,
    effect: { key: "spider_climb", duration: { hours: 1 } },
    flavorOnConfirm: "You gain a climbing speed equal to your walking speed and can climb difficult surfaces.",
  },

  "misty step": {
    shape: "self",
    range: 30,
    effect: { key: "misty_step", duration: "instantaneous" },
    flavorOnConfirm: "You teleport up to 30 feet to an unoccupied space you can see.",
  },

  "dimension door": {
    shape: "self",
    range: 500,
    effect: { key: "dimension_door", duration: "instantaneous" },
    flavorOnConfirm: "You teleport up to 500 feet to a location you can describe.",
  },

  "death ward": {
    shape: "self",
    range: 5,
    effect: { key: "death_ward", duration: { hours: 8 } },
    flavorOnConfirm: "The next time a creature would drop to 0 HP, they drop to 1 HP instead. Spell ends after triggering.",
  },

  "mind blank": {
    shape: "self",
    range: 5,
    effect: { key: "mind_blank", duration: { hours: 24 } },
    flavorOnConfirm: "Target is immune to psychic damage, charmed, and all attempts to read their thoughts or location.",
  },

  "etherealness": {
    shape: "self",
    range: 0,
    effect: { key: "etherealness", duration: { hours: 8 } },
    flavorOnConfirm: "You step into the Ethereal Plane and can move freely through solid objects.",
  },

  "time stop": {
    shape: "self",
    range: 0,
    effect: { key: "time_stop", duration: { rounds: 5 } },
    flavorOnConfirm: "You take 1d4+1 additional turns in a row. Spells affecting others end the effect early.",
  },
};

