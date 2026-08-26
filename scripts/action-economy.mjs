// ─── ACE QOL — Action economy only exists inside a fight ─────────────────────
//
// Actions, bonus actions, reactions and every "once per turn" limit are counted
// against a TURN. Outside combat there are no turns, so none of them apply.
//
// Johnny, 2026-08-24, unable to test spells on Varek Thalor:
//
//   "All the bonus spells outside of combat: unless you're in combat, you have
//    to be able to cast your bonus spells... it says he's already taking a turn
//    casting the spell. Outside of combat, that cannot happen... you can cast as
//    many spells, or whatever, as many times as you have ready."
//   "or bonus anything: bonus reactions, all that shit."
//
// ═══ WHY THIS IS ONE FUNCTION AND NOT A CHECK COPIED INTO EACH GATE ══════════
//
// ⚠️ FIX THE CLASS, NOT THE ONE THAT SURFACED. The bonus-action spell rule is
// the gate he happened to hit, but the same assumption is written into the
// reaction budget, Sneak Attack's once-per-turn, Divine Strike, Crusher and
// Slasher. Every one of them stores "used this turn" on the actor and clears it
// on `combatTurnChange` — a hook that never fires when no combat is running. So
// out of combat those flags are written once and NEVER CLEARED: a rogue who
// sneak-attacked a training dummy could not sneak-attack again until somebody
// started an encounter. Silent, permanent, and invisible until you go looking.
//
// One reader, so a future gate cannot get its own subtly different answer.
//
// ⚠️ "IS THERE A COMBAT" IS THE WRONG QUESTION. The right one is "does THIS
// creature have a turn". A shopkeeper across town is not in the initiative
// order of the fight in the tavern, and a party member who joined late has no
// turn until they are added. Asking `game.combat?.started` alone would start
// counting actions for creatures that are not in the fight at all.
// ──────────────────────────────────────────────────────────────────────────────

const LOG = "ace-qol | ActionEconomy";

/**
 * Does this creature currently have turns, and therefore an action economy?
 *
 * @param {Actor|null} actor  The creature being asked about. Omit to ask only
 *                            whether any combat is running on this scene.
 * @returns {boolean} true only while a STARTED encounter contains this creature.
 */
export function hasTurns(actor = null) {
  try {
    // ⚠️ STARTED, not merely present. An encounter sitting in the tracker with
    // no initiative rolled is not a fight — the GM is still setting it up, and
    // the party must not start being charged actions while they do it. Same
    // test `TheClock.inCombat` uses, deliberately.
    const combats = (game.combats?.contents ?? []).filter(c => c.started);
    if (!combats.length) return false;
    if (!actor) return true;

    const actorId = actor.id;
    for (const combat of combats) {
      for (const combatant of (combat.combatants?.contents ?? [])) {
        if (combatant.actorId === actorId) return true;
        // Unlinked tokens of one stat block share an actor id, so also match
        // the token's own resolved actor — two goblins are two combatants.
        if (combatant.actor?.uuid && combatant.actor.uuid === actor.uuid) return true;
      }
    }
    return false;
  } catch (err) {
    // ⚠️ FAIL OPEN, AND SAY SO. If we cannot tell, the player gets to act. A
    // rule that silently forbids something when it is confused is worse than
    // one that lets an edge case through — the first loses a turn at the table
    // and nobody knows why, the second is caught by a GM who is watching.
    console.warn(`${LOG} | could not tell whether ${actor?.name ?? "a creature"} has turns — allowing:`, err);
    return false;
  }
}

/**
 * Should a "once per turn" or per-turn-budget limit be enforced right now?
 * Reads as the question the calling code actually wants to ask.
 */
export function enforcePerTurnLimits(actor = null) {
  return hasTurns(actor);
}
