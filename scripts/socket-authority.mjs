// ─── ACE QOL — who is allowed to answer a question the GM asked ──────────────
//
// ⚠️🔴 FOUNDRY ATTACHES NO TRUSTED SENDER TO A MODULE SOCKET. Every field in a
// payload, `userId` included, is written by whoever sent it. "Is the sender a
// GM?" is not a check; a player types the GM's id and passes it.
//
// For request/response traffic there IS a real check available, and it is much
// stronger than ownership: the GM asked ONE specific person, and it remembers
// who. A reply from anybody else is refused. That closes the whole family at
// once — smite riders, spell target picks, repeating saves, optional prompts,
// reaction offers — because every one of them is "the GM asked, the player
// answers".
//
// What this stops, concretely: one player answering a prompt aimed at another
// player. Divine Smite spent from someone else's slots, a rival's spell aimed
// where you like, a re-save answered "I rolled a 20" on a creature that is not
// yours, a reaction declined on your behalf so your Shield never fires.
//
// ⚠️ FAILS CLOSED, LOUDLY. If a pending record has no recorded addressee, the
// reply is refused and the console names the request. A silent pass would mean
// one forgotten `askedUserId` quietly reopens the hole, and nothing on screen
// would say so. A refusal that names itself gets fixed; a silent one does not.

const MODULE_ID = "ace-qol";

/**
 * @param {string|null|undefined} askedUserId  who the GM sent the request to
 * @param {object} payload                     the reply as it arrived
 * @param {string} label                       what to name in the console
 * @returns {boolean}                          true = act on this reply
 */
export function replyIsFromTheUserWeAsked(askedUserId, payload, label) {
  const claimed = payload?.userId;

  if (!askedUserId) {
    console.warn(`${MODULE_ID} | ${label} REFUSED — no addressee was recorded for this request, ` +
      `so there is nothing to check the reply against. This is a bug in whoever created the ` +
      `request, not in the reply.`);
    return false;
  }
  if (!claimed) {
    console.warn(`${MODULE_ID} | ${label} REFUSED — the reply names no user.`);
    return false;
  }
  if (claimed !== askedUserId) {
    const who = game.users?.get?.(claimed)?.name ?? claimed;
    const asked = game.users?.get?.(askedUserId)?.name ?? askedUserId;
    console.warn(`${MODULE_ID} | ${label} REFUSED — "${who}" answered a request sent to "${asked}".`);
    return false;
  }
  return true;
}

/**
 * Ownership check for replies that are not tied to a pending request — the
 * player acted on their own card and is telling the GM to record it.
 *
 * @param {object} payload   the reply as it arrived
 * @param {Document} actor   the creature the reply claims to act for
 * @param {string} label     what to name in the console
 * @returns {boolean}
 */
export function replyOwnerIsAuthorised(payload, actor, label) {
  const claimed = payload?.userId;
  const user = claimed ? game.users?.get?.(claimed) : null;
  if (!user) {
    console.warn(`${MODULE_ID} | ${label} REFUSED — names no real user.`);
    return false;
  }
  if (user.isGM) {
    console.warn(`${MODULE_ID} | ${label} REFUSED — claims GM "${user.name}"; a GM does this locally.`);
    return false;
  }
  if (!actor?.testUserPermission?.(user, "OWNER")) {
    console.warn(`${MODULE_ID} | ${label} REFUSED — "${user.name}" does not own ` +
      `"${actor?.name ?? "that creature"}".`);
    return false;
  }
  return true;
}
