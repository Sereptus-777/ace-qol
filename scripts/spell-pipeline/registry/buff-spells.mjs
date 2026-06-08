// ─── ACE: QOL — Spell Registry: Multi-Buff Shape ──────────────────────────────
// Multi-pick portrait grid, applies an ActiveEffect to each selected target.
// Bless, Bane, Faerie Fire, Shield of Faith (single target — uses multi w/ N=1),
// Aid, Heroism, Beacon of Hope.
// ──────────────────────────────────────────────────────────────────────────────

export const BUFF_SPELLS = {

  "bless": {
    shape: "multi-buff",
    range: 30,
    countResolver: (castLevel) => 3 + Math.max(0, (castLevel ?? 1) - 1),
    effect: { key: "bless", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: true },
    flavorOnConfirm: "Up to three creatures of your choice gain +1d4 to attack rolls and saving throws.",
  },

  "bane": {
    shape: "multi-buff",
    range: 30,
    countResolver: (castLevel) => 3 + Math.max(0, (castLevel ?? 1) - 1),
    effect: { key: "bane", duration: "concentration" },
    save: { ability: "cha", onSuccess: "negate" },  // applies effect only on failed save
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Up to three creatures must succeed on a Charisma save or suffer −1d4 on attacks and saves.",
  },

  "faerie fire": {
    shape: "multi-buff",
    range: 60,
    countResolver: () => 999,  // template-like 20ft cube, treat as multi up to limit
    effect: { key: "faerie_fire", duration: "concentration" },
    save: { ability: "dex", onSuccess: "negate" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Each creature in a 20-foot cube must save or be outlined — attackers gain advantage and the target can't benefit from invisibility.",
  },

  "shield of faith": {
    shape: "multi-buff",
    range: 60,
    countResolver: () => 1,  // always single target
    effect: { key: "shield_of_faith", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: true },
    flavorOnConfirm: "A shimmering field surrounds the target — +2 AC for the duration.",
  },

  "aid": {
    shape: "multi-buff",
    range: 30,
    countResolver: () => 3,  // exactly 3 targets per RAW
    effect: { key: "aid", duration: { hours: 8 } },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: true },
    flavorOnConfirm: "Up to three creatures gain +5 max HP and current HP (+5 per upcast above 2nd).",
  },

  "heroism": {
    shape: "multi-buff",
    range: 5,
    countResolver: (castLevel) => 1 + Math.max(0, (castLevel ?? 1) - 1),
    effect: { key: "heroism", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "Target becomes immune to fear and gains temporary HP each round equal to your spellcasting modifier.",
  },

  "beacon of hope": {
    shape: "multi-buff",
    range: 30,
    countResolver: () => 999,  // any number within range
    effect: { key: "beacon_of_hope", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: true },
    flavorOnConfirm: "Chosen creatures gain advantage on Wisdom saves and death saves, and regain max HP from healing.",
  },
};
