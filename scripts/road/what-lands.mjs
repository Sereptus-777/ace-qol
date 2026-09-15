// ─── ACE: QOL — WHAT LANDS: a save's result, decided from its recipe ────────
//
// The One Road, Phase 1 (2026-09-14). Johnny: "Then Phase 1 saves: what lands +
// the four doors." This is the first half. Given a recipe and how one creature's
// save came out after the reaction window, it says what goes on that creature.
// It touches nothing: the four doors do the landing.
//
// ⚠️ ONE DECIDER. Before this, the save engine and the spell pipeline's save
// resolvers each worked out what a save does for themselves, and one of them
// sent Varek's Disintegrate through with no damage at all while its card showed
// 10d6 + 40 force (2026-09-13).
//
// RAW, both editions:
//   - Half damage is rounded down.
//   - Evasion only touches an effect that allows half damage on a success: a made
//     save then takes none, a failed one half. Disintegrate, which deals nothing
//     on a success, is untouched by it.
//   - The damage is rolled once for every creature the spell catches; each
//     creature's own save decides how much of it lands on that creature.
//
// ⚠️ IMPORTS NOTHING, so the executor, the replay and any self-test can use it.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * How much of the rolled damage one creature's save lets through, and the words
 * its card row carries.
 *
 * ⚠️🔴 THE ONE RULE (2026-09-14). The save engine worked this out in eight
 * places, and every one of them gave Evasion to effects that have no half
 * clause, so a rogue who failed against Disintegrate took half of it.
 *
 * @param {object} o
 * @param {boolean} o.half        the effect deals half damage on a made save
 * @param {boolean} o.passed      the save as it stands after the reaction window
 * @param {boolean} [o.evasion]   Evasion, or a feature like it, for this save's ability
 * @param {boolean} [o.autoFail]  the save failed automatically (a condition did it)
 * @returns {{share: number, label: string, evades: boolean}}  share is 1, 0.5 or 0
 */
export function damageShare({ half = false, passed, evasion = false, autoFail = false } = {}) {
  const evades = !!evasion && !!half;
  if (passed) {
    if (evades) return { share: 0, label: "PASS (EVASION)", evades };
    return half ? { share: 0.5, label: "PASS (HALF)", evades } : { share: 0, label: "PASS (NO DMG)", evades };
  }
  if (evades) return { share: 0.5, label: "FAIL (EVASION: HALF)", evades };
  return { share: 1, label: autoFail ? "AUTO-FAIL" : "FAIL", evades };
}

/**
 * A share of a rolled total, rounded down the way the rules round half. Also
 * takes the GM's quarter and double from a card's override buttons.
 */
export function shareOf(total, share) {
  return Math.floor(Math.max(0, Number(total) || 0) * Math.max(0, Number(share) || 0));
}

/**
 * What one creature's save puts on it.
 *
 * @param {object} recipe   a recipe decided by a save (inference/recipe.mjs)
 * @param {object} result
 * @param {boolean} result.passed   the save as it stands after the reaction window
 * @param {Array<{total: number, type: string|null}>} [result.rolled]
 *   the damage that was rolled for the whole spell, one entry per damage type,
 *   after its dice have landed
 * @param {boolean} [result.evasion]  the creature has Evasion and this is a Dexterity save
 * @param {boolean} [result.autoFail]  the save failed automatically; changes only the row's words
 * @returns {{damage: Array<{amount: number, type: string|null, why: string}>,
 *            conditions: object[], effects: object[], notes: string[], why: string,
 *            share: number, half: boolean, evades: boolean, label: string}}
 *   conditions and effects are the recipe's own `condition` objects: key,
 *   duration in seconds, and how it ends. `share` is how much of the rolled
 *   damage this save lets through (1, 0.5 or 0) and `label` is what the card row
 *   says, so a save card asks this and nothing else.
 */
