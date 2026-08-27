// ─── ACE: QOL — Spell Registry: Multi-Buff Shape ──────────────────────────────
// Multi-pick portrait grid, applies an ActiveEffect to each selected target.
// Bless, Bane, Faerie Fire, Shield of Faith (single target — uses multi w/ N=1),
// Aid, Heroism, Beacon of Hope.
// ──────────────────────────────────────────────────────────────────────────────

export const BUFF_SPELLS = {

  // ── Migrated from the legacy SPELL_AUTO_APPLY table (2026-06-25) ──────────────
  // Touch-range single-target buffs. Adding them here makes the pipeline OWN them
  // (it takes precedence over the legacy table via SpellPipeline.ownsSpell, so the
  // old entries go inert). Touch = range 5 + requiresAdjacent; allowSelf because the
  // caster may touch themselves. Effect keys + durations come from condition-library.
  // These four have NO 2014/2024 split (the smites, barkskin, and divine favor DO —
  // concentration changed in 2024 — so they're handled in a separate edition pass).
  "invisibility": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "invisibility", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch (or yourself) turns invisible until the spell ends — or until it attacks or casts a spell.",
  },

  "freedom of movement": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "freedom_of_movement", duration: { seconds: 3600 } },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch ignores difficult terrain for 1 hour, and can't be paralyzed, restrained, or have its speed reduced by spells.",
  },

  "protection from evil and good": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "protection_from_evil", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch is warded against aberrations, celestials, elementals, fey, fiends, and undead — they attack it at disadvantage, and it can't be charmed, frightened, or possessed by them.",
  },

  "protection from evil": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "protection_from_evil", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch is warded against aberrations, celestials, elementals, fey, fiends, and undead — they attack it at disadvantage, and it can't be charmed, frightened, or possessed by them.",
  },

  // Barkskin — touch, single target. 2014 concentration (the 2024 no-concentration
  // variant is a separate edition pass on the def). Migrated 2026-06-25.
  "barkskin": {
    shape: "multi-buff",
    range: 5,
    countResolver: () => 1,
    effect: { key: "barkskin", duration: "concentration" },
    // 2024: Barkskin is no longer concentration — flat 1-hour duration.
    // (2024 also raises the AC floor 16 → 17 — that lives in the condition
    // library def and is tracked separately; duration/concentration is the
    // audit item closed here.)
    byEdition: { modern: { effect: { key: "barkskin", duration: { minutes: 60 } } } },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch is sheathed in rugged bark — its AC can't drop below 16, whatever it's wearing.",
  },

  // Slow — multi-target WITH the Wisdom save the legacy auto-apply was MISSING (a
  // RAW fix: slow lets each target save to avoid it). Same both editions. 2026-06-25.
  "slow": {
    shape: "multi-buff",
    range: 120,
    countResolver: () => 6,   // up to six creatures in a 40-ft cube
    effect: { key: "slow", duration: "concentration" },
    save: { ability: "wis", onSuccess: "negate" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Up to six creatures must succeed on a Wisdom save or be Slowed — halved speed, −2 AC and Dex saves, and only one action OR bonus action each turn.",
  },

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

  // NOTE: "faerie fire" MOVED to template-spells.mjs (2026-06-26). It is a
  // 20-ft CUBE AREA spell, not a multi-target buff — you place a template and
  // every creature inside (visible OR hidden) rolls a DEX save. The old
  // portrait-picker was wrong: you can't pick an invisible creature from a list.

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
    range: 0,  // 30 feet radius aura
    countResolver: () => 999,
    effect: { key: "pass_without_trace", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: true, excludeDead: true },
    flavorOnConfirm: "All within 30 feet gain +10 to Stealth checks and leave no trace.",
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
    flavorOnConfirm: "Holy energy radiates 30 feet — friendly creatures gain +1d4 radiant damage on weapon attacks.",
  },

  "spirit shroud": {
    shape: "self",
    range: 0,
    effect: { key: "spirit_shroud", duration: "concentration" },
    flavorOnConfirm: "Spectral ribbons surround you — your attacks within 10 feet deal +1d8 radiant/necrotic/cold damage.",
  },
};
