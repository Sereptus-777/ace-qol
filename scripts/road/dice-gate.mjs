// ─── ACE: QOL — THE DICE GATE ────────────────────────────────────────────────
//
// HIS RULE, months old and absolute: nothing touches a creature, fires a signal
// others act on, or shows an answer until the dice that decided it have landed.
//
// ⚠️ IT LIVES IN ITS OWN LEAF SO EVERY PATH CAN READ IT. It was inside
// road/doors.mjs, which imports the condition library, the damage applicator and
// the calculator — so the library could not read the gate back without a genuine
// import cycle, and a side door that never reached a door was ungated. This file
// imports dsn-utils and nothing else (dsn-utils imports nothing at all), so the
// doors, the condition library and anything later can all hold to the same rule.
// doors.mjs re-exports it, so every existing caller is untouched.
// ──────────────────────────────────────────────────────────────────────────────

import { awaitDiceSettle, diceInFlight } from "../dsn-utils.mjs";

/**
 * The dice that decided a landing, waited for.
 *
 * @param {boolean|undefined|{messageId?: string}} dice  true, or the chat message
 *   the dice came in on, when dice decided this landing; false when the caller
 *   has thought about it and nothing was thrown; LEFT OUT means "ask the screen".
 */
export async function untilDiceLand(dice) {
  const messageId = typeof dice === "object" ? (dice.messageId ?? null) : null;

  // ⚠️🔴 "NOBODY DECLARED DICE" IS NOT "THERE ARE NO DICE ON THE TABLE".
  //
  // His table, 2026-09-29: a save card flipped to FAIL while the d20 was still
  // tumbling. The caller was right, the door was wrong. `dice` was a promise the
  // CALLER had to remember to make, and of the forty-five cards this module can
  // post, five made it. The other forty - and every card redrawn through
  // `update`, which no caller passed it to at all - went straight past the wait.
  //
  // A default that has to be remembered at every door is not a door, it is a
  // habit. So the door asks instead of being told: if this screen has dice in
  // the air right now, the landing waits for them, whoever threw them. His rule
  // is absolute and is about the screen, not about one feature - "if a card
  // flips while 3D dice are up, that call is wrong".
  //
  // ⚠️ NOTE 4 IS UNTOUCHED. "A door with no dice does not wait": an immune
  // target, a spell with no save, an automatic heal. Nothing was thrown, nothing
  // is in the air, and this returns on the same tick without so much as a timer
  // (the twenty-second card of 4 September stays fixed).
  // ⚠️ DECLARED "NO DICE" IS HONOURED; SILENCE IS NOT.
  //
  // `dice: false`, written out, is a caller saying it has thought about this and
  // nothing was thrown that decides it: a ROLL DAMAGE button, a prompt, a notice.
  // Those land at once even while somebody else's dice are in the air, because
  // holding a BUTTON behind an animation is not what his rule is about - his rule
  // is that a RESULT never beats its dice.
  //
  // Leaving it out is not that declaration. That is the forty cards that never
  // thought about it at all, and they go through the gate.
  if (dice === false) return;
  if (!dice && !diceInFlight()) return;

  await awaitDiceSettle(undefined, { messageId });
}
