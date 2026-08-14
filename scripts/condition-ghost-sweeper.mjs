// ─── ACE QOL — Condition ghost sweeper ────────────────────────────────────────
//
// A "ghost" is a DISABLED condition effect carrying one of dnd5e's FIXED ids
// (`dnd5eprone000000`, `dnd5eblinded00000`, …). It is the worst shape a bug can
// take, because it is invisible from every direction:
//
//   • It contributes nothing to `actor.statuses`, so no token icon, no rule
//     reads it, and every "is this creature prone?" check says no.
//   • It still occupies its fixed id, so `toggleStatusEffect` — which looks for
//     the status in `statuses`, doesn't find it, and creates with keepId —
//     COLLIDES. And it returns `true` while doing nothing.
//
// Net effect: the creature can never have that condition again. Not by a spell,
// not by a shove, not by a fall. Silently, forever.
//
// ⚠️ FOUND 2026-08-12. Firaxis Greenbeard and Count Strahd both carried a
// disabled prone record. The symptom that finally exposed it was a falling
// creature whose card claimed "Lands prone" three times running while the
// creature stayed on its feet — and only because the fall pipeline had just been
// changed to VERIFY the status instead of assuming it. Before that it was
// completely invisible.
//
// ROOT CAUSE, now fixed at source: ACE's own effects panel defaulted to
// `disabled: true` on right-click rather than deleting. See effects-panel.mjs.
// This sweeper exists because (a) worlds already carry the damage, and (b) the
// panel is not the only thing in a Foundry install that can disable an effect.
//
// ⚠️ WHY DELETE AND NOT RE-ENABLE. A disabled condition means somebody meant to
// take it OFF. Re-enabling would silently re-apply conditions across the whole
// world on load — a party waking up paralyzed. Deleting restores the intent AND
// unblocks the id.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG = "ace-qol | GhostSweeper";

/** dnd5e's fixed condition ids look like "dnd5eprone000000" — name then zeroes. */
const FIXED_CONDITION_ID = /^dnd5e[a-z]+0*$/i;

export class ConditionGhostSweeper {

  /**
   * Is this effect a ghost?
   * Must be DISABLED, and must either carry a status or occupy a fixed id.
   * A disabled ordinary buff is somebody's deliberate "suspended" effect and is
   * none of our business.
   */
  static isGhost(effect) {
    try {
      if (!effect?.disabled) return false;
      const hasStatus = (effect.statuses?.size ?? 0) > 0;
      const fixedId = FIXED_CONDITION_ID.test(String(effect.id ?? ""));
      return hasStatus || fixedId;
    } catch (_) { return false; }
  }

  /**
   * Find every ghost in the world without changing anything.
   * @returns {Array<{actor, effect, statuses}>}
   */
  static find() {
    const found = [];
    try {
      for (const actor of game.actors ?? []) {
        for (const effect of actor.effects ?? []) {
          if (!ConditionGhostSweeper.isGhost(effect)) continue;
          found.push({ actor, effect, statuses: [...(effect.statuses ?? [])] });
        }
      }
      // Unlinked tokens keep their own effects on the ActorDelta and are NOT
      // covered by game.actors — a ghost there blocks that one creature only,
      // which is even harder to spot.
      for (const scene of game.scenes ?? []) {
        for (const tokenDoc of scene.tokens ?? []) {
          if (tokenDoc.actorLink) continue;                 // already covered
          const actor = tokenDoc.actor;
          if (!actor) continue;
          for (const effect of actor.effects ?? []) {
            if (!ConditionGhostSweeper.isGhost(effect)) continue;
            found.push({ actor, effect, statuses: [...(effect.statuses ?? [])], scene: scene.name });
          }
        }
      }
    } catch (err) {
      console.error(`${LOG} | scan failed:`, err);
    }
    return found;
  }

  /** Remove them. Returns how many. */
  static async repair({ quiet = false } = {}) {
    if (game.users?.activeGM !== game.user) return 0;
    const ghosts = ConditionGhostSweeper.find();
    if (!ghosts.length) return 0;

    let fixed = 0;
    for (const g of ghosts) {
      try {
        await g.effect.delete();
        fixed++;
        console.log(`${LOG} | removed dead "${g.effect.name}" [${g.statuses.join(",") || "no status"}] from ${g.actor.name}${g.scene ? ` (unlinked, ${g.scene})` : ""}`);
      } catch (err) {
        console.error(`${LOG} | could not remove "${g.effect.name}" from ${g.actor.name}:`, err);
      }
    }

    // ⚠️ SAY SO. A silent repair is how the original damage went unnoticed for
    // weeks — and if this keeps finding ghosts every load, something is still
    // creating them and the GM needs to know that, not just be quietly patched.
    if (fixed && !quiet) {
      ui.notifications?.warn(
        `ACE repaired ${fixed} dead condition record${fixed === 1 ? "" : "s"} that were blocking those conditions from ever being applied. See the console.`);
    }
    return fixed;
  }

  static register() {
    const run = async () => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const n = await ConditionGhostSweeper.repair();
        console.log(`${LOG} | startup sweep complete — ${n} ghost(s) cleared.`);
      } catch (err) {
        console.error(`${LOG} | startup sweep failed:`, err);
      }
    };

    // ⚠️ 🔴 DO NOT WAIT FOR "ready" WITHOUT CHECKING WHETHER IT ALREADY FIRED.
    // `register()` is called from INSIDE ace-qol's own ready handler, so a bare
    // `Hooks.once("ready", …)` here waits for an event that has ALREADY
    // happened — and never runs. Nothing errors; the feature is simply absent.
    //
    // Proven live 2026-08-12: 13 condition ghosts survived a load with this
    // sweeper installed and "online" in the console. Calling repair() by hand
    // cleared all 13 instantly, which is what proved the sweep never ran rather
    // than ran-and-failed. The GM check passed the whole time.
    //
    // Same shape as the chat-card sweep in chat-render-utils.mjs, which got
    // this right; the guard just never made it into the newer files.
    if (game.ready) run();
    else Hooks.once("ready", run);

    console.log(`${LOG} | online`);
  }
}
