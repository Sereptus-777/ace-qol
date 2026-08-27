// ─── ACE: QOL — Spell Registry: Chained Shape ─────────────────────────────────
// Primary target + auto-selected secondary targets propagated by RAW rule
// (Chain Lightning bounces, Catapult line of objects). For Phase 4.
//
// IMPORTANT (v0.7.72) — Chain Lightning intentionally NOT registered yet:
// RAW is "1 primary target + 3 secondaries within 30 feet of primary." Without
// a real ChainResolver to pick primary + filter secondaries, the closest
// pipeline shapes (save-single → only 1 target; save-area → every creature
// in 150 feet saves) both misrepresent the spell. The current dnd5e + save-
// engine flow lets the GM target 1 + 3 manually; that's strictly closer to
// RAW than pipelining it would be right now. Phase 4 ships a primary-picker
// + auto-secondary-detection ChainResolver and the entry below moves into
// SUMMON_SPELLS-style activation.
//
// Catapult IS registered — it's a single-target DEX-save spell that doesn't
// actually chain (the name is misleading; it just hurls one object at one
// creature). save-single shape fits cleanly.
// ──────────────────────────────────────────────────────────────────────────────

export const CHAIN_SPELLS = {

  // ── Catapult (1st, S, 60 feet, single target) ─────────────────────────────
  // Hurl a 5-lb object at a creature within 60 feet. Target takes 3d8
  // bludgeoning on a failed DEX save. +1d8 per upcast slot above 1st.
  "catapult": {
    shape: "save-single",
    range: 60,
    save: { ability: "dex", halfOnPass: false },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "A 5-lb object hurtles toward the target — DEX save vs 3d8 bludgeoning, no damage on success.",
  },
};

/**
 * Phase 4 ChainResolver targets — NOT exported into SPELL_REGISTRY.
 * When ChainResolver lands, move the entry below into CHAIN_SPELLS proper.
 *
 *   "chain lightning": {
 *     shape: "chained",
 *     range: 150,
 *     save: { ability: "dex", halfOnPass: true },
 *     // Primary picker UI: 1 target within 150 feet.
 *     // ChainResolver auto-picks up to 3 secondaries within 30 feet of primary,
 *     // skips invalid (caster, objects, dead). Each rolls own save.
 *     primaryRange: 150,
 *     secondaryRangeFromPrimary: 30,
 *     secondaryCount: 3,
 *     picker: { allowSelf: false, excludeDead: true },
 *     flavorOnConfirm: "A bolt of lightning leaps to a primary target — DEX save vs 10d8 lightning, half on success. Three secondaries within 30 feet each save separately.",
 *   },
 */
