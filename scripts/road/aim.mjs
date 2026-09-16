// ─── ACE: QOL — ACE AIMS ON PURPOSE, SO IT IS NEVER ASKED IF IT MEANT TO ──────
//
// Johnny, 2026-09-15, pressing Raise Dead with nobody targeted: *"If I don't
// pick a target, Raise Dead does not work because I get this picker: 'Specter is
// dead. Are you sure you want to target it?' It cancels the cast and refunds the
// slot... It's a whole different ball game if I'm picking."*
//
// ⚠️🔴 THE QUESTION IS FOR A STRAY CLICK, AND A PICK IS NOT ONE.
// `dead-token-lock.mjs` patches Token#setTarget so a GM whose cursor lands on a
// corpse is asked once whether they meant it. setTarget is synchronous and a
// dialog is not, so that branch RETURNS WITHOUT TARGETING and asks afterwards.
// That is right for a mouse and wrong for ACE: when the caller was the gate's own
// picker, handing back the corpse he had just chosen, the reticle never landed,
// the press carried on with nobody targeted, and the cast was thrown away with a
// modal standing over the picker. He had already answered the question by
// clicking the body; asking it again is asking twice.
//
// ⚠️ ONE HELPER FOR EVERY AIM ACE MAKES, not a flag remembered at seven call
// sites. Every reticle ACE places is ACE deciding and never a mouse: the gate's
// picker, the attack picker, multiattack's next swing, the opportunity-attack
// prompt, the save engine re-aiming its own targets, and a template's area.
//
// ⚠️ IT ALSO REPORTS WHETHER THE RETICLE LANDED. The old loop set "somebody was
// targeted" the moment it had called setTarget, which is how a silently refused
// target became a cast with no targets. A call that did not take says so.
//
// ⚠️ IMPORTS NOTHING, so the lock itself, the gate, both pipelines and the
// engines can all read it (a binding read at load inside an import cycle is how
// a module dies on the way in — 2026-08-28, again 2026-09-06).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The mark on a target context that says ACE aimed this one, so the dead-token
 * question stands aside. The lock sets it too when the GM answers "Target it".
 */
export const DELIBERATE = "aceDeadTargetConfirmed";

/**
 * Put ACE's reticle on a token, dead or alive, without being asked to confirm it.
 *
 * @param {Token} token                the token to target
 * @param {object} [context]           anything Foundry's setTarget takes
 *                                     (releaseOthers, groupSelection, user)
 * @returns {boolean}                  true when the target actually landed
 */
export function aimAt(token, context = {}) {
  try {
    if (!token?.setTarget) return false;
    token.setTarget(true, { user: game.user, ...context, [DELIBERATE]: true });
    const held = game.user?.targets;
    // No set to read (a stand-in, or a call before the canvas is up) is not a
    // refusal: trust the call rather than report a failure that did not happen.
    if (typeof held?.has !== "function") return true;
    if (held.has(token)) return true;
    console.warn(`ace-qol | ${token?.name ?? "that creature"} would not take a target reticle, `
      + `so nothing is aimed at it.`);
    return false;
  } catch (err) {
    console.warn(`ace-qol | could not aim at ${token?.name ?? "that creature"}:`, err);
    return false;
  }
}
