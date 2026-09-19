// ─── ACE: QOL — ONE rule for "does this attack roll hit?" ─────────────────────
//
// ⚠️ THIS ORDER IS THE RULES. It was written out twice, once in the GM's
// attack pipeline and once in the socket path a player's attack takes, with a
// comment on each saying it must match the other. The socket copy drifted once
// already (an auto-crit tested before the AC, so a player's 12 against AC 18
// on a held target was reported as a critical; Grok audit, 2026-08-18). Lucky
// (2026-09-18) needs to judge the same attack again with a different d20, which
// would have been a third copy. So there is one, here, and all three ask it.
//
// RAW, both editions:
//   • a natural 1 always misses (a fumble),
//   • full cover and an attack taken by a Mirror Image duplicate miss the real
//     target whatever the total,
//   • a natural 20 always hits, and it is a critical,
//   • otherwise the total against the AC; an auto-crit condition (melee against
//     a paralysed or unconscious creature, Assassinate) upgrades a HIT to a
//     critical and never turns a miss into one.
//
// ⚠️ IT IMPORTS NOTHING, so anything may depend on it without an import cycle.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {number} o.d20            the face the attack used
 * @param {number} o.total          the attack's total
 * @param {number} o.ac             the AC it is against, cover included
 * @param {boolean} [o.fullCover]
 * @param {boolean} [o.mirrorImage] a duplicate took the attack
 * @param {boolean} [o.autoCrit]    a hit on this target is a critical
 * @returns {"fumble"|"miss"|"critical"|"hit"}
 */
export function judgeAttack({ d20, total, ac, fullCover = false, mirrorImage = false, autoCrit = false }) {
  if (Number(d20) === 1) return "fumble";
  if (fullCover) return "miss";
  if (mirrorImage) return "miss";
  if (Number(d20) === 20) return "critical";
  if (Number(total) >= Number(ac)) return autoCrit ? "critical" : "hit";
  return "miss";
}

/** A result that is a hit of either kind. */
export function isAHit(hitResult) {
  return hitResult === "hit" || hitResult === "critical";
}

/**
 * Could a different d20 change this miss? Not when full cover or a Mirror Image
 * duplicate took it: those miss the real target whatever the dice say.
 */
export function missADieCouldChange(result) {
  if (isAHit(result?.hitResult)) return false;
  if (result?.coverResult?.isFullCover) return false;
  if (result?.mirrorImageRedirect) return false;
  return true;
}
