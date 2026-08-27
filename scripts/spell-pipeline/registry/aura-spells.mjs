// ─── ACE: QOL — Spell Registry: Aura Shape ────────────────────────────────────
// Caster-anchored emanation with per-turn re-evaluation. Spirit Guardians,
// Aura of Vitality, Holy Weapon.
//
// IMPORTANT — minimal entries by design (v0.7.72):
// The aura runtime (per-turn pulse, edge-to-edge 3D distance, disposition
// filtering, smart-anim fallback) lives in aura-engine.mjs and has shipped
// since v0.6.x. Registering these spells in the pipeline gives them the
// v0.7.21 cross-cutting services (slot deferral, Counterspell barrier, etc.)
// WITHOUT touching the proven runtime path — TemplateResolver.runAura
// is a no-op by design.
//
// DELIBERATELY NOT REGISTERED HERE: Crusader's Mantle, Spirit Shroud,
// Elemental Weapon. Those are already in buff-spells.mjs as multi-buff or
// single-buff entries (their aura emanation is wired through a flag on
// the caster's own Active Effect; the emanation tick is aura-engine's job).
// Double-registering would dual-dispatch through both BuffResolver and
// TemplateResolver. Pick one home — buff-spells already had them.
// ──────────────────────────────────────────────────────────────────────────────

export const AURA_SPELLS = {

  // ── Spirit Guardians (3rd, V·S·M, self, 15-ft emanation, 10 min, conc.) ─
  // 3d8 radiant (good cleric) or 3d8 necrotic (evil cleric) on hostile
  // creatures' first entry per turn or at the start of their turn inside.
  // WIS save half. Halves their speed while inside.
  "spirit guardians": {
    shape: "template-trigger",
    // ⚠️🔴 WAS shape "aura", WHICH RESOLVED TO NOTHING AT ALL.
    //
    // "aura" dispatches to TemplateResolver.runAura, a no-op whose comment
    // said the work was "handled by aura-engine". aura-engine knows five
    // PALADIN CLASS FEATURES and no spells, so this cast fell through three
    // layers and landed nowhere. Johnny, 2026-08-27: "Spirit Guardians did
    // absolutely nothing: no animation, nothing."
    //
    // ⚠️ IT IS MOONBEAM WITH A DIFFERENT ORIGIN. Persistent template,
    // save on entering and again at the start of a turn inside, half on a
    // success - which is exactly what template-trigger drives, and Moonbeam
    // has been proving that path works. spell-timing.mjs already tags this
    // ENTER_START with a WIS save and half on pass, so the data was ready and
    // only the dispatch was wrong.
    //
    // ⚠️ THE ONE REAL DIFFERENCE is that it is centred on the caster and
    // travels with them. The concentration tracker already fires entry saves
    // when a TEMPLATE MOVES onto somebody, so dragging it along with the
    // caster resolves correctly. What it will not do is move itself.
    range: 0,
    save: { ability: "wis", halfOnPass: true },
    flavorOnConfirm: "A 15-ft emanation of guardian spirits surrounds the caster. Hostile creatures: 3d8 radiant or necrotic on first entry per turn / start of turn inside (WIS save half). Speed halved inside.",
  },

  // ── Aura of Vitality (3rd, V, self, 30-ft emanation, 1 min, conc.) ──────
  // Bonus action: heal one creature in range for 2d6 HP. No damage, no save.
  "aura of vitality": {
    shape: "aura",
    range: 0,
    save: null,
    flavorOnConfirm: "A 30-ft emanation of healing energy follows the caster. Bonus action: heal one creature in range for 2d6 HP.",
  },

  // ── Holy Weapon (5th, V·S, self, 60 feet, 1 min, conc.) ───────────────────
  // 2014 ER: caster's weapon becomes magical, +2d10 radiant damage on hit,
  // burst 30 feet on dismiss (CON save vs 4d10 radiant, half). No aura per se;
  // the emanation behaviour is on the dismiss burst. Aura-engine handles
  // the burst on dismiss event via the buff's Active Effect lifecycle.
  "holy weapon": {
    shape: "aura",
    range: 0,
    save: { ability: "con", halfOnPass: true },
    flavorOnConfirm: "Your weapon glows with radiant power — +2d10 radiant per hit. As a bonus action, dismiss to burst 30 feet radiant (4d10 CON save half).",
  },
};
