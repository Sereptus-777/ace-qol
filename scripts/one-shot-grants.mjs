// ─── ACE QOL — One-shot grants ────────────────────────────────────────────────
//
// "The NEXT attack roll against this target has advantage."
//
// Guiding Bolt, Faerie Fire's cousins, a dozen monster riders and half the
// smites phrase their benefit that way — one attack, then it's spent. ACE could
// not express it until now: every advantage grant in the library was PERSISTENT
// (`grants.advantage.attack.all`), which is correct for Prone, Restrained,
// Paralyzed and Faerie Fire, and WRONG for anything one-shot.
//
// ⚠️ WHY THIS WAS NOT JUST SHIPPED AS A PERSISTENT GRANT (2026-08-13). Reusing
// the `.all` flag for Guiding Bolt would have handed the party advantage on
// EVERY attack against that target for a round instead of one. Nothing would
// error; the fight would simply be mis-ruled in the players' favour, silently,
// forever. That is the exact failure shape this codebase spent two days digging
// out. Better to build the mechanism than to ship a believable lie.
//
// ── HOW IT WORKS ─────────────────────────────────────────────────────────────
// An effect declares `flags.ace-qol.grants.advantage.attack.once`. FlagsEngine
// reads it alongside the persistent grants, so the attack pipeline needs no
// changes. This module listens for a completed attack and deletes the effect
// afterwards, so the second attack no longer sees it.
//
// ⚠️ CONSUMED ON A MISS TOO. RAW is "the next attack ROLL" — a miss spends it.
// Consuming only on hits would quietly make the buff better than the spell.
//
// ⚠️ CONSUMED AFTER, NEVER BEFORE. The grant must still be live while the attack
// resolves, or it would never apply to the very attack it was meant for.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ Declared locally, not imported — ace-qol.mjs imports this file, and taking
// MODULE_ID back from it forms the cycle that made every token unclickable on
// 2026-08-11.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | OneShotGrants";

/** The flag an effect sets to say "this is good for one attack only". */
export const ONCE_PATHS = [
  "grants.advantage.attack.once",
  "grants.disadvantage.attack.once",
];

export class OneShotGrants {

  /** Does this effect carry a one-shot grant? */
  static isOneShot(effect) {
    try {
      const f = effect?.getFlag?.(MODULE_ID, "oneShotGrant");
      if (f) return true;
      // Also catch effects that set the flag through `changes` rather than a
      // direct flag — that is how the condition library writes them.
      for (const c of (effect?.changes ?? [])) {
        const key = String(c?.key ?? "");
        if (ONCE_PATHS.some(p => key.endsWith(p))) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  /**
   * Spend every one-shot grant on this creature.
   * @returns {number} how many were removed
   */
  static async consume(actor, { exceptFromItem = null } = {}) {
    try {
      if (!actor) return 0;
      const doomed = (actor.effects ?? []).filter(e => {
        if (!OneShotGrants.isOneShot(e)) return false;
        // ⚠️ NEVER EAT THE GRANT THIS VERY ATTACK CREATED. Guiding Bolt applies
        // its own one-shot advantage on hit, from the SAME attackComplete hook
        // this consumer listens to. Without this guard the buff would be spent
        // the instant it landed and would look, from the table, exactly like
        // "it doesn't work" — with nothing logged anywhere.
        if (exceptFromItem) {
          const from = e?.getFlag?.(MODULE_ID, "appliedByItem");
          if (from && from === exceptFromItem) return false;
        }
        return true;
      });
      if (!doomed.length) return 0;
      for (const e of doomed) {
        try {
          await e.delete();
          console.log(`${LOG} | spent "${e.name}" on ${actor.name} — one attack, gone.`);
        } catch (err) {
          console.warn(`${LOG} | could not spend "${e.name}" on ${actor.name}:`, err);
        }
      }
      return doomed.length;
    } catch (err) {
      console.warn(`${LOG} | consume failed (harmless):`, err);
      return 0;
    }
  }

  /** Resolve the target actor out of an attack result row, whatever its shape. */
  static _actorFrom(result) {
    try {
      if (result?.actor) return result.actor;
      if (result?.targetActor) return result.targetActor;
      const scene = result?.sceneId ? game.scenes.get(result.sceneId) : canvas?.scene;
      const tokenDoc = result?.tokenDocId ? scene?.tokens?.get(result.tokenDocId)
                     : result?.tokenId    ? scene?.tokens?.get(result.tokenId)
                     : null;
      if (tokenDoc?.actor) return tokenDoc.actor;
      const id = result?.targetId ?? result?.actorId;
      return id ? game.actors.get(id) : null;
    } catch (_) { return null; }
  }

  static register() {
    // ⚠️ ONE WRITER. The hook fires on every client; without this the effect is
    // deleted several times over and the losers log permission errors.
    Hooks.on(`${MODULE_ID}.attackComplete`, async ({ item, results } = {}) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        // EVERY result, not just hits — a miss spends it too.
        const seen = new Set();
        for (const r of (results ?? [])) {
          const actor = OneShotGrants._actorFrom(r);
          if (!actor || seen.has(actor.id)) continue;
          seen.add(actor.id);
          await OneShotGrants.consume(actor, { exceptFromItem: item?.uuid ?? item?.name ?? null });
        }
      } catch (err) {
        console.warn(`${LOG} | attackComplete handling failed (harmless):`, err);
      }
    });

    console.log(`${LOG} | online — one-shot advantage grants will be spent after the first attack`);
  }
}
