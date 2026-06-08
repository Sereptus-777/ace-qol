// ─── ACE: QOL — Pipeline Resolver: Save ───────────────────────────────────────
// Single-target save shape — Hold Person, Charm Person, Banishment, Polymorph,
// Disintegrate, Dominate Person, Feeblemind, Suggestion, Tasha's Hideous
// Laughter, Crown of Madness, Bestow Curse.
//
// Flow:
//   1. UnifiedSpellPicker (single) returns the chosen target token
//   2. Resolver calls save-engine's public postSaveCard with that one target
//   3. Save engine handles the save roll (NPC auto-roll or PC prompt)
//   4. On fail → applies the entry's effect via ConditionLibrary
//   5. On pass → no effect (just chat note)
//
// Effect application on fail is wired through save-engine's existing
// post-save hook, which reads the registry entry's `effect.key` and applies
// it. For Phase 2 launch the resolver passes the effect key in the opts so
// save-engine can complete the chain.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { ConditionLibrary } from "../../condition-library.mjs";

export class SaveResolver {

  static async runSingle(ctx, result) {
    const { entry, item, actor, castLevel, spellMod } = ctx;
    const target = result?.target ?? result?.targets?.[0];
    if (!target) {
      console.warn(`${MODULE_ID} | SaveResolver.runSingle: no target`);
      return;
    }

    const saveAbility = entry.save?.ability ?? "wis";
    const saveDC = SaveResolver._computeSaveDC(actor, item, spellMod);
    const onSuccess = entry.save?.onSuccess ?? "negate";
    const onFail = entry.save?.onFail ?? "effect";

    // Set game.user.targets to the chosen target so AA + downstream systems
    // see the single target the player picked in our UI.
    SaveResolver._setUserTarget(target.token);

    // Call save-engine's public postSaveCard with the single target.
    const saveEngine = game.aceQol?.saveEngine;
    if (saveEngine?.postSaveCard) {
      try {
        await saveEngine.postSaveCard(item, actor, [target.token], {
          saveAbility,
          saveDC,
          halfOnSave: false,                // single-target effect spells don't have half-damage
          damageTypes: [],                  // no damage for these (Disintegrate is the exception — see entry override)
          isSpell: true,
          timing: { isInstant: true, isPersistent: false },
          activityId: ctx.activity?.id,
          spellLevel: castLevel,
        });
      } catch (err) {
        console.error(`${MODULE_ID} | SaveResolver: postSaveCard failed for "${item.name}":`, err);
      }
    } else {
      console.warn(`${MODULE_ID} | SaveResolver: game.aceQol.saveEngine.postSaveCard not available`);
    }

    // ── Post-save effect application ──
    // Listen for the save result for this target, then apply effect on fail.
    // Uses a one-shot hook to catch the saveComplete event.
    if (entry.effect?.key) {
      SaveResolver._wireEffectOnFail(target.token, entry.effect.key, castLevel, item);
    }
  }

  /**
   * Wire a one-shot save-complete hook for the given target token. If the
   * save fails, apply the entry's effect via ConditionLibrary. Auto-removes
   * the hook after firing once (or after 60s timeout).
   */
  static _wireEffectOnFail(targetToken, effectKey, castLevel, spellItem) {
    const targetTokenDocId = targetToken?.document?.id ?? targetToken?.id;
    if (!targetTokenDocId) return;

    let fired = false;
    const hookId = Hooks.on(`${MODULE_ID}.saveComplete`, async (payload) => {
      try {
        if (fired) return;
        if (payload?.tokenDocId !== targetTokenDocId) return;
        fired = true;
        Hooks.off(`${MODULE_ID}.saveComplete`, hookId);

        if (payload.passed) {
          console.debug(`${MODULE_ID} | SaveResolver: ${payload.actor?.name} saved against "${effectKey}" — no effect`);
          return;
        }
        // Failed → apply effect
        if (payload.actor) {
          await ConditionLibrary.applyEffect(payload.actor, effectKey, {
            castLevel,
            spellItem,
            spellLevel: castLevel,
          });
          console.debug(`${MODULE_ID} | SaveResolver: applied "${effectKey}" to ${payload.actor.name} (failed save)`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | SaveResolver._wireEffectOnFail handler threw:`, err);
      }
    });

    // Safety timeout — clear the hook after 60s even if no event fires
    setTimeout(() => {
      if (!fired) {
        Hooks.off(`${MODULE_ID}.saveComplete`, hookId);
        console.debug(`${MODULE_ID} | SaveResolver: timeout clearing saveComplete hook for ${targetTokenDocId}`);
      }
    }, 60000);
  }

  static _setUserTarget(token) {
    if (!token) return;
    try {
      // Clear current targets first
      for (const t of [...(game.user.targets ?? [])]) {
        t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
      }
      // Set the picked one
      token.setTarget?.(true, { user: game.user, releaseOthers: false, groupSelection: false });
    } catch (err) {
      console.warn(`${MODULE_ID} | SaveResolver._setUserTarget threw:`, err);
    }
  }

  static _computeSaveDC(actor, item, spellMod) {
    // Try the spell's own save DC first (dnd5e stores it on activities)
    const activitySaveDC = item?.system?.activities
      ? Object.values(item.system.activities ?? {}).find(a => a.type === "save")?.save?.dc?.value
      : null;
    if (Number.isFinite(activitySaveDC) && activitySaveDC > 0) return activitySaveDC;

    // Fall back to actor's spell DC
    const spellDC = actor?.system?.attributes?.spelldc;
    if (Number.isFinite(spellDC) && spellDC > 0) return spellDC;

    // Last resort: 8 + spellMod + prof
    const prof = actor?.system?.attributes?.prof ?? 2;
    return 8 + (spellMod ?? 0) + prof;
  }
}
