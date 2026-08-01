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

/** Spectral purple for the Ghostly Howl wave (Johnny 2026-07-29 — was pale blue). */
const GHOSTLY_WAVE_COLOR = 0xa46bff;

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

  // ── Ghostly Howl (King, the Spectral Dire Wolf — 2026-07-10) ─────────────
  // CONFIRMED against King's own actor JSON (2026-07-11): "King lets out a
  // mournful howl. Each creature of his choice within 30 feet must succeed on
  // a DC 13 Wisdom saving throw or become Frightened for 1 minute." Johnny's
  // spec: no target-pick — everyone in 30 ft saves at once (the source's
  // position is the origin; save-area shape). On a fail → Frightened 1 min.
  // The `fx` fires the expanding ghostly waves + King's own wolf-howl sound
  // (broadcast to all clients, synced with the visual). The GM setting
  // `ghostlyHowlSound` overrides this default if changed.
  "ghostly howl": {
    shape: "save-area",
    range: 30,
    save: { ability: "wis", dc: 13, repeatAt: "endOfTurn" },
    effect: { key: "frightened", duration: { rounds: 10 } },  // 1 minute
    // "Each CREATURE within 30 ft" (statblock) — not just King's enemies.
    // King was friendly-disposition, so "enemies" wrongly skipped the whole
    // party (live-fire 2026-07-11). "all" = everyone in range saves; the GM
    // narrates whom King spares. Frightened re-saves at end of each turn.
    targets: "all",
    // It's a HOWL — a creature that can't hear it isn't frightened by it.
    // Deafened creatures (and, later, sound-blocked ones) auto-ignore it.
    requiresHearing: true,
    picker: { allowSelf: false, excludeDead: true },
    // ⚠️ NO DEFAULT SOUND — ON PURPOSE (2026-07-29).
    // The original default pointed at a file that doesn't exist, so ACE was
    // silent here and the howl Johnny always heard came from ANOTHER source
    // (Automated Animations matches items by name — see forge-aa-integration).
    // "Fixing" the dead path on 07-28 didn't restore a missing howl, it added a
    // SECOND one: a short blip over the top of the real howl. Johnny, live:
    // "it goes beep and then plays… it didn't use to do that."
    //
    // Silent by default is correct — we don't own this creature's audio. A GM
    // who wants ACE to play the sound sets `ghostlyHowlSound`, and that still
    // overrides. Do not put a file back here without checking what else is
    // already making noise for this item.
    fx: { kind: "ghostlyWave", radiusFt: 30, color: GHOSTLY_WAVE_COLOR },
    flavorOnConfirm: "King lets out a mournful howl — every creature within 30 ft must make a DC 13 Wisdom save or be Frightened.",
  },

  // Phase 2: more save-area / save-single / summon / teleport entries land here
  // as their shapes come online (Blinding Breath, gaze attacks, etc.).
};
