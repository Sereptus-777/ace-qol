// ─── ACE QOL — On-hit riders ──────────────────────────────────────────────────
//
// "On a hit, the target also …"
//
// Guiding Bolt outlines its target. Ensnaring Strike restrains. Half the smites
// leave something behind. ACE could resolve the attack and the damage but had no
// declarative way to say "and this lands on the target too" — the registry
// covers what a SPELL does when cast, not what an ATTACK leaves behind.
//
// A rider is a row here, not a script.
//
// ⚠️ 🔴 ORDER IS LOAD-BEARING — THIS MUST REGISTER AFTER OneShotGrants.
// Both listen to `ace-qol.attackComplete`. one-shot-grants CONSUMES spent
// one-attack grants; this module APPLIES new ones. Foundry calls hooks in
// registration order, so consuming happens first and a grant applied here is
// not eaten by the very attack that created it.
//
// Order alone is too quiet a guarantee to rest a rule on, so there is a second,
// explicit defence: every rider stamps `appliedByItem` on the effect, and
// one-shot-grants refuses to consume an effect stamped with the item it is
// currently processing. Belt and braces, because a silent self-consume would
// look exactly like "the buff didn't work" and be miserable to find.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ Local — importing MODULE_ID from ace-qol.mjs forms the cycle that made every
// token unclickable on 2026-08-11.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | OnHitRiders";

/**
 * name (lower-case, as printed on the item) → what it leaves on a target it hits.
 *
 * `condition` is a key in the condition library.
 * `onCrit` — set true if the rider only applies on a critical hit.
 */
export const ON_HIT_RIDERS = {
  // Guiding Bolt (1st level evocation). RAW: "the next attack roll made against
  // this target before the end of your next turn has advantage." ONE attack —
  // the condition uses `grants.advantage.attack.once`, which one-shot-grants
  // spends on the next attack roll, hit or miss.
  "guiding bolt": { condition: "guiding_bolt" },
};

export class OnHitRiders {

  static lookup(item) {
    try {
      const name = String(item?.name ?? "").trim().toLowerCase();
      return name ? (ON_HIT_RIDERS[name] ?? null) : null;
    } catch (_) { return null; }
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

  static async _apply(rider, actor, item) {
    try {
      const { ConditionLibrary } = await import("./condition-library.mjs");
      // ⚠️ `applyEffect`, AND CALLED WITHOUT `?.` ON PURPOSE. I first wrote
      // `ConditionLibrary.apply?.(…)` here — a method that does not exist. The
      // optional call would have returned undefined, the rider would have
      // silently never applied, and nothing would have thrown. That is the exact
      // fault found across six sites on 2026-08-12 (rollAbilitySave, rollSkillV2).
      // A plain call on a method we own is correct: if it is ever renamed, this
      // throws loudly instead of quietly doing nothing.
      const applied = await ConditionLibrary.applyEffect(actor, rider.condition, {
        origin: item?.uuid ?? null,
      });
      if (!applied) {
        // ⚠️ REPORT THE OUTCOME, NOT THE INTENTION. If the condition did not
        // land, say so — a log claiming success here would send Johnny hunting
        // the attack pipeline for a bug that is actually in the library.
        console.warn(`${LOG} | "${rider.condition}" did NOT land on ${actor?.name} — nothing applied.`);
        return false;
      }
      // Stamp which item put it there, so one-shot-grants will not let this very
      // attack consume the grant it just created.
      try {
        const fx = (actor.effects ?? []).find(e => e?.getFlag?.(MODULE_ID, "conditionKey") === rider.condition);
        await fx?.setFlag?.(MODULE_ID, "appliedByItem", item?.uuid ?? item?.name ?? "unknown");
      } catch (_) { /* stamping is a nicety; the ordering guarantee still holds */ }
      console.log(`${LOG} | ${item?.name} left "${rider.condition}" on ${actor?.name}.`);
      return true;
    } catch (err) {
      console.warn(`${LOG} | could not apply "${rider?.condition}" to ${actor?.name}:`, err);
      return false;
    }
  }

  static register() {
    Hooks.on(`${MODULE_ID}.attackComplete`, async ({ item, results } = {}) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const rider = OnHitRiders.lookup(item);
        if (!rider) return;

        // ⚠️ HITS ONLY. A rider is "on a hit" — applying it to a miss would be a
        // straight rules error. (Contrast one-shot-grants, which spends a grant
        // on a miss too, because RAW there is "the next attack ROLL".)
        const seen = new Set();
        for (const r of (results ?? [])) {
          const hit = r?.hitResult === "hit" || r?.hitResult === "critical";
          if (!hit) continue;
          if (rider.onCrit && r?.hitResult !== "critical") continue;
          const actor = OnHitRiders._actorFrom(r);
          if (!actor || seen.has(actor.id)) continue;
          seen.add(actor.id);
          await OnHitRiders._apply(rider, actor, item);
        }
      } catch (err) {
        console.warn(`${LOG} | attackComplete handling failed (harmless):`, err);
      }
    });

    console.log(`${LOG} | online — ${Object.keys(ON_HIT_RIDERS).length} on-hit rider(s)`);
  }
}
