// ─── ACE: QOL — Concentration on Damage ──────────────────────────────────────
// RAW (PHB 203, repeated SRD): "Whenever you take damage while you are
// concentrating on a spell, you must make a Constitution saving throw to
// maintain your concentration. The DC equals 10 or half the damage you take,
// whichever number is higher."
//
// dnd5e 5.3.1 ships `Actor5e.challengeConcentration({ dc, ability })` which
// rolls the save and breaks concentration on failure — but `applyDamage` does
// NOT auto-fire it (verified live). This module bridges the gap: hook
// `dnd5e.preApplyDamage`, detect concentrating actors, compute DC, fire
// the challenge.
//
// SCOPE:
//   - Fires for ANY damage source (attacks, spells, traps, environment, etc.)
//   - Both NPCs and PCs (RAW makes no distinction)
//   - DC capped at typical RAW maximums via the formula itself (50 dmg → DC 25)
//   - Skips zero/negative damage (healing, "0 damage" hits)
//
// CONFIGURATION:
//   - Setting `concentrationOnDamage` (default true): master enable
//   - Setting `concentrationDamageMinDC` (default 10): floor for the DC
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

export class ConcentrationDamage {

  static init() {
    Hooks.on("dnd5e.preApplyDamage", async (actor, amount /*, updates, options */) => {
      try {
        // activeGM: dnd5e.preApplyDamage fires on all clients; concentration save card must only fire once
        if (game.users?.activeGM !== game.user) return;
        if (!QolSettings.get?.("concentrationOnDamage")) return;
        if (!Number.isFinite(amount) || amount <= 0) return;
        if (!actor) return;

        // Find the concentrating Active Effect on this actor (if any)
        const concEffect = ConcentrationDamage._findConcentrationEffect(actor);
        if (!concEffect) return;
        const concEffectId = concEffect.id;
        const concEffectName = concEffect.name ?? "Concentration";

        // RAW: DC = max(10, floor(damage / 2))
        const minDC = Number(QolSettings.get?.("concentrationDamageMinDC") ?? 10);
        const dc = Math.max(minDC, Math.floor(amount / 2));

        // Defer slightly so the damage is applied first; the save-break-effect
        // happens AFTER the HP bar updates. This matches the natural play
        // sequence: "you take 14 damage… now make a CON save DC 10."
        setTimeout(async () => {
          try {
            // dnd5e's challengeConcentration:
            //   - Rolls a CON save (with concentration bonuses, profs, etc.)
            //   - On fail, deletes the concentrating effect (auto-cascade
            //     unlinks dependent effects via dnd5e.dependentOn chain)
            //   - Returns the roll, or null if the actor isn't concentrating
            await actor.challengeConcentration({ dc, ability: "con" });

            // Emit concentrationBroken if the effect was removed by the challenge.
            // Check by ID — if the effect is gone, concentration was broken.
            const stillHasEffect = actor.effects?.some(e => e.id === concEffectId);
            if (!stillHasEffect) {
              Hooks.callAll(`${MODULE_ID}.concentrationBroken`, {
                actor,
                effectName: concEffectName,
                reason: "damage",
                dc,
                damage: amount,
              });
            }

            if (QolSettings.get?.("debugMode")) {
              console.log(`${MODULE_ID} | Concentration challenged for ${actor.name}: damage=${amount} DC=${dc}`);
            }
          } catch (err) {
            console.warn(`${MODULE_ID} | challengeConcentration failed for ${actor.name}:`, err);
          }
        }, 50);
      } catch (err) {
        console.warn(`${MODULE_ID} | concentration-on-damage hook failed:`, err);
      }
    });

    console.debug(`${MODULE_ID} | ConcentrationDamage online`);
  }

  /**
   * Returns the actor's concentration Active Effect, or null.
   * Matches against multiple shapes for cross-version compatibility:
   *   - dnd5e 5.x:   statuses Set contains "concentration"
   *   - dnd5e 4.x:   statuses Set contains "concentrating"
   *   - flags fallback: flags.dnd5e.statusId or flags.core.statusId
   *   - name-based fallback for edge cases
   */
  static _findConcentrationEffect(actor) {
    const effects = actor?.effects?.contents ?? actor?.effects ?? [];
    for (const effect of effects) {
      if (!effect || effect.disabled) continue;
      const statuses = effect.statuses;
      // dnd5e 5.x uses "concentration"; 4.x used "concentrating" — check both
      const hasConc5x = statuses?.has?.("concentration") === true;
      const hasConc4x = statuses?.has?.("concentrating") === true;
      const dnd5eStatus = effect.flags?.dnd5e?.statusId;
      const coreStatus  = effect.flags?.core?.statusId;
      const nameLc = String(effect.name ?? "").toLowerCase();
      const isConc = hasConc5x
                  || hasConc4x
                  || dnd5eStatus === "concentration"
                  || dnd5eStatus === "concentrating"
                  || coreStatus  === "concentration"
                  || coreStatus  === "concentrating"
                  || nameLc.startsWith("concentrat");  // covers both spellings
      if (isConc) return effect;
    }
    return null;
  }
}
