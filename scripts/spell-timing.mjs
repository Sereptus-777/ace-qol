// ============================================================
// ACE QOL — Spell Timing Classification
// Maps save-based AoE spells to their damage trigger timing.
//
// Resolution order (first match wins):
// 1. Item flag override:  flags.ace-qol.spellTiming
// 2. Description parsing: scans spell text for timing keywords
// 3. Hardcoded table:     known spells (safety net)
// 4. Heuristic fallback:  concentration + template → best guess
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

// Reverse-lookup set for validation
const VALID_TIMINGS = new Set(Object.values(TIMING));


// ═══════════════════════════════════════════════════════════════
//  LAYER 1: FLAG-BASED OVERRIDE
//  GMs or compendiums can set flags.ace-qol.spellTiming on any
//  spell item to override timing behavior. Supports:
//    flags.ace-qol.spellTiming.timing   (required — one of TIMING values)
//    flags.ace-qol.spellTiming.save     (optional — "dex", "con", etc.)
//    flags.ace-qol.spellTiming.onSave   (optional — "half", "none")
//    flags.ace-qol.spellTiming.notes    (optional — string)
// ═══════════════════════════════════════════════════════════════

function _checkFlagOverride(item) {
  const flags = item.flags?.["ace-qol"]?.spellTiming;
  if (!flags?.timing) return null;
  if (!VALID_TIMINGS.has(flags.timing)) {
    console.warn(`${MODULE_ID} | SpellTiming: "${item.name}" has invalid flag timing "${flags.timing}" — ignoring`);
    return null;
  }
  return {
    timing:       flags.timing,
    isInstant:    flags.timing === TIMING.INSTANT,
    isPersistent: flags.timing !== TIMING.INSTANT,
    fromTable:    false,
    fromFlag:     true,
    fromParsing:  false,
    unclassified: false,
    save:         flags.save ?? null,
    onSave:       flags.onSave ?? null,
    notes:        flags.notes ?? null,
    phases:       flags.phases ?? null,
    family:       flags.family ?? null,
    failEffect:   flags.failEffect ?? null,
  };
}


// ═══════════════════════════════════════════════════════════════
//  LAYER 2: DESCRIPTION PARSING
//  Scans spell description text for D&D 5e timing keywords.
//  Handles the standard phrases from PHB/XGtE/TCE/etc.
// ═══════════════════════════════════════════════════════════════

