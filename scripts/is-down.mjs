// ─── ACE: QOL — Is this creature dead? Asked once, answered one way ─────────
//
// ⚠️🔴 THE DEAD DRAGON, AND NOW THE DEAD MAN IN THE SPEAR'S WAY.
//
// 2026-09-02: a dead shadow dragon attacked a player character and hit, because
// `canAct` decided deadness by asking `statuses.has("dead")` and ACE's own death
// pipeline REMOVES that status so Foundry's skull does not stack on the corpse
// artwork. A corpse in this world carries no marker at all.
//
// 2026-09-06, Johnny: *"I had a guy trying to throw a spear across a dead guy
// onto a live guy. It said he had disadvantage because the fucking dead guy was
// in his way... and the same goes for cover. He's not covered or anything."*
//
// Same bug, three more sites, four days later. The lesson was written down and
// only the one site that surfaced was converted:
//   • the ranged-in-melee check counted a corpse as a hostile within five feet
//   • Pack Tactics counted a corpse as the ally beside the target
//   • Aura of Protection counted a dead paladin as still projecting it
// and the cover engine asked the hit points but never the flag, so a corpse
// whose token still reports hit points went on granting half cover.
//
// ⚠️ SO THERE IS ONE READER NOW, AND IT IS THIS FILE. Two private copies already
// existed — `DeadTokenLock.isDead` and `CombatContext._deathState` — which is
// two answers to one question waiting to drift. Both now come here.
//
// ⚠️ IT IMPORTS NOTHING, ON PURPOSE. Everything that needs to ask this is deep
// in the attack path, and a shared leaf that imports a sibling is how an import
// cycle kills the module at load.
//
// ⚠️ ASK THE FACT, NOT THE MARKER. Hit points and ACE's own `isDead` flag are
// the only two things here, because nothing cosmetic writes either of them.
// Before adding a third input, check who else WRITES it: if any writer is a
// display concern, it is not a rules input.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";

/**
 * Statuses that take a creature out of the fight for the purposes of the rules
 * that ask "is anybody threatening / helping / blocking here".
 *
 * ⚠️ BLINDED IS NOT IN THIS LIST. A blinded enemy is still very much in the
 * fight; it just cannot see you, which is a separate clause in the ranged
 * attack rule and belongs at that call site.
 */
export const OUT_OF_FIGHT_STATUSES = Object.freeze([
  "incapacitated", "unconscious", "paralyzed", "petrified", "stunned",
]);

/** Pull the token document and the actor out of whatever the caller had. */
function _parts(subject) {
  if (!subject) return { doc: null, actor: null };
  // An Actor carries a system block and never an `actor` of its own.
  if (subject.system && !subject.actor) return { doc: subject.token ?? null, actor: subject };
  const doc = subject.document ?? subject;          // placeable → its doc; doc → itself
  return { doc, actor: subject.actor ?? doc?.actor ?? null };
}

/** Does any body belonging to this creature carry ACE's own death flag? */
function _flagged(doc, actor) {
  if (doc?.flags?.[MODULE_ID]?.isDead) return true;
  if (actor?.token?.flags?.[MODULE_ID]?.isDead) return true;
  for (const t of (actor?.getActiveTokens?.(true) ?? [])) {
    if (t?.document?.flags?.[MODULE_ID]?.isDead) return true;
  }
  return false;
}

/**
 * "dead", "at 0 hit points", or null for a creature still up.
 *
 * ⚠️ THE TWO ARE WORDED APART DELIBERATELY. Telling a table its paladin is dead
 * when he is bleeding out and savable is its own kind of wrong.
 *
 * @param {Actor|TokenDocument|Token} subject
 * @returns {"dead"|"at 0 hit points"|null}
 */
export function deathState(subject) {
  try {
    const { doc, actor } = _parts(subject);
    if (_flagged(doc, actor)) return "dead";

    const hp = Number(actor?.system?.attributes?.hp?.value);
    // ⚠️ A thing with no hit points at all — a vehicle, a group, a stub — is not
    // a corpse, it is a creature this question does not apply to. NaN must never
    // read as zero.
    if (!Number.isFinite(hp)) return null;
    if (hp > 0) return null;
    return actor?.type === "character" ? "at 0 hit points" : "dead";
  } catch (err) {
    // ⚠️ FAIL OPEN AND SAY SO. Every caller uses this to take something away
    // from somebody; guessing "dead" on a fault would silently delete a live
    // creature's cover, its threat and its aura.
    console.warn(`${MODULE_ID} | could not tell whether this creature is dead, `
      + `so it is being treated as alive:`, err);
    return null;
  }
}

/**
 * Is this creature down — dead or bleeding out on nought hit points?
 *
 * @param {Actor|TokenDocument|Token} subject
 * @returns {boolean}
 */
export function isDead(subject) {
  return deathState(subject) !== null;
}

/**
 * Is this creature out of the fight — down, or held by something that stops it
 * acting at all?
 *
 * This is the question the positional rules actually want. A corpse does not
 * threaten you, a paralysed guard does not flank for you, and an unconscious
 * paladin projects nothing.
 *
 * @param {Actor|TokenDocument|Token} subject
 * @returns {boolean}
 */
export function isOutOfTheFight(subject) {
  try {
    if (isDead(subject)) return true;
    const { actor } = _parts(subject);
    const statuses = actor?.statuses;
    if (!statuses) return false;
    return OUT_OF_FIGHT_STATUSES.some(s => statuses.has(s));
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read this creature's condition, `
      + `so it is being treated as still fighting:`, err);
    return false;
  }
}
