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

  // v0.7.74 — Stoneskin RAW is "touch a willing creature." Moved from
  // self-shape (caster only) to multi-buff/touch so the cleric / wizard can
  // cast it on the party tank as RAW intends. Pre-highlight self for the
  // common case where the caster does target themselves.
  "stoneskin": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "stoneskin", duration: { hours: 1 } },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A willing creature you touch gains resistance to nonmagical bludgeoning, piercing, and slashing damage.",
  },

  "blur": {
    shape: "self",
    range: 0,
    effect: { key: "blur", duration: { minutes: 1 } },
    flavorOnConfirm: "Your body becomes blurred and indistinct — attackers have disadvantage against you.",
  },

  // v0.7.74 — Greater Invisibility RAW is "touch a creature" — wizard
  // commonly casts it on the rogue / striker, not always self. Moved.
  "greater invisibility": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "greater_invisibility", duration: { minutes: 1 } },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch becomes invisible and remains so even when it attacks or casts spells.",
  },

  // v0.7.74 — Foresight RAW is "touch a willing creature." 9th-level slot
  // almost never goes on the caster themselves — it's the iconic "buff your
  // melee god" spell. Was self-only, now touch single. (flavor text
  // updated to match the new semantics; previously inconsistent.)
  "foresight": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "foresight", duration: { minutes: 480 } },  // 8 hours
    picker: { allowSelf: true, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
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

  // v0.7.74 — Death Ward RAW is "touch a creature." This is THE canonical
  // "save your tank" spell — almost never self-cast. Was routing through
  // SelfResolver which dumped it on the cleric instead of the fighter
  // they were trying to ward. Moved to touch single.
  "death ward": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "death_ward", duration: { hours: 8 } },
    picker: { allowSelf: true, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch is warded — the next time it would drop to 0 HP it drops to 1 HP instead. Spell ends after triggering.",
  },

  // v0.7.74 — Mind Blank RAW is "touch a willing creature." Iconic anti-
  // scrying buff cast on the party diplomat / mage, not the caster.
  // Moved from self-only to touch single.
  "mind blank": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "mind_blank", duration: { hours: 24 } },
    picker: { allowSelf: true, preHighlightSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A willing creature becomes immune to psychic damage, charmed, and all attempts to read their thoughts or locate them.",
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