// Pre-compiled patterns for performance
const _PATTERNS = {
  // ── "enters the area for the first time on a turn or starts its turn there" ──
  enterStart: [
    /enters?\s+(?:the\s+)?(?:area|spell(?:'s)?\s+area|emanation|zone|cloud|sphere|guardians|beam)\s+for\s+the\s+first\s+time\s+on\s+a\s+turn\s+or\s+starts?\s+its\s+turn\s+there/i,
    /(?:first\s+)?enters?\s+(?:the\s+)?(?:area|zone|cloud)\b.*?\bor\s+starts?\s+(?:its|their|a)\s+turn/i,
    /when\s+a\s+creature\s+(?:enters?\s+(?:the\s+)?(?:area|spell|zone).*?|moves?\s+into\s+(?:the\s+)?(?:area|spell)).*?(?:also|or).*?start\s+of\s+(?:its|their|a\s+creature'?s?)\s+turn/i,
  ],

  // ── "enters the area for the first time on a turn or ends its turn there" ──
  enterEnd: [
    /enters?\s+(?:the\s+)?(?:area|wall|zone|thorns|plague|swarm)\s+for\s+the\s+first\s+time\s+on\s+a\s+turn\s+or\s+ends?\s+its\s+turn\s+there/i,
    /(?:first\s+)?enters?\s+(?:the\s+)?(?:area|wall|zone)\b.*?\bor\s+ends?\s+(?:its|their|a)\s+turn/i,
  ],

  // ── "starts its turn" (without an "enters" companion) ──
  startOfTurn: [
    /(?:at\s+the\s+)?start\s+of\s+(?:each\s+of\s+)?(?:its|their|a\s+creature'?s?)\s+turn/i,
    /when\s+(?:a\s+creature|it)\s+starts?\s+its\s+turn\s+(?:in|within|inside)/i,
  ],

  // ── "ends its turn" (without an "enters" companion) ──
  endOfTurn: [
    /(?:at\s+the\s+)?end\s+of\s+(?:each\s+of\s+)?(?:its|their|a\s+creature'?s?)\s+turn/i,
    /when\s+(?:a\s+creature|it)\s+ends?\s+its\s+turn\s+(?:in|within|inside|near)/i,
  ],

  // ── "as an action" / "use your action" / "bonus action" on subsequent turns ──
  casterAction: [
    /(?:on\s+(?:each|subsequent|your)\s+turn|each\s+turn\s+after\s+the\s+first).*?(?:you\s+can\s+use\s+(?:your|an?)\s+(?:action|bonus\s+action))/i,
    /(?:you\s+can\s+use\s+(?:your|an?)\s+(?:action|bonus\s+action)).*?(?:on\s+(?:each|subsequent|your|later)\s+turn)/i,
    /(?:as\s+an?\s+action|use\s+(?:your|a)\s+(?:bonus\s+)?action)\s+(?:on\s+(?:a\s+)?(?:subsequent|later)\s+turn|each\s+(?:round|turn))/i,
    /until\s+the\s+spell\s+ends.*?you\s+can\s+use\s+(?:your|an?)\s+(?:action|bonus\s+action)\s+(?:to|on)/i,
  ],

  // ── No save, automatic damage on entering / being in area ──
  noSaveAuto: [
    /(?:no\s+saving\s+throw|without\s+(?:a\s+)?(?:save|saving\s+throw)|automatically\s+takes?\s+(?:\d+d\d+\s+)?damage)/i,
    /takes?\s+\d+d\d+\s+(?:\w+\s+)?damage\s+for\s+(?:every|each)\s+(?:5|10)\s+feet/i,
  ],

  // ── Instant indicators (used to confirm duration=inst spells) ──
  instant: [
    /(?:each\s+)?creature\s+(?:in\s+(?:the\s+)?(?:area|line|cone|sphere|cube|cylinder)|within\s+\d+\s+feet)\s+must\s+(?:make|succeed)/i,
  ],
};

/**
 * Parse spell description to determine timing classification.
 * @param {Item} item
 * @returns {object|null} — timing result or null if no confident match
 */
function _parseDescription(item) {
  const desc = (item.system?.description?.value ?? "").replace(/<[^>]*>/g, " ").toLowerCase();
  if (!desc || desc.length < 20) return null;

  // ── Detect save ability from description ──
  const saveMatch = desc.match(/(?:must\s+(?:make|succeed\s+on)\s+a\s+)?(\w+)\s+saving\s+throw/i);
  const save = _normalizeSaveAbility(saveMatch?.[1] ?? null);

  // ── Detect half damage on save ──
  const halfMatch = /half\s+(?:as\s+much\s+)?damage\s+on\s+a\s+success/i.test(desc)
                 || /takes?\s+half\s+(?:(?:the|that)\s+)?damage/i.test(desc)
                 || /(?:on\s+a\s+)?success(?:ful\s+save)?,?\s+(?:a\s+creature\s+)?takes?\s+half/i.test(desc);
  const onSave = halfMatch ? "half" : (save ? "none" : null);

  // ── Check patterns in priority order ──
  // "enters + starts" must be checked before "starts" alone
  for (const re of _PATTERNS.enterStart) {
    if (re.test(desc)) return _makeParsedResult(TIMING.ENTER_START, save, onSave, item);
  }
  for (const re of _PATTERNS.enterEnd) {
    if (re.test(desc)) return _makeParsedResult(TIMING.ENTER_END, save, onSave, item);
  }

  // Caster action — check before start/end since the description may also mention turns
  for (const re of _PATTERNS.casterAction) {
    if (re.test(desc)) return _makeParsedResult(TIMING.CASTER_ACTION, save, onSave, item);
  }

  // No-save auto damage (Cloud of Daggers, Spike Growth)
  const sys = item.system ?? {};
  const durationUnits = sys.duration?.units ?? "";
  if (durationUnits !== "inst" && durationUnits !== "") {
    for (const re of _PATTERNS.noSaveAuto) {
      if (re.test(desc) && !save) return _makeParsedResult(TIMING.NO_SAVE_AUTO, null, null, item);
    }
  }

  // Start of turn (standalone — not paired with "enters")
  for (const re of _PATTERNS.startOfTurn) {
    if (re.test(desc)) return _makeParsedResult(TIMING.START_OF_TURN, save, onSave, item);
  }
  for (const re of _PATTERNS.endOfTurn) {
    if (re.test(desc)) return _makeParsedResult(TIMING.END_OF_TURN, save, onSave, item);
  }

  // No confident match from description
  return null;
}

function _normalizeSaveAbility(raw) {
  if (!raw) return null;
  const map = {
    strength: "str", str: "str",
    dexterity: "dex", dex: "dex",
    constitution: "con", con: "con",
    intelligence: "int", int: "int",
    wisdom: "wis", wis: "wis",
    charisma: "cha", cha: "cha",
  };
  return map[raw.toLowerCase()] ?? null;
}

function _makeParsedResult(timing, save, onSave, item) {
  console.log(`${MODULE_ID} | SpellTiming: "${item.name}" classified via description parsing → ${timing}`);
  return {
    timing,
    isInstant:    timing === TIMING.INSTANT,
    isPersistent: timing !== TIMING.INSTANT,
    fromTable:    false,
    fromFlag:     false,
    fromParsing:  true,
    unclassified: false,
    save,
    onSave,
    notes:  null,
    phases: null,
    family: null,
    failEffect: null,
  };
}


// ═══════════════════════════════════════════════════════════════
//  LAYER 3: HARDCODED TABLE (safety net for known spells)
//  Keyed by lowercase spell name. These are guaranteed correct
//  and serve as validation for the parser + catch edge cases
//  where description parsing fails (unusual wording, etc.).
// ═══════════════════════════════════════════════════════════════

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
  "blade barrier":         { timing: TIMING.ENTER_START, save: "dex", onSave: "half" },
  "dawn":                  { timing: TIMING.ENTER_START, save: "con", onSave: "half", notes: "Caster can move beam" },
  "create bonfire":        { timing: TIMING.ENTER_START, save: "dex", onSave: "none" },
  "dust devil":            { timing: TIMING.ENTER_START, save: "str", onSave: "half", notes: "Caster can move it" },
  "evard's black tentacles": { timing: TIMING.ENTER_START, save: "dex", onSave: "none", notes: "Also restrains on fail" },
  "sleet storm":           { timing: TIMING.ENTER_START, save: "dex", onSave: "none", notes: "No damage — prone + conc check" },

  // ────── AREA DENIAL FAMILY (entry + start-of-turn + exit-with-advantage) ──────
  // These all use the same homebrew-plus-RAW mechanic in concentration-widget:
  //   1. Save on entering (homebrew, one per turn)
  //   2. Save at start of turn while wholly inside (RAW)
  //   3. Save with advantage on exit, ONLY if failed a save this round
  //      Fail exit save → Lingering Nausea (Incapacitated) next turn
  //   4. Template deleted while inside-and-failed → Lingering Nausea queued
  // `failEffect` controls what extra effect to apply on a failed save
  // (damage is handled by the existing save-engine path via the item's
  // damage parts). null/undefined means "damage only, no extra effect."
  "stinking cloud":        { timing: TIMING.ENTER_START, save: "con", onSave: "none", family: "areaDenial", failEffect: "retching", autoSucceedIfCondImmune: ["poisoned"], notes: "RAW PHB: creatures that don't need to breathe OR are immune to poison automatically succeed. Entry save = homebrew." },
  "cloudkill":             { timing: TIMING.ENTER_START, save: "con", onSave: "half", family: "areaDenial", notes: "5d8 poison, half on save. Moves 10ft/round away from caster." },
  "sickening radiance":    { timing: TIMING.ENTER_START, save: "con", onSave: "none", family: "areaDenial", failEffect: "exhaustion+glowing", notes: "4d6 radiant + 1 exhaustion + glowing on fail." },
  "incendiary cloud":      { timing: TIMING.ENTER_START, save: "dex", onSave: "half", family: "areaDenial", notes: "10d8 fire, half on save. Moves 10ft/round." },
  "watery sphere":         { timing: TIMING.ENTER_START, save: "str", onSave: "none", family: "areaDenial", failEffect: "restrained", notes: "Restrained inside sphere on fail. Caster can move sphere." },

  // ────── ENTER + END OF TURN ──────
  "wall of fire":          { timing: TIMING.ENTER_END, save: "dex", onSave: "half", notes: "One side only, 10ft range" },
  "insect plague":         { timing: TIMING.ENTER_END, save: "con", onSave: "half" },
  "wall of thorns":        { timing: TIMING.ENTER_END, save: "dex", onSave: "half" },

  // ────── START OF TURN ONLY ──────
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
  // These still use phases for their unique mechanics, but `family: "areaDenial"`
  // also gives them the exit-save-with-advantage + Lingering Nausea treatment
  // when the player fails any save inside the cloud.
  "hunger of hadar":       {
    timing: TIMING.SPECIAL,
    family: "areaDenial",
    phases: [
      { trigger: "startOfTurn", damage: "2d6", type: "cold", save: null, notes: "No save, auto cold damage" },
      { trigger: "endOfTurn", damage: "2d6", type: "acid", save: "dex", onSave: "none" },
    ],
    notes: "RAW: auto 2d6 cold at start of turn; Dex save vs 2d6 acid at end of turn. Difficult terrain inside.",
  },
  "storm sphere":          {
    timing: TIMING.SPECIAL,
    family: "areaDenial",
    save: "str",
    onSave: "none",
    phases: [
      { trigger: "enter+startOfTurn", damage: "2d6", type: "bludgeoning", save: "str", onSave: "none" },
      { trigger: "casterAction", damage: "4d6", type: "lightning", save: "dex", onSave: "half", notes: "Bonus action bolt" },
    ],
    notes: "2d6 bludgeoning on Str-save fail (entry + start of turn). Caster has bonus-action lightning bolt.",
  },

  // ────── NO SAVE / AUTO DAMAGE ──────
  // Cloud of Daggers — auto damage on FIRST entry per turn OR start of turn.
  // Not per-5ft movement (that's Spike Growth). Routes through the area-denial
  // pipeline with a "no save, just damage" branch (family: areaDenialAuto).
  "cloud of daggers":      { timing: TIMING.ENTER_START, save: null, onSave: null, family: "areaDenialAuto", notes: "4d4 slashing on enter (1/turn) or start-of-turn; no save" },
  "spike growth":          { timing: TIMING.NO_SAVE_AUTO, save: null, onSave: null, notes: "2d4 per 5ft moved, no save" },
};


// ═══════════════════════════════════════════════════════════════
//  LAYER 4: HEURISTIC FALLBACK
//  When nothing else matches, use item metadata for best guess.
// ═══════════════════════════════════════════════════════════════

function _heuristicFallback(item) {
  const sys = item.system ?? {};
  const durationUnits = sys.duration?.units ?? "";
  const isConcentration = sys.properties?.has?.("concentration")
                       || sys.concentration === true
                       || (typeof sys.properties === "object" && sys.properties?.concentration);

  const templateType = sys.target?.template?.type ?? sys.target?.type ?? "";
  const hasTemplate = !!templateType;

  // Instant duration → instant spell
  if (durationUnits === "inst" || durationUnits === "") {
    return _makeResult(TIMING.INSTANT, false, false);
  }

  // Non-instant + template + concentration → persistent, default startOfTurn
  if (hasTemplate && isConcentration) {
    console.warn(`${MODULE_ID} | SpellTiming: "${item.name}" not in table, description parse failed — defaulting to start-of-turn. Set flags.ace-qol.spellTiming.timing on this item to fix.`);
    return _makeResult(TIMING.START_OF_TURN, false, true);
  }

  // Non-instant + concentration but no template → buff/debuff (Hold Person, etc.)
  if (isConcentration && !hasTemplate) {
    return _makeResult(TIMING.INSTANT, false, false);
  }

  // Absolute fallback
  return _makeResult(TIMING.INSTANT, false, false);
}


// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Get the timing classification for a spell item.
 * Resolution: flag override → description parse → hardcoded table → heuristic.
 *
 * @param {Item} item — the spell/feature item
 * @returns {{
 *   timing: string,
 *   isInstant: boolean,
 *   isPersistent: boolean,
 *   fromTable: boolean,
 *   fromFlag: boolean,
 *   fromParsing: boolean,
 *   unclassified: boolean,
 *   save: string|null,
 *   onSave: string|null,
 *   notes: string|null,
 *   phases: object[]|null
 * }}
 */
export function getSpellTiming(item) {
  if (!item) return _makeResult(TIMING.INSTANT, false, false);

  // ── Layer 1: Flag override (highest priority) ──
  const flagResult = _checkFlagOverride(item);
  if (flagResult) return flagResult;

  // ── Layer 1b: Non-spell items resolve IMMEDIATELY ──
  // The persistent start/end-of-turn classification below is ONLY for actual
  // spells. An equipment item, feat, or consumable with a save (e.g. the Holy
  // Symbol of Ravenkind's "Hold Vampires") presents and saves NOW. Without this
  // gate, a description phrase like "re-save at the end of each turn" made the
  // parser tag the item as a persistent end-of-turn save and DEFER its save card
  // (nothing posted to chat until end of turn). A flag override (above) can still
  // force timing for any specific item that genuinely needs it.
  if (item.type !== "spell") return _makeResult(TIMING.INSTANT, false, false);

  const name = (item.name ?? "").toLowerCase().trim();

  // ── Layer 2: Description parsing ──
  const parsedResult = _parseDescription(item);
  if (parsedResult) {
    // Cross-validate against table if entry exists (log mismatch for debugging)
    const tableEntry = SPELL_TABLE[name];
    if (tableEntry && tableEntry.timing !== parsedResult.timing) {
      console.warn(`${MODULE_ID} | SpellTiming: parser says "${item.name}" → ${parsedResult.timing}, but table says ${tableEntry.timing}. Using table (more reliable for known spells).`);
      // Table wins for known spells — it's hand-verified
      return _fromTableEntry(tableEntry);
    }
    return parsedResult;
  }

  // ── Layer 3: Hardcoded table ──
  const entry = SPELL_TABLE[name];
  if (entry) return _fromTableEntry(entry);

  // ── Layer 4: Heuristic fallback ──
  return _heuristicFallback(item);
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

function _fromTableEntry(entry) {
  const isInstant = entry.timing === TIMING.INSTANT;
  return {
    timing:       entry.timing,
    isInstant,
    isPersistent: !isInstant,
    fromTable:    true,
    fromFlag:     false,
    fromParsing:  false,
    unclassified: false,
    save:         entry.save ?? null,
    onSave:       entry.onSave ?? null,
    notes:        entry.notes ?? null,
    phases:       entry.phases ?? null,
    family:       entry.family ?? null,
    failEffect:   entry.failEffect ?? null,
    autoSucceedIfCondImmune: entry.autoSucceedIfCondImmune ?? null,
  };
}

function _makeResult(timing, fromTable, unclassified = false) {
  return {
    timing,
    isInstant:    timing === TIMING.INSTANT,
    isPersistent: timing !== TIMING.INSTANT,
    fromTable,
    fromFlag:     false,
    fromParsing:  false,
    unclassified,
    save:   null,
    onSave: null,
    notes:  null,
    phases: null,
    family: null,
    failEffect: null,
  };
}
