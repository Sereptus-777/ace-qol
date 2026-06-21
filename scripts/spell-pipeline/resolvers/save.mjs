// ─── ACE: QOL — Pipeline Resolver: Save (Single Target) ──────────────────────
// Single-target save shape — Hold Person, Charm Person, Banishment, Polymorph,
// Disintegrate, Dominate Person, Feeblemind, Suggestion, Tasha's Hideous
// Laughter, Crown of Madness, Bestow Curse, Maze, Power Word Stun, etc.
//
// Flow:
//   1. UnifiedSpellPicker (single) returns the chosen target token
//   2. Resolver calls save-engine's public postSaveCard with that one target
//   3. Save engine handles the save roll (NPC auto-roll or PC prompt)
//   4. On fail → applies the entry's effect via ConditionLibrary
//   5. v0.7.21 — links effect to caster's concentration (so ending
//      concentration removes effect from target)
//   6. v0.7.21 — replaces same-key effect on re-cast (no stacking)
//   7. v0.7.21 — wires save-at-end-of-turn for marked spells (Hold Person,
//      Tasha's, Crown of Madness, Maze, Power Word Stun)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../../ace-qol.mjs";
import { ConditionLibrary } from "../../condition-library.mjs";
import { SpellPipeline } from "../pipeline.mjs";

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
      SaveResolver._wireEffectOnFail(target.token, entry, castLevel, item, actor);
    }
  }

  /**
   * Save-area (emanation): EVERY eligible creature within `entry.range` of the
   * source makes the save — no template, no picker, the source's own position
   * is the origin. On a fail → the entry's effect (and the activity's damage,
   * if any, via postSaveCard). Frightful Presence, aura-of-fear, gaze pulses…
   *
   * entry fields: range (ft), save { ability, halfOnPass?, repeatAt? },
   *   effect { key, duration }, targets ("enemies"|"allies"|"all"; default
   *   "enemies"), picker { allowSelf?, excludeDead?, creatureTypeFilter? }.
   */
  static async runArea(ctx) {
    const { entry, item, actor, castLevel, spellMod } = ctx;
    const source = actor.getActiveTokens?.()?.[0]
      ?? canvas.tokens?.placeables.find(t => t.actor?.id === actor.id);
    if (!source) {
      console.warn(`${MODULE_ID} | SaveResolver.runArea: source actor has no token on the scene.`);
      return;
    }

    const rangeFt = Number(entry.range) || 0;
    const filter  = entry.picker ?? {};
    const affects = entry.targets ?? "enemies";
    const srcDisp = source.document?.disposition ?? 0;

    const { aceWithinFt } = await import("../../geometry-utils.mjs");
    const targets = (canvas.tokens?.placeables ?? []).filter(t => {
      if (!t.actor) return false;
      if (t === source && filter.allowSelf !== true) return false;
      if (filter.excludeDead !== false && (t.actor.system?.attributes?.hp?.value ?? 1) <= 0) return false;
      if (affects === "enemies" && t.document?.disposition === srcDisp) return false;
      if (affects === "allies"  && t.document?.disposition !== srcDisp) return false;
      if (filter.creatureTypeFilter) {
        const type = String(t.actor.system?.details?.type?.value ?? "").toLowerCase();
        if (type !== String(filter.creatureTypeFilter).toLowerCase()) return false;
      }
      return aceWithinFt(source, t, rangeFt);
    });

    if (!targets.length) {
      ui.notifications?.info(`${item.name}: no creatures within ${rangeFt} ft.`);
      return;
    }

    // Auto-detect damage from the activity (lazy import — no static cycle).
    let damageTypes = [];
    try {
      const { CombatState } = await import("../../combat-state.mjs");
      damageTypes = CombatState._getItemDamageTypes?.(item) ?? [];
    } catch (_) { /* condition-only ability */ }

    const saveAbility = entry.save?.ability ?? "wis";
    const saveDC = SaveResolver._computeSaveDC(actor, item, spellMod);

    const saveEngine = game.aceQol?.saveEngine;
    if (saveEngine?.postSaveCard) {
      try {
        await saveEngine.postSaveCard(item, actor, targets, {
          saveAbility, saveDC,
          halfOnSave: entry.save?.halfOnPass === true,
          damageTypes,
          isSpell: item.type === "spell",
          timing: { isInstant: true, isPersistent: false },
          activityId: ctx.activity?.id,
          spellLevel: castLevel,
        });
      } catch (err) {
        console.error(`${MODULE_ID} | SaveResolver.runArea: postSaveCard failed for "${item.name}":`, err);
      }
    } else {
      console.warn(`${MODULE_ID} | SaveResolver.runArea: saveEngine.postSaveCard unavailable.`);
    }

    if (entry.effect?.key) {
      for (const t of targets) SaveResolver._wireEffectOnFail(t, entry, castLevel, item, actor);
    }
  }

  /**
   * Wire a one-shot save-complete hook for the given target token. If the
   * save fails, apply the entry's effect via ConditionLibrary + the
   * concentration-link + the replace-on-recast cleanup + save-at-end-of-turn
   * machinery for spells that need it.
   *
   * Auto-removes the hook after firing once (or after 60s timeout).
   */
  static _wireEffectOnFail(targetToken, entry, castLevel, spellItem, casterActor) {
    const targetTokenDocId = targetToken?.document?.id ?? targetToken?.id;
    if (!targetTokenDocId) return;

    const effectKey = entry.effect?.key;
    const isConcentration = entry.effect?.duration === "concentration";

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
        const targetActor = payload.actor;
        if (!targetActor) return;

        // ── Replace-on-recast: if target already has this effect, kill the
        // old one (flagged as replacement so post-end hooks bail) before
        // applying the new one. Prevents stacking on re-cast of the same
        // save spell on the same target.
        const existingSame = targetActor.effects?.find(e =>
          e.flags?.[MODULE_ID]?.conditionKey === effectKey
          || String(e.name ?? "").toLowerCase().trim() === String(effectKey).replace(/_/g, " ").toLowerCase().trim()
        );
        if (existingSame) {
          try { await existingSame.setFlag(MODULE_ID, "_replacedNotEnded", true); } catch (_) {}
          try { await existingSame.delete(); } catch (_) {}
        }

        const targetEffect = await ConditionLibrary.applyEffect(targetActor, effectKey, {
          castLevel,
          spellItem,
          spellLevel: castLevel,
          sourceActorId: casterActor?.id,
          origin: spellItem.uuid,
        });

        console.debug(`${MODULE_ID} | SaveResolver: applied "${effectKey}" to ${targetActor.name} (failed save)`);

        // ── Concentration link: tie the placed effect to the caster's
        // concentration effect via flags.dnd5e.dependentOn (UUID string,
        // matching dnd5e's expected format). When the caster ends
        // concentration, dnd5e auto-deletes this dependent effect.
        if (targetEffect && isConcentration && casterActor) {
          // v0.7.21: uses shared SpellPipeline.findCasterConcentrationFor (audit dedup).
          const casterConcEffect = SpellPipeline.findCasterConcentrationFor(casterActor, spellItem);
          if (casterConcEffect) {
            try {
              await targetEffect.update({
                "flags.dnd5e.dependentOn": casterConcEffect.uuid,
                [`flags.${MODULE_ID}.concentrationOrigin`]: {
                  casterId:       casterActor.id,
                  spellName:      spellItem.name,
                  spellItemId:    spellItem.id,
                  concEffectUuid: casterConcEffect.uuid,
                },
              });
              console.debug(`${MODULE_ID} | SaveResolver: linked ${targetActor.name}'s ${effectKey} → ${casterActor.name}'s Concentrating:${spellItem.name}`);
            } catch (err) {
              console.warn(`${MODULE_ID} | SaveResolver: concentration link failed (non-fatal):`, err);
            }
          } else {
            console.warn(`${MODULE_ID} | SaveResolver: ${spellItem.name} is concentration but no caster conc effect — effect will not auto-cleanup`);
          }
        }

        // ── Save-at-end-of-turn machinery (Hold Person, Hold Monster,
        // Tasha's Hideous Laughter, Crown of Madness, Maze, Power Word Stun).
        // Marked via entry.save.repeatAt = "endOfTurn". On the target's
        // turn END, prompt the save again — if they pass, effect ends.
        if (targetEffect && entry.save?.repeatAt === "endOfTurn") {
          SaveResolver._wireEndOfTurnSave({
            targetActor,
            targetTokenDocId,
            targetEffectId: targetEffect.id,
            effectKey,
            casterActor,
            spellItem,
            castLevel,
            saveAbility: entry.save?.ability ?? "wis",
            saveDC: SaveResolver._computeSaveDC(casterActor, spellItem, casterActor?.system?.attributes?.spellmod ?? 0),
            halvesDamage: entry.save?.halfOnPass === true,
          });
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

  /**
   * Wire a save-at-end-of-turn loop for spells like Hold Person.
   * Listens to combatTurn — when the affected target's turn ends, the target
   * rolls a save. On success, the effect is removed (spell ends on them).
   * On fail, the effect persists; the loop continues until concentration
   * ends, the effect is removed manually, or the save passes.
   *
   * Hook auto-removes if the effect is deleted (concentration end, dispel,
   * etc.) — checks effect existence each turn.
   */
  static _wireEndOfTurnSave({ targetActor, targetTokenDocId, targetEffectId, effectKey, casterActor, spellItem, castLevel, saveAbility, saveDC, halvesDamage }) {
    const hookId = Hooks.on("combatTurn", async (combat, updateData, opts) => {
      try {
        // v0.7.74 — multi-GM safety. combatTurn fires on every client.
        // isGM is true for ALL connected GMs, so two GMs would double-
        // process the end-of-turn save (double chat card + double save
        // roll + double effect delete on success). activeGM-gate ensures
        // ONE client owns the state change. Matches the multi-GM audit
        // pattern (2026-06-15).
        if (game.users?.activeGM !== game.user) return;
        // Only fire when the AFFECTED target's turn just ENDED — i.e. the
        // PREVIOUS turn's combatant matches this target.
        const prevTurn = combat?.previous?.turn ?? combat?.turns?.[combat?.turn - 1]?._id;
        const prevCombatant = combat?.combatants?.find?.(c => c.tokenId === targetTokenDocId);
        if (!prevCombatant) return;
        // Detect "this combatant just finished their turn" — current turn pointer is past them
        const currentTurnIdx = combat?.turn ?? 0;
        const prevTurnIdx = (currentTurnIdx - 1 + combat.turns.length) % combat.turns.length;
        const prevTurnCombatant = combat?.turns?.[prevTurnIdx];
        if (prevTurnCombatant?.tokenId !== targetTokenDocId) return;

        // Check if effect still exists — if not (caster ended concentration,
        // dispel, manual delete), kill the hook.
        const stillEffected = targetActor.effects?.get?.(targetEffectId)
          ?? targetActor.effects?.find?.(e => e.id === targetEffectId);
        if (!stillEffected) {
          Hooks.off("combatTurn", hookId);
          console.debug(`${MODULE_ID} | SaveResolver: ${effectKey} effect on ${targetActor.name} gone — end-of-turn save loop unhooked`);
          return;
        }

        // Roll save at end of target's turn
        const abilityMod = targetActor.system?.abilities?.[saveAbility]?.mod ?? 0;
        const saveBonus = Number(targetActor.system?.abilities?.[saveAbility]?.bonuses?.save ?? 0);
        const profBonus = targetActor.system?.attributes?.prof ?? 0;
        const isProficient = targetActor.system?.abilities?.[saveAbility]?.proficient > 0;
        const profPart = isProficient ? ` + ${profBonus}` : "";
        const bonusPart = saveBonus ? ` + ${saveBonus}` : "";
        const formula = `1d20 + ${abilityMod}${profPart}${bonusPart}`;
        const roll = await new Roll(formula).evaluate();
        const total = roll.total;
        const passed = total >= saveDC;

        // Post chat card for the end-of-turn save result
        const accent = passed ? "#7ec97e" : "#e57373";
        const verb = passed ? "shakes off" : "remains caught by";
        const html = `
          <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);
                      border:2px solid ${accent};
                      border-radius:6px;
                      padding:10px 12px;
                      color:#f0e4c0;
                      font-family:'Signika','Helvetica Neue',sans-serif;">
            <div style="font-size:14px;font-weight:700;color:${accent};
                        text-transform:uppercase;letter-spacing:0.6px;
                        border-bottom:1px solid #4a3a28;
                        padding-bottom:5px;margin-bottom:6px;">
              ${spellItem.name.toUpperCase()} — END-OF-TURN SAVE
            </div>
            <div style="font-size:13px;color:#e8d49a;margin-bottom:4px;">
              <strong>${targetActor.name}</strong> ${verb} <em>${spellItem.name}</em>.
            </div>
            <div style="font-size:12px;color:#c0b288;">
              Save: <strong>${total}</strong> vs DC <strong>${saveDC}</strong> (${saveAbility.toUpperCase()}) — <strong>${passed ? "SUCCESS" : "FAIL"}</strong>
            </div>
          </div>
        `;
        try {
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: targetActor }),
            content: html,
            rolls: [roll],
            type: CONST.CHAT_MESSAGE_STYLES?.OTHER ?? 0,
          });
        } catch (_) { /* non-fatal */ }

        if (passed) {
          // Delete the effect — spell ends on this target (concentration
          // on caster persists in case other targets remain affected).
          try {
            await stillEffected.setFlag(MODULE_ID, "_replacedNotEnded", true); // suppress post-end hooks
            await stillEffected.delete();
          } catch (_) { /* non-fatal */ }
          Hooks.off("combatTurn", hookId);
          console.debug(`${MODULE_ID} | SaveResolver: ${targetActor.name} saved at end of turn vs ${spellItem.name} — effect removed`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | SaveResolver._wireEndOfTurnSave handler threw (non-fatal):`, err);
      }
    });

    // Safety net: also kill the hook on combat end / world reload (mirrors
    // ReactionEngine cleanup pattern)
    Hooks.once("deleteCombat", () => Hooks.off("combatTurn", hookId));

    console.debug(`${MODULE_ID} | SaveResolver: wired end-of-turn save loop for ${targetActor.name} vs ${spellItem.name}`);
  }

  // _findCasterConcentrationFor moved to SpellPipeline.findCasterConcentrationFor
  // (audit dedup 2026-06-08). All call sites now reference the shared helper.

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
