// ─── ACE: QOL — Feature Registry (pipeline) ──────────────────────────────────
// Feature-specific pipeline entries: monster / class / racial abilities whose
// mechanic is NOT simply a same-named spell. Same entry shape as the spell
// registry ({ shape, save, effect, picker, range, countResolver, byEdition… }),
// keyed by ability name in lowercase.
//
// How classification works (see pipeline.mjs _getEntry):
//   • A SPELL only ever uses the spell registry.
//   • A FEATURE (feat item) checks THIS registry first, then falls back to the
//     spell registry — so an ability mechanically identical to a spell (a
//     monster's Banishment, a Hold-type gaze, a Bless-like buff) automatically
//     reuses that spell's entry + resolver. One definition, works as spell OR
//     feature. "Banish is Banish."
//
// Add an entry HERE only when the feature needs DIFFERENT behavior than the
// same-named spell, or has no spell twin at all — Frightful Presence, breath
// weapons, Beguile, Awestruck, Blinding Breath, etc. These get populated per
// the pipeline category map (docs/SPELL_PIPELINE_ARCHITECTURE.md) as each
// supporting shape lands (save-area, summon, teleport, …).
// ──────────────────────────────────────────────────────────────────────────────

export const FEATURE_REGISTRY = {
  // ── Frightful Presence (emanation save) ──────────────────────────────────
  // Each enemy within range makes a Wis save or is Frightened for 1 min, with
  // a save at the end of each of its turns to shake it off. (RAW also grants
  // 24h immunity on a success — not modeled yet.) Proves the save-area shape.
  "frightful presence": {
    shape: "save-area",
    range: 120,
    save: { ability: "wis", repeatAt: "endOfTurn" },
    effect: { key: "frightened", duration: { rounds: 10 } },
    targets: "enemies",
    picker: { allowSelf: false, excludeDead: true },
  },

  // Phase 2: more save-area / save-single / summon / teleport entries land here
  // as their shapes come online (Blinding Breath, gaze attacks, etc.).
};
