// ─── ACE: QOL — Who decides a creature's reaction? Asked once, answered one way ─
//
// ⚠️🔴 THE OPPORTUNITY ATTACK WENT TO EVERYBODY WHO COULD HAVE ANSWERED IT.
//
// 2026-09-18, Johnny: *"Opportunity attack posts in GM chat AND the player's
// chat when the owner is connected. Owner connected: box / card only on that
// player's client. Nothing in GM chat. Owner offline or no owner: GM gets it.
// Same rule you already use for Counterspell."*
//
// Counterspell, Shield, Absorb Elements and every other reaction box already
// asked one question - who at the table decides for this creature - and sent
// the box to that one person. The opportunity attack wrote its own list
// instead (every GM, plus every owner whether connected or not), so the GM got
// a card that was not theirs to click, and an owner who was offline came back
// to a stale one. Two answers to one question. This file is the one answer.
//
// THE RULE: a CONNECTED player who owns the creature decides for it. If no
// connected player owns it (an NPC, or a character whose player is offline),
// a connected GM decides. With nobody else, this client.
//
// ⚠️ IT IMPORTS NOTHING, ON PURPOSE. The reaction engine and the opportunity
// attack both ask it, and a shared leaf that imports a sibling is how an import
// cycle kills the module at load (see is-down.mjs).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Who decides this creature's reaction.
 *
 * @param {Actor|null} actor
 * @returns {{ user: User|null, isPlayer: boolean, why: string }}
 *   `user` is the one person to ask; `isPlayer` is true when that is a
 *   connected player who owns the creature; `why` says so in words for the log.
 */
export function whoAnswers(actor) {
  const me = game.user ?? null;
  if (!actor) return { user: me, isPlayer: false, why: "there is no creature to ask about" };

  // Foundry's OWNER level. The loop skips "default": a creature every player
  // owns by default has no one player to send it to, so the GM decides, as
  // the reaction engine always did.
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const offline = [];
  for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
    if (userId === "default") continue;
    if (!(Number(level) >= OWNER)) continue;
    const user = game.users?.get?.(userId) ?? null;
    if (!user || user.isGM) continue;
    if (user.active) {
      return { user, isPlayer: true, why: `${user.name} owns it and is connected, so ${user.name} alone is asked` };
    }
    offline.push(user.name);
  }

  // ⚠️ A PLAYER'S OWN CHARACTER IS THEIRS EVEN WITHOUT A NAMED GRANT
  // (2026-09-19). The save engine waits for "their assigned character, or an
  // explicit per-user grant" (SaveEngine._pcOwnerActive); this asked about the
  // grant alone. So a character owned through the default level and assigned to
  // its player got its save prompt sent to that player, and its roll box would
  // have opened on the GM's screen. Two answers to one question, again.
  const own = game.users?.find?.(u => u?.active && !u.isGM && u.character?.id === actor.id) ?? null;
  if (own) {
    return { user: own, isPlayer: true, why: `it is ${own.name}'s character and ${own.name} is connected, so ${own.name} alone is asked` };
  }

  const gm = game.users?.find?.(u => u.isGM && u.active) ?? null;
  const why = offline.length
    ? `its owner (${offline.join(", ")}) is not connected, so the GM decides`
    : "no player owns it, so the GM decides";
  return { user: gm ?? me, isPlayer: false, why };
}
