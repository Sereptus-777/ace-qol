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

  // ─── Phase 3.A additions — common buff spells ───

  "haste": {
    shape: "multi-buff",
    range: 30,
    countResolver: () => 1,  // always single target
    effect: { key: "haste", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: true },
    flavorOnConfirm: "Target's speed doubles, +2 AC, advantage on Dex saves, +1 action per turn.",
  },

  "pass without trace": {
    shape: "multi-buff",
    range: 0,  // 30ft radius aura
    countResolver: () => 999,
    effect: { key: "pass_without_trace", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: true },
    flavorOnConfirm: "All within 30 ft gain +10 to Stealth checks and leave no trace.",
  },

  "resistance": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "resistance", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "Target adds 1d4 to one saving throw of their choice within the next minute.",
  },

  "guidance": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "guidance", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "Target adds 1d4 to one ability check of their choice within the next minute.",
  },

  "heroes' feast": {
    aliases: ["heroes feast"],
    shape: "multi-buff",
    range: 30,
    countResolver: () => 12,  // up to 12 creatures
    effect: { key: "heroes_feast", duration: { hours: 24 } },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: false },
    flavorOnConfirm: "Up to 12 creatures gain temp HP, advantage on Wisdom saves, and immunity to poison and fear for 24 hours.",
  },

  "tongues": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "tongues", duration: { hours: 1 } },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "Target can understand and speak any spoken language for 1 hour.",
  },

  "water breathing": {
    shape: "multi-buff",
    range: 30,
    countResolver: () => 10,
    effect: { key: "water_breathing", duration: { hours: 24 } },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: false },
    flavorOnConfirm: "Up to 10 creatures gain the ability to breathe underwater for 24 hours.",
  },

  "magic weapon": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "magic_weapon", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "A nonmagical weapon becomes a +1 magic weapon (+2 at 4th level, +3 at 6th).",
  },

  "elemental weapon": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "elemental_weapon", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: false },
    flavorOnConfirm: "A weapon becomes magic with +1 to attacks and +1d4 elemental damage (more at higher levels).",
  },

  "crusader's mantle": {
    aliases: ["crusaders mantle"],
    shape: "self",  // self-centered emanation — self apply
    range: 0,
    effect: { key: "crusaders_mantle", duration: "concentration" },
    flavorOnConfirm: "Holy energy radiates 30 ft — friendly creatures gain +1d4 radiant damage on weapon attacks.",
  },

  "spirit shroud": {
    shape: "self",
    range: 0,
    effect: { key: "spirit_shroud", duration: "concentration" },
    flavorOnConfirm: "Spectral ribbons surround you — your attacks within 10 ft deal +1d8 radiant/necrotic/cold damage.",
  },
};
