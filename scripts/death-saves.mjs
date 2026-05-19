// ─── ACE: QOL — Death Saves Automation ───────────────────────────────────────
// RAW PHB 197: When a creature drops to 0 HP, it falls unconscious (or dies if
// damage was ≥ its HP maximum from a single source). On each of its turns,
// it makes a death saving throw (DC 10 d20).
//   - 10+ = success, three successes = stabilize (still 0 HP, conscious at GM
//     discretion, regains 1 HP after 1d4 hours)
//   - <10 = failure, three failures = dead
//   - Nat 1 = two failures, nat 20 = regain 1 HP and conscious
//
// dnd5e 5.x already tracks success/failure counts at
// `actor.system.attributes.death.success/failure` and provides
// `actor.rollDeathSave()` which handles the entire roll + tally + stabilize/die
// transition. What's missing is the AUTO-FIRE at PC turn start and the
// massive-damage instant-death check.
//
// SCOPE
//   - Auto-roll death save at start of dying PC's turn (configurable)
//   - Massive-damage instant-death: damage ≥ max HP while at 0 HP = dead
//   - Reset death save tally when actor heals to 1+ HP
//   - GM-only: actually fires the rolls (player still sees the chat card)
//
// SETTINGS
//   - autoDeathSaves      (Boolean, default true)
//   - massiveDamageDeath  (Boolean, default true)
//   - autoResetOnHeal     (Boolean, default true)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class DeathSaves {

  static init() {
    // ── Auto-roll death save at PC turn start ──
    // dnd5e fires combatTurn / combatTurnChange when the active combatant
    // changes. We check the new combatant: if it's a PC at 0 HP, not stable,
    // not dead, fire the death save.
    Hooks.on("combatTurnChange", async (combat /*, prior, current */) => {
      try {
        if (!game.user.isGM) return;
        if (!QolSettings.get?.("autoDeathSaves")) return;
        const combatant = combat?.combatant;
        const actor = combatant?.actor;
        if (!actor) return;
        // Only PCs (NPCs die at 0 HP via death-pipeline, no death saves)
        if (!actor.hasPlayerOwner) return;
        const hp = actor.system?.attributes?.hp;
        if (!hp || Number(hp.value ?? 0) > 0) return;
        // Already stabilized? (dnd5e marks via stable flag or unconscious effect)
        if (DeathSaves._isStabilized(actor)) return;
        // Already dead?
        if (DeathSaves._isDead(actor)) return;

        // Brief delay so the turn-start animations land first
        setTimeout(async () => {
          try {
            // dnd5e's rollDeathSave handles the full chain: rolls, updates
            // success/failure count, stabilizes/kills/heals on nat 20
            await actor.rollDeathSave?.();
            console.log(`${MODULE_ID} | Death save auto-rolled for ${actor.name}`);
          } catch (err) {
            console.warn(`${MODULE_ID} | Auto death save failed for ${actor.name}:`, err);
          }
        }, 500);
      } catch (err) {
        console.warn(`${MODULE_ID} | DeathSaves combatTurnChange handler threw:`, err);
      }
    });

    // ── Massive damage instant death (PHB 197) ──
    // If a creature would drop to 0 HP from damage AND the damage exceeds
    // its hit point maximum, it dies instantly. Same rule applies if the
    // creature is already at 0 HP and the damage is ≥ max HP.
    //
    // We hook dnd5e.preApplyDamage so we have the raw damage amount before
    // clamping. Setting only applies to PCs (NPCs already die at 0 HP).
    Hooks.on("dnd5e.preApplyDamage", (actor, amount /*, updates, options */) => {
      try {
        if (!game.user.isGM) return;
        if (!QolSettings.get?.("massiveDamageDeath")) return;
        if (!actor?.hasPlayerOwner) return;
        if (!Number.isFinite(amount) || amount <= 0) return;

        const currentHP = Number(actor.system?.attributes?.hp?.value ?? 0);
        const maxHP     = Number(actor.system?.attributes?.hp?.max ?? 0);
        if (maxHP <= 0) return;

        // Two scenarios:
        //   A) PC has HP > 0, this damage drops them to 0 AND the OVERFLOW
        //      meets/exceeds max HP → instant death
        //   B) PC is already at 0 HP and takes damage ≥ max HP → instant
        //      death (per RAW)
        const wouldKill = (currentHP > 0 && amount >= currentHP)
                       || (currentHP === 0);
        if (!wouldKill) return;

        const overflow = currentHP > 0
          ? Math.max(0, amount - currentHP)
          : amount;
        if (overflow < maxHP) return;

        // Massive damage — set 3 failures and apply Dead status
        // Done via setTimeout so this fires AFTER the damage application
        setTimeout(async () => {
          try {
            await actor.update({
              "system.attributes.death.success": 0,
              "system.attributes.death.failure": 3,
            });
            // Apply the dead status if dnd5e doesn't already
            const hasDeadStatus = actor.statuses?.has?.("dead");
            if (!hasDeadStatus) {
              await actor.toggleStatusEffect?.("dead", { active: true, overlay: true });
            }
            await ChatMessage.create({
              speaker: ChatMessage.getSpeaker({ actor }),
              content: `<div class="ace-qol-massive-damage-card"><strong>💀 MASSIVE DAMAGE</strong><br/>${actor.name} takes ${overflow} excess damage (max HP ${maxHP}) and dies instantly per PHB 197.</div>`,
              flags: { [MODULE_ID]: { type: "massiveDamage", actorId: actor.id } },
            });
          } catch (err) {
            console.warn(`${MODULE_ID} | Massive damage instant-death failed for ${actor.name}:`, err);
          }
        }, 50);
      } catch (err) {
        console.warn(`${MODULE_ID} | DeathSaves preApplyDamage handler threw:`, err);
      }
    });

    // ── Reset death save tally when actor heals to 1+ HP ──
    // dnd5e SHOULD do this automatically but it's been inconsistent across
    // versions; defensive auto-reset.
    Hooks.on("updateActor", async (actor, changes) => {
      try {
        if (!game.user.isGM) return;
        if (!QolSettings.get?.("autoResetOnHeal")) return;
        const newHP = foundry.utils.getProperty(changes, "system.attributes.hp.value");
        if (newHP === undefined || Number(newHP) < 1) return;
        // Only reset if there's a non-zero death-save count to reset
        const succ = Number(actor.system?.attributes?.death?.success ?? 0);
        const fail = Number(actor.system?.attributes?.death?.failure ?? 0);
        if (succ === 0 && fail === 0) return;

        await actor.update({
          "system.attributes.death.success": 0,
          "system.attributes.death.failure": 0,
        });
        console.log(`${MODULE_ID} | Death save tally reset for ${actor.name} (healed to ${newHP} HP)`);
      } catch (err) {
        console.warn(`${MODULE_ID} | DeathSaves heal-reset handler threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | DeathSaves online`);
  }

  static _isStabilized(actor) {
    // dnd5e tracks stabilization via the `stable` flag on hp, or via the
    // explicit `stable` status. Check both.
    const hpStable = actor.system?.attributes?.hp?.stable === true;
    const hasStableStatus = actor.statuses?.has?.("stable");
    return hpStable || hasStableStatus;
  }

  static _isDead(actor) {
    const succ = Number(actor.system?.attributes?.death?.success ?? 0);
    const fail = Number(actor.system?.attributes?.death?.failure ?? 0);
    if (fail >= 3) return true;
    if (actor.statuses?.has?.("dead")) return true;
    return false;
  }
}