export function whatLands(recipe, { passed, result = null, rolled = [], evasion = false, autoFail = false } = {}) {
  if (recipe?.decidedBy?.kind === "attack") return attackLands(recipe, { result, rolled });
  const isSave = recipe?.decidedBy?.kind === "save";
  const onFail = isSave ? (recipe.onFail ?? []) : [];
  const onSuccess = isSave ? (recipe.onSuccess ?? []) : [];
  // One activity has one rule for its damage on a made save.
  const half = onFail.find(o => o.kind === "damage")?.onSuccess === "half";
  const s = damageShare({ half, passed, evasion, autoFail });
  const out = { damage: [], conditions: [], effects: [], notes: [], why: "",
                share: s.share, half, evades: s.evades, label: s.label };
  if (!isSave) {
    out.why = "it is not decided by a save";
    return out;
  }
  const why = !passed ? (s.evades ? "failed; Evasion halves it" : "failed")
    : s.evades ? "made it; Evasion takes none"
    : half ? "made it; half, rounded down" : "made it; none on a success";

  for (const r of rolled) {
    out.damage.push({ amount: shareOf(r?.total, s.share), type: r?.type ?? null, why });
  }

  for (const o of passed ? onSuccess : onFail) {
    if (o?.kind === "condition") out.conditions.push({ ...(o.condition ?? {}) });
    else if (o?.kind === "effect") out.effects.push({ ...(o.condition ?? {}) });
    else if (o?.kind === "note") out.notes.push(String(o.condition?.key ?? ""));
  }
  out.why = passed ? "the save was made" : "the save was failed";
  return out;
}

/**
 * What one attack's result puts on the creature it was made against (The One
 * Road, Phase 3, 2026-09-14). A hit lands onHit; a critical hit lands onHit and
 * onCrit; a miss lands onMiss. The same one decider as a save's result.
 *
 * The attack's own dice are the sheet's, rolled the way dnd5e builds them, and
 * arrive as `rolled`; this says whether they land, and what else does. `extras`
 * are the damage a critical hit adds beyond them (the item's own crit dice),
 * rolled once, never doubled, and never on a plain hit. `then` are the saves the
 * hit hands on: each is a new run on the same road, and whatLands decides it as
 * a save.
 *
 * @param {object} recipe  a recipe decided by an attack roll
 * @param {object} o
 * @param {"hit"|"critical"|"miss"} o.result  the attack, after the reaction window
 * @param {Array<{total: number, type: string|null}>} [o.rolled]  what was rolled for it
 */
function attackLands(recipe, { result, rolled = [] }) {
  const res = result === "critical" || result === "crit" ? "critical"
    : result === "hit" ? "hit" : result === "miss" ? "miss" : null;
  const out = { damage: [], conditions: [], effects: [], notes: [], why: "", share: 0, half: false, evades: false,
    label: res ? res.toUpperCase() : "NO RESULT", result: res, dealsDamage: false, extras: [], then: [] };
  if (!res) {
    out.why = "an attack lands by its result: a hit, a critical hit or a miss";
    return out;
  }
  const lists = res === "miss" ? [recipe.onMiss] : res === "critical" ? [recipe.onHit, recipe.onCrit] : [recipe.onHit];
  const outcomes = lists.flatMap(l => (Array.isArray(l) ? l : [])).filter(Boolean);
  out.dealsDamage = outcomes.some(o => o.kind === "damage");
  out.share = (res !== "miss" || out.dealsDamage) ? 1 : 0;
  out.why = res === "miss" ? (out.dealsDamage ? "it missed, and a miss still deals damage" : "it missed")
    : res === "critical" ? "a critical hit" : "a hit";
  for (const r of rolled) out.damage.push({ amount: shareOf(r?.total, out.share), type: r?.type ?? null, why: out.why });
  for (const o of outcomes) {
    if (o.kind === "condition") out.conditions.push({ ...(o.condition ?? {}) });
    else if (o.kind === "effect") out.effects.push({ ...(o.condition ?? {}) });
    else if (o.kind === "note") out.notes.push(String(o.condition?.key ?? ""));
  }
  // ⚠️ A CRIT'S OWN DICE ARE ADDED ONCE, AFTER THE DOUBLING, the way dnd5e adds an
  // attack's critical bonus; a plain hit never gets them.
  if (res === "critical") {
    out.extras = (recipe.onCrit ?? []).filter(o => o?.kind === "damage" && String(o.formula ?? "").trim())
      .map(o => ({ formula: String(o.formula).trim(), types: [...(o.types ?? [])] }));
  }
  if (res !== "miss") out.then = [...(recipe.then ?? [])];
  return out;
}
