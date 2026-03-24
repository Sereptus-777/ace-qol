// ============================================================
// ACE QOL — Spell Timing Classification
// Maps save-based AoE spells to their damage trigger timing.
// The D&D 5e Foundry system has NO metadata for when persistent
// spell damage triggers — this table is the ONLY source of truth.
// ============================================================

const MODULE_ID = "ace-qol";

// ── Timing Categories ────────────────────────────────────────
export const TIMING = Object.freeze({
  INSTANT:          "instant",           // One-shot: Fireball, Lightning Bolt
  ENTER_START:      "enter+startOfTurn", // Moonbeam, Spirit Guardians, Cloudkill
  ENTER_END:        "enter+endOfTurn",   // Wall of Fire, Insect Plague
  START_OF_TURN:    "startOfTurn",       // Incendiary Cloud
  END_OF_TURN:      "endOfTurn",         // Flaming Sphere (within 5ft)
  CASTER_ACTION:    "casterAction",      // Call Lightning, Sunbeam
  SPECIAL:          "special",           // Hunger of Hadar (two types at different times)
  NO_SAVE_AUTO:     "noSaveAuto",        // Cloud of Daggers, Spike Growth (no save, auto damage)
});

// ── Hardcoded Spell Timing Table ─────────────────────────────
// Keyed by lowercase spell name. Covers ~95% of real gameplay.
// For spells NOT in this table, auto-detection kicks in.
const SPELL_TABLE = {

  // ────── INSTANT (one-shot damage, template gone) ──────
  "fireball":              { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "lightning bolt":        { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "cone of cold":          { timing: TIMING.INSTANT, save: "con", onSave: "half" },
  "shatter":               { timing: TIMING.INSTANT, save: "con", onSave: "half" },
  "thunderwave":           { timing: TIMING.INSTANT, save: "con", onSave: "half" },
  "burning hands":         { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "ice storm":             { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "chain lightning":       { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "meteor swarm":          { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "circle of death":       { timing: TIMING.INSTANT, save: "con", onSave: "half" },
  "destructive wave":      { timing: TIMING.INSTANT, save: "con", onSave: "half" },
  "flame strike":          { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "divine word":           { timing: TIMING.INSTANT, save: "cha", onSave: "none" },
  "synaptic static":       { timing: TIMING.INSTANT, save: "int", onSave: "half" },
  "erupting earth":        { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "tidal wave":            { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "vitriolic sphere":      { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "acid splash":           { timing: TIMING.INSTANT, save: "dex", onSave: "none" },
  "earth tremor":          { timing: TIMING.INSTANT, save: "dex", onSave: "none" },
  "arms of hadar":         { timing: TIMING.INSTANT, save: "str", onSave: "half" },
  "aganazzar's scorcher":  { timing: TIMING.INSTANT, save: "dex", onSave: "half" },
  "word of radiance":      { timing: TIMING.INSTANT, save: "con", onSave: "none" },
  "sword burst":           { timing: TIMING.INSTANT, save: "dex", onSave: "none" },
  "thunderclap":           { timing: TIMING.INSTANT, save: "con", onSave: "none" },
  "sacred flame":          { timing: TIMING.INSTANT, save: "dex", onSave: "none" },
  "toll the dead":         { timing: TIMING.INSTANT, save: "wis", onSave: "none" },
  "poison spray":          { timing: TIMING.INSTANT, save: "con", onSave: "none" },
  "sunburst":              { timing: TIMING.INSTANT, save: "con", onSave: "half" },
  "prismatic spray":       { timing: TIMING.INSTANT, save: "dex", onSave: "varies" },
  "bones of the earth":    { timing: TIMING.INSTANT, save: "dex", onSave: "none" },

  // ────── ENTER + START OF TURN ──────
  "moonbeam":              { timing: TIMING.ENTER_START, save: "con", onSave: "half", notes: "Shapechanger disadvantage" },
  "spirit guardians":      { timing: TIMING.ENTER_START, save: "wis", onSave: "half", notes: "Moves with caster, halves speed" },
  "cloudkill":             { timing: TIMING.ENTER_START, save: "con", onSave: "half", notes: "Moves 10ft/round away from caster" },
  "sickening radiance":    { timing: TIMING.ENTER_START, save: "con", onSave: "none", notes: "+1 exhaustion on fail" },
  "blade barrier":         { timing: TIMING.ENTER_START, save: "dex", onSave: "half" },
  "dawn":                  { timing: TIMING.ENTER_START, save: "con", onSave: "half", notes: "Caster can move beam" },
  "create bonfire":        { timing: TIMING.ENTER_START, save: "dex", onSave: "none" },
  "dust devil":            { timing: TIMING.ENTER_START, save: "str", onSave: "half", notes: "Caster can move it" },
  "evard's black tentacles": { timing: TIMING.ENTER_START, save: "dex", onSave: "none", notes: "Also restrains on fail" },
  "stinking cloud":        { timing: TIMING.START_OF_TURN, save: "con", onSave: "none", notes: "No damage — wastes action" },
  "sleet storm":           { timing: TIMING.ENTER_START, save: "dex", onSave: "none", notes: "No damage — prone + conc check" },

  // ────── ENTER + END OF TURN ──────
  "wall of fire":          { timing: TIMING.ENTER_END, save: "dex", onSave: "half", notes: "One side only, 10ft range" },
  "insect plague":         { timing: TIMING.ENTER_END, save: "con", onSave: "half" },
  "wall of thorns":        { timing: TIMING.ENTER_END, save: "dex", onSave: "half" },

  // ────── START OF TURN ONLY ──────
  "incendiary cloud":      { timing: TIMING.START_OF_TURN, save: "dex", onSave: "half", notes: "Moves 10ft/round" },
  "maelstrom":             { timing: TIMING.START_OF_TURN, save: "str", onSave: "half", notes: "Pulls toward center" },

  // ────── END OF TURN ONLY ──────
  "flaming sphere":        { timing: TIMING.END_OF_TURN, save: "dex", onSave: "half", notes: "Within 5ft; caster rams as bonus action" },
  "investiture of flame":  { timing: TIMING.END_OF_TURN, save: "dex", onSave: "half", notes: "5ft aura around caster" },

  // ────── CASTER ACTION (caster uses action each turn) ──────
  "call lightning":        { timing: TIMING.CASTER_ACTION, save: "dex", onSave: "half", notes: "Action to call bolt each turn" },
  "sunbeam":               { timing: TIMING.CASTER_ACTION, save: "con", onSave: "half", notes: "Action to re-fire 60ft line" },
  "witch bolt":            { timing: TIMING.CASTER_ACTION, save: null, onSave: null, notes: "Action to deal auto-damage, no save" },
  "heat metal":            { timing: TIMING.CASTER_ACTION, save: "con", onSave: "none", notes: "Bonus action; CON save is to drop object" },

  // ────── SPECIAL (unique multi-phase timing) ──────
  "hunger of hadar":       {
    timing: TIMING.SPECIAL,
    phases: [
      { trigger: "startOfTurn", damage: "2d6", type: "cold", save: null, notes: "No save, auto cold damage" },
      { trigger: "endOfTurn", damage: "2d6", type: "acid", save: "dex", onSave: "none" },
    ],
  },
  "storm sphere":          {
    timing: TIMING.SPECIAL,
    phases: [
      { trigger: "enter+startOfTurn", damage: "2d6", type: "bludgeoning", save: "str", onSave: "none" },
      { trigger: "casterAction", damage: "4d6", type: "lightning", save: "dex", onSave: "half", notes: "Bonus action bolt" },
    ],
  },

  // ────── NO SAVE / AUTO DAMAGE ──────
  "cloud of daggers":      { timing: TIMING.NO_SAVE_AUTO, save: null, onSave: null, notes: "No save, auto damage on enter/start" },
  "spike growth":          { timing: TIMING.NO_SAVE_AUTO, save: null, onSave: null, notes: "2d4 per 5ft moved, no save" },
};


// ── Public API ───────────────────────────────────────────────

/**
 * Get the timing classification for a spell item.
 * Checks the hardcoded table first, then falls back to auto-detection.
 *
 * @param {Item} item — the spell/feature item
 * @returns {{
 *   timing: string,
 *   isInstant: boolean,
 *   isPersistent: boolean,
 *   fromTable: boolean,
 *   unclassified: boolean,
 *   save: string|null,
 *   onSave: string|null,
 *   notes: string|null,
 *   phases: object[]|null
 * }}
 */
export function getSpellTiming(item) {
  if (!item) return _makeResult(TIMING.INSTANT, true);

  const name = (item.name ?? "").toLowerCase().trim();

  // ── Check lookup table first ──
  const entry = SPELL_TABLE[name];
  if (entry) {
    const isInstant = entry.timing === TIMING.INSTANT;
    return {
      timing:       entry.timing,
      isInstant,
      isPersistent: !isInstant,
      fromTable:    true,
      unclassified: false,
      save:         entry.save ?? null,
      onSave:       entry.onSave ?? null,
      notes:        entry.notes ?? null,
      phases:       entry.phases ?? null,
    };
  }

  // ── Fallback: auto-detect from item data ──
  const sys = item.system ?? {};
  const durationUnits = sys.duration?.units ?? "";
  const isConcentration = sys.properties?.has?.("concentration")
                       || sys.concentration === true
                       || (typeof sys.properties === "object" && sys.properties?.concentration);

  // Check for template
  const templateType = sys.target?.template?.type ?? sys.target?.type ?? "";
  const hasTemplate = !!templateType;

  // Instant duration → instant spell
  if (durationUnits === "inst" || durationUnits === "") {
    return _makeResult(TIMING.INSTANT, false);
  }

  // Non-instant + template + concentration → persistent, default startOfTurn
  if (hasTemplate && isConcentration) {
    console.warn(`${MODULE_ID} | SpellTiming: "${item.name}" not in lookup table — defaulting to start-of-turn trigger`);
    return _makeResult(TIMING.START_OF_TURN, false, true);
  }

  // Non-instant + concentration but no template → probably a buff/debuff targeting
  // individuals (Hold Person, Bestow Curse) — treat as instant for our purposes
  if (isConcentration && !hasTemplate) {
    return _makeResult(TIMING.INSTANT, false);
  }

  // Absolute fallback
  return _makeResult(TIMING.INSTANT, false);
}

/**
 * Check if a spell name is in the hardcoded table.
 * @param {string} spellName
 * @returns {boolean}
 */
export function isKnownSpell(spellName) {
  return (spellName ?? "").toLowerCase().trim() in SPELL_TABLE;
}

/**
 * Get the raw table entry for a spell (or null).
 * @param {string} spellName
 * @returns {object|null}
 */
export function getTableEntry(spellName) {
  return SPELL_TABLE[(spellName ?? "").toLowerCase().trim()] ?? null;
}

// ── Helpers ──────────────────────────────────────────────────

function _makeResult(timing, fromTable, unclassified = false) {
  return {
    timing,
    isInstant:    timing === TIMING.INSTANT,
    isPersistent: timing !== TIMING.INSTANT,
    fromTable,
    unclassified,
    save:   null,
    onSave: null,
    notes:  null,
    phases: null,
  };
}
