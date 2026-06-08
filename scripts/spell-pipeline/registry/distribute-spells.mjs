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
    schoolIcon: "icons/magic/perception/eye-ringed-glow-blue.webp",
    flavorOnConfirm: "Glowing darts of magical force streak unerringly to their targets.",
  },

  // ── Scorching Ray (2024 = no attack rolls in this implementation; 2014 routes
  //    to attack-single. Disabled until 2014 dual-path is added in Phase 2.) ──
  // "scorching ray": {
  //   shape: "distribute",
  //   range: 120,
  //   countResolver: (castLevel) => 3 + Math.max(0, (castLevel ?? 2) - 2),
  //   unit: { formula: "2d6", type: "fire" },
  //   picker: { allowSelf: false, excludeDead: true },
  //   byEdition: {
  //     legacy: { shape: "attack-single" /* per ray */ },
  //   },
  // },
};
