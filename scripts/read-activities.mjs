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

/**
 * How long an effect says it lasts, as {seconds|rounds|turns}, or null.
 *
 * ⚠️ ITS NUMBERS FIRST, ITS WORDS SECOND. In the hijinx world the imported
 * copies of hundreds of spell effects lost their duration numbers while keeping
 * their descriptions; Varek's "Prismatic Blinding" still says "Blinded for 1
 * minute" in its own text with nothing in the field. The words are the same
 * data, written down, so they are read when the numbers are gone.
 */
export function effectDuration(effect) {
  try {
    const d = effect?.duration ?? {};
    const out = {};
    for (const k of ["seconds", "rounds", "turns"]) {
      const v = Number(d?.[k]);
      if (Number.isFinite(v) && v > 0) out[k] = v;
    }
    if (Object.keys(out).length) return out;
    const text = String(effect?.description ?? "").replace(/<[^>]+>/g, " ");
    const m = text.match(/\bfor\s+(\d+|an?|one|two|three|ten)\s+(round|minute|hour|day)s?\b/i);
    if (!m) return null;
    const WORD = { a: 1, an: 1, one: 1, two: 2, three: 3, ten: 10 };
    const n = Number(m[1]) || WORD[m[1].toLowerCase()] || 0;
    const per = { round: 6, minute: 60, hour: 3600, day: 86400 }[m[2].toLowerCase()];
    return n > 0 && per ? { seconds: n * per } : null;
  } catch (_) { return null; }
}

/**
 * The conditions this item applies, read off its own Active Effects.
 *
 * ⚠️🔴 THE CONDITION WAS BEING READ OUT OF PROSE WHILE IT SAT IN THE DATA.
 * Johnny, 2026-09-08: a Specter failed Fear on a natural 1 and was not
 * frightened. His Fear parsed ZERO conditions, because the only reader ACE had
 * was `DescriptionParser`, which hunts phrases like "must succeed on a Wisdom
 * saving throw or have the Frightened condition" in the description text. An
 * item with a thin, homebrewed or re-written description therefore applies
 * nothing at all, no matter how correctly it is built.
 *
 * And dnd5e states it structurally, on every properly built item:
 *
 *     Fear             effect "Fear"        statuses ["frightened"]
 *     Hold Person      effect "Paralyzed"   statuses ["paralyzed"]
 *     Hypnotic Pattern effect "Hypnotized"  statuses ["charmed","incapacitated"]
 *
 * with the activity naming the effect and saying when it lands:
 *     activity.effects: [{ _id: "…", onSave: false }]
 * `onSave: false` means it is NOT applied on a successful save, which is to say
 * it applies on a FAILED one. That is the save gate, stated, rather than
 * inferred from how near a DC happens to sit to the word "frightened".
 *
 * ⚠️ A TRANSFER EFFECT IS NOT ONE OF THESE. `transfer: true` means the effect
 * rides on whoever CARRIES the item (a cloak's own bonus); applying that to a
 * target would stamp the item's passive buff onto the victim.
 *
 * @param {Item|object} item
 * @param {string|null} [activityId]  restrict to one activity's effects
 * @returns {Array<{condition: string, requiresSave: boolean, fromEffect: true,
 *                  effectName: string|null}>}
 */
export function readAppliedConditions(item, activityId = null) {
  const out = [];
  const seen = new Set();
  try {
    // The item's own effects, in whichever shape this copy is in.
    const raw = item?.effects;
    const list = Array.isArray(raw?.contents) ? raw.contents
      : (typeof raw?.values === "function" ? [...raw.values()]
        : (Array.isArray(raw) ? raw : []));
    // A compendium copy stores only the ids here; there is nothing to read.
    const effects = list.filter(e => e && typeof e === "object");
    if (!effects.length) return out;

    const byId = new Map();
    for (const e of effects) {
      const id = e.id ?? e._id;
      if (id) byId.set(String(id), e);
    }

    // Which effects does an activity actually apply, and on what result?
    const refs = [];
    for (const a of readActivities(item)) {
      if (activityId && String(a?.id ?? "") !== String(activityId)) continue;
      for (const r of (Array.isArray(a?.effects) ? a.effects : [])) {
        const id = r?._id ?? r?.id;
        if (id) refs.push({ id: String(id), onSave: r?.onSave === true });
      }
    }

    const take = (effect, requiresSave) => {
      if (!effect || effect.disabled === true || effect.transfer === true) return;
      const st = effect.statuses;
      const names = st instanceof Set ? [...st] : (Array.isArray(st) ? st : []);
      // ⚠️ THE EFFECT'S OWN DURATION TRAVELS WITH ITS CONDITIONS. Prismatic
      // Wall's Blinding Save is "Blinded for 1 minute", and a condition placed
      // without it lasted until somebody took it off by hand (2026-09-11).
      const duration = effectDuration(effect);
      for (const n of names) {
        const key = String(n ?? "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ condition: key, requiresSave, fromEffect: true,
                   effectName: effect.name ?? null,
                   ...(duration ? { duration } : {}) });
      }
    };

    if (refs.length) {
      for (const r of refs) take(byId.get(r.id), !r.onSave);
    } else {
      // ⚠️ NO REFERENCE IS NOT NO ANSWER. Plenty of homebrew carries the effect
      // on the item without wiring it to an activity. Those still describe what
      // the item does; assume the ordinary case, that a save avoids it.
      for (const e of effects) take(e, true);
    }
  } catch (err) {
    console.warn(`ace-qol | could not read the effects on "${item?.name ?? "an item"}":`, err);
  }
  return out;
}
