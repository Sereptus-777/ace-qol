// ─── ACE: QOL — Getting the activities off an item ──────────────────────────
//
// ⚠️🔴 `Object.values(item.system.activities)` RETURNS AN EMPTY ARRAY. ALWAYS.
//
// `system.activities` is an `ActivityCollection`, which extends Foundry's
// `Collection`, which extends `Map`. A Map keeps its entries internally, not as
// enumerable own properties, so `Object.values()` on one returns `[]` every
// single time. It does not throw, it does not warn, it does not look wrong.
//
// Six places in this suite read it that way. The worst was
// `inference/action-facts.mjs`, the entry point of the whole inference engine:
// every reader downstream of it — trigger, cost, scope, delivery, resolution,
// change — has been working from an empty list since dnd5e 5.x moved targeting,
// ranges and saves onto activities. The engine has been reading items with the
// most important half of the sheet invisible.
//
// Johnny, 2026-09-07, having pressed Fear and had nothing at all happen:
// *"I thought we built an engine to look at every time I push a fucking
// button."* It looked. Its list was empty.
//
// ⚠️ AND IT MUST HANDLE ALL FOUR SHAPES, because they all appear. A live item
// gives a Collection. A `toObject()` copy gives a plain object keyed by id.
// Some older code hands over an array. And a stub in a self-test gives whatever
// the harness felt like. Anything that reads one shape only will be silently
// blind against the other three, which is exactly how this happened.
//
// ⚠️ THIS FILE IMPORTS NOTHING, on purpose, so it can be used from anywhere in
// the attack path without risking an import cycle.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Every activity on an item, as a plain array.
 *
 * @param {Item|object} item
 * @returns {object[]}
 */
export function readActivities(item) {
  try {
    const acts = item?.system?.activities ?? item?.activities ?? null;
    if (!acts) return [];

    // A Foundry Collection: the documented way to get its members.
    if (Array.isArray(acts.contents)) return acts.contents.filter(Boolean);

    // Any Map, including a Collection on a build that changes `contents`.
    if (typeof acts.values === "function" && typeof acts.get === "function") {
      return [...acts.values()].filter(Boolean);
    }

    if (Array.isArray(acts)) return acts.filter(Boolean);

    // A `toObject()` copy: a plain object keyed by activity id.
    if (typeof acts === "object") return Object.values(acts).filter(
      (a) => a && typeof a === "object" && !Array.isArray(a));

    return [];
  } catch (err) {
    // ⚠️ NEVER SILENT. An empty list here makes an item look featureless, which
    // is the failure this file exists to end.
    console.warn("ace-qol | could not read the activities off "
      + `"${item?.name ?? "an item"}":`, err);
    return [];
  }
}

/** The first activity of a given type, or null. */
export function firstActivityOfType(item, type) {
  return readActivities(item).find(a => a?.type === type) ?? null;
}
