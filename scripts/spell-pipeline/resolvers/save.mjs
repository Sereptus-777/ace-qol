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
import { CombatState } from "../../combat-state.mjs";
import { ConditionLibrary } from "../../condition-library.mjs";
import { SpellPipeline } from "../pipeline.mjs";
import { Situation } from "../../situation.mjs";
import { safeShowForRoll } from "../../dsn-utils.mjs";

// ─── Creature snapshot access (2026-07-28) ───────────────────────────────────
// Facts about a creature come from the ONE reader, never from actor.system.
const _aceCreatureCache = new Map();
function _aceCreature(actor, token = null) {
  if (!actor) return {};
  const key = actor.uuid ?? actor.id;
  const hit = _aceCreatureCache.get(key);
  if (hit) return hit;
  let c = {};
  try { c = Situation.readCreature(actor, token) ?? {}; } catch (_) { c = {}; }
  _aceCreatureCache.set(key, c);
  setTimeout(() => _aceCreatureCache.delete(key), 3000);
  return c;
}


export class SaveResolver {

  static async runSingle(ctx, result) {
    const { entry, item, actor, castLevel, spellMod } = ctx;
    const target = result?.target ?? result?.targets?.[0];
    if (!target) {
      console.warn(`${MODULE_ID} | SaveResolver.runSingle: no target`);
      return;
    }

    // No-save conditional kill (Power Word Kill) — RAW has NO saving throw in
    // either edition. Handle it directly; never post a save card.
    if (entry.instantKill) {
      return SaveResolver._runInstantKill(ctx, target);
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
   * Power Word Kill-style no-save conditional kill. RAW (2014 + 2024): no save.
   *   • target HP ≤ threshold (100) → dies instantly (HP set to 0 → dnd5e death).
   *   • target HP > threshold:
   *       – 2024 (modern): takes overDamage (12d12 psychic; resistance applies).
   *       – 2014 (legacy): no effect.
   */
  static async _runInstantKill(ctx, target) {
    const { entry, item, actor } = ctx;
    const tActor = target?.actor;
    if (!tActor) return;
    SaveResolver._setUserTarget(target.token);

    const cur = Number(_aceCreature(tActor)?.hp?.value ?? 0);
    const thr = Number(entry.instantKill?.hpThreshold ?? 100);
    const modern = CombatState.getActiveRulesVersion(actor) !== "legacy";  // honors ACE gameRulesEdition override
    const accent = "#b71c1c";
    const card = (flavor, body) => {
      try {
        ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor,
          content: `<div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);border:2px solid ${accent};border-radius:6px;padding:12px 14px;color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;">
            <div style="font-size:15px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:0.6px;border-bottom:1px solid #4a3a28;padding-bottom:6px;margin-bottom:8px;"><i class="fas fa-skull"></i> ${item.name.toUpperCase()}</div>
            <div style="font-size:14px;color:#e8d49a;">${body}</div>
          </div>`,
        });
      } catch (_) { /* non-fatal */ }
    };

    if (cur <= thr) {
      try { await tActor.update({ "system.attributes.hp.value": 0 }); } catch (_) {}
      card(`${item.name} — ${tActor.name} slain`, `<strong>${tActor.name}</strong> has ${cur} HP (≤ ${thr}) and <strong>dies instantly</strong> — no save.`);
      return;
    }

    if (modern && entry.instantKill?.overDamage) {
      let total = 0;
      try {
        const roll = await new Roll(String(entry.instantKill.overDamage)).evaluate();
        total = roll.total;
        // Was `await game.dice3d.showForRoll(...)` — a bare await on an external
        // module's promise, the exact shape that hung the damage pipeline in
        // v0.4.21 when a renderer broke. Fire-and-forget + registered, so the
        // card still waits for these dice without being able to hang on them.
        safeShowForRoll(roll, "instant-kill overdamage");
      } catch (_) {}
      const dtype = entry.instantKill.overDamageType ?? "psychic";
      if (total > 0 && typeof tActor.applyDamage === "function") {
        try { await tActor.applyDamage([{ value: total, type: dtype }]); } catch (_) {}
      }
      card(`${item.name} — ${tActor.name} survives`, `<strong>${tActor.name}</strong> is above ${thr} HP — takes <strong>${total} ${dtype}</strong> damage instead (2024).`);
      return;
    }

    // 2014, above threshold → no effect.
    card(`${item.name} — no effect`, `<strong>${tActor.name}</strong> is above ${thr} HP — the spell has <strong>no effect</strong> (2014 rules).`);
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
    let targets = (canvas.tokens?.placeables ?? []).filter(t => {
      if (!t.actor) return false;
      if (t === source && filter.allowSelf !== true) return false;
      if (filter.excludeDead !== false && (_aceCreature(t.actor)?.hp?.value ?? 1) <= 0) return false;
      // "all" = every creature in range (Ghostly Howl); "enemies"/"allies" gate
      // by disposition relative to the source.
      if (affects === "enemies" && t.document?.disposition === srcDisp) return false;
      if (affects === "allies"  && t.document?.disposition !== srcDisp) return false;
      if (filter.creatureTypeFilter) {
        const type = String(_aceCreature(t.actor)?.type ?? "").toLowerCase();
        if (type !== String(filter.creatureTypeFilter).toLowerCase()) return false;
      }
      return aceWithinFt(source, t, rangeFt);
    });

    // ── Hearing gate for sound-based emanations (a howl, a thunderous roar) ──
    // A creature that can't hear it isn't affected: (1) deafened → immune;
    // (2) a SOUND-blocking wall/closed sound-door between the source and the
    // target stops the howl (same wall backend Foundry uses for ambient audio,
    // mirroring our sight-collision checks). An open doorway lets it through.
    // 2026-07-11 — RAW: a howl is sound; walls that block sound block it.
    if (entry.requiresHearing) {
      const soundBackend = CONFIG.Canvas?.polygonBackends?.sound;
      targets = targets.filter(t => {
        const st = t.actor?.statuses;
        if (st instanceof Set && (st.has("deafened") || st.has("deaf"))) {
          console.log(`${MODULE_ID} | ${t.name} is deafened — can't hear "${item.name}", unaffected`);
          return false;
        }
        try {
          const blocked = soundBackend?.testCollision?.(source.center, t.center, { type: "sound", mode: "any" });
          if (blocked) {
            console.log(`${MODULE_ID} | ${t.name}: a sound-blocking wall stops "${item.name}" — unaffected`);
            return false;
          }
        } catch (_) { /* backend unavailable → don't false-exclude */ }
        return true;
      });
    }

    // ── Emanation FX (Ghostly Howl's expanding waves, etc.) ──
    // Fire BEFORE the early no-targets return so the visual plays even when the
    // room is empty — a howl still howls. Broadcast so every client sees it.
    if (entry.fx?.kind === "ghostlyWave") {
      try {
        const { AceFX } = await import("../../ace-fx.mjs");
        // Sound: the GM-configured Ghostly Howl file wins; the entry can carry a
        // default. Blank = silent wave.
        let sound = entry.fx.sound ?? null;
        try {
          const s = (game.settings.get(MODULE_ID, "ghostlyHowlSound") || "").trim();
          if (s) sound = s;
        } catch (_) { /* setting not registered yet — use the entry default */ }
        AceFX.ghostlyWaveBroadcast(source, entry.fx.radiusFt ?? rangeFt, entry.fx.color ?? 0xbfeaff, sound);
      } catch (err) { console.warn(`${MODULE_ID} | save-area FX failed (non-fatal):`, err); }
    }

    if (!targets.length) {
      ui.notifications?.info(`${item.name}: no creatures within ${rangeFt} ft.`);
      return;
    }

    // Auto-detect damage from the activity (lazy import — no static cycle).
    let damageTypes = [];
    try {
      const { CombatState } = await import("../../combat-state.mjs");
      // The USED activity only — an item-wide sweep merges every other ability's
      // damage into this one (see CombatState._getItemDamageTypes).
      damageTypes = CombatState._getItemDamageTypes?.(item, ctx.activity ?? null) ?? [];
    } catch (_) { /* condition-only ability */ }

    const saveAbility = entry.save?.ability ?? "wis";
    // An explicit DC on the entry (e.g. King's fixed DC 13) wins over the
    // computed one, so the statblock number always holds.
    const saveDC = Number(entry.save?.dc) > 0
      ? Number(entry.save.dc)
      : SaveResolver._computeSaveDC(actor, item, spellMod);

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
        // ALWAYS stamp our concentrationOrigin tag for concentration spells so the
        // end-sweep can find this debuff on the target — even when the caster-conc
        // lookup races and returns null. The dnd5e dependentOn link is a bonus when
        // we have the conc effect; the sweep is authoritative. (Audit 2026-06-27, P0.)
        if (targetEffect && isConcentration && casterActor) {
          // v0.7.21: uses shared SpellPipeline.findCasterConcentrationFor (audit dedup).
          const casterConcEffect = SpellPipeline.findCasterConcentrationFor(casterActor, spellItem);
          try {
            const update = {
              [`flags.${MODULE_ID}.concentrationOrigin`]: {
                casterId:       casterActor.id,
                spellName:      spellItem.name,
                spellItemId:    spellItem.id,
                concEffectUuid: casterConcEffect?.uuid ?? null,
                stampedAt:      Date.now(),   // protects a fresh re-cast from the old cast's in-flight sweep
              },
            };
            if (casterConcEffect) update["flags.dnd5e.dependentOn"] = casterConcEffect.uuid;
            await targetEffect.update(update);
            console.debug(`${MODULE_ID} | SaveResolver: tagged ${targetActor.name}'s ${effectKey} as ${casterActor.name}'s concentration${casterConcEffect ? " + dnd5e link" : " (sweep-only — conc effect not found yet)"}`);
          } catch (err) {
            console.warn(`${MODULE_ID} | SaveResolver: concentration tag/link failed (non-fatal):`, err);
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
            saveDC: SaveResolver._computeSaveDC(casterActor, spellItem, _aceCreature(casterActor)?.spellMod ?? 0),
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
   * Listens to combatTurnChange — when the affected target's turn ends, the target
   * rolls a save. On success, the effect is removed (spell ends on them).
   * On fail, the effect persists; the loop continues until concentration
   * ends, the effect is removed manually, or the save passes.
   *
   * Hook auto-removes if the effect is deleted (concentration end, dispel,
   * etc.) — checks effect existence each turn.
   */
  static _wireEndOfTurnSave({ targetActor, targetTokenDocId, targetEffectId, effectKey, casterActor, spellItem, castLevel, saveAbility, saveDC, halvesDamage }) {
    // ── FIRE ON THE TURN THAT ACTUALLY ENDED (audit F-022, 2026-08-07) ──
    // This listened to `combatTurn` and worked the answer out by hand:
    //     prevTurnIdx = (combat.turn - 1 + len) % len
    // Foundry fires combatTurn BEFORE it applies the update, so `combat.turn`
    // there is ALREADY the turn that is ending — subtracting one stepped back
    // to the turn before that, and the re-save fired a full turn LATE. A Hold
    // Person target got its escape attempt one combatant too late, every time.
    //
    // `combatTurnChange` hands the state directly: `prior.combatantId` IS the
    // combatant whose turn just ended, with no arithmetic to get wrong. This is
    // the rule already recorded in memory — it was written about this exact
    // mistake, and this site still had it.
    const hookId = Hooks.on("combatTurnChange", async (combat, prior, current) => {
      try {
        // v0.7.74 — multi-GM safety. The hook fires on every client, and isGM
        // is true for ALL connected GMs, so two GMs would double-process the
        // end-of-turn save (double chat card + double roll + double delete).
        // activeGM-gate ensures ONE client owns the state change.
        if (game.users?.activeGM !== game.user) return;

        // Whose turn just ENDED — asked, not computed.
        const endedId = prior?.combatantId ?? null;
        if (!endedId) return;
        const endedCombatant = combat?.combatants?.get(endedId);
        if (!endedCombatant) return;
        if (endedCombatant.tokenId !== targetTokenDocId) return;

        // Check if effect still exists — if not (caster ended concentration,
        // dispel, manual delete), kill the hook.
        const stillEffected = targetActor.effects?.get?.(targetEffectId)
          ?? targetActor.effects?.find?.(e => e.id === targetEffectId);
        if (!stillEffected) {
          Hooks.off("combatTurnChange", hookId);
          console.debug(`${MODULE_ID} | SaveResolver: ${effectKey} effect on ${targetActor.name} gone — end-of-turn save loop unhooked`);
          return;
        }

        // Roll save at end of target's turn
        // ── ONE save modifier, not a fourth hand-rolled one (2026-07-28) ──
        // This rebuilt the save from scratch — ability mod, then bonuses.save,
        // then proficiency IF proficient — a fourth independent implementation
        // of a number the creature snapshot already holds, free to disagree
        // with the other three. The snapshot's `save` is what dnd5e itself
        // computes and what the character sheet displays.
        const totalSaveMod = Number(_aceCreature(targetActor)?.abilities?.[saveAbility]?.save ?? 0) || 0;
        const formula = `1d20 ${totalSaveMod >= 0 ? "+" : "-"} ${Math.abs(totalSaveMod)}`;
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
          Hooks.off("combatTurnChange", hookId);
          console.debug(`${MODULE_ID} | SaveResolver: ${targetActor.name} saved at end of turn vs ${spellItem.name} — effect removed`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | SaveResolver._wireEndOfTurnSave handler threw (non-fatal):`, err);
      }
    });

    // Safety net: also kill the hook on combat end / world reload (mirrors
    // ReactionEngine cleanup pattern)
    Hooks.once("deleteCombat", () => Hooks.off("combatTurnChange", hookId));

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
    const spellDC = _aceCreature(actor)?.spellDC;
    if (Number.isFinite(spellDC) && spellDC > 0) return spellDC;

    // Last resort: 8 + spellMod + prof
    const prof = _aceCreature(actor)?.prof ?? 2;
    return 8 + (spellMod ?? 0) + prof;
  }
}
