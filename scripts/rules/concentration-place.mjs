// ─── ACE: QOL — Is this concentration holding a PLACE, or a creature? ────────
//
// Johnny, 2026-09-16: "Spirit Guardians ended on next-turn. Caster did not drop
// concentration, take a conc save, or cast another conc spell. Log:
// 'Concentrating: Spirit Guardians ended — no targets remain affected.' WRONG.
// An emanation on the caster does not end when nobody is inside it. Duration is
// concentration, up to 10 minutes. Empty aura is still the spell."
//
// ⚠️🔴 THE SWEEP THIS ANSWERS IS RIGHT FOR HOLD PERSON AND WRONG FOR AN AREA.
// ACE watches for the last concentration-linked effect leaving a creature and
// drops the caster's concentration when none are left, because a caster locked
// into an effectless Hold Person is a trap nobody notices. A spell that IS a
// place is the other thing entirely: it sits on the map with nobody in it and
// catches whoever walks in next. Taking the halved speed off somebody who walked
// OUT of Spirit Guardians left no linked effects at all, and the sweep read that
// as "the spell did nothing" and ended a spell the caster was still holding.
//
// Three witnesses, cheapest first, and each one says so in words a log can print.
//
// ⚠️ IT IMPORTS NOTHING AT LOAD. The recipe reader is pulled in only when the
// first two witnesses say nothing, and this file is reached from the entry file's
// own graph, where a top-level import of the inference engine would deepen the
// cycle that has killed this module twice.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Why this concentration stands on its own, or null when it does not.
 *
 * @param {ActiveEffect} parent        the Concentrating effect
 * @param {object} o
 * @param {Actor} [o.casterActor]      whose concentration it is
 * @param {object[]} [o.tracked]       the areas ACE is running (the concentration
 *                                     widget's own list)
 * @param {object[]} [o.templates]     the templates on the scene; read from the
 *                                     canvas when not given
 * @returns {Promise<string|null>}     the reason it stands, for the log
 */
export async function concentrationHoldsAPlace(parent, { casterActor = null, tracked = [], templates = null } = {}) {
  try {
    const originUuid = parent?.flags?.dnd5e?.concentration?.origin
      ?? parent?.flags?.dnd5e?.item?.uuid ?? parent?.origin ?? null;
    let item = null;
    if (originUuid) {
      const resolved = (typeof fromUuidSync === "function") ? fromUuidSync(originUuid) : null;
      item = resolved?.item ?? resolved ?? null;
    }
    const itemUuid = item?.uuid ?? null;

    // 1. Its own area, still on this scene.
    const mine = (v) => typeof v === "string" && itemUuid && (v === itemUuid || v.startsWith(`${itemUuid}.`));
    const onScene = templates ?? (globalThis.canvas?.scene?.templates?.contents ?? []);
    if (onScene.some(t => mine(t?.flags?.dnd5e?.item) || mine(t?.flags?.dnd5e?.origin))) {
      return "its area is still on the map";
    }

    // 2. ACE still running it. An emanation that travels with its caster is
    //    tracked even while its template is being dragged along behind it.
    if ((tracked ?? []).some(tr => tr?.actor?.id === casterActor?.id
      && (tr?.item?.uuid === itemUuid || (item?.id && tr?.item?.id === item.id)))) {
      return "ACE is still running its area";
    }

    // 3. Its recipe. An emanation is a place centred on the caster and lasts as
    //    long as they hold it, whether anybody is standing in it or not.
    if (item?.type === "spell") {
      const { recipesFor } = await import("../inference/recipe.mjs");
      const recipes = recipesFor?.(item) ?? [];
      if (recipes.some(r => String(r?.recipe?.where?.kind ?? r?.where?.kind ?? "") === "emanation")) {
        return "its own recipe says it is an emanation centred on its caster";
      }
    }
  } catch (err) {
    console.warn(`ace-qol | could not tell whether that concentration holds a place:`, err);
  }
  return null;
}
