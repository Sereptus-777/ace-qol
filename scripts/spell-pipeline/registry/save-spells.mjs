// ─── ACE: QOL — Spell Registry: Single-Target Save Shape ──────────────────────
// Single-pick portrait grid → target rolls save → effect applies on fail.
// SaveResolver wires a one-shot saveComplete listener; ConditionLibrary
// applies the registry's `effect.key` if the save failed.
// ──────────────────────────────────────────────────────────────────────────────

export const SAVE_SPELLS = {

  "hold person": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "paralyzed", duration: "concentration" },
    picker: { allowSelf: false, creatureTypeFilter: "humanoid", excludeDead: true },
    flavorOnConfirm: "A humanoid must succeed on a Wisdom save or be paralyzed for the duration.",
  },

  "hold monster": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "paralyzed", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Any non-undead creature must succeed on a Wisdom save or be paralyzed.",
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
    save: { ability: "cha", onFail: "effect" },
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
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "tashas_hideous_laughter", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Target must succeed on a Wisdom save or drop prone and become incapacitated from laughter.",
  },

  "crown of madness": {
    shape: "save-single",
    range: 120,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "crown_of_madness", duration: "concentration" },
    picker: { allowSelf: false, excludeDead: true },
    flavorOnConfirm: "Humanoid target wears a twisted iron crown — must attack whoever you direct.",
  },

  "bestow curse": {
    shape: "save-single",
    range: 5,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "bestow_curse", duration: "concentration" },
    picker: { allowSelf: false, requiresAdjacent: true, excludeDead: true },
    flavorOnConfirm: "A creature you touch must save or be cursed for the duration.",
  },
};
