// ─── A spell's words as plain text, with dnd5e's enrichers spelled out ──────
//
// ⚠️ ONE READER FOR THE WORDS, THREE THINGS READING THEM. The plan reads a
// spell's sentences to decide whether its area lingers; the facts reader reads
// them to see whether the caster chooses who is caught; the save-outcome reader
// reads them to tell a success effect from a failure effect. Three private
// copies of "strip the HTML" would drift apart, and the first one that forgot an
// enricher would read the whole 2024 book as saying nothing. So they share this.
//
// ⚠️🔴 THE 2024 BOOK WRITES ITS SUBJECTS AS ENRICHERS. Fear's description is
//     [[lookup @labels.description.affects]] in a 30-foot Cone ... makes a
//     [[/save ability=wis]] ...
// and dnd5e renders that as "Each creature in a 30-foot Cone ... makes a Wisdom
// saving throw". The words "each creature" appear nowhere in the stored text.
// Anything looking for them reads hundreds of spells as saying nothing, which is
// a silent blind spot rather than an error anybody would notice.
//
// (Moved here from spell-plan.mjs on 2026-09-11, unchanged.)
//
// ⚠️ IMPORTS NOTHING, so any reader can use it without risking an import cycle.
// ──────────────────────────────────────────────────────────────────────────────

/** The enrichers written out as the words dnd5e would render. */
export const expandEnrichers = (t) => String(t ?? "")
  .replace(/\[\[lookup\s+@labels\.description\.affects[^\]]*\]\]/gi, "each creature")
  .replace(/\[\[lookup\s+@labels\.description\.template[^\]]*\]\]/gi, "the area")
  .replace(/\[\[lookup[^\]]*\]\]/gi, " ")
  .replace(/\[\[\/save[^\]]*\]\]/gi, "saving throw")
  .replace(/\[\[\/damage[^\]]*\]\]/gi, "damage")
  .replace(/\[\[\/[a-z]+[^\]]*\]\]/gi, " ")
  // &Reference[frightened]{frightened} and &Reference[prone apply=false]
  .replace(/(?:&amp;|&)Reference\[(\w+)[^\]]*\](?:\{([^}]*)\})?/gi, (_m, id, label) => label || id);

/** The description as one line of plain words. */
export const plainSpellText = (html) => expandEnrichers(html)
  .replace(/<[^>]+>/g, " ")
  .replace(/&(?:amp|nbsp|quot|#\d+);/gi, " ")
  .replace(/\s+/g, " ")
  .trim();
