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

  // ── Banish (2024 Paladin legendary action — NOT the Banishment spell) ────
  // Target makes a CHA save. On fail: takes 3d6 force damage AND vanishes
  // until the start of the user's next turn, then reappears within 120 ft
  // of where it left. RAW reference: PHB 2024 Oath of Watchers / generic
  // monster "Banish" legendary actions (Strahd, Marquise of Pain, etc.).
  //
  // Notable contrast with the Banishment spell:
  //   • spell = CHA save → 1-minute concentration banish → permanent if full duration
  //   • feature = CHA save → end of user's next turn → ALWAYS returns within 120 ft
  //
  // Damage rides the activity's own damage parts via save-engine (not declared
  // here — every Banish item should already carry its 3d6 force on the save
  // activity). We deliberately do NOT set an `effect` key — banishment.mjs's
  // _onBanishFeatureSave catches the failed save via the ace-qol.saveComplete
  // hook and applies the SHORT banishShort effect lifecycle (hide + GM card
  // + return at start of user's next turn). Two-track approach keeps the
  // spell banishment.mjs flow and the feature short-banish flow cleanly split.
  "banish": {
    shape: "save-single",
    range: 60,
    save: { ability: "cha" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target makes a Charisma save — on a fail, takes 3d6 force damage and vanishes until the start of your next turn, then reappears within 120 ft.",
  },

  // ── Ghostly Howl (King's signature — 2026-07-10) ─────────────────────────
  // Johnny's spec, verbatim: "push it, visual waves go out 30 feet, anybody in
  // that 30-foot radius has to save immediately." No target-pick, no template —
  // the source's position IS the origin (save-area). Every enemy within 30 ft
  // saves at once; on a fail they're Frightened for 1 minute (the RAW-standard
  // "howl" effect — Wis save vs fear). The `fx` field fires the expanding
  // ghostly waves (AceFX.ghostlyWaveBroadcast) as the ability resolves.
  //
  // NOTE (morning-me / Johnny): if King's actual statblock uses a different
  // save (e.g. Con) or ALSO deals damage, this is a one-line change — the
  // save-area resolver auto-detects damage from the activity's own parts, and
  // the save ability + effect key live right here. Tell me the numbers and I
  // match them exactly.
  "ghostly howl": {
    shape: "save-area",
    range: 30,
    save: { ability: "wis", repeatAt: "endOfTurn" },
    effect: { key: "frightened", duration: { rounds: 10 } },  // 1 minute
    targets: "enemies",
    picker: { allowSelf: false, excludeDead: true },
    fx: { kind: "ghostlyWave", radiusFt: 30, color: 0xbfeaff },
    flavorOnConfirm: "A keening spectral howl rolls outward — every creature within 30 ft must save or be Frightened.",
  },

  // Phase 2: more save-area / save-single / summon / teleport entries land here
  // as their shapes come online (Blinding Breath, gaze attacks, etc.).
};
