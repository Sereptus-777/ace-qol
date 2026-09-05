// ─── ACE: QOL — ONE spell-name key. Nothing else may write these rules. ──────
//
// ⚠️🔴 A SUFFIX BEAT THE WHOLE REGISTRY FOR MONTHS. Johnny's 2014 content is
// named "Aura of Vitality (Legacy)", "Sleep (Legacy)", "Mass Cure Wounds
// (Legacy)" — straight from the importer. Four separate places matched a spell
// by `item.name.trim().toLowerCase()` and nothing else, while every registry
// key is written plain. They never matched:
//
//   spell-pipeline/pipeline.mjs   the entire 124-entry curated registry
//   engagement-gate.mjs           the whole target-count table, 16 spells
//   spell-auto-damage.mjs         Magic Missile, twice
//
// So Aura of Vitality read as "self" (worked out) with "emanation-heal"
// (written by hand, correct, with a working resolver) sitting right there
// unused. Proven live on 2026-09-05 from his own console.
//
// ⚠️ THIS FILE IMPORTS NOTHING, DELIBERATELY. It is reached from the entry
// file's own dependency graph and from leaf modules alike, and a const read at
// top level inside an import cycle throws at load and kills the whole module
// (2026-08-28). No imports means no cycle is possible, which is also why it is
// safe for anything at all to depend on it.
//
// ⚠️ IF YOU ARE ABOUT TO WRITE `.toLowerCase()` ON A SPELL NAME, USE THIS.
// That is the entire reason it exists. A fifth private copy is how the drift
// started the first four times.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The lookup key for a spell, feature or item name.
 *
 * Drops the things an importer adds and the book never printed:
 *   "Aura of Vitality (Legacy)"  -> "aura of vitality"
 *   "Frightful Presence (1/Day)" -> "frightful presence"
 *   "Sleep [2024]"               -> "sleep"
 *   "Bigby’s Hand"               -> "bigby's hand"      (curly apostrophe)
 *
 * ⚠️ THE MAGIC BONUS IS NOT DROPPED HERE. "Rapier +3" stays "rapier +3",
 * because a curated entry is allowed to be about one specific magic weapon and
 * silently collapsing those would be a different bug in a place nobody looks.
 * Callers that want the base weapon ask for it explicitly — see `baseKey`.
 */
export function spellKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")     // "(Legacy)", "(1/Day)", "(Mirthful only)"
    .replace(/\s*\[[^\]]*\]\s*/g, " ")    // "[2024]"
    .replace(/[‘’]/g, "'")      // curly apostrophes
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The same, with a magic bonus taken off: "rapier +3" -> "rapier".
 * Returns null when there was no bonus to remove, so a caller can tell the
 * difference between "already the base name" and "stripped down to it".
 */
export function baseKey(name) {
  const key = spellKey(name);
  const bare = key.replace(/\s*[+-]\d+\s*$/, "").trim();
  return (bare && bare !== key) ? bare : null;
}
