// ─── ACE: QOL — Nullification Registry: Artifacts & Boon Items ──────────────
// Legendary one-of-a-kind items + Curse of Strahd specific items.
// All require attunement unless noted otherwise.
// ──────────────────────────────────────────────────────────────────────────────

export const ARTIFACTS = [

  // ── DMG Artifacts ───────────────────────────────────────────────────────
  {
    name: "Axe of the Dwarvish Lords", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: {
      damage: { fire: "resistant" },
      stats: { con: 20 },
      special: { artifactProperties: true },
    },
    source: "DMG Axe of the Dwarvish Lords p.219",
  },
  {
    name: "Book of Exalted Deeds", matchType: "item", requiresAttunement: true,
    nullifications: { saves: { advantage: ["spell"] }, special: { exaltedReader: true } },
    source: "DMG Book of Exalted Deeds p.222",
  },
  {
    name: "Book of Vile Darkness", matchType: "item", requiresAttunement: true,
    nullifications: { special: { vileDarknessReader: true } },
    source: "DMG Book of Vile Darkness p.222",
  },
  {
    name: "Eye and Hand of Vecna", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { cha: 20, int: 20, wis: 20 }, special: { vecnaPowers: true } },
    source: "DMG Eye and Hand of Vecna p.224",
  },
  {
    name: "Hand of Vecna", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 20 }, special: { vecnaPowers: true } },
    source: "DMG Hand of Vecna p.224",
  },
  {
    name: "Eye of Vecna", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { int: 20, wis: 20 }, special: { vecnaPowers: true, truesight: true } },
    source: "DMG Eye of Vecna p.224",
  },
  {
    name: "Orb of Dragonkind", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { saves: { advantage: ["charm", "fear"] }, special: { dragonkindOrb: true } },
    source: "DMG Orb of Dragonkind p.225",
  },
  {
    name: "Sword of Kas", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 20 }, special: { swordOfKas: true } },
    source: "DMG Sword of Kas p.225",
  },
  {
    name: "Wand of Orcus", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { con: 25 }, special: { wandOfOrcus: true } },
    source: "DMG Wand of Orcus p.227",
  },

  // ── Curse of Strahd specific ───────────────────────────────────────────
  {
    name: "Holy Symbol of Ravenkind", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { holySymbolOfRavenkind: true } }, // turn undead at advantage, sunlight, hold vampire
    source: "CoS Holy Symbol of Ravenkind",
  },
  {
    name: "Sunsword", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { sunsword: true } }, // sunblade variant — radiant damage, daylight
    source: "CoS Sunsword",
  },
  {
    name: "Tome of Strahd", matchType: "item", requiresAttunement: true,
    nullifications: { special: { tomeOfStrahd: true } },
    source: "CoS Tome of Strahd",
  },
  {
    name: "Heart of Sorrow", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { heartOfSorrow: true } }, // Strahd's lair phylactery
    source: "CoS Heart of Sorrow — Strahd-only",
  },
  {
    name: "Sun Blade", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { sunBlade: true } }, // radiant + daylight on activation
    source: "DMG Sun Blade p.205",
  },
  {
    name: "Holy Avenger", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { holyAvenger: true, spellAdvantageAura: 30 } }, // 30ft aura — advantage on saves vs spells from fiend/undead
    source: "DMG Holy Avenger p.174",
  },

  // ── Other notable artifacts ─────────────────────────────────────────────
  {
    name: "Ioun Stone Greater Absorption", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { greaterAbsorption: true } }, // absorb up to 50 spell levels
    source: "DMG Ioun Stone Greater Absorption p.176",
  },
  {
    name: "Ioun Stone Absorption", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { iounAbsorption: true } }, // absorb spells targeting you up to L4
    source: "DMG Ioun Stone Absorption p.176",
  },
  {
    name: "Deck of Many Things", matchType: "item",
    nullifications: { special: { deckOfManyThings: true } },
    source: "DMG Deck of Many Things p.162",
  },
  {
    name: "Robe of Stars", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { saves: { bonus: { all: "1" } }, special: { robeOfStars: true } },
    source: "DMG Robe of Stars p.193",
  },
  {
    name: "Robe of Eyes", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { robeOfEyes: true, cantBeSurprised: true } },
    source: "DMG Robe of Eyes p.193",
  },
  {
    name: "Defender", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { defenderSword: true } }, // can transfer +3 bonus to AC
    source: "DMG Defender (sword) p.164",
  },
  {
    name: "Vorpal Sword", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { vorpal: true } }, // crit decapitates if humanoid + has head
    source: "DMG Vorpal Sword p.209",
  },
];
