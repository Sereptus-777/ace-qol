// ─── ACE: QOL — Nullification Registry: Class Features ──────────────────────
// Fires when the listed feature is on the actor (typically as a "feat" item).
// Many features have minLevel + classMatch gates to handle subclass features
// that share names with base-class features but apply differently.
// ──────────────────────────────────────────────────────────────────────────────

export const CLASS_FEATURES = [

  // ── Save / defense features ─────────────────────────────────────────────
  {
    name: "Slippery Mind", matchType: "feature", classMatch: "Rogue", minLevel: 15,
    nullifications: { saves: { bonus: { wis: "0" } }, special: { wisProficient: true } },
    source: "PHB Rogue 15 — gain proficiency in WIS saving throws",
  },
  {
    name: "Diamond Soul", matchType: "feature", classMatch: "Monk", minLevel: 14,
    nullifications: { special: { proficientInAllSaves: true } },
    source: "PHB Monk 14 — proficient in all saving throws",
  },
  {
    name: "Indomitable", matchType: "feature", classMatch: "Fighter", minLevel: 9,
    nullifications: { special: { indomitable: true } }, // 1/long rest reroll save; 2 at L13, 3 at L17
    source: "PHB Fighter 9 — reroll failed save once per long rest",
  },
  {
    name: "Magic Resistance", matchType: "feature",
    nullifications: { saves: { advantage: ["spell"] } },
    source: "Various — advantage on saves vs spells (Yuan-Ti, Drow High Magic, Gnome Cunning at level, etc.)",
  },
  {
    name: "Evasion", matchType: "feature",
    nullifications: { special: { evasion: true } }, // DEX save success = no damage; fail = half
    source: "PHB Rogue 7 / Monk 7 / Ranger 8 (Hunter)",
  },
  {
    name: "Improved Evasion", matchType: "feature",
    nullifications: { special: { improvedEvasion: true } }, // success = no damage; fail = half (no benefit when incapacitated)
    source: "Various epic features",
  },
  {
    name: "Uncanny Dodge", matchType: "feature", classMatch: "Rogue", minLevel: 5,
    nullifications: { special: { uncannyDodge: true } }, // halve incoming damage from one attack/turn
    source: "PHB Rogue 5",
  },
  {
    name: "Reliable Talent", matchType: "feature", classMatch: "Rogue", minLevel: 11,
    nullifications: { special: { reliableTalent: true } }, // skill rolls min 10
    source: "PHB Rogue 11",
  },
  {
    name: "Blindsense", matchType: "feature", classMatch: "Rogue", minLevel: 14,
    nullifications: { special: { blindsense10: true } },
    source: "PHB Rogue 14",
  },
  {
    name: "Elusive", matchType: "feature", classMatch: "Rogue", minLevel: 18,
    nullifications: { attacks: { disadvantageVs: false }, special: { noAdvantageVsUnlessIncapacitated: true } },
    source: "PHB Rogue 18 — no attack roll has advantage vs you unless you're incapacitated",
  },
  {
    name: "Stroke of Luck", matchType: "feature", classMatch: "Rogue", minLevel: 20,
    nullifications: { special: { strokeOfLuck: true } },
    source: "PHB Rogue 20",
  },
  {
    name: "Stillness of Mind", matchType: "feature", classMatch: "Monk", minLevel: 7,
    nullifications: { special: { stillnessOfMind: true } }, // end charm/fear at start of turn
    source: "PHB Monk 7",
  },
  {
    name: "Purity of Body", matchType: "feature", classMatch: "Monk", minLevel: 10,
    nullifications: { damage: { poison: "immune" }, conditions: { immune: ["diseased"] } },
    source: "PHB Monk 10",
  },
  {
    name: "Empty Body", matchType: "feature", classMatch: "Monk", minLevel: 18,
    nullifications: {
      damage: {
        acid: "resistant", bludgeoning: "resistant", cold: "resistant", fire: "resistant",
        lightning: "resistant", necrotic: "resistant", piercing: "resistant", poison: "resistant",
        psychic: "resistant", radiant: "resistant", slashing: "resistant", thunder: "resistant",
      },
      special: { emptyBody: true, invisibility: true },
    },
    source: "PHB Monk 18 — invisible + resistance to all damage except force",
  },
  {
    name: "Perfect Self", matchType: "feature", classMatch: "Monk", minLevel: 20,
    nullifications: { special: { perfectSelf: true } },
    source: "PHB Monk 20",
  },

  // ── Barbarian ───────────────────────────────────────────────────────────
  {
    name: "Rage", matchType: "feature", classMatch: "Barbarian", requiresStatus: "raging",
    nullifications: { damage: { bludgeoning: "resistant", piercing: "resistant", slashing: "resistant" } },
    source: "PHB Barbarian Rage — resistance to B/P/S while raging",
  },
  {
    name: "Reckless Attack", matchType: "feature", classMatch: "Barbarian", minLevel: 2,
    nullifications: { attacks: { advantageVs: true } }, // when actively used; informational
    source: "PHB Barbarian 2",
  },
  {
    name: "Danger Sense", matchType: "feature", classMatch: "Barbarian", minLevel: 2,
    nullifications: { saves: { advantage: ["dex"] } },
    source: "PHB Barbarian 2 — advantage on Dex saves vs effects you can see",
  },
  {
    name: "Brutal Critical", matchType: "feature", classMatch: "Barbarian", minLevel: 9,
    nullifications: { special: { brutalCritical: true } }, // extra damage die on crit
    source: "PHB Barbarian 9",
  },
  {
    name: "Relentless Rage", matchType: "feature", classMatch: "Barbarian", minLevel: 11,
    nullifications: { special: { relentlessRage: true } }, // CON save or drop to 1 HP instead of 0 while raging
    source: "PHB Barbarian 11",
  },
  {
    name: "Persistent Rage", matchType: "feature", classMatch: "Barbarian", minLevel: 15,
    nullifications: { special: { persistentRage: true } },
    source: "PHB Barbarian 15",
  },
  {
    name: "Indomitable Might", matchType: "feature", classMatch: "Barbarian", minLevel: 18,
    nullifications: { special: { strCheckMin20: true } },
    source: "PHB Barbarian 18",
  },
  {
    name: "Primal Champion", matchType: "feature", classMatch: "Barbarian", minLevel: 20,
    nullifications: { stats: { str: 24, con: 24 } },
    source: "PHB Barbarian 20",
  },
  {
    name: "Mindless Rage", matchType: "feature", classMatch: "Barbarian", minLevel: 6, requiresStatus: "raging",
    nullifications: { conditions: { immune: ["charmed", "frightened"] } },
    source: "PHB Berserker 6 — immune to charm/frightened while raging",
  },

  // ── Fighter ─────────────────────────────────────────────────────────────
  {
    name: "Second Wind", matchType: "feature", classMatch: "Fighter",
    nullifications: { special: { secondWind: true } },
    source: "PHB Fighter 1",
  },
  {
    name: "Action Surge", matchType: "feature", classMatch: "Fighter", minLevel: 2,
    nullifications: { special: { actionSurge: true } },
    source: "PHB Fighter 2",
  },
  {
    name: "Extra Attack", matchType: "feature",
    nullifications: { special: { extraAttacks: true } }, // count varies by class/level
    source: "PHB various — multiple attacks per Attack action",
  },
  {
    name: "Survivor", matchType: "feature", classMatch: "Fighter", minLevel: 20,
    nullifications: { special: { survivor: true } }, // regen 5+CON at start of turn if below half HP
    source: "PHB Fighter 20 (Champion)",
  },
  {
    name: "Superior Critical", matchType: "feature",
    nullifications: { special: { critRange18: true } },
    source: "PHB Champion 15 — crit on 18-20",
  },
  {
    name: "Improved Critical", matchType: "feature",
    nullifications: { special: { critRange19: true } },
    source: "PHB Champion 3 — crit on 19-20",
  },

  // ── Paladin Auras ───────────────────────────────────────────────────────
  {
    name: "Aura of Protection", matchType: "feature", classMatch: "Paladin", minLevel: 6,
    nullifications: { special: { auraOfProtectionActive: true } }, // +CHA to saves for allies in range
    source: "PHB Paladin 6",
  },
  {
    name: "Aura of Courage", matchType: "feature", classMatch: "Paladin", minLevel: 10,
    nullifications: { conditions: { immune: ["frightened"] }, special: { auraOfCourageActive: true } },
    source: "PHB Paladin 10",
  },
  {
    name: "Aura of Warding", matchType: "feature", classMatch: "Paladin", minLevel: 7,
    nullifications: { special: { auraOfWardingActive: true } }, // resistance to spell damage from Oath of the Ancients aura
    source: "PHB Ancients Paladin 7",
  },
  {
    name: "Cleansing Touch", matchType: "feature", classMatch: "Paladin", minLevel: 14,
    nullifications: { special: { cleansingTouch: true } },
    source: "PHB Paladin 14",
  },

  // ── Sorcerer ────────────────────────────────────────────────────────────
  {
    name: "Heart of the Storm", matchType: "feature", classMatch: "Sorcerer", minLevel: 6,
    nullifications: { damage: { lightning: "resistant", thunder: "resistant" } },
    source: "XGtE Storm Sorcerer 6",
  },
  {
    name: "Soul of the Storm", matchType: "feature", classMatch: "Sorcerer", minLevel: 18,
    nullifications: { damage: { lightning: "resistant", thunder: "resistant" }, special: { walkOnAir: true } },
    source: "XGtE Storm Sorcerer 18",
  },
  {
    name: "Draconic Resilience", matchType: "feature", classMatch: "Sorcerer", minLevel: 1,
    nullifications: { special: { draconicResilience: true } }, // AC 13 + DEX unwearing armor + 1 HP/level extra
    source: "PHB Draconic Bloodline 1",
  },
  {
    name: "Dragon Wings", matchType: "feature", classMatch: "Sorcerer", minLevel: 14,
    nullifications: { special: { dragonWings: true } },
    source: "PHB Draconic Bloodline 14",
  },
  {
    name: "Draconic Presence", matchType: "feature", classMatch: "Sorcerer", minLevel: 18,
    nullifications: { special: { draconicPresence: true } },
    source: "PHB Draconic Bloodline 18",
  },
  {
    name: "Tides of Chaos", matchType: "feature", classMatch: "Sorcerer", minLevel: 1,
    nullifications: { special: { tidesOfChaos: true } },
    source: "PHB Wild Magic 1",
  },

  // ── Warlock ─────────────────────────────────────────────────────────────
  {
    name: "Eldritch Master", matchType: "feature", classMatch: "Warlock", minLevel: 20,
    nullifications: { special: { eldritchMaster: true } },
    source: "PHB Warlock 20",
  },
  {
    name: "Fey Presence", matchType: "feature", classMatch: "Warlock", minLevel: 1,
    nullifications: { special: { feyPresence: true } },
    source: "PHB Archfey 1",
  },
  {
    name: "Dark One's Blessing", matchType: "feature", classMatch: "Warlock", minLevel: 1,
    nullifications: { special: { darkOnesBlessing: true } },
    source: "PHB Fiend 1",
  },
  {
    name: "Dark One's Own Luck", matchType: "feature", classMatch: "Warlock", minLevel: 6,
    nullifications: { special: { darkOnesOwnLuck: true } },
    source: "PHB Fiend 6",
  },
  {
    name: "Hurl Through Hell", matchType: "feature", classMatch: "Warlock", minLevel: 14,
    nullifications: { special: { hurlThroughHell: true } },
    source: "PHB Fiend 14",
  },
  {
    name: "Awakened Mind", matchType: "feature", classMatch: "Warlock", minLevel: 1,
    nullifications: { special: { telepathy: true } },
    source: "PHB Great Old One 1",
  },
  {
    name: "Entropic Ward", matchType: "feature", classMatch: "Warlock", minLevel: 6,
    nullifications: { special: { entropicWard: true } },
    source: "PHB Great Old One 6 — reaction give disadvantage to attacker who missed",
  },
  {
    name: "Thought Shield", matchType: "feature", classMatch: "Warlock", minLevel: 10,
    nullifications: { damage: { psychic: "resistant" }, special: { mindReadingBlocked: true } },
    source: "PHB Great Old One 10",
  },
  {
    name: "Create Thrall", matchType: "feature", classMatch: "Warlock", minLevel: 14,
    nullifications: { special: { canCreateThrall: true } },
    source: "PHB Great Old One 14",
  },

  // ── Cleric ──────────────────────────────────────────────────────────────
  {
    name: "Channel Divinity", matchType: "feature", classMatch: "Cleric",
    nullifications: { special: { hasChannelDivinity: true } },
    source: "PHB Cleric 2",
  },
  {
    name: "Divine Intervention", matchType: "feature", classMatch: "Cleric", minLevel: 10,
    nullifications: { special: { divineIntervention: true } },
    source: "PHB Cleric 10",
  },
  {
    name: "Destroy Undead", matchType: "feature", classMatch: "Cleric", minLevel: 5,
    nullifications: { special: { destroyUndead: true } },
    source: "PHB Cleric 5",
  },
  {
    name: "Divine Strike", matchType: "feature", classMatch: "Cleric",
    nullifications: { special: { divineStrike: true } },
    source: "PHB various Cleric domains 8",
  },
  {
    name: "Potent Spellcasting", matchType: "feature", classMatch: ["Cleric", "Druid"],
    nullifications: { special: { potentSpellcasting: true } },
    source: "PHB Cleric/Druid 8 — +spellmod to cantrip damage",
  },
  {
    name: "Avatar of Battle", matchType: "feature", classMatch: "Cleric", minLevel: 17,
    nullifications: { damage: { bludgeoning: "resistant", piercing: "resistant", slashing: "resistant" } },
    source: "PHB War Cleric 17",
  },
  {
    name: "Divine Eminence", matchType: "feature", classMatch: "Cleric", minLevel: 1,
    nullifications: { special: { divineEminence: true } },
    source: "Acolyte of Nature variant — informational",
  },

  // ── Druid ───────────────────────────────────────────────────────────────
  {
    name: "Wild Shape", matchType: "feature", classMatch: "Druid",
    nullifications: { special: { hasWildShape: true } },
    source: "PHB Druid 2",
  },
  {
    name: "Timeless Body", matchType: "feature", classMatch: "Druid", minLevel: 18,
    nullifications: { special: { timelessBody: true } },
    source: "PHB Druid 18",
  },
  {
    name: "Land's Stride", matchType: "feature", classMatch: ["Druid", "Ranger"],
    nullifications: { special: { landsStride: true } }, // ignore nonmagical difficult terrain
    source: "PHB Druid 6 / Ranger 8",
  },

  // ── Bard ────────────────────────────────────────────────────────────────
  {
    name: "Jack of All Trades", matchType: "feature", classMatch: "Bard", minLevel: 2,
    nullifications: { special: { jackOfAllTrades: true } },
    source: "PHB Bard 2",
  },
  {
    name: "Song of Rest", matchType: "feature", classMatch: "Bard", minLevel: 2,
    nullifications: { special: { songOfRest: true } },
    source: "PHB Bard 2",
  },
  {
    name: "Cutting Words", matchType: "feature", classMatch: "Bard", minLevel: 3,
    nullifications: { special: { cuttingWords: true } },
    source: "PHB Lore Bard 3",
  },
  {
    name: "Countercharm", matchType: "feature", classMatch: "Bard", minLevel: 6,
    nullifications: { special: { countercharm: true } },
    source: "PHB Bard 6",
  },
  {
    name: "Magical Secrets", matchType: "feature", classMatch: "Bard", minLevel: 10,
    nullifications: { special: { magicalSecrets: true } },
    source: "PHB Bard 10",
  },

  // ── Ranger ──────────────────────────────────────────────────────────────
  {
    name: "Favored Enemy", matchType: "feature", classMatch: "Ranger", minLevel: 1,
    nullifications: { special: { favoredEnemy: true } },
    source: "PHB Ranger 1",
  },
  {
    name: "Natural Explorer", matchType: "feature", classMatch: "Ranger", minLevel: 1,
    nullifications: { special: { naturalExplorer: true } },
    source: "PHB Ranger 1",
  },
  {
    name: "Vanish", matchType: "feature", classMatch: "Ranger", minLevel: 14,
    nullifications: { special: { vanishBonusActionHide: true } },
    source: "PHB Ranger 14",
  },
  {
    name: "Feral Senses", matchType: "feature", classMatch: "Ranger", minLevel: 18,
    nullifications: { special: { feralSenses: true } },
    source: "PHB Ranger 18",
  },

  // ── Wizard ──────────────────────────────────────────────────────────────
  {
    name: "Arcane Recovery", matchType: "feature", classMatch: "Wizard", minLevel: 1,
    nullifications: { special: { arcaneRecovery: true } },
    source: "PHB Wizard 1",
  },
  {
    name: "Empowered Evocation", matchType: "feature", classMatch: "Wizard", minLevel: 10,
    nullifications: { special: { empoweredEvocation: true } },
    source: "PHB Evocation 10",
  },
  {
    name: "Overchannel", matchType: "feature", classMatch: "Wizard", minLevel: 14,
    nullifications: { special: { overchannel: true } },
    source: "PHB Evocation 14",
  },
  {
    name: "Spell Mastery", matchType: "feature", classMatch: "Wizard", minLevel: 18,
    nullifications: { special: { spellMastery: true } },
    source: "PHB Wizard 18",
  },
  {
    name: "Signature Spells", matchType: "feature", classMatch: "Wizard", minLevel: 20,
    nullifications: { special: { signatureSpells: true } },
    source: "PHB Wizard 20",
  },
  {
    name: "Portent", matchType: "feature", classMatch: "Wizard", minLevel: 2,
    nullifications: { special: { portent: true } },
    source: "PHB Divination 2",
  },

  // ── Feats ───────────────────────────────────────────────────────────────
  {
    name: "Lucky", matchType: "feature",
    nullifications: { special: { lucky: true } }, // 3/long rest reroll
    source: "PHB Lucky feat p.167",
  },
  {
    name: "War Caster", matchType: "feature",
    nullifications: { saves: { advantage: ["concentration"] }, special: { warCasterOA: true } },
    source: "PHB War Caster feat p.170",
  },
  {
    name: "Resilient", matchType: "feature",
    nullifications: { special: { resilientFeat: true } }, // gain proficiency in chosen save
    source: "PHB Resilient feat p.168",
  },
  {
    name: "Tough", matchType: "feature",
    nullifications: { special: { toughFeat: true } }, // +2 HP per level
    source: "PHB Tough feat p.170",
  },
  {
    name: "Alert", matchType: "feature",
    nullifications: { special: { cantBeSurprised: true } }, // +5 initiative + unseen attackers don't get advantage
    source: "PHB Alert feat p.165",
  },
  {
    name: "Magic Initiate", matchType: "feature",
    nullifications: { special: { magicInitiate: true } },
    source: "PHB Magic Initiate feat p.168",
  },
  {
    name: "Mage Slayer", matchType: "feature",
    nullifications: { saves: { advantage: ["spell"] }, special: { mageSlayerOA: true } },
    source: "PHB Mage Slayer feat p.168 — advantage on saves vs spells from within 5ft",
  },
  {
    name: "Mobile", matchType: "feature",
    nullifications: { special: { mobile: true } },
    source: "PHB Mobile feat p.168",
  },
  {
    name: "Sentinel", matchType: "feature",
    nullifications: { special: { sentinel: true } },
    source: "PHB Sentinel feat p.169",
  },
  {
    name: "Polearm Master", matchType: "feature",
    nullifications: { special: { polearmMaster: true } },
    source: "PHB Polearm Master feat p.168",
  },
  {
    name: "Great Weapon Master", matchType: "feature",
    nullifications: { special: { greatWeaponMaster: true } },
    source: "PHB Great Weapon Master feat p.167",
  },
  {
    name: "Sharpshooter", matchType: "feature",
    nullifications: { special: { sharpshooter: true } },
    source: "PHB Sharpshooter feat p.170",
  },
  {
    name: "Healer", matchType: "feature",
    nullifications: { special: { healerFeat: true } },
    source: "PHB Healer feat p.167",
  },
  {
    name: "Tavern Brawler", matchType: "feature",
    nullifications: { special: { tavernBrawler: true } },
    source: "PHB Tavern Brawler feat p.170",
  },
  {
    name: "Heavy Armor Master", matchType: "feature",
    nullifications: { special: { heavyArmorMaster: true } }, // reduce nonmagical B/P/S by 3
    source: "PHB Heavy Armor Master feat p.167",
  },
  {
    name: "Inspiring Leader", matchType: "feature",
    nullifications: { special: { inspiringLeader: true } },
    source: "PHB Inspiring Leader feat p.167",
  },
  {
    name: "Observant", matchType: "feature",
    nullifications: { special: { lipReading: true, passiveBonus: 5 } },
    source: "PHB Observant feat p.168",
  },
  {
    name: "Skulker", matchType: "feature",
    nullifications: { special: { skulker: true } },
    source: "PHB Skulker feat p.170",
  },
  {
    name: "Magic Resistance Feat", aliases: ["Magic Resistance"], matchType: "feature",
    nullifications: { saves: { advantage: ["spell"] } },
    source: "Various — feat or feature granting magic resistance",
  },
];
