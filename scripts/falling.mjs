// ─── ACE QOL — Falling ────────────────────────────────────────────────────────
//
// Someone steps off the balcony. What happens, and who can stop it.
//
// ⚠️ FEATHER FALL IS THE ONLY REACTION THAT CATCHES A FALL. Fly and Levitate
// are both a full ACTION, so nobody can cast them mid-drop — Feather Fall's
// entire reason to exist is this moment (reaction, 60 feet, up to five creatures,
// negates the damage). That is why the catch window is shaped like counterspell:
// the designers built the same shape.
//
// ⚠️ THE SOFTWARE CANNOT KNOW IF THEY MEANT TO. Leaving a raised region by the
// staircase and being shoved over the rail look identical from here — same
// region exit, same elevation change. Guess wrong and every trip downstairs
// costs 3d6 and lands the player prone, and the feature gets switched off inside
// one session. So the GM is asked, once, on drops of 10 feet or more, and the
// default is FALL. He knows whether there is a rope there; this never will.
//
// LEAF MODULE — pure rules, no Foundry calls, provable outside the app.
// ──────────────────────────────────────────────────────────────────────────────

/** RAW: 1d6 bludgeoning per 10 feet fallen… */
export const DICE_PER_FEET = 10;
/** …to a maximum of 20d6. A 200-ft drop and a 2,000-ft drop hurt the same. */
export const MAX_DICE = 20;
/** Below this, RAW does nothing at all — and neither do we. */
export const MIN_FALL_FT = 10;
/** Feather Fall's range. */
export const FEATHER_FALL_RANGE_FT = 60;

/**
 * How many d6 a fall of this height deals.
 * ⚠️ FLOOR, NOT ROUND. A 15-ft drop is 1d6, not 2 — you need a full ten feet
 * to earn each die.
 */
export function fallDamageDice(feet) {
  const ft = Math.max(0, Number(feet) || 0);
  if (ft < MIN_FALL_FT) return 0;
  return Math.min(MAX_DICE, Math.floor(ft / DICE_PER_FEET));
}

/** "3d6" — or null when the drop is not far enough to hurt. */
export function fallDamageFormula(feet) {
  const dice = fallDamageDice(feet);
  return dice > 0 ? `${dice}d6` : null;
}

/**
 * Things that stop a fall without anyone spending a reaction.
 * @returns {{negated: boolean, reason: string}}
 */
export function autoNegates(actor) {
  try {
    const statuses = actor?.statuses;
    if (statuses?.has?.("flying"))    return { negated: true, reason: "is flying" };
    if (statuses?.has?.("hovering"))  return { negated: true, reason: "is hovering" };

    // A Ring of Feather Falling is always on — it costs nobody a reaction and
    // must never open a prompt.
    const items = actor?.items?.contents ?? actor?.items ?? [];
    for (const it of items) {
      const name = String(it?.name ?? "");
      if (!/feather\s*fall/i.test(name)) continue;
      if (!/ring|boots|cloak|amulet/i.test(name)) continue;   // the ITEM, not the spell
      // Attunement/equipped where the sheet records it; absent data means worn.
      const equipped = it.system?.equipped;
      const attuned  = it.system?.attunement;
      if (equipped === false) continue;
      if (attuned === "required") continue;      // required but not attuned
      return { negated: true, reason: `is wearing ${name}` };
    }
  } catch (_) { /* fall through — better to offer the prompt than to swallow it */ }
  return { negated: false, reason: "" };
}

/**
 * A Monk's Slow Fall: a reaction that reduces the damage by five times their
 * monk level. Their OWN reaction, not somebody else's.
 * @returns {number} feet of damage-reduction, 0 if they cannot
 */
export function slowFallReduction(actor) {
  try {
    const classes = actor?.system?.classes ?? {};
    const monk = classes.monk ?? Object.entries(classes)
      .find(([k]) => /monk/i.test(k))?.[1];
    const level = Number(monk?.levels ?? monk?.level ?? 0) || 0;
    if (level < 4) return 0;                     // Slow Fall arrives at 4th
    return level * 5;
  } catch (_) { return 0; }
}

/**
 * Where a falling creature actually lands.
 *
 * ⚠️ NOT ALWAYS ZERO. A catwalk over a balcony over a hall means the floor
 * below is another raised region, not the scene floor. Assuming 0 would drop
 * someone through the balcony they were about to land on and charge them for
 * the whole height.
 *
 * @param {Array<{elevation:number, contains:boolean}>} groundsBelow
 *        every ground-level region at the landing point, with its elevation
 * @param {number} from   the elevation they left
 * @param {number} floor  the scene floor, normally 0
 */
export function landingElevation(groundsBelow, from, floor = 0) {
  const start = Number(from) || 0;
  const candidates = (groundsBelow ?? [])
    .filter(g => g?.contains !== false)
    .map(g => Number(g.elevation) || 0)
    .filter(e => e < start);                      // only things BELOW them
  if (!candidates.length) return floor;
  // ⚠️ 🔴 DO NOT PUT `floor` IN THIS MAX. It was `Math.max(...candidates, floor)`,
  // and with a sunken room at -30 that reads Math.max(-30, 0) = 0 — so the
  // landing came out AT ground level, the fall computed as 0 feet, and the whole
  // pipeline returned without a word. Found 2026-08-13: creatures walked off a
  // balcony into a cellar and simply arrived, no prompt, no damage.
  //
  // Balcony-to-ground falls hid it perfectly: from 30 feet onto a floor at 0,
  // Math.max(0, 0) is 0 and everything looked correct. Only a floor BELOW zero
  // exposes it.
  //
  // `floor` is the DEFAULT for when nothing is found — it is returned on the
  // line above. It is not a candidate to be compared against real ground.
  return Math.max(...candidates);                 // the highest floor under them
}

/**
 * Resolve the whole fall.
 *
 * @param {object} opts
 * @param {number} opts.from              elevation they left
 * @param {number} opts.to                elevation they land at
 * @param {boolean} [opts.caught]         someone cast Feather Fall
 * @param {number} [opts.slowFallFt]      Monk reduction, in feet
 * @returns {{distanceFt, dice, formula, prone, negated, reason}}
 */
export function resolveFall({ from, to = 0, caught = false, slowFallFt = 0 } = {}) {
  const distanceFt = Math.max(0, (Number(from) || 0) - (Number(to) || 0));

  if (distanceFt < MIN_FALL_FT) {
    return { distanceFt, dice: 0, formula: null, prone: false, negated: true,
             reason: `only ${distanceFt} feet — not far enough to hurt` };
  }
  if (caught) {
    // ⚠️ Feather Fall negates the damage AND the landing. RAW: "when it lands
    // it takes no damage and can land on its feet."
    return { distanceFt, dice: 0, formula: null, prone: false, negated: true,
             reason: "Feather Fall — lands gently on its feet" };
  }

  // Slow Fall reduces the DAMAGE, expressed as feet of the drop ignored.
  const effectiveFt = Math.max(0, distanceFt - (Number(slowFallFt) || 0));
  const dice = fallDamageDice(effectiveFt);

  return {
    distanceFt,
    dice,
    formula: dice > 0 ? `${dice}d6` : null,
    // ⚠️ PRONE EVEN WHEN THE DAMAGE IS FULLY ABSORBED. RAW ties landing prone
    // to taking damage from the fall, so a Monk who reduces it to nothing stays
    // on their feet — but one who still takes a single die does not.
    prone: dice > 0,
    negated: dice === 0,
    reason: dice === 0 && slowFallFt > 0 ? "Slow Fall absorbed it entirely" : "",
  };
}
