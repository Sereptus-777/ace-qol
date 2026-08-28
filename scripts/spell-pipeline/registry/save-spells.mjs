// ─── ACE: QOL — Spell Registry: Single-Target Save Shape ──────────────────────
// Single-pick portrait grid → target rolls save → effect applies on fail.
// SaveResolver wires a one-shot saveComplete listener; ConditionLibrary
// applies the registry's `effect.key` if the save failed.
// ──────────────────────────────────────────────────────────────────────────────

export const SAVE_SPELLS = {

  // ── Command (1st level, 1 round, NO concentration) ──────────────────────
  //
  // ⚠️ dnd5e OWNS THE WORD. The premium PHB ships Command with one ACTIVITY per
  // word — Approach, Flee, Grovel, Halt — and that picker already works. We do
  // NOT rebuild it; the save card already prints the chosen word ("Vampire casts
  // Grovel on Izek"). ACE's job is the part nothing did: land an effect on a
  // failed save so the table can SEE the creature is under a command.
  //
  // ⚠️ NO RE-SAVE, AND NO CONCENTRATION. Duration is 1 round: the target obeys
  // on its NEXT turn and it is over. Anything that adds an end-of-turn re-save
  // here is wrong. (Contrast Hold Person directly above, which does re-save.)
  //
  // ⚠️ THE EFFECT IS A MARKER, NOT AN ENFORCEMENT. RAW the creature acts out the
  // command on its own turn — Grovel means it drops prone and ends its turn.
  // Applying prone at CAST time would be a full turn early, so we mark and let
  // the GM play it. Word-specific behaviour is the follow-up, and per
  // rule_check_premades_before_writing_a_spell.md I want to read how Chris's
  // Premades and the Midi showcase handled it before automating that part.
  "command": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },   // deliberately no repeatAt
    effect: { key: "command", duration: { rounds: 1 } },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "One creature must succeed on a Wisdom save or follow a one-word command on its next turn. No effect on undead, on a creature that does not understand your language, or if the command is directly harmful.",
  },

  "hold person": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect", repeatAt: "endOfTurn" },  // RAW: re-save at end of each turn
    // v0.7.72: use the spell-specific "hold_person" entry (not generic
    // "paralyzed") so the effect panel reads "Hold Person" — UX clarity +
    // the spell entry's changes are a superset (paralysis + zero movement).
    effect: { key: "hold_person", duration: "concentration" },
    picker: { allowSelf: false, creatureTypeFilter: "humanoid", excludeDead: true },
    flavorOnConfirm: "A humanoid must succeed on a Wisdom save or be paralyzed. Re-saves at end of each turn.",
  },

  "hold monster": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect", repeatAt: "endOfTurn" },  // RAW: re-save at end of each turn
    // v0.7.72: spell-specific entry, same reasoning as Hold Person above.
    effect: { key: "hold_monster", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Any non-undead creature must succeed on a Wisdom save or be paralyzed. Re-saves at end of each turn.",
  },

  "charm person": {
    shape: "save-single",
    range: 30,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "charm_person", duration: { hours: 1 } },
    picker: { allowSelf: false, creatureTypeFilter: "humanoid", excludeDead: true },
    flavorOnConfirm: "A humanoid must succeed on a Wisdom save or be charmed by you for 1 hour.",
  },

  "suggestion": {
    shape: "save-single",
    range: 30,
    save: { ability: "wis", onFail: "effect" },
    // Suggestion IS concentration RAW (up to 8 hours). The "concentration" signal
    // (not a fixed {hours:8}) is what wires the cleanup link. (Audit 2026-06-27.)
    effect: { key: "suggestion", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Suggest a course of activity — target must save or follow it.",
  },

  "banishment": {
    shape: "save-single",
    range: 60,
    save: { ability: "cha", onFail: "effect" },  // RAW: no end-of-turn re-save; ends if concentration broken or 1 min passes
    effect: { key: "banishment", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target must succeed on a Charisma save or be banished to a harmless demiplane.",
  },

  "polymorph": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "polymorph", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: true },
    flavorOnConfirm: "Target transforms into a beast of CR equal to its level or lower (Wis save negates if unwilling).",
  },

  "dominate person": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "dominate_person", duration: "concentration" },
    picker: { allowSelf: false, creatureTypeFilter: "humanoid", excludeDead: true },
    flavorOnConfirm: "A humanoid must succeed on a Wisdom save or be dominated for the duration.",
  },

  "dominate monster": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "dominate_monster", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Any creature must succeed on a Wisdom save or be dominated for the duration.",
  },

  "feeblemind": {
    shape: "save-single",
    range: 150,
    save: { ability: "int", onFail: "effect" },
    effect: { key: "feeblemind", duration: { hours: 24 * 30 } },  // until cured
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Blast a creature's mind — Intelligence and Charisma drop to 1.",
  },

  "tasha's hideous laughter": {
    shape: "save-single",
    range: 30,
    save: { ability: "wis", onFail: "effect", repeatAt: "endOfTurn" },  // RAW: re-save at end of each turn
    effect: { key: "tashas_hideous_laughter", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target must succeed on a Wisdom save or drop prone and become incapacitated from laughter. Re-saves at end of each turn.",
  },

  // v0.7.74 AUDIT FIX — added creatureTypeFilter: "humanoid". RAW Crown of
  // Madness explicitly says "Choose one humanoid that you can see within
  // range." Without the filter, a player could target a dragon or beholder
  // and the spell would silently apply — Crown isn't valid on non-humanoids
  // RAW. The flavor text already called this out as humanoid-only; the
  // picker filter was just missing.
  "crown of madness": {
    shape: "save-single",
    range: 120,
    save: { ability: "wis", onFail: "effect", repeatAt: "endOfTurn" },  // RAW: re-save at end of each turn
    effect: { key: "crown_of_madness", duration: "concentration" },
    picker: { allowSelf: false, creatureTypeFilter: "humanoid", excludeDead: true },
    flavorOnConfirm: "Humanoid target wears a twisted iron crown — must attack whoever you direct. Re-saves at end of each turn.",
  },

  "bestow curse": {
    shape: "save-single",
    range: 5,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "bestow_curse", duration: "concentration" },
    picker: { allowSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch must save or be cursed for the duration.",
  },

  // ─── Phase 3.A additions ───

  "maze": {
    shape: "save-single",
    range: 60,
    save: { ability: "int", onFail: "effect", repeatAt: "endOfTurn" },  // RAW: INT save at end of each turn to escape
    effect: { key: "maze", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target is banished to a labyrinthine demiplane. INT save at end of each turn to escape.",
  },

  "imprisonment": {
    shape: "save-single",
    range: 30,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "imprisonment", duration: { seconds: 86400 * 365 } },  // until lifted
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target must succeed on a Wisdom save or be magically imprisoned. Lasts until the spell is dispelled.",
  },

  "geas": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "geas", duration: { seconds: 86400 * 30 } },  // 30 days
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Charge a creature to carry out a service or refrain from an action. Fail saves and take 5d10 psychic if they violate.",
  },

  "mass suggestion": {
    shape: "save-single",  // RAW: each creature saves separately; for picker we treat as single (loop manually for multi later)
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "suggestion", duration: { hours: 24 } },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Suggest a course of action — up to 12 creatures within range must save or follow it.",
  },

  "modify memory": {
    shape: "save-single",
    range: 30,
    save: { ability: "wis", onFail: "narrate" },
    // No mechanical condition — Modify Memory is narrative. Post the WIS save
    // card; on a fail the GM adjudicates the memory change. (Was applying an
    // empty, instantly-expiring effect that did nothing — removed.)
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Reach into a target's mind and modify up to 10 minutes of memory (GM narrates on a failed save — no mechanical effect).",
  },

  "power word stun": {
    shape: "save-single",
    range: 60,
    save: { ability: "con", onFail: "effect", repeatAt: "endOfTurn" },  // 2024: CON save at end of each turn
    // Power Word Stun is NOT a concentration spell (neither edition) — stunned
    // until a CON save succeeds at end of each turn. Marking it concentration
    // wrongly held the caster's concentration slot + tore it down on the next
    // conc cast. Fixed duration + the end-of-turn re-save clears it. (Audit 2026-06-27.)
    effect: { key: "power_word_stun", duration: { rounds: 10 } },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target with ≤150 HP must succeed CON save or be stunned. Re-saves at end of each turn.",
  },

  "power word kill": {
    shape: "save-single",  // routed to SaveResolver._runInstantKill (no save card)
    range: 60,
    // RAW (2014 + 2024): NO saving throw. ≤100 HP → die instantly. 2024: a target
    // ABOVE 100 HP instead takes 12d12 psychic (resistance applies); 2014: no
    // effect above 100 HP.
    instantKill: { hpThreshold: 100, overDamage: "12d12", overDamageType: "psychic" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "If the target has 100 HP or fewer, it dies — no save. (2024: otherwise it takes 12d12 psychic.)",
  },

  "polymorph any object": {
    shape: "save-single",
    range: 120,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "polymorph", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Permanently or temporarily transform a creature or object into another creature or object.",
  },

  "true polymorph": {
    shape: "save-single",
    range: 30,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "polymorph", duration: "concentration" },
    picker: { allowSelf: true, preHighlightSelf: false, excludeDead: true },
    flavorOnConfirm: "Target transforms into a different creature for the duration. After 1 hour of concentration, the change becomes permanent.",
  },

  "sleep": {
    // ── 2024 PHB (modern) ── WIS SAVE. Each creature of your choice in the area
    //    saves; on a FAIL it falls Unconscious. Concentration (up to 1 min); ends
    //    on damage or a shake; elves / Exhaustion-immune auto-succeed. Routed as
    //    multi-buff WITH a save — the SAME proven path as Bane / Faerie Fire:
    //    BuffResolver._runMultiWithSave gives a picker + a per-target WIS save card
    //    + the condition only on a fail.
    //    NOTE: the exact two-stage (Incapacitated for one turn → repeat save →
    //    Unconscious on the SECOND fail) is the next refinement; this ships the
    //    WIS save + Unconscious + concentration + wake-on-damage now.
    // ── 2014 PHB (legacy) ── NO save, 5d8-HP pool (byEdition override below).
    shape: "multi-buff",
    range: 60,
    save: { ability: "wis" },   // 2024: per-target Wisdom save; only failures fall asleep
    countResolver: () => 999,
    // sleep_unconscious carries the full RAW unconscious changes (incapacitated +
    // prone + zero movement + auto-crit melee + auto-fail STR/DEX) and a sleep
    // marker condition-raw-hooks.mjs watches so any damage wakes the sleeper.
    effect: { key: "sleep_unconscious", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true, creatureTypeFilter: null },
    flavorOnConfirm: "Each creature of your choice in the area must make a Wisdom save or fall asleep (Unconscious). Any damage wakes them.",
    byEdition: {
      legacy: {
        save: null,                 // 2014: NO save — the HP pool decides
        range: 90,
        // ⚠️ THE POOL IS THE SPELL. Without it "no save" meant every creature
        // the GM picked fell unconscious, so a 1st-level Sleep dropped a 40 HP
        // boss. 5d8, +2d8 per slot level above 1st, lowest current HP first,
        // undead unaffected. (Grok audit 2026-08-18.)
        hpPool: { formula: "5d8", perLevel: "d8", baseLevel: 1, excludeTypes: ["undead"] },
        effect: { key: "sleep_unconscious", duration: { rounds: 10 } },  // 2014 = 1 min, NOT concentration
        flavorOnConfirm: "No save (2014 RAW): choose creatures (5d8 HP pool, lowest current HP first) to fall unconscious; any damage wakes them.",
      },
    },
  },

  "color spray": {
    // RAW: NO save (HP-pool). Multi-buff so chosen creatures are blinded
    // unconditionally; the GM picks who drops. (Was save-single w/ a phantom WIS save.)
    // ⚠️🔴 IT IS A CONE. DRAW THE CONE. This said `multi-buff` until
    // 2026-08-28, which meant ACE popped a target picker and never put the
    // 15 foot cone on the map at all. Johnny: "It pops a target picker instead.
    // The animation was set to play when the cone appears. Well, that's your
    // fucking fault." It was. The curated animation was waiting for a cone that
    // ACE had decided not to draw, and cover, elevation and terrain had no area
    // to test anybody against either.
    //
    // `template-pool` places the spell's own area and lets area-pool.mjs apply
    // the hit-point pool to whoever is standing in it. The picker existed to
    // escape this sheet's phantom Constitution save, and the save engine now
    // stands aside for pool spells instead.
    shape: "template-pool",
    range: 15,
    // ⚠️ Same fix as Sleep — the comment already said "6d10 HP pool" while the
    // code blinded everyone picked. 6d10, +2d10 per level above 1st.
    hpPool: { formula: "6d10", perLevel: "d10", baseLevel: 1, excludeTypes: [] },
    // RAW: blinded until the END OF YOUR NEXT TURN = 1 round, not 1 minute.
    // Was {rounds:10} → 10× too long. (Audit 2026-06-27.)
    effect: { key: "blinded", duration: { rounds: 1 } },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Dazzling colors blind creatures in a 15 feet cone — 6d10 HP pool, lowest current hit points first.",
  },
};
