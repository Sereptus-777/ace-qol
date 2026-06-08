// ─── ACE: QOL — Nullification Registry: Racial Features ─────────────────────
// Match by item.type === "race" or "feat" depending on system version.
// The walker accepts both — matchType "feature" covers both code paths.
// ──────────────────────────────────────────────────────────────────────────────

export const RACIAL_FEATURES = [

  // ── Dwarf ───────────────────────────────────────────────────────────────
  {
    name: "Dwarven Resilience", matchType: "feature",
    nullifications: { damage: { poison: "resistant" }, saves: { advantage: ["poison"] } },
    source: "PHB Dwarf — resistance to poison damage, advantage on saves vs poison",
  },
  {
    name: "Dwarven Toughness", matchType: "feature",
    nullifications: { special: { dwarvenToughness: true } }, // +1 HP per level
    source: "PHB Hill Dwarf",
  },
  {
    name: "Stonecunning", matchType: "feature",
    nullifications: { special: { stonecunning: true } },
    source: "PHB Dwarf",
  },
  {
    name: "Dwarven Armor Training", matchType: "feature",
    nullifications: { special: { dwarvenArmorTraining: true } },
    source: "PHB Mountain Dwarf",
  },

  // ── Elf ─────────────────────────────────────────────────────────────────
  {
    name: "Fey Ancestry", matchType: "feature",
    nullifications: { saves: { advantage: ["charm"] }, special: { cantBeSleepMagicked: true } },
    source: "PHB Elf — advantage on saves vs charm, magic can't put you to sleep",
  },
  {
    name: "Trance", matchType: "feature",
    nullifications: { special: { trance: true } },
    source: "PHB Elf",
  },
  {
    name: "Elf Weapon Training", matchType: "feature",
    nullifications: { special: { elfWeaponTraining: true } },
    source: "PHB High Elf / Wood Elf",
  },
  {
    name: "Mask of the Wild", matchType: "feature",
    nullifications: { special: { maskOfTheWild: true } },
    source: "PHB Wood Elf",
  },
  {
    name: "Drow Magic", matchType: "feature",
    nullifications: { special: { drowMagic: true } },
    source: "PHB Drow",
  },
  {
    name: "Sunlight Sensitivity", matchType: "feature",
    nullifications: { special: { sunlightSensitivity: true } }, // disadvantage on attacks + perception in bright sunlight
    source: "PHB Drow / Kobold",
  },

  // ── Halfling ────────────────────────────────────────────────────────────
  {
    name: "Lucky Halfling", aliases: ["Lucky"], matchType: "feature",
    nullifications: { special: { halflingLuck: true } }, // reroll 1s on d20 for attacks/saves/checks
    source: "PHB Halfling — Lucky racial (re-rolls 1s)",
  },
  {
    name: "Brave", matchType: "feature",
    nullifications: { saves: { advantage: ["frightened"] } },
    source: "PHB Halfling",
  },
  {
    name: "Halfling Nimbleness", matchType: "feature",
    nullifications: { special: { halflingNimbleness: true } },
    source: "PHB Halfling",
  },
  {
    name: "Naturally Stealthy", matchType: "feature",
    nullifications: { special: { naturallyStealthy: true } },
    source: "PHB Lightfoot Halfling",
  },
  {
    name: "Stout Resilience", matchType: "feature",
    nullifications: { damage: { poison: "resistant" }, saves: { advantage: ["poison"] } },
    source: "PHB Stout Halfling",
  },

  // ── Human / Half-Elf / Half-Orc ────────────────────────────────────────
  {
    name: "Skill Versatility", matchType: "feature",
    nullifications: { special: { skillVersatility: true } },
    source: "PHB Half-Elf",
  },
  {
    name: "Savage Attacks", matchType: "feature",
    nullifications: { special: { savageAttacks: true } }, // extra die on crit melee
    source: "PHB Half-Orc",
  },
  {
    name: "Relentless Endurance", matchType: "feature",
    nullifications: { special: { relentlessEndurance: true } }, // drop to 1 HP instead of 0 once per long rest
    source: "PHB Half-Orc",
  },

  // ── Tiefling ────────────────────────────────────────────────────────────
  {
    name: "Hellish Resistance", matchType: "feature",
    nullifications: { damage: { fire: "resistant" } },
    source: "PHB Tiefling — resistance to fire damage",
  },
  {
    name: "Infernal Legacy", matchType: "feature",
    nullifications: { special: { infernalLegacy: true } },
    source: "PHB Tiefling",
  },

  // ── Dragonborn ──────────────────────────────────────────────────────────
  {
    name: "Draconic Ancestry", matchType: "feature",
    nullifications: { special: { draconicAncestry: true } },
    source: "PHB Dragonborn",
  },
  {
    name: "Breath Weapon", matchType: "feature",
    nullifications: { special: { breathWeapon: true } },
    source: "PHB Dragonborn",
  },
  {
    name: "Damage Resistance", aliases: ["Draconic Damage Resistance"], matchType: "feature",
    nullifications: { special: { dragonbornResistance: true } }, // type per ancestry — flag for damage card
    source: "PHB Dragonborn — resistance to ancestry damage type",
  },

  // ── Gnome ───────────────────────────────────────────────────────────────
  {
    name: "Gnome Cunning", matchType: "feature",
    nullifications: { saves: { advantage: ["int", "wis", "cha"] } },
    source: "PHB Gnome — advantage on INT, WIS, and CHA saves vs magic",
  },
  {
    name: "Natural Illusionist", matchType: "feature",
    nullifications: { special: { naturalIllusionist: true } },
    source: "PHB Forest Gnome",
  },
  {
    name: "Speak with Small Beasts", matchType: "feature",
    nullifications: { special: { speakWithSmallBeasts: true } },
    source: "PHB Forest Gnome",
  },
  {
    name: "Artificer's Lore", matchType: "feature",
    nullifications: { special: { artificersLore: true } },
    source: "PHB Rock Gnome",
  },

  // ── Aasimar (Volo's) ────────────────────────────────────────────────────
  {
    name: "Celestial Resistance", matchType: "feature",
    nullifications: { damage: { necrotic: "resistant", radiant: "resistant" } },
    source: "VGtM Aasimar",
  },
  {
    name: "Healing Hands", matchType: "feature",
    nullifications: { special: { healingHands: true } },
    source: "VGtM Aasimar",
  },

  // ── Goliath ─────────────────────────────────────────────────────────────
  {
    name: "Stone's Endurance", matchType: "feature",
    nullifications: { special: { stonesEndurance: true } }, // reaction reduce damage by 1d12 + CON
    source: "VGtM Goliath",
  },
  {
    name: "Mountain Born", matchType: "feature",
    nullifications: { damage: { cold: "resistant" } },
    source: "VGtM Goliath — cold resistance",
  },

  // ── Tabaxi / Kenku / others ────────────────────────────────────────────
  {
    name: "Feline Agility", matchType: "feature",
    nullifications: { special: { felineAgility: true } },
    source: "VGtM Tabaxi",
  },
  {
    name: "Cat's Claws", matchType: "feature",
    nullifications: { special: { catsClaws: true } },
    source: "VGtM Tabaxi",
  },
];
