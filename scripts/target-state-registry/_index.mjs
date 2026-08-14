// ─── ACE: QOL — Nullification Registry: Merged Index ─────────────────────────
// Concatenates all six sub-registries into one flat array the walker iterates.
//
// Sub-registries (lazy add new ones here):
//   - SPELL_EFFECTS       — active spell effects on target
//   - MAGIC_ITEMS         — equipped/attuned magic items
//   - CLASS_FEATURES      — class/subclass features + feats
//   - RACIAL_FEATURES     — racial traits
//   - ARTIFACTS           — artifacts + boon items + Curse of Strahd specifics
//   - BACKGROUND_FEATURES — backgrounds (mostly informational)
// ──────────────────────────────────────────────────────────────────────────────

import { SPELL_EFFECTS }        from "./spell-effects-registry.mjs";
import { MAGIC_ITEMS }          from "./magic-items-registry.mjs";
import { CLASS_FEATURES }       from "./class-features-registry.mjs";
import { RACIAL_FEATURES }      from "./racial-features-registry.mjs";
import { ARTIFACTS }            from "./artifacts-registry.mjs";
import { BACKGROUND_FEATURES }  from "./background-features-registry.mjs";

export const NULLIFICATION_REGISTRY = [
  ...SPELL_EFFECTS,
  ...MAGIC_ITEMS,
  ...CLASS_FEATURES,
  ...RACIAL_FEATURES,
  ...ARTIFACTS,
  ...BACKGROUND_FEATURES,
];

/**
 * Find a registry entry by the name printed on the item, or null.
 *
 * ⚠️ THE LOOKUP LIVES HERE, NOT IN THE CALLER. Added 2026-08-13 when the unknown
 * scout needed to ask "does ACE already cover this?" — the alternative was the
 * scout walking this array itself, which is a second definition of "registered"
 * that drifts the moment the entry shape changes. One reader, here.
 *
 * ⚠️ ALIASES MATTER. Entries carry them precisely because the same thing ships
 * under different names ("Shield" vs "Shield Spell"), and matching only `name`
 * would report a covered item as missing.
 */
export function findByName(name) {
  const q = String(name ?? "").trim().toLowerCase();
  if (!q) return null;
  for (const entry of NULLIFICATION_REGISTRY) {
    if (String(entry?.name ?? "").trim().toLowerCase() === q) return entry;
    for (const alias of (entry?.aliases ?? [])) {
      if (String(alias).trim().toLowerCase() === q) return entry;
    }
  }
  return null;
}

// Diagnostic helper — count entries per category
export function getRegistryStats() {
  return {
    spellEffects: SPELL_EFFECTS.length,
    magicItems: MAGIC_ITEMS.length,
    classFeatures: CLASS_FEATURES.length,
    racialFeatures: RACIAL_FEATURES.length,
    artifacts: ARTIFACTS.length,
    backgroundFeatures: BACKGROUND_FEATURES.length,
    total: NULLIFICATION_REGISTRY.length,
  };
}
