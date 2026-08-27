// ─── ACE: QOL — Spell Registry: Summon Shape ──────────────────────────────────
// Spawn one or more creatures from a compendium (or world folder) at a
// caster-chosen location. Find Familiar, Animate Dead, Conjure Animals,
// Summon Beast / Fey / Construct / Aberration / Celestial / Fiend /
// Elemental / Undead.
//
// IMPORTANT (v0.7.72) — DELIBERATELY STILL EMPTY AT THE EXPORT LEVEL.
// dnd5e 5.x ships a working Summons configuration tab on the activity
// (CR-picker, statblock interpolation, attack/damage scaling); pipelining
// summon spells PREMATURELY would cause a real bug: the slot is deferred in
// preUseActivity for any registered spell, and without a SummonResolver to
// actually commit it the dispatch default branch refunds the slot →
// free Summon Beast / Find Familiar / Animate Dead casts.
//
// The PLANNED entries below are kept as a documentation skeleton so the
// Phase 4 SummonResolver knows the targets, ranges, and 2024 statblock
// hooks each summon needs. When SummonResolver lands, copy the
// `PLANNED_SUMMONS` shape into `SUMMON_SPELLS` and add a `case "summon"`
// in pipeline.mjs that opens the summon dialog + commits the slot.
//
// PHASE 4 PROMISE — when SummonResolver lands:
//   1. Dialog: "Summon a creature of CR ≤ N from <compendium>"
//   2. Selection grid: portraits of qualifying creatures with HP / AC
//   3. Click → spawn at template centre with the caster's disposition
//   4. Concentration link → on conc end the summon despawns
// ──────────────────────────────────────────────────────────────────────────────

export const SUMMON_SPELLS = {
  // Intentionally empty. See PLANNED_SUMMONS for the Phase 4 skeleton.
};

/**
 * Phase 4 SummonResolver target list — NOT exported into SPELL_REGISTRY.
 * Each entry mirrors the shape the real SummonResolver will consume:
 *
 *   shape:       "summon",
 *   range:       N ft,
 *   compendium:  "<pack-id>" or null (use the GM's local folder),
 *   crByLevel:   (castLevel) => maxCR     (RAW upcast scaling),
 *   countByLevel:(castLevel) => howMany,
 *   spawnDisposition: "ally" | "neutral" | "hostile" (default: ally),
 *   concentration: true | false,
 *   duration:    { minutes? hours? },
 *   flavorOnConfirm: "<one-line description>",
 *
 * The dialog UI is a generic SummonResolver responsibility; entry-level
 * fields above let it filter the candidate list correctly.
 */
export const PLANNED_SUMMONS = Object.freeze({

  // ── Find Familiar (1st ritual, V·S·M, 10 feet, 1 hour cast) ───────────────
  "find familiar": {
    range: 10,
    crByLevel: () => "1/8",
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: false,
    duration: { hours: 999 },     // permanent until dismissed
    flavorOnConfirm: "Summon a familiar spirit in beast form (rat, owl, cat, etc.) at a chosen point within 10 feet.",
  },

  // ── Animate Dead (3rd, V·S·M, 10 feet, 1 min cast, 24h duration) ──────────
  "animate dead": {
    range: 10,
    crByLevel: (lvl) => Math.max(1, lvl - 2),   // 3rd: 1 zombie/skeleton; +1 per upcast
    countByLevel: (lvl) => 1 + 2 * (lvl - 3),
    compendium: null,
    spawnDisposition: "ally",
    concentration: false,
    duration: { hours: 24 },
    flavorOnConfirm: "Animate a corpse or skeleton as a zombie or skeleton. Upcast adds more or re-asserts control for 24 hours.",
  },

  // ── Conjure Animals (3rd, V·S, 60 feet, 1 hour, conc.) ────────────────────
  "conjure animals": {
    range: 60,
    crByLevel: () => 2,        // RAW: max CR 2 base; PHB pick tier
    countByLevel: (lvl) => 1 * Math.pow(2, lvl - 3),
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon fey spirits in beast form. RAW: 1 CR-2 / 2 CR-1 / 4 CR-1/2 / 8 CR-1/4 (more on upcast).",
  },

  // ── Summon Beast (2nd, V·S·M, 90 feet, 1 hour, conc., 2024) ───────────────
  "summon beast": {
    range: 90,
    crByLevel: (lvl) => lvl + 1,   // statblock scales with cast level
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon a Bestial Spirit (Air / Land / Water). Player picks the form at cast time. 2024 statblock.",
  },

  // ── Summon Fey (3rd, V·S·M, 90 feet, 1 hour, conc., 2024) ─────────────────
  "summon fey": {
    range: 90,
    crByLevel: (lvl) => lvl,
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon a Fey Spirit (Fuming / Mirthful / Tricksy). Player picks the form at cast time.",
  },

  // ── Summon Undead (3rd, V·S·M, 90 feet, 1 hour, conc., 2024) ──────────────
  "summon undead": {
    range: 90,
    crByLevel: (lvl) => lvl,
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon an Undead Spirit (Ghostly / Putrid / Skeletal). Player picks the form at cast time.",
  },

  // ── Summon Celestial (5th, V·S·M, 90 feet, 1 hour, conc., 2024) ───────────
  "summon celestial": {
    range: 90,
    crByLevel: (lvl) => lvl,
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon a Celestial Spirit (Avenger / Defender).",
  },

  // ── Summon Fiend (6th, V·S·M, 90 feet, 1 hour, conc., 2024) ───────────────
  "summon fiend": {
    range: 90,
    crByLevel: (lvl) => lvl,
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon a Fiendish Spirit (Demon / Devil / Yugoloth).",
  },

  // ── Summon Elemental (4th, V·S·M, 90 feet, 1 hour, conc., 2024) ───────────
  "summon elemental": {
    range: 90,
    crByLevel: (lvl) => lvl,
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon an Elemental Spirit (Air / Earth / Fire / Water).",
  },

  // ── Summon Construct (4th, V·S·M, 90 feet, 1 hour, conc., 2024) ───────────
  "summon construct": {
    range: 90,
    crByLevel: (lvl) => lvl,
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon a Construct Spirit (Clay / Metal / Stone).",
  },

  // ── Summon Aberration (4th, V·S·M, 90 feet, 1 hour, conc., 2024) ──────────
  "summon aberration": {
    range: 90,
    crByLevel: (lvl) => lvl,
    countByLevel: () => 1,
    compendium: null,
    spawnDisposition: "ally",
    concentration: true,
    duration: { hours: 1 },
    flavorOnConfirm: "Summon an Aberrant Spirit (Beholderkin / Slaad / Star Spawn).",
  },
});
