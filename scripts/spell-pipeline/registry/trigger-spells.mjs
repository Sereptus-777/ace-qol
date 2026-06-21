// ─── ACE: QOL — Spell Registry: Template-Trigger Shape ────────────────────────
// Persistent template areas with entry / start-of-turn / exit save triggers.
// Spike Growth, Cloud of Daggers, Wall of Fire, Wall of Stone, Moonbeam,
// Grease, Web, Black Tentacles.
//
// IMPORTANT — minimal entries by design (v0.7.72):
// Per-turn re-evaluation, entry-save bookkeeping, Lingering Nausea, exit-
// with-advantage, difficult-terrain Regions — all of that lives in
// concentration-widget.mjs + spell-timing.mjs SPELL_TABLE and has been
// shipping since v0.5.x. Registering these spells in the pipeline gives
// them the v0.7.21 cross-cutting services (slot deferral, Counterspell
// barrier, etc.) WITHOUT touching the proven runtime path —
// TemplateResolver.runTrigger is a no-op by design.
// ──────────────────────────────────────────────────────────────────────────────

export const TRIGGER_SPELLS = {

  // ── Spike Growth (2nd, V·S·M, 150 ft, 20 ft sq, 10 min, conc.) ──────────
  // 2d4 piercing per 5 ft moved through (no save). Difficult terrain.
  // spell-timing has timing: NO_SAVE_AUTO + difficultTerrain: 2.
  "spike growth": {
    shape: "template-trigger",
    range: 150,
    save: null,
    flavorOnConfirm: "Hard spikes erupt across the 20-ft area — 2d4 piercing per 5 ft of movement, no save. Difficult terrain.",
  },

  // ── Cloud of Daggers (2nd, V·S·M, 60 ft, 5 ft cube, 1 min, conc.) ───────
  // 4d4 slashing on first entry per turn OR start of turn. No save.
  "cloud of daggers": {
    shape: "template-trigger",
    range: 60,
    save: null,
    flavorOnConfirm: "Spinning daggers fill the 5-ft cube — 4d4 slashing on first entry per turn or at the start of a turn spent inside. No save.",
  },

  // ── Wall of Fire (4th, V·S·M, 120 ft, 60 ft × 20 ft, 1 min, conc.) ──────
  // 5d8 fire damage, DEX save half. RAW: only one side burns (chosen by caster).
  "wall of fire": {
    shape: "template-trigger",
    range: 120,
    save: { ability: "dex", halfOnPass: true },
    flavorOnConfirm: "A 60-ft wall of flame, one side burning. Entry or end-of-turn-within-10-ft of the hot side → DEX save vs 5d8 fire, half on success.",
  },

  // ── Wall of Stone (5th, V·S·M, 120 ft, ten 10×10 panels, 10 min, conc.) ─
  // No damage on creation; the wall is the obstacle. DEX save to NOT be
  // trapped between panels if cast on a creature. (Stub entry for the
  // pipeline — concentration-widget owns the conc tick.)
  "wall of stone": {
    shape: "template-trigger",
    range: 120,
    save: { ability: "dex", halfOnPass: false },
    flavorOnConfirm: "Ten 10×10 stone panels appear, sealing space. A creature in the wall's path may DEX save to leap free; otherwise it ends up on whichever side the caster chooses.",
  },

  // ── Moonbeam (2nd, V·S·M, 120 ft, 5 ft × 40 ft cylinder, 1 min, conc.) ──
  // 2d10 radiant damage, CON save half. Shapechangers have disadvantage AND
  // revert on fail. Moves 60 ft as caster action.
  "moonbeam": {
    shape: "template-trigger",
    range: 120,
    save: { ability: "con", halfOnPass: true },
    flavorOnConfirm: "A silver beam wholly fills a 5-ft × 40-ft cylinder. Entry or start-of-turn → CON save vs 2d10 radiant, half on success. Shapechangers save with disadvantage and revert on fail.",
  },

  // ── Grease (1st, V·S·M, 60 ft, 10 ft square, 1 min) ─────────────────────
  // No damage. DEX save when entering or starting turn inside or fall prone.
  // Difficult terrain. v0.7.72 added to spell-timing SPELL_TABLE.
  "grease": {
    shape: "template-trigger",
    range: 60,
    save: { ability: "dex", halfOnPass: false },
    flavorOnConfirm: "A 10-ft square covered in slick grease. DEX save on entry or start-of-turn inside or fall prone. Difficult terrain.",
  },

  // ── Web (2nd, V·S·M, 60 ft, 20 ft cube, 1 hour, conc.) ──────────────────
  // No damage. DEX save on entry / start of turn inside or be restrained.
  // STR check (action) vs spell DC to break free. Difficult terrain.
  // Flammable — 2d4 fire on the next turn if ignited.
  "web": {
    shape: "template-trigger",
    range: 60,
    save: { ability: "dex", halfOnPass: false },
    flavorOnConfirm: "Thick webs fill the 20-ft cube. DEX save on entry / start of turn or be restrained. STR check vs spell DC to break free. Difficult terrain. Flammable.",
  },

  // ── Evard's Black Tentacles (4th, V·S·M, 90 ft, 20 ft sq, 1 min, conc.) ─
  // 3d6 bludgeoning on entry/start-of-turn (no save for damage in 2014;
  // 2024 wraps it under one DEX save). Restrained on fail (STR or DEX save
  // depending on edition).
  "evard's black tentacles": {
    shape: "template-trigger",
    range: 90,
    save: { ability: "dex", halfOnPass: false },
    flavorOnConfirm: "Squirming black tentacles fill the 20-ft square. 3d6 bludgeoning on entry / start of turn. Save or be restrained — STR (or DEX) check to break free.",
  },
  "black tentacles": {  // alias — some dnd5e items omit Evard's prefix
    shape: "template-trigger",
    range: 90,
    save: { ability: "dex", halfOnPass: false },
    flavorOnConfirm: "Squirming black tentacles fill the 20-ft square. 3d6 bludgeoning on entry / start of turn. Save or be restrained.",
  },
};
