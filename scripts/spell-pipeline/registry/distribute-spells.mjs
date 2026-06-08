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

  // ── Scorching Ray ────────────────────────────────────────────────────────
  // 2024 RAW: auto-hit per ray (no attack rolls) — distribute shape applies cleanly.
  // 2014 RAW: melee spell attack roll per ray — would need attack-single shape.
  // For Phase 2 launch we ship the 2024 behavior; 2014 users can opt out via the
  // `weaponMasteryAllowIn2014`-style edition override (TBD; defer to dnd5e for now).
  "scorching ray": {
    shape: "distribute",
    range: 120,
    countResolver: (castLevel) => 3 + Math.max(0, (castLevel ?? 2) - 2),
    unit: { formula: "2d6", type: "fire" },
    unitNoun: "ray",
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Hurl 3 rays of fire — each strikes a creature within range for 2d6 fire damage.",
  },
};
