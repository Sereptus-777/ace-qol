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
  // ── Aura of Vitality ───────────────────────────────────────────────
  // ⚠️🔴 THIS SAID `shape: "aura"` AND THAT MEANT NOTHING HAPPENED. The aura
  // shape hands off to the aura engine, and that engine knows five things, all
  // paladin class features. It has never heard of a spell. The cast reached an
  // owner that could not accept it and died there, leaving one console warning.
  //
  // ⚠️ AN EMANATION IS NOT A TEMPLATE AND NOT A CLASS AURA. It is centred on
  // the caster, moves with them, and its whole use is a decision the caster
  // makes on their turn. That is its own shape.
  //
  // ⚠️ THE EDITIONS AGREE ON THE SIZE AND THE DICE, AND DIFFER ON THE COST.
  // 2014 spends a BONUS ACTION on a later turn; 2024 gives it "when you create
  // it and at the start of each of your turns". Both are offered once a turn, so
  // the card names the cost rather than pretending they are the same.
  "aura of vitality": {
    shape: "emanation-heal",
    range: 0,
    save: null,
    emanation: { radiusFt: 30, cost: "when you create it and at the start of each of your turns" },
    heal: { formula: () => "2d6" },
    byEdition: {
      "2014": { emanation: { radiusFt: 30, cost: "bonus action" } },
    },
    flavorOnConfirm: "A 30-ft emanation of healing energy follows the caster, restoring 2d6 hit points to one creature in it.",
  },

  // ── Holy Weapon (5th, V·S, self, 60 feet, 1 min, conc.) ───────────────────
  // 2014 ER: caster's weapon becomes magical, +2d10 radiant damage on hit,
  // burst 30 feet on dismiss (CON save vs 4d10 radiant, half). No aura per se;
  // the emanation behaviour is on the dismiss burst. Aura-engine handles
  // the burst on dismiss event via the buff's Active Effect lifecycle.
  // ── Holy Weapon ── DELIBERATELY NOT REGISTERED ───────────────────────
  //
  // ⚠️🔴 ITS ENTRY WAS DEAD AND ITS NUMBERS WERE WRONG. It carried
  // `shape: "aura"`, which hands off to the paladin class-feature engine and
  // therefore did nothing at all — the same fault as Aura of Vitality. And the
  // flavour promised +2d10 on hit and 4d10 on the burst; RAW is 2d8 and 4d8.
  //
  // ⚠️ AN ENTRY THAT IS WRONG IS WORSE THAN NO ENTRY. With none, the pipeline
  // does not claim the spell and dnd5e resolves the item on its own sheet —
  // which for a weapon buff with a dismiss burst is a working outcome, and the
  // inference engine still reads it. With a dead one, ACE claimed it and dropped
  // it. Nobody at this table owns the spell, so there is no live data to build a
  // proper shape against; it goes back to dnd5e until somebody does.
};
