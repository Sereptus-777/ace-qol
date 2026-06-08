// ─── ACE: QOL — Nullification Registry: Background Features ─────────────────
// Most backgrounds give non-combat features. Listed for completeness but
// only the combat-impactful ones get nullifications. The "special" flags
// here are mostly informational for AI / GM tools.
// ──────────────────────────────────────────────────────────────────────────────

export const BACKGROUND_FEATURES = [

  {
    name: "Shelter of the Faithful", matchType: "feature",
    nullifications: { special: { shelterOfTheFaithful: true } },
    source: "PHB Acolyte background — free room/board at temples",
  },
  {
    name: "By Popular Demand", matchType: "feature",
    nullifications: { special: { byPopularDemand: true } },
    source: "PHB Entertainer background",
  },
  {
    name: "False Identity", matchType: "feature",
    nullifications: { special: { falseIdentity: true } },
    source: "PHB Charlatan background",
  },
  {
    name: "Criminal Contact", matchType: "feature",
    nullifications: { special: { criminalContact: true } },
    source: "PHB Criminal background",
  },
  {
    name: "Folk Hero", aliases: ["Rustic Hospitality"], matchType: "feature",
    nullifications: { special: { rusticHospitality: true } },
    source: "PHB Folk Hero background",
  },
  {
    name: "Guild Membership", matchType: "feature",
    nullifications: { special: { guildMembership: true } },
    source: "PHB Guild Artisan background",
  },
  {
    name: "Discovery", matchType: "feature",
    nullifications: { special: { hermitDiscovery: true } },
    source: "PHB Hermit background",
  },
  {
    name: "Position of Privilege", matchType: "feature",
    nullifications: { special: { positionOfPrivilege: true } },
    source: "PHB Noble background",
  },
  {
    name: "Wanderer", matchType: "feature",
    nullifications: { special: { wanderer: true } },
    source: "PHB Outlander background",
  },
  {
    name: "Researcher", matchType: "feature",
    nullifications: { special: { researcher: true } },
    source: "PHB Sage background",
  },
  {
    name: "Ship's Passage", matchType: "feature",
    nullifications: { special: { shipsPassage: true } },
    source: "PHB Sailor background",
  },
  {
    name: "Military Rank", matchType: "feature",
    nullifications: { special: { militaryRank: true } },
    source: "PHB Soldier background",
  },
  {
    name: "City Secrets", matchType: "feature",
    nullifications: { special: { citySecrets: true } },
    source: "PHB Urchin background",
  },
];
