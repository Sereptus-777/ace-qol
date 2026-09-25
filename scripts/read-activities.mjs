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

/* ────────────────────────────────────────────────────────────────────────────
 *  WHAT DAMAGE TYPE DOES THIS WEAPON DEAL
 *
 * ⚠️🔴 A WEAPON HAS NO `damage.parts`. NOT ONE, ANYWHERE (proved 2026-09-25).
 * dnd5e 5.3.3's weapon schema is `damage: { base, versatile }` and nothing else
 * (dnd5e.mjs, WeaponData#defineSchema); its own migration lifts the old
 * `parts[0]` into `base` and throws the list away. Of the 3,185 weapons in
 * hijinx, 3,185 carry `base` and NONE carries `parts`. So every read of a
 * weapon's `system.damage.parts` returned undefined and took its fallback
 * without a word: a scimitar's Sneak Attack was piercing, a greataxe's Brutal
 * Strike was bludgeoning, and a Battle Master's Maneuvering Attack was untyped,
 * which walks straight past resistance.
 *
 * ⚠️ AND THE USED ACTIVITY IS STILL THE BETTER ANSWER WHEN THERE IS ONE. On a
 * LIVE item dnd5e puts the weapon's base damage at the FRONT of the attack's
 * own parts, marked `base` (AttackActivityData#prepareFinalData), so an attack
 * in hand already knows. A stored or compendium copy has not been through that,
 * and its parts are empty — which is exactly why the item must be read too.
 *
 * ⚠️ `types` IS A SET ON A LIVE ITEM AND AN ARRAY IN COMPENDIUM JSON, so
 * `types[0]` is undefined live. That is how the Pact of the Blade chooser came
 * to offer "Normal (normal)" for every weapon in the game.
 *
 * ⚠️ VERSATILE DOES NOT CARRY ITS OWN TYPE. All 105 versatile weapons in his
 * world leave `versatile.types` empty and inherit the base's, the way dnd5e
 * rolls them — so base is read first and versatile only answers for a weapon
 * that genuinely declares something different.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A Set live, an array in JSON, a bare string from a stub, nothing at all. */
const _types = (v) => (v instanceof Set ? [...v]
  : Array.isArray(v) ? v
    : (v ? [v] : []))
  .map(t => String(t ?? "").trim().toLowerCase())
  .filter(Boolean);

/**
 * Every damage type a weapon's swing can deal, best source first.
 *
 * @param {Item|object} item        the weapon
 * @param {object|null} [activity]  the activity actually used, when known
 * @returns {string[]}  lower-case type names; empty when the weapon declares none
 */
export function weaponDamageTypes(item, activity = null) {
  const out = [];
  const add = (list) => { for (const t of list) if (!out.includes(t)) out.push(t); };
  try {
    // The activity actually used wins: live, its parts already hold the base.
    for (const p of (Array.isArray(activity?.damage?.parts) ? activity.damage.parts : [])) {
      add(_types(p?.types));
      // A pre-5.x part is the pair [formula, type].
      if (Array.isArray(p) && p[1]) add(_types(p[1]));
    }
    if (out.length) return out;

    const d = item?.system?.damage ?? null;
    add(_types(d?.base?.types));
    if (!out.length) add(_types(d?.versatile?.types));
  } catch (err) {
    console.warn(`ace-qol | could not read the damage type of "${item?.name ?? "an item"}":`, err);
  }
  return out;
}

/**
 * The single damage type to stamp on a rider that deals "the weapon's type" —
 * Sneak Attack, Brutal Strike, a Battle Master maneuver, Rage, Graze.
 *
 * ⚠️ A WEAPON CAN DECLARE TWO. Seven in his world do (a Javelin of Lightning is
 * lightning AND piercing, an aberration's Claw is bludgeoning AND slashing).
 * dnd5e asks the roller which one at damage time, and that pick is not made yet
 * when a rider is offered, so the first declared type is used and the caller's
 * own default is never reached for a weapon that declares anything at all.
 *
 * @param {Item|object} item
 * @param {object|null} [activity]
 * @param {string|null} [fallback]  what to say for a weapon that declares no type
 * @returns {string|null}
 */
export function weaponDamageType(item, activity = null, fallback = null) {
  return weaponDamageTypes(item, activity)[0] ?? fallback;
}

/**
 * The dice an activity actually rolls, part by part.
 *
 * ⚠️🔴 A SPELL HAS NO `system.damage` AT ALL. Not an empty one — the field does
 * not exist in dnd5e 5.3.3's spell schema (dnd5e.mjs, SpellData#defineSchema
 * has ability, activation, duration, level, materials, method, prepared,
 * properties, range, school, sourceItem, target, and nothing else). All 4,929
 * spells in hijinx confirm it. A spell's damage lives on its activities and
 * only there, so `spell.system.damage.parts` has always been undefined, and
 * every caller that read it took a hardcoded fallback in silence.
 *
 * @param {object|null} activity
 * @returns {Array<{formula: string, types: string[], type: string|null}>}
 */
export function damageDice(activity) {
  const out = [];
  const parts = Array.isArray(activity?.damage?.parts) ? activity.damage.parts : [];
  for (const p of parts) {
    // A pre-5.x part is the pair [formula, type].
    if (Array.isArray(p)) {
      const f = String(p[0] ?? "").trim();
      if (f) out.push({ formula: f, types: _types(p[1]), type: _types(p[1])[0] ?? null });
      continue;
    }
    const custom = p?.custom?.enabled ? String(p.custom.formula ?? "").trim() : "";
    let formula = custom;
    if (!formula && p?.number && p?.denomination) formula = `${p.number}d${p.denomination}`;
    const bonus = String(p?.bonus ?? "").trim();
    if (!custom && bonus) formula = formula ? `${formula} + ${bonus}` : bonus;
    if (!formula) continue;           // dnd5e rolls nothing for a part with no formula
    const types = _types(p?.types);
    out.push({ formula, types, type: types[0] ?? null });
  }
  return out;
}

/**
 * The first damage any of an item's activities rolls — for a caller holding only
 * the item, with no idea which activity is in play.
 *
 * @param {Item|object} item
 * @param {object|null} [activity]  the one in play, when known; it wins outright
 * @returns {{formula: string, types: string[], type: string|null}|null}
 */
export function firstDamage(item, activity = null) {
  if (activity) {
    const own = damageDice(activity);
    if (own.length) return own[0];
  }
  for (const a of readActivities(item)) {
    const d = damageDice(a);
    if (d.length) return d[0];
  }
  return null;
}
