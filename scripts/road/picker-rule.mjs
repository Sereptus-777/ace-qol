// ─── ACE: QOL — WHO A PICKER MAY OFFER: the living, the dying and the dead ────
//
// The One Road, Phase 4 (2026-09-15). Johnny: "Dead/0 HP is a PICKER rule, not a
// new gate rule." And his note of 09-14: "Life-restoring spells must be able to
// select dead tokens, including killed-for-good, so the gate can refuse and Do it
// anyway can run. Healing must select 0 HP unconscious. Damage spells do not gain
// corpses."
//
// ⚠️ ONE RULE FOR EVERY PICKER. The spell picker took anything at 0 hit points
// for dead, so a dying ally could not be picked for Cure Wounds and a corpse could
// not be picked for Raise Dead; the heal picker took everyone, the dead included.
// Both pickers ask this now, so they cannot answer the same creature differently.
//
// ⚠️ IMPORTS NOTHING, so the gate, both pickers, the spell pipeline and the replay
// can all read it.
// ──────────────────────────────────────────────────────────────────────────────

/** A revive that lifts the killed-for-good lock: only True Resurrection or Wish (Vorpal RAW). */
export const STRICT_REVIVES = Object.freeze([/true\s*resurrection/i, /\bwish\b/i]);
/** A revive that cannot bring back a creature killed for good. Matched by name, as the old revive hook matched them. */
export const ORDINARY_REVIVES = Object.freeze([/revivify/i, /raise\s*dead/i, /^resurrection\b/i, /reincarnate/i]);

/**
 * A spell aimed at a dead creature: Revivify, Raise Dead, Resurrection,
 * Reincarnate, True Resurrection, by the same names the gate's revive lock reads.
 * Wish is not one: it lifts the lock, but it is not aimed at a corpse.
 */
export function revivesTheDead(item) {
  const name = String(item?.name ?? "");
  return !!name && (ORDINARY_REVIVES.some(rx => rx.test(name)) || /true\s*resurrection/i.test(name));
}

/**
 * How alive a creature is, as the table sees it:
 *   alive  above 0 hit points
 *   dying  at 0 hit points and not dead: unconscious, making death saves
 *   dead   marked dead (the Dead status, ACE's death mark, killed for good), or
 *          three failed death saves
 *
 * ⚠️ ONLY A MARK SAYS DEAD. A creature at 0 that nothing marked could be either,
 * and what ACE cannot tell never blocks (section 9), so a heal and a revive can
 * both pick an unmarked creature at 0 that is not a player character.
 *
 * @param {Actor} actor
 * @param {TokenDocument} [tokenDoc]  the token, which carries ACE's death marks
 * @returns {{hp: number, state: "alive"|"dying"|"dead", killedForGood: boolean, unmarkedAtZero: boolean}}
 */
export function lifeStateOf(actor, tokenDoc = null) {
  const hp = Number(actor?.system?.attributes?.hp?.value ?? 0);
  const flags = tokenDoc?.flags?.["ace-qol"] ?? {};
  const killedForGood = !!flags.permanentlyDead;
  const marked = !!actor?.statuses?.has?.("dead") || !!flags.isDead || killedForGood
    || Number(actor?.system?.attributes?.death?.failure ?? 0) >= 3;
  const state = marked ? "dead" : (hp <= 0 ? "dying" : "alive");
  return { hp, state, killedForGood, unmarkedAtZero: !marked && hp <= 0 && actor?.type !== "character" };
}

/**
 * May a picker of this kind offer this creature?
 *
 * ONE SET OF RULES, EVERY SPELL (his, 2026-09-16):
 *   harm     a damage, save or attack spell, and a Spirit Guardians tick: the
 *            living, a creature at 0 hit points included, never the dead
 *   heal     Cure Wounds, Heal, a potion, Spare the Dying: the same list
 *   exclude  "who is safe": the living the caster may mark as unaffected
 *   revive   Raise Dead and its kin: the dead, killed for good included, and
 *            never the living, not even one dying at 0
 *
 * ⚠️🔴 REFUSED MEANS HIDDEN, NOT DIMMED. His words: "Show... Hide: dead and
 * killed-for-good", and for a revive "Hide: living, including 0 HP dying". A row
 * that cannot be picked is not on the list at all. Range is the other question
 * and keeps its old answer: too far is dimmed, with the distance on the row, so
 * he can see who is there to walk to.
 *
 * ⚠️ A CREATURE AT 0 HIT POINTS IS NOT A CORPSE. Only a mark says dead (the Dead
 * status, ACE's own death flag, killed for good, three failed death saves), so a
 * dying ally is on the heal list AND takes the damage of an area it is lying in.
 * An unmarked creature at 0 that is not a player character is the one thing ACE
 * cannot tell apart, so it is offered to both a revive and a heal rather than
 * refused by a guess.
 *
 * @param {"heal"|"revive"|"harm"|"exclude"} kind
 * @param {ReturnType<typeof lifeStateOf>} life
 * @returns {{ok: boolean, why: string}}  why is what the picker's row says stops it
 */
export function pickable(kind, life) {
  const st = life?.state ?? "alive";
  if (kind === "revive") {
    if (st === "dead" || life?.unmarkedAtZero) return { ok: true, why: "" };
    return { ok: false, why: st === "dying"
      ? "dying, not dead: a heal is what it needs"
      : "alive: there is nothing to bring back" };
  }
  if (st === "dead") {
    return { ok: false, why: life?.killedForGood ? "killed for good" : "dead" };
  }
  return { ok: true, why: "" };
}

/** The word on a picker row for a creature that is not simply alive. */
export function lifeBadge(life) {
  if (life?.killedForGood) return "KILLED FOR GOOD";
  if (life?.state === "dead") return "DEAD";
  if (life?.state === "dying") return "0 HP";
  return "";
}
