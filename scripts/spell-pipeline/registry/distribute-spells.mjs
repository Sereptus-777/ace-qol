// ─── ACE: QOL — Spell Registry: Distribute Shape ─────────────────────────────
// Shape = N units of damage to be split across M targets, no attack roll.
// Magic Missile, Scorching Ray (2024 — 2014 routes through attack-single).
// ──────────────────────────────────────────────────────────────────────────────

export const DISTRIBUTE_SPELLS = {

  "magic missile": {
    shape: "distribute",
    range: 120,
    countResolver: (castLevel) => 3 + Math.max(0, (castLevel ?? 1) - 1),  // 3 base, +1/upcast
    unit: { formula: "1d4 + 1", type: "force" },
    picker: { allowSelf: false, excludeDead: true },
    schoolIcon: "icons/magic/perception/eye-ringed-green.webp",
    flavorOnConfirm: "Glowing darts of magical force streak unerringly to their targets.",
  },

  // ── Scorching Ray — REMOVED v0.7.74 (RAW correctness) ────────────────────
  // Previously routed through distribute shape which AUTO-HIT every ray —
  // strict RAW violation. Scorching Ray (BOTH 2014 AND 2024 PHB) requires
  // a RANGED SPELL ATTACK PER RAY. The earlier comment claiming 2024 changed
  // the spell to auto-hit was incorrect — verified against 2024 PHB ("Make
  // a ranged spell attack for each ray"). Distribute-shape auto-hit was
  // strictly stronger than RAW (no AC math, no Shield-spell defense, no
  // miss possibility) — that's a balance bug.
  //
  // Removed from the registry so dnd5e's default flow handles it. dnd5e
  // 5.x ships proper multi-attack support for Scorching Ray (3 separate
  // ranged spell attacks, each can target a different creature, each
  // resolves through the normal attack pipeline including Shield reactions).
  // The pipeline loses slot-deferral + Counterspell-barrier on this one
  // spell, but the RAW correctness win is worth it.
  //
  // PHASE 4 PROMISE — if the registry ever ships a multi-attack shape
  // (similar to multi-buff but with attack rolls per ray), Scorching Ray
  // moves into it with:
  //   shape: "attack-multi", range: 120,
  //   countResolver: (castLevel) => 3 + Math.max(0, castLevel - 2),
  //   unit: { formula: "2d6", type: "fire", attackRoll: true },
};
