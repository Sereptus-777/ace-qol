// ─── ACE QOL — reading numbers out of dnd5e roll data ─────────────────────────
//
// ⚠️ THE BUG THAT CREATED THIS FILE (2026-08-09). The repeating-save engine built
// its formula by hand:
//
//     `1d20 + @abilities.wis.save`
//
// In dnd5e 5.x that path no longer resolves to a NUMBER. Saves gained a bonus
// structure, so it resolves to an object — `{roll: {min, max, mode}, value: 4}` —
// which Foundry stringifies into the formula and then refuses to evaluate:
//
//     Error: Unresolved StringTerm ᚖ{"roll":{…},"value":4}ᚖ requested for evaluation
//
// Every out-of-combat repeating save for Ireena died on that, silently, in a
// catch. It only surfaced because advancing the world clock fired a batch of
// them at once.
//
// ⚠️ NEVER INTERPOLATE A ROLL-DATA PATH INTO A FORMULA STRING and hope it is a
// number. Resolve it to a number HERE first. A path that happens to be a number
// today is one system release away from being an object, and the failure mode is
// a swallowed exception rather than a visible break.
//
// LEAF MODULE — imports nothing, so it is testable outside Foundry.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Pull a number out of a roll-data value that might be a bare number, a
 * numeric string, or one of dnd5e 5.x's bonus objects.
 *
 * @param {*} raw            whatever sat at the roll-data path
 * @param {number} fallback  used when there is genuinely nothing there
 * @returns {number}
 */
export function numberFromRollData(raw, fallback = 0) {
  if (raw === null || raw === undefined) return fallback;

  if (typeof raw === "number") return Number.isFinite(raw) ? raw : fallback;

  if (typeof raw === "string") {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : fallback;
  }

  if (typeof raw === "object") {
    // dnd5e 5.x bonus object: the total lives on `value`. Some shapes use
    // `total` or `bonus` instead, so try each before giving up.
    for (const key of ["value", "total", "bonus", "mod"]) {
      const n = Number(raw[key]);
      if (Number.isFinite(n)) return n;
    }
  }

  return fallback;
}

/**
 * A creature's saving-throw bonus, as a number safe to put in a formula.
 * @param {object} rollData  from `actor.getRollData()`
 * @param {string} ability   "str", "dex", …
 */
export function saveBonus(rollData, ability) {
  return numberFromRollData(rollData?.abilities?.[String(ability).toLowerCase()]?.save, 0);
}

/**
 * A creature's raw ability modifier, as a number safe to put in a formula.
 * @param {object} rollData  from `actor.getRollData()`
 * @param {string} ability   "str", "dex", …
 */
export function abilityMod(rollData, ability) {
  return numberFromRollData(rollData?.abilities?.[String(ability).toLowerCase()]?.mod, 0);
}

/**
 * The natural d20 face off an evaluated Roll — the number the die actually
 * showed, before any bonus. Needed by every card ACE prints, because the
 * CHAT CARD RULE is that the d20 is always shown.
 *
 * ⚠️ ADVANTAGE / DISADVANTAGE. A 2d20kh roll has TWO results and only one is
 * `active`. Taking `results[0]` blindly prints the discarded die — the card
 * then shows a 3 beside a total of 18. Active first, index 0 only as a last
 * resort for a plain single die.
 *
 * ⚠️ TWO SHAPES. Foundry exposes dice as `roll.dice` (evaluated pools) and as
 * `roll.terms` (the parsed formula). A Roll rebuilt from JSON can arrive with
 * one populated and not the other, so both are checked.
 *
 * @param {Roll} roll  an evaluated Roll
 * @returns {number|null}  the face, or null if this roll has no d20 to read
 */
export function naturalD20(roll) {
  try {
    let die = (roll?.dice ?? []).find(d => Number(d?.faces) === 20)
           ?? (roll?.dice ?? [])[0]
           ?? null;
    if (!die && Array.isArray(roll?.terms)) {
      die = roll.terms.find(t => Number(t?.faces) === 20 && Array.isArray(t?.results)) ?? null;
    }
    const res = die?.results?.find?.(r => r?.active !== false) ?? die?.results?.[0] ?? null;
    const n = Number(res?.result ?? NaN);
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}
