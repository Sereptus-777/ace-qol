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

/**
 * Inline rolls written out as the dice they roll.
 *
 * ⚠️🔴 AN IMPORTED STAT BLOCK WRITES ITS DICE AS ROLLS. Neferon's Claws says
 *     taking 10 ([[/r 3d6]]) poison damage on a failed save
 * and the post-hit reader, looking for "10 (3d6) poison damage", found nothing.
 * So the save after the claw could do nothing at all, and ACE never knew the
 * Specter it hit was immune to that poison (Johnny, 2026-09-12). Six weapons in
 * hijinx are written this way: Neferon's Claws, Majesto's Sting, and the
 * shortswords and light crossbows of Arrigal and the Vistana Assassin.
 *
 * Foundry shows a roll's label when it has one ("+7") and its formula when it
 * does not, so that is what is left behind. ONLY the roll commands: a
 * [[/save ...]], [[/damage ...]] or [[lookup ...]] means something else and is
 * left for the reader that knows it.
 */
export const inlineRollsAsText = (t) => String(t ?? "")
  .replace(/\[\[\/(?:r|roll|gmr|gmroll|br|broll|blindroll|sr|selfroll|pr|publicroll)\s+([^\]]*?)\s*\]\](?:\{([^}]*)\})?/gi,
    (_m, formula, label) => String(label ?? "").trim() || String(formula ?? "").trim())
  // A bare inline roll, [[3d6]] or [[1d6 + 2]], and only when it is dice.
  .replace(/\[\[\s*(\d*d\d+[^\]]*?)\s*\]\](?:\{([^}]*)\})?/gi,
    (_m, formula, label) => String(label ?? "").trim() || String(formula ?? "").trim());

/** The enrichers written out as the words dnd5e would render. */
export const expandEnrichers = (t) => inlineRollsAsText(t)
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
