// ─── ACE: QOL — Nullification Registry: Magic Items ──────────────────────────
// Entries fire when the listed magic item is on the actor's inventory.
// Most require `equipped: true`. Many require `requiresAttunement: true`.
// ──────────────────────────────────────────────────────────────────────────────

export const MAGIC_ITEMS = [

  // ── Damage-nullifying items ─────────────────────────────────────────────
  {
    name: "Brooch of Shielding", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: {
      damage: { force: "resistant" },
      spellImmune: ["magic missile"],
    },
    source: "DMG Brooch of Shielding p.156",
  },
  {
    name: "Adamantine Armor", aliases: ["Adamantine Plate", "Adamantine Chain Mail", "Adamantine Breastplate"], matchType: "item", equipped: true,
    nullifications: { special: { critsBecomeNormal: true } },
    source: "DMG Adamantine Armor p.150 — crits against you become normal hits",
  },
  {
    name: "Dragon Scale Mail", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { dragonScaleMail: true } }, // resistance to dragon damage type — varies; flag for damage card
    source: "DMG Dragon Scale Mail p.165",
  },
  {
    name: "Periapt of Proof Against Poison", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { poison: "immune" }, conditions: { immune: ["poisoned"] } },
    source: "DMG Periapt of Proof Against Poison p.184",
  },
  {
    name: "Periapt of Wound Closure", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { stableOnDeathSave: true, doubleHpFromHitDice: true } },
    source: "DMG Periapt of Wound Closure p.184",
  },
  {
    name: "Mantle of Spell Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { saves: { advantage: ["spell"] } },
    source: "DMG Mantle of Spell Resistance p.180",
  },
  {
    name: "Cloak of Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { saves: { bonus: { all: "1" } } },
    source: "DMG (3pp / homebrew) — Cloak of Resistance",
  },
  {
    name: "Armor of Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { armorOfResistance: true } }, // type read from item flags
    source: "DMG Armor of Resistance p.152",
  },
  {
    name: "Armor of Invulnerability", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: {
      damage: { bludgeoning: "resistant", piercing: "resistant", slashing: "resistant" },
      special: { armorOfInvulnerability: true }, // 10 min immunity on action
    },
    source: "DMG Armor of Invulnerability p.152",
  },

  // ── AC + Save modifying items ───────────────────────────────────────────
  {
    name: "Cloak of Protection", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { ac: { bonus: 1 }, saves: { bonus: { all: "1" } } },
    source: "DMG Cloak of Protection p.159",
  },
  {
    name: "Ring of Protection", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { ac: { bonus: 1 }, saves: { bonus: { all: "1" } } },
    source: "DMG Ring of Protection p.191",
  },
  {
    name: "Robe of the Archmagi", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: {
      ac: { bonus: 2 }, // 15 base + WIS — approximation: +2 over standard
      saves: { advantage: ["spell"] },
      special: { spellSaveDcBonus: 2 },
    },
    source: "DMG Robe of the Archmagi p.193",
  },
  {
    name: "Bracers of Defense", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { ac: { bonus: 2 } },
    source: "DMG Bracers of Defense p.156",
  },
  {
    name: "Stone of Good Luck", aliases: ["Luckstone"], matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { saves: { bonus: { all: "1" } }, special: { abilityCheckBonus: 1 } },
    source: "DMG Stone of Good Luck p.205",
  },
  {
    name: "Shield +1", matchType: "item", equipped: true,
    nullifications: { ac: { bonus: 1 } }, // already on item; included for completeness
    source: "DMG Shield variants p.200",
  },
  {
    name: "Shield +2", matchType: "item", equipped: true,
    nullifications: { ac: { bonus: 2 } },
    source: "DMG Shield variants p.200",
  },
  {
    name: "Shield +3", matchType: "item", equipped: true,
    nullifications: { ac: { bonus: 3 } },
    source: "DMG Shield variants p.200",
  },
  {
    name: "Cloak of Displacement", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { attacks: { disadvantageVs: true }, special: { cloakOfDisplacement: true } }, // suppresses on hit until start of next turn
    source: "DMG Cloak of Displacement p.158",
  },
  {
    name: "Cloak of Elvenkind", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { stealthAdvantage: true, perceptionDisadvantageAgainst: true } },
    source: "DMG Cloak of Elvenkind p.158",
  },
  {
    name: "Boots of Elvenkind", matchType: "item", equipped: true,
    nullifications: { special: { silentMovement: true } },
    source: "DMG Boots of Elvenkind p.155",
  },
  {
    name: "Boots of Speed", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { bootsOfSpeed: true } }, // double speed when active, OA disadvantage vs you
    source: "DMG Boots of Speed p.155",
  },

  // ── Ability score override items ────────────────────────────────────────
  {
    name: "Headband of Intellect", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { int: 19 } },
    source: "DMG Headband of Intellect p.173",
  },
  {
    name: "Gauntlets of Ogre Power", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 19 } },
    source: "DMG Gauntlets of Ogre Power p.170",
  },
  {
    name: "Amulet of Health", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { con: 19 } },
    source: "DMG Amulet of Health p.150",
  },
  {
    name: "Belt of Hill Giant Strength", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 21 } },
    source: "DMG Belt of Giant Strength p.155",
  },
  {
    name: "Belt of Stone Giant Strength", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 23 } },
    source: "DMG Belt of Giant Strength p.155",
  },
  {
    name: "Belt of Frost Giant Strength", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 23 } },
    source: "DMG Belt of Giant Strength p.155",
  },
  {
    name: "Belt of Fire Giant Strength", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 25 } },
    source: "DMG Belt of Giant Strength p.155",
  },
  {
    name: "Belt of Cloud Giant Strength", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 27 } },
    source: "DMG Belt of Giant Strength p.155",
  },
  {
    name: "Belt of Storm Giant Strength", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 29 } },
    source: "DMG Belt of Giant Strength p.155",
  },
  {
    name: "Manual of Bodily Health", matchType: "item",
    nullifications: { stats: { con: 2 } }, // +2 CON max increases by 2
    source: "DMG Manual of Bodily Health p.180",
  },
  {
    name: "Manual of Gainful Exercise", matchType: "item",
    nullifications: { stats: { str: 2 } },
    source: "DMG Manual of Gainful Exercise p.180",
  },
  {
    name: "Manual of Quickness of Action", matchType: "item",
    nullifications: { stats: { dex: 2 } },
    source: "DMG Manual of Quickness of Action p.180",
  },
  {
    name: "Tome of Clear Thought", matchType: "item",
    nullifications: { stats: { int: 2 } },
    source: "DMG Tome of Clear Thought p.207",
  },
  {
    name: "Tome of Leadership and Influence", matchType: "item",
    nullifications: { stats: { cha: 2 } },
    source: "DMG Tome of Leadership and Influence p.207",
  },
  {
    name: "Tome of Understanding", matchType: "item",
    nullifications: { stats: { wis: 2 } },
    source: "DMG Tome of Understanding p.207",
  },

  // ── Detection & Information items ───────────────────────────────────────
  {
    name: "Ring of Mind Shielding", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: {
      damage: { psychic: "resistant" }, // not RAW, but commonly homebrewed — kept conservative
      special: { mindShielded: true }, // immune to mind-reading divination
    },
    source: "DMG Ring of Mind Shielding p.191",
  },
  {
    name: "Eyes of the Eagle", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { eaglesight: true } },
    source: "DMG Eyes of the Eagle p.168",
  },
  {
    name: "Helm of Telepathy", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { telepathy: true } },
    source: "DMG Helm of Telepathy p.173",
  },
  {
    name: "Goggles of Night", matchType: "item", equipped: true,
    nullifications: { special: { darkvision60: true } },
    source: "DMG Goggles of Night p.172",
  },
  {
    name: "Driftglobe", matchType: "item",
    nullifications: {},
    source: "DMG Driftglobe p.166 — light source",
  },

  // ── Resource / utility items ────────────────────────────────────────────
  {
    name: "Pearl of Power", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { canRecoverSlot: true } }, // up to L3 once per long rest
    source: "DMG Pearl of Power p.184",
  },
  {
    name: "Ring of Spell Storing", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { storedSpells: true } },
    source: "DMG Ring of Spell Storing p.192",
  },
  {
    name: "Ring of Spell Turning", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { saves: { advantage: ["spell"] }, special: { reflectsTargetedSpells: true } },
    source: "DMG Ring of Spell Turning p.193 — legendary",
  },
  {
    name: "Ring of Three Wishes", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { wishesAvailable: true } },
    source: "DMG Ring of Three Wishes p.193",
  },
  {
    name: "Ring of Regeneration", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { ringRegeneration: true } }, // 1d6 HP / 10 min
    source: "DMG Ring of Regeneration p.192",
  },
  {
    name: "Ring of Free Action", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: {
      conditions: { immune: ["paralyzed", "restrained", "grappled"] },
      special: { freedomOfMovement: true },
    },
    source: "DMG Ring of Free Action p.191",
  },
  {
    name: "Ring of Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { ringOfResistance: true } }, // type read from item subtype
    source: "DMG Ring of Resistance p.192",
  },
  {
    name: "Ring of Evasion", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { reactionConvertDexSaveToSuccess: true } }, // reaction once per dawn
    source: "DMG Ring of Evasion p.191",
  },
  {
    name: "Ring of Acid Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { acid: "resistant" } },
    source: "DMG Ring of Resistance — Acid",
  },
  {
    name: "Ring of Cold Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { cold: "resistant" } },
    source: "DMG Ring of Resistance — Cold",
  },
  {
    name: "Ring of Fire Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { fire: "resistant" } },
    source: "DMG Ring of Resistance — Fire",
  },
  {
    name: "Ring of Force Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { force: "resistant" } },
    source: "DMG Ring of Resistance — Force",
  },
  {
    name: "Ring of Lightning Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { lightning: "resistant" } },
    source: "DMG Ring of Resistance — Lightning",
  },
  {
    name: "Ring of Necrotic Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { necrotic: "resistant" } },
    source: "DMG Ring of Resistance — Necrotic",
  },
  {
    name: "Ring of Poison Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { poison: "resistant" } },
    source: "DMG Ring of Resistance — Poison",
  },
  {
    name: "Ring of Psychic Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { psychic: "resistant" } },
    source: "DMG Ring of Resistance — Psychic",
  },
  {
    name: "Ring of Radiant Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { radiant: "resistant" } },
    source: "DMG Ring of Resistance — Radiant",
  },
  {
    name: "Ring of Thunder Resistance", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { damage: { thunder: "resistant" } },
    source: "DMG Ring of Resistance — Thunder",
  },

  // ── Movement / Utility ──────────────────────────────────────────────────
  {
    name: "Boots of Flying", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { canFly: true } },
    source: "DMG Boots of Flying p.155",
  },
  {
    name: "Boots of Levitation", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { canLevitate: true } },
    source: "DMG Boots of Levitation p.155",
  },
  {
    name: "Boots of Striding and Springing", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { walkingSpeedNoLessThan30: true, jumpDistanceTriple: true } },
    source: "DMG Boots of Striding and Springing p.156",
  },
  {
    name: "Winged Boots", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { canFly: true } },
    source: "DMG Winged Boots p.214",
  },
  {
    name: "Gloves of Swimming and Climbing", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { climbingSpeedEqualToWalking: true, swimmingSpeedEqualToWalking: true } },
    source: "DMG Gloves of Swimming and Climbing p.171",
  },
  {
    name: "Cloak of the Bat", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { batForm: true, stealthAdvantage: true } },
    source: "DMG Cloak of the Bat p.158",
  },
  {
    name: "Cape of the Mountebank", matchType: "item", equipped: true,
    nullifications: { special: { dimensionDoorOncePerDay: true } },
    source: "DMG Cape of the Mountebank p.157",
  },
  {
    name: "Necklace of Adaptation", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: {
      damage: { poison: "resistant" }, // approximation; RAW = breathe normally + advantage vs poison gas
      saves: { advantage: ["poison"] },
    },
    source: "DMG Necklace of Adaptation p.182",
  },

  // ── Healing items ───────────────────────────────────────────────────────
  {
    name: "Potion of Healing", matchType: "item",
    nullifications: {},
    source: "DMG Potion of Healing p.187 — instantaneous heal",
  },
  {
    name: "Potion of Greater Healing", matchType: "item",
    nullifications: {},
    source: "DMG Potion of Healing variants p.187",
  },
  {
    name: "Potion of Superior Healing", matchType: "item",
    nullifications: {},
    source: "DMG Potion of Healing variants p.187",
  },
  {
    name: "Potion of Supreme Healing", matchType: "item",
    nullifications: {},
    source: "DMG Potion of Healing variants p.187",
  },

  // ── Holy items ──────────────────────────────────────────────────────────
  {
    name: "Holy Avenger", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { holyAvenger: true } }, // 30ft aura — magic resistance for allies vs spells from fiends/undead
    source: "DMG Holy Avenger p.174",
  },

  // ── Stat / Saving items ─────────────────────────────────────────────────
  {
    name: "Ioun Stone Mastery", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { proficiencyBonusPlus1: true } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Awareness", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { cantBeSurprised: true } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Fortitude", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { hp: { maxBonus: 0 }, special: { hpMaxPlusLevel2: true } }, // +2 per level — handled in special calc
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Reserve", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { special: { storedSpells: true } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Strength", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { str: 19 } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Dexterity", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { dex: 19 } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Constitution", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { con: 19 } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Intellect", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { int: 19 } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Insight", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { wis: 19 } },
    source: "DMG Ioun Stone p.176",
  },
  {
    name: "Ioun Stone Leadership", matchType: "item", equipped: true, requiresAttunement: true,
    nullifications: { stats: { cha: 19 } },
    source: "DMG Ioun Stone p.176",
  },
];
