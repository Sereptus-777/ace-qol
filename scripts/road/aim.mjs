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

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT THE PRESS POINTED AT

   His rule, 2026-09-30: *"'Already selected' means Foundry's current targets,
   not only ACE's last pick. One legal target already targeted → no picker,
   that target is the cast."*

   ⚠️🔴 ACE WIPES THE RETICLE BEFORE ITS OWN PICKER OPENS. 0.65.0 taught the
   picker to stand aside when one legal creature was already targeted, and it
   still opened on Jeth. The reason is upstream of the picker entirely: the
   pipeline's `preUseActivity` clears `game.user.targets` for every picker-using
   shape — save-single, touch, chained, distribute, the two multis, attack-multi
   — so by the time the picker asks what is targeted, the answer is nothing. It
   was reading a set ACE had just emptied.

   The clear is right and stays. It exists because a stale reticle from the LAST
   cast pre-filled the next one, and because Automated Animations fires at
   cast time and would otherwise throw the clip at last cast's victims. Both are
   about a target that is STALE. The one he just set for THIS press is not.

   So the clear remembers what it cleared, and the picker asks here when the live
   set is empty.

   ⚠️ READ ONCE, THEN GONE. A snapshot that outlived its press would hand the
   next cast a target from the previous one, which is the very bug the clear was
   written to stop. Every clear overwrites it (an empty press writes an empty
   snapshot, so nothing can be inherited) and the first read consumes it.
   ══════════════════════════════════════════════════════════════════════════ */

/** @type {{ids: string[], why: string}|null} */
let _atPress = null;

/**
 * Snapshot the reticle, then let the caller clear it. Called BY the clear, so
 * there is one place to add and no caller to remember.
 *
 * @param {string} [why]  what is about to clear it, for the log
 * @returns {string[]}    the token ids that were targeted
 */
export function rememberAim(why = "a press") {
  try {
    const ids = [...(globalThis.game?.user?.targets ?? [])].map(t => t?.id).filter(Boolean);
    _atPress = { ids, why: String(why) };
    if (ids.length) {
      console.log(`ace-qol | ${ids.length} target(s) were on the table when ${why} cleared them, `
        + `so the picker can still use them.`);
    }
    return ids;
  } catch (err) {
    _atPress = { ids: [], why: String(why) };
    console.warn(`ace-qol | could not remember what was targeted before ${why}:`, err);
    return [];
  }
}

/**
 * What was targeted at the press, for a picker whose live set has been emptied.
 * Reading it consumes it.
 *
 * @returns {{ids: string[], why: string}|null}
 */
export function aimedAtPress() {
  const held = _atPress;
  _atPress = null;
  return held;
}
