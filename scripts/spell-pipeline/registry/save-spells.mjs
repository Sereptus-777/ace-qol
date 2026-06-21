// ─── ACE: QOL — Spell Registry: Single-Target Save Shape ──────────────────────
// Single-pick portrait grid → target rolls save → effect applies on fail.
// SaveResolver wires a one-shot saveComplete listener; ConditionLibrary
// applies the registry's `effect.key` if the save failed.
// ──────────────────────────────────────────────────────────────────────────────

export const SAVE_SPELLS = {

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
    effect: { key: "suggestion", duration: { hours: 8 } },
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

  "crown of madness": {
    shape: "save-single",
    range: 120,
    save: { ability: "wis", onFail: "effect", repeatAt: "endOfTurn" },  // RAW: re-save at end of each turn
    effect: { key: "crown_of_madness", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
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
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "modify_memory", duration: "instantaneous" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Reach into a target's mind and modify up to 10 minutes of memory.",
  },

  "power word stun": {
    shape: "save-single",
    range: 60,
    save: { ability: "con", onFail: "effect", repeatAt: "endOfTurn" },  // 2024: CON save at end of each turn
    effect: { key: "power_word_stun", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target with ≤150 HP must succeed CON save or be stunned. Re-saves at end of each turn.",
  },

  "power word kill": {
    shape: "save-single",
    range: 60,
    // 2014 RAW: no save, HP-threshold instant kill. 2024 RAW: CON save.
    save: { ability: "con", onFail: "effect" },
    effect: { key: "dead", duration: "instantaneous" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "If target has ≤100 HP, they die. (2024: CON save negates.)",
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
    shape: "save-single",  // simplification: pipeline treats as single-target; real HP-pool flow handled by dnd5e default
    range: 90,
    // Sleep has no save — HP-pool mechanic. For pipeline purposes we route through single picker.
    save: { ability: "wis", onSuccess: "negate" },  // RAW has no save, but pipeline structure requires one — leave WIS as placeholder
    // v0.7.72: use "sleep_unconscious" key (renamed from "unconscious" so it
    // doesn't clobber the SRD unconscious condition in ALL_EFFECTS). The
    // renamed entry has FULL RAW changes (incapacitated + zero movement +
    // auto-crit melee + auto-fail STR/DEX) and a sleepSpell flag that
    // condition-raw-hooks.mjs watches so any damage wakes the sleeper.
    effect: { key: "sleep_unconscious", duration: { rounds: 10 } },
    picker: { allowSelf: false, excludeDead: true, creatureTypeFilter: null },  // any creature; HP cap not enforced here
    flavorOnConfirm: "Choose creatures within 20 ft of a point. 5d8 HP-pool; lowest current HP first; each affected falls unconscious.",
    _needsVerification: true,  // RAW Sleep doesn't use a save — pipeline impl is a simplification (HP-pool flow is a future phase)
  },

  "color spray": {
    shape: "save-single",  // similar simplification — RAW is HP-pool, no save
    range: 15,
    save: { ability: "wis", onSuccess: "negate" },
    effect: { key: "blinded", duration: { rounds: 10 } },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Dazzling colors blind creatures in a 15 ft cone (HP pool — pipeline simplification).",
    _needsVerification: true,
  },
};
