// ─── ACE: QOL — Spell Registry: Template-Save Shape ───────────────────────────
// Instant template area, target rolls save, damage scales by save result.
// Fireball, Lightning Bolt, Cone of Cold, Stinking Cloud, Sleet Storm, Ice Storm.
//
// IMPORTANT — minimal entries by design (v0.7.72):
// These spells have been working through dnd5e + save-engine + spell-timing
// since v0.4.x. Registering them in the pipeline gives them the v0.7.21
// cross-cutting services (slot deferral, Counterspell barrier, stale-target
// clear, cast-level cache) WITHOUT touching the proven runtime path —
// TemplateResolver.runSave is a no-op by design. The fields below are
// declarative metadata; the actual damage + save card is owned by
// save-engine + spell-timing.mjs SPELL_TABLE.
//
// `range` is informational (range to the centre of the template) and
// matches the PHB. `save.ability` mirrors spell-timing for sanity-check
// only — if the two disagree it's a bug in one of them.
// ──────────────────────────────────────────────────────────────────────────────

export const TEMPLATE_SPELLS = {

  // ── Fireball (3rd, V·S·M·sulfur+guano, 150 feet, 20 feet sphere) ────────────
  // 8d6 fire damage, DEX save half. RAW: ignites flammable objects not
  // worn or carried. Up to 17d6 at 9th-level upcast (+1d6/level above 3rd).
  "fireball": {
    shape: "template-save",
    range: 150,
    save: { ability: "dex", halfOnPass: true },
    flavorOnConfirm: "A streaking pinprick of light blossoms into a 20-ft sphere of fire — DEX save vs the spell DC, half damage on a success.",
  },

  // ── Lightning Bolt (3rd, V·S·M, self, 100 feet line × 5 feet) ────────────────
  // 8d6 lightning damage, DEX save half. Ignites flammable objects.
  "lightning bolt": {
    shape: "template-save",
    range: 0,        // origin is caster (line starts at the caster)
    save: { ability: "dex", halfOnPass: true },
    flavorOnConfirm: "A 100-ft line of lightning lances out — DEX save vs the spell DC, half on a success.",
  },

  // ── Cone of Cold (5th, V·S·M, self, 60 feet cone) ─────────────────────────
  // 8d8 cold damage, CON save half. 2014: kills a creature dropped to 0 HP
  // outright if it's a creature (not a PC) — we let dnd5e handle that ruling
  // since most tables treat it as "GM call."
  "cone of cold": {
    shape: "template-save",
    range: 0,
    save: { ability: "con", halfOnPass: true },
    flavorOnConfirm: "A 60-ft cone of biting cold blasts forward — CON save vs the spell DC, half on a success.",
  },

  // ── Stinking Cloud (3rd, V·S·M, 90 feet, 20 feet sphere, 1 min, conc.) ──────
  // No damage. CON save or the creature spends its action retching.
  // ALSO an area-denial family in spell-timing (entry + start-of-turn +
  // exit-with-advantage + Lingering Nausea). Template-save here covers the
  // INITIAL placement; concentration-widget owns the per-turn re-checks.
  "stinking cloud": {
    shape: "template-save",
    range: 90,
    save: { ability: "con", halfOnPass: false },
    flavorOnConfirm: "A 20-ft sphere of yellow nauseating gas. Creatures inside the gas must succeed a CON save or spend their action retching. Persistent area-denial — concentration-widget handles re-entry saves.",
  },

  // ── Sleet Storm (3rd, V·S·M, 150 feet, 40 feet cylinder, 1 min, conc.) ──────
  // No damage. DEX save when entering or as caster directs (PHB). Falls
  // prone on fail. Heavily obscured + extinguishes open flames.
  "sleet storm": {
    shape: "template-save",
    range: 150,
    save: { ability: "dex", halfOnPass: false },
    flavorOnConfirm: "A 40-ft cylinder of sleet + freezing rain. DEX save or fall prone. Concentration on the spell halts on a failed CON save vs DC 10.",
  },

  // ── Ice Storm (4th, V·S·M, 300 feet, 20 feet cylinder) ──────────────────────
  // 2d8 bludgeoning + 4d6 cold damage, DEX save half. Difficult terrain
  // for 1 round after (RAW). The save-engine handles the multi-type damage.
  "ice storm": {
    shape: "template-save",
    range: 300,
    save: { ability: "dex", halfOnPass: true },
    flavorOnConfirm: "A 20-ft cylinder of icy chunks slams down — DEX save vs the spell DC, half on a success. Ground stays difficult terrain for 1 round.",
  },

  // ── Faerie Fire (1st, V, 60 feet, 20-ft CUBE, 1 min, conc.) ───────────────
  // RAW (2014 + 2024): an AREA spell, NOT a target spell. You place a 20-ft
  // cube (dnd5e draws it; ACE square-snaps it to grid VERTICES — a 4×4 cube has
  // no centre square). EVERY creature inside — visible OR hidden — makes a DEX
  // save. On a FAIL it gets the `faerie_fire` effect (the cycling glow flushes
  // it out, attackers gain advantage, it can't benefit from invisibility). On a
  // SUCCESS it's untouched — an invisible creature that SAVES stays hidden.
  // No portrait picker (you flood an area, you don't pick a face). The save-engine
  // gathers the cube + rolls the saves; it applies this `effect` on each fail
  // (the template-save → effect hand-off in _applyFailedSaveConditions). Unlike
  // the other entries here, Faerie Fire carries an `effect` (no damage).
  "faerie fire": {
    shape: "template-save",
    range: 60,
    save: { ability: "dex", halfOnPass: false },
    effect: { key: "faerie_fire", duration: "concentration" },
    flavorOnConfirm: "A 20-ft cube blooms with blue, green, and violet light. Each creature inside makes a DEX save — on a failure it's outlined: attackers have advantage and it can't benefit from being invisible.",
  },
};
