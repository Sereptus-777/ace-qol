// ─── ACE: QOL — Nullification Registry: Spell Effects ────────────────────────
// Entries fire when the listed spell's ActiveEffect is present on the target.
// Source: 2014 PHB + 2024 PHB + XGtE + TCoE. byEdition used where rules differ.
//
// Naming: match the dnd5e system's effect name verbatim where possible. Most
// spells create an effect with the spell's name; aliases catch variants.
// ──────────────────────────────────────────────────────────────────────────────

export const SPELL_EFFECTS = [

  // ── L1 ──────────────────────────────────────────────────────────────────
  {
    name: "Shield", aliases: ["Shield Spell"], matchType: "effect",
    nullifications: {
      ac: { bonus: 5 },
      spellImmune: ["magic missile"],
    },
    source: "PHB Shield p.275 — '+5 AC including against triggering attack, no damage from magic missile'",
  },
  {
    name: "Bless", matchType: "effect",
    nullifications: { saves: { bonus: { all: "1d4" } } },
    source: "PHB Bless p.219",
  },
  {
    name: "Bane", matchType: "effect",
    nullifications: { saves: { bonus: { all: "-1d4" } } },
    source: "PHB Bane p.216",
  },
  {
    name: "Sanctuary", matchType: "effect",
    nullifications: { special: { sanctuaryActive: true } },
    source: "PHB Sanctuary p.272 — attackers must WIS save or pick another target",
  },
  {
    name: "Protection from Evil and Good", aliases: ["Protection from Good and Evil"], matchType: "effect",
    nullifications: {
      attacks: { cantTarget: ["aberration", "celestial", "elemental", "fey", "fiend", "undead"] },
      conditions: { immune: ["charmed", "frightened"] },
      special: { protectionFromAlignmentAdvantage: true },
    },
    source: "PHB Protection from Evil and Good p.270",
  },
  {
    name: "Heroism", matchType: "effect",
    nullifications: { conditions: { immune: ["frightened"] } },
    source: "PHB Heroism p.250 — immune to frightened, temp HP each turn",
  },
  {
    name: "Mage Armor", matchType: "effect",
    nullifications: { special: { mageArmorActive: true } }, // AC = 13 + DEX (handled in AC calc)
    source: "PHB Mage Armor p.256",
  },
  {
    name: "Faerie Fire", matchType: "effect",
    nullifications: {
      attacks: { advantageVs: true },
      special: { cantBenefitFromInvisibility: true },
    },
    source: "PHB Faerie Fire p.239",
  },
  {
    name: "Hex", matchType: "effect",
    nullifications: { special: { hexed: true } },
    source: "PHB Hex p.251 — disadvantage on chosen ability check",
  },
  {
    name: "Hunter's Mark", matchType: "effect",
    nullifications: { special: { marked: true } },
    source: "PHB Hunter's Mark p.251 — +1d6 weapon damage from marker",
  },
  {
    name: "Compelled Duel", matchType: "effect",
    nullifications: { special: { compelledTo: true } },
    source: "PHB Compelled Duel p.224",
  },

  // ── L2 ──────────────────────────────────────────────────────────────────
  {
    name: "Blur", matchType: "effect",
    nullifications: { attacks: { disadvantageVs: true } },
    source: "PHB Blur p.219 — attackers vs you have disadvantage unless they can see through",
  },
  {
    name: "Mirror Image", matchType: "effect",
    nullifications: { special: { mirrorImageActive: true } }, // handled by mirror-image system
    source: "PHB Mirror Image p.260",
  },
  {
    name: "Aid", matchType: "effect",
    nullifications: { hp: { maxBonus: 5 } }, // +5 base; upcast adds more handled at apply time
    source: "PHB Aid p.211",
  },
  {
    name: "Warding Bond", matchType: "effect",
    nullifications: {
      ac: { bonus: 1 },
      saves: { bonus: { all: "1" } },
      damage: { acid: "resistant", bludgeoning: "resistant", cold: "resistant", fire: "resistant", force: "resistant", lightning: "resistant", necrotic: "resistant", piercing: "resistant", poison: "resistant", psychic: "resistant", radiant: "resistant", slashing: "resistant", thunder: "resistant" },
      special: { wardingBond: true },
    },
    source: "PHB Warding Bond p.288 — +1 AC, +1 saves, resistance to all damage",
  },
  {
    name: "Lesser Restoration", matchType: "effect",
    nullifications: {},
    source: "PHB Lesser Restoration p.255 — instantaneous, no state",
  },
  {
    name: "Pass Without Trace", matchType: "effect",
    nullifications: { saves: { bonus: { dex: "10" } } }, // Stealth bonus — informational
    source: "PHB Pass Without Trace p.264",
  },
  {
    name: "See Invisibility", matchType: "effect",
    nullifications: { special: { seesInvisible: true } },
    source: "PHB See Invisibility p.274",
  },

  // ── L3 ──────────────────────────────────────────────────────────────────
  {
    name: "Protection from Energy", matchType: "effect",
    nullifications: { special: { protectionFromEnergyActive: true } }, // type read from effect flags
    source: "PHB Protection from Energy p.270",
  },
  {
    name: "Haste", matchType: "effect",
    nullifications: { ac: { bonus: 2 }, saves: { advantage: ["dex"] }, special: { hasted: true } },
    source: "PHB Haste p.250",
  },
  {
    name: "Slow", matchType: "effect",
    nullifications: { ac: { bonus: -2 }, saves: { disadvantage: ["dex"] }, special: { slowed: true } },
    source: "PHB Slow p.277",
  },
  {
    name: "Spirit Guardians", matchType: "effect",
    nullifications: { special: { spiritGuardiansActive: true } },
    source: "PHB Spirit Guardians p.278",
  },
  {
    name: "Beacon of Hope", matchType: "effect",
    nullifications: { saves: { advantage: ["wis", "death"] }, special: { maxHealing: true } },
    source: "PHB Beacon of Hope p.218",
  },
  {
    name: "Crusader's Mantle", matchType: "effect",
    nullifications: { special: { crusadersMantleActive: true } },
    source: "PHB Crusader's Mantle p.230 — +1d4 radiant from allies in 30ft",
  },
  {
    name: "Counterspell", matchType: "effect",
    nullifications: {},
    source: "PHB Counterspell p.228 — instant, no lingering state",
  },
  {
    name: "Fly", matchType: "effect",
    nullifications: { special: { canFly: true } },
    source: "PHB Fly p.243",
  },

  // ── L4 ──────────────────────────────────────────────────────────────────
  {
    name: "Stoneskin", matchType: "effect",
    nullifications: {
      damage: { bludgeoning: "resistant", piercing: "resistant", slashing: "resistant" },
      special: { stoneskinNonmagicalOnly: true }, // resistance only vs nonmagical B/P/S — handled in apply
    },
    source: "PHB Stoneskin p.278 — resistance to nonmagical bludgeoning/piercing/slashing",
  },
  {
    name: "Death Ward", matchType: "effect",
    nullifications: { death: { wardActive: true } },
    source: "PHB Death Ward p.230 — first reduction-to-0 sets to 1 HP instead",
  },
  {
    name: "Freedom of Movement", matchType: "effect",
    nullifications: {
      conditions: { immune: ["grappled", "restrained", "paralyzed"] },
      special: { freedomOfMovement: true },
    },
    source: "PHB Freedom of Movement p.244",
  },
  {
    name: "Greater Invisibility", matchType: "effect",
    nullifications: { attacks: { disadvantageVs: true }, special: { invisibleSpellActive: true } },
    source: "PHB Greater Invisibility p.247",
  },
  {
    name: "Fire Shield", matchType: "effect",
    nullifications: { special: { fireShieldActive: true } }, // type (cold/warm) read from effect flags
    source: "PHB Fire Shield p.242",
  },
  {
    name: "Polymorph", matchType: "effect",
    nullifications: { special: { polymorphed: true } },
    source: "PHB Polymorph p.266",
  },
  {
    name: "Banishment", matchType: "effect",
    nullifications: { special: { banished: true } },
    source: "PHB Banishment p.217",
  },
  {
    name: "Compulsion", matchType: "effect",
    nullifications: { special: { compulsion: true } },
    source: "PHB Compulsion p.224",
  },

  // ── L5 ──────────────────────────────────────────────────────────────────
  {
    name: "Hold Monster", matchType: "effect",
    nullifications: { special: { paralyzedBySpell: true } },
    source: "PHB Hold Monster p.251",
  },
  {
    name: "Hold Person", matchType: "effect",
    nullifications: { special: { paralyzedBySpell: true } },
    source: "PHB Hold Person p.251",
  },
  {
    name: "Mass Cure Wounds", matchType: "effect",
    nullifications: {},
    source: "PHB Mass Cure Wounds p.258",
  },
  {
    name: "Greater Restoration", matchType: "effect",
    nullifications: {},
    source: "PHB Greater Restoration p.246",
  },
  {
    name: "Bigby's Hand", aliases: ["Arcane Hand"], matchType: "effect",
    nullifications: { special: { bigbysHandActive: true } },
    source: "PHB Bigby's Hand p.219",
  },
  {
    name: "Wall of Force", matchType: "effect",
    nullifications: {},
    source: "PHB Wall of Force p.286 — informational",
  },

  // ── L6 ──────────────────────────────────────────────────────────────────
  {
    name: "Globe of Invulnerability", matchType: "effect",
    nullifications: { special: { globeOfInvulnerabilityActive: true } }, // L5 and below cast outside don't affect inside
    source: "PHB Globe of Invulnerability p.246",
  },
  {
    name: "Heroes' Feast", matchType: "effect",
    nullifications: {
      conditions: { immune: ["poisoned", "frightened"] },
      saves: { advantage: ["wis"] },
      hp: { maxBonus: 12 }, // +2d10 max HP — approximated as +12
    },
    source: "PHB Heroes' Feast p.250",
  },
  {
    name: "True Seeing", matchType: "effect",
    nullifications: { special: { seesInvisible: true, seesEthereal: true } },
    source: "PHB True Seeing p.284",
  },
  {
    name: "Sunbeam", matchType: "effect",
    nullifications: {},
    source: "PHB Sunbeam p.279",
  },
  {
    name: "Disintegrate", matchType: "effect",
    nullifications: {},
    source: "PHB Disintegrate p.233 — instant, no lingering state",
  },

  // ── L7 ──────────────────────────────────────────────────────────────────
  {
    name: "Holy Aura", matchType: "effect",
    nullifications: {
      saves: { advantage: ["all"] },
      attacks: { disadvantageVs: true },
      special: { holyAuraActive: true }, // fiend/undead blind on hit
    },
    source: "PHB Holy Aura p.251",
  },
  {
    name: "Mirage Arcane", matchType: "effect",
    nullifications: {},
    source: "PHB Mirage Arcane p.260",
  },
  {
    name: "Regenerate", matchType: "effect",
    nullifications: { special: { regenerating: true } }, // 1 HP/round
    source: "PHB Regenerate p.271",
  },

  // ── L8 ──────────────────────────────────────────────────────────────────
  {
    name: "Mind Blank", matchType: "effect",
    nullifications: {
      damage: { psychic: "immune" },
      conditions: { immune: ["charmed"] },
      special: { mindBlankActive: true }, // immune to mind-reading, divination
    },
    source: "PHB Mind Blank p.260",
  },
  {
    name: "Antimagic Field", matchType: "effect",
    nullifications: { special: { antimagicFieldActive: true } },
    source: "PHB Antimagic Field p.213",
  },
  {
    name: "Earthquake", matchType: "effect",
    nullifications: {},
    source: "PHB Earthquake p.236",
  },
  {
    name: "Sunburst", matchType: "effect",
    nullifications: {},
    source: "PHB Sunburst p.279",
  },

  // ── L9 ──────────────────────────────────────────────────────────────────
  {
    name: "Foresight", matchType: "effect",
    nullifications: {
      attacks: { disadvantageVs: true },
      saves: { advantage: ["all"] },
      special: { foresightActive: true, cantBeSurprised: true },
    },
    source: "PHB Foresight p.244 — advantage on attacks/saves/checks, attacks vs disadvantage, can't be surprised",
  },
  {
    name: "Mass Heal", matchType: "effect",
    nullifications: {},
    source: "PHB Mass Heal p.258",
  },
  {
    name: "Power Word Heal", matchType: "effect",
    nullifications: {},
    source: "PHB Power Word Heal p.266",
  },
  {
    name: "True Polymorph", matchType: "effect",
    nullifications: { special: { truePolymorphed: true } },
    source: "PHB True Polymorph p.284",
  },
  {
    name: "Time Stop", matchType: "effect",
    nullifications: {},
    source: "PHB Time Stop p.282",
  },
  {
    name: "Imprisonment", matchType: "effect",
    nullifications: { special: { imprisoned: true } },
    source: "PHB Imprisonment p.252",
  },
  {
    name: "Wish", matchType: "effect",
    nullifications: {},
    source: "PHB Wish p.288 — varies",
  },

  // ── XGtE additions ─────────────────────────────────────────────────────
  {
    name: "Absorb Elements", matchType: "effect",
    nullifications: { special: { absorbElementsActive: true } }, // resistance to triggering type for round
    source: "XGtE Absorb Elements p.150",
  },
  {
    name: "Shield of Faith", matchType: "effect",
    nullifications: { ac: { bonus: 2 } },
    source: "PHB Shield of Faith p.275",
  },
  {
    name: "Spirit Shroud", matchType: "effect",
    nullifications: { special: { spiritShroudActive: true } }, // +1d8 of chosen type from caster
    source: "TCoE Spirit Shroud p.108",
  },
  {
    name: "Tasha's Mind Whip", matchType: "effect",
    nullifications: { special: { mindWhipped: true } }, // limited reaction/action
    source: "TCoE Mind Whip p.108",
  },
  {
    name: "Synaptic Static", matchType: "effect",
    nullifications: { special: { synapticStatic: true } }, // -1d6 to attacks/checks/saves using INT/WIS/CHA
    source: "XGtE Synaptic Static p.166",
  },
  {
    name: "Bones of the Earth", matchType: "effect",
    nullifications: {},
    source: "XGtE Bones of the Earth p.155",
  },
  {
    name: "Resistance", matchType: "effect",
    nullifications: { saves: { bonus: { all: "1d4" } } },
    source: "PHB Resistance p.272 — concentration cantrip, +1d4 to one save",
  },
  {
    name: "Guidance", matchType: "effect",
    nullifications: { special: { guidance: true } }, // +1d4 to one ability check
    source: "PHB Guidance p.248",
  },
  {
    name: "Bardic Inspiration", matchType: "effect",
    nullifications: { special: { hasBardicInspiration: true } },
    source: "PHB Bardic Inspiration p.53",
  },
  {
    name: "Hypnotic Pattern", matchType: "effect",
    nullifications: { special: { hypnoticPatternCharmed: true } },
    source: "PHB Hypnotic Pattern p.252",
  },
  {
    name: "Confusion", matchType: "effect",
    nullifications: { special: { confused: true } },
    source: "PHB Confusion p.224",
  },
  {
    name: "Otto's Irresistible Dance", matchType: "effect",
    nullifications: { special: { dancing: true } },
    source: "PHB Otto's Irresistible Dance p.264",
  },
  {
    name: "Charm Person", matchType: "effect",
    nullifications: { special: { charmedByCaster: true } },
    source: "PHB Charm Person p.221",
  },
  {
    // A creature that can't hear is simply unaffected by hearing-clause
    // spells (the hearing-gate module is the canonical list — keep in sync).
    name: "Deafened", matchType: "effect", aliases: ["Deaf"],
    nullifications: {
      spellImmune: [
        "vicious mockery", "dissonant whispers", "suggestion",
        "mass suggestion", "compulsion", "enthrall", "command",
      ],
    },
    source: "PHB conditions — Deafened; per-spell hearing clauses",
  },
  {
    name: "Suggestion", matchType: "effect",
    nullifications: { special: { suggestionActive: true } },
    source: "PHB Suggestion p.279",
  },
  {
    name: "Dominate Person", matchType: "effect",
    nullifications: { special: { dominatedByCaster: true } },
    source: "PHB Dominate Person p.235",
  },
  {
    name: "Dominate Monster", matchType: "effect",
    nullifications: { special: { dominatedByCaster: true } },
    source: "PHB Dominate Monster p.235",
  },
  {
    name: "Tasha's Hideous Laughter", matchType: "effect",
    nullifications: { special: { proneIncapacitated: true } },
    source: "PHB Tasha's Hideous Laughter p.280",
  },
  {
    name: "Feeblemind", matchType: "effect",
    nullifications: { special: { feebleminded: true } },
    source: "PHB Feeblemind p.239",
  },
  {
    name: "Bestow Curse", matchType: "effect",
    nullifications: { special: { cursed: true } },
    source: "PHB Bestow Curse p.218",
  },
  {
    name: "Crown of Madness", matchType: "effect",
    nullifications: { special: { crownOfMadness: true } },
    source: "PHB Crown of Madness p.229",
  },
];
