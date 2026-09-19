// ─── ACE: QOL — What a save's DC comes to, the way dnd5e works it out ───────
//
// ⚠️🔴 "WORKED OUT FROM CONSTITUTION" IS NOT A NUMBER UNTIL SOMEBODY WORKS IT
// OUT (2026-09-19). The 2024 Monster Manual's Magmin stores its Death Burst DC
// as `calculation: "con"` with no formula. dnd5e turns that into a number when
// it prepares the activity (SaveActivity#prepareFinalData: the creature's own
// Constitution save DC). A reader that only takes the prepared value refuses
// the save whenever it runs on an activity nobody prepared, and a burst that
// refuses its own save is a creature exploding in silence.
//
// So the DC is worked out here, in dnd5e's own order:
//   1. a number the recipe already carries;
//   2. the activity's prepared value;
//   3. its calculation: an ability's DC on the creature (8 + its modifier +
//      proficiency), or the creature's spell save DC for "spellcasting";
//   4. a plain number written as its formula.
//
// A LEAF: imports nothing, so the burst engine, the gaze and the replay can all
// ask it.
// ──────────────────────────────────────────────────────────────────────────────

const ABILITIES = new Set(["str", "dex", "con", "int", "wis", "cha"]);

/** One activity of an item: by id when given, else the first with a save. */
function activityOf(item, id) {
  const acts = item?.system?.activities;
  if (!acts) return null;
  const list = [...(acts.values?.() ?? Object.values(acts))];
  if (id) return acts.get?.(id) ?? acts[id] ?? list.find(a => (a?.id ?? a?._id) === id) ?? null;
  return list.find(a => a?.save) ?? null;
}

/** A creature's proficiency bonus: dnd5e's own, else from its level or challenge rating. */
function profOf(actor) {
  const p = Number(actor?.system?.attributes?.prof);
  if (Number.isFinite(p) && p > 0) return p;
  const level = Number(actor?.system?.details?.level);
  if (Number.isFinite(level) && level > 0) return Math.floor((level + 7) / 4);
  const cr = Number(actor?.system?.details?.cr);
  return Math.floor((Math.max(Number.isFinite(cr) ? cr : 0, 1) + 7) / 4);
}

/** An ability's modifier on a creature: dnd5e's, else from its score. */
function modOf(actor, key) {
  const a = actor?.system?.abilities?.[key];
  const m = Number(a?.mod);
  if (Number.isFinite(m)) return m;
  const v = Number(a?.value);
  return Number.isFinite(v) ? Math.floor((v - 10) / 2) : 0;
}

/**
 * The number a save's DC comes to.
 *
 * @param {object|null} recipe  the save's recipe (its decidedBy.dc may be a number or a calculation)
 * @param {Item} item           the item the save is on
 * @returns {number} the DC, or NaN when nothing says
 */
export function saveDCOf(recipe, item) {
  const n = Number(recipe?.decidedBy?.dc);
  if (Number.isFinite(n) && n > 0) return n;
  const act = activityOf(item, recipe?.source?.activity ?? null);
  const dc = act?.save?.dc ?? {};
  const prepared = Number(dc.value);
  if (Number.isFinite(prepared) && prepared > 0) return prepared;
  const actor = item?.actor ?? item?.parent ?? null;
  const calc = String(dc.calculation ?? "").toLowerCase();
  const bonus = Number(dc.bonus) || 0;
  if (ABILITIES.has(calc) && actor) {
    const own = Number(actor.system?.abilities?.[calc]?.dc);
    if (Number.isFinite(own) && own > 0) return own + bonus;
    return 8 + modOf(actor, calc) + profOf(actor) + bonus;
  }
  if (calc === "spellcasting" && actor) {
    const spell = Number(actor.system?.attributes?.spell?.dc);
    if (Number.isFinite(spell) && spell > 0) return spell + bonus;
    const key = String(actor.system?.attributes?.spellcasting ?? "").toLowerCase();
    if (ABILITIES.has(key)) return 8 + modOf(actor, key) + profOf(actor) + bonus;
  }
  const formula = Number(dc.formula);
  return Number.isFinite(formula) && formula > 0 ? formula + bonus : NaN;
}
