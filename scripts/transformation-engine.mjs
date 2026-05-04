// ─── ACE: QOL — Transformation Engine ─────────────────────────────────────────
// Generic engine for any creature shape change in 5e:
//   - Polymorph (4th-level spell)
//   - True Polymorph (9th-level spell, becomes permanent at 1 hour)
//   - Mass Polymorph (Wish only)
//   - Polymorph Glyph (Forge trap)
//   - Druid Wild Shape
//   - Lycanthropy / curse-driven transformations
//   - Doppelganger / Skinwalker / Oni innate shapeshifts
//   - Item-driven transformations (Cloak of the Bat, etc.)
//
// Wraps dnd5e's transformInto/revertOriginalForm and adds:
//   - Metadata stamp on the actor (source, caster, duration, revert triggers)
//   - Concentration linkage via existing dnd5e dependentOn flag
//   - Timed auto-revert (worldTime hook)
//   - HP-threshold auto-revert with damage carryover (Polymorph RAW)
//   - Voluntary revert (Wild Shape, Doppelganger; not Polymorph spell)
//   - Permanent-after-duration (True Polymorph trick)
//
// Public API:
//   TransformationEngine.init();
//   TransformationEngine.transform(targetActor, sourceActor, opts);
//   TransformationEngine.revert(actor, reason);
//   TransformationEngine.isTransformed(actor);
//   TransformationEngine.getState(actor);
//
// State stored at: actor.flags["ace-qol"].transformState
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { CustomPolymorph } from "./custom-polymorph.mjs";
import { QolSettings } from "./settings.mjs";
import { TokenCache } from "./token-cache.mjs";

// ── Revert reason codes (used in chat cards / logs) ──────────────────────────
export const REVERT_REASON = Object.freeze({
  CONCENTRATION_END: "concentration",
  DURATION_EXPIRED: "duration",
  ZERO_HP:           "zeroHp",
  VOLUNTARY:         "voluntary",
  GM_FORCED:         "gmForced",
  CURSE_REMOVED:     "curseRemoved",
  PERMANENT_LOCKED:  "permanentLocked", // True Polymorph after 1 hour
});

// ── Source codes (where the transformation came from) ────────────────────────
export const TRANSFORM_SOURCE = Object.freeze({
  SPELL_POLYMORPH:       "spell.polymorph",
  SPELL_TRUE_POLYMORPH:  "spell.truePolymorph",
  SPELL_ANIMAL_SHAPES:   "spell.animalShapes",
  SPELL_MASS_POLYMORPH:  "spell.massPolymorph",
  TRAP_POLYMORPH:        "trap.polymorph",
  FEATURE_WILD_SHAPE:    "feature.wildShape",
  CURSE_LYCANTHROPY:     "curse.lycanthropy",
  INNATE_SHAPECHANGER:   "innate.shapechanger",
  ITEM_TRANSFORM:        "item.transform",
  CUSTOM:                "custom",
});


export class TransformationEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // ── Duration auto-revert ──
    // On every world-time advance, scan actors for transform states whose
    // duration has expired. Same idempotent pattern as repeating-save engine.
    Hooks.on("updateWorldTime", async (worldTime, dt) => {
      try {
        if (!game.user.isGM) return;
        if (!Number.isFinite(dt)) return;
        await this._sweepExpiredTransformations(worldTime);
      } catch (err) {
        console.warn(`${MODULE_ID} | TransformationEngine worldTime sweep failed:`, err);
      }
    });

    // ── HP-threshold auto-revert ──
    // dnd5e fires `updateActor` when HP changes. Watch for transformed actors
    // hitting 0 HP and trigger revert with damage carryover.
    Hooks.on("updateActor", async (actor, changes /*, opts, userId */) => {
      try {
        if (!game.user.isGM) return;
        const hpChange = foundry.utils.getProperty(changes, "system.attributes.hp.value");
        if (hpChange === undefined) return;
        const state = this.getState(actor);
        if (!state) return;
        if (!state.revertOnZeroHP) return;
        if (Number(hpChange) > 0) return;

        // Hit 0 HP in transformed form — RAW (Polymorph): revert with excess
        // damage carrying over to the original form's HP. Excess is captured
        // at damage-application time via recordPendingExcess() (see below).
        await this._handleZeroHPRevert(actor, state, changes);
      } catch (err) {
        console.warn(`${MODULE_ID} | TransformationEngine HP-revert failed:`, err);
      }
    });

    // ── Pre-clamp excess damage capture (RAW carryover) ──
    // dnd5e's `preApplyDamage` hook fires with the raw damage amount BEFORE
    // the system clamps HP at 0. We use this to compute "excess damage"
    // (how far past 0 the hit would have gone) and stash it in a transient
    // cache so _handleZeroHPRevert can apply it to the original form's HP.
    //
    // RAW: "Any excess damage carries over to its normal form."
    //
    // This catches damage from ALL sources — dnd5e stock damage buttons,
    // ace-qol's damage-applicator, custom modules. Anything that ultimately
    // calls Actor.applyDamage() lands here.
    Hooks.on("dnd5e.preApplyDamage", (actor, amount /*, updates, options */) => {
      try {
        if (!game.user.isGM) return;
        if (!Number.isFinite(amount) || amount <= 0) return;
        const state = this.getState?.(actor);
        if (!state) return;
        if (!state.revertOnZeroHP) return;
        const currentHP = Number(actor.system?.attributes?.hp?.value ?? 0);
        if (amount <= currentHP) return; // doesn't drop them to 0
        const excess = amount - currentHP;
        TransformationEngine.recordPendingExcess(actor, excess);
        if (QolSettings.get?.("debugMode")) {
          console.log(`${MODULE_ID} | Polymorph excess captured (preApplyDamage): ${actor.name} damage=${amount} hp=${currentHP} excess=${excess}`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | preApplyDamage excess capture failed:`, err);
      }
    });

    // ── Chat-card "Revert Now" button binding ──
    // Foundry V13 fires `renderChatMessageHTML` (HTMLElement), V12 fires
    // `renderChatMessage` (jQuery). Register BOTH with the same handler
    // so the button works regardless of Foundry version.
    // Re-binds on every render so the button works on history messages
    // after a page reload. Also reveals .ace-qol-gm-only sections when the
    // current user is GM by setting data-ace-gm="true".
    const _onRenderChat = (message, html) => {
      try {
        const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
        if (!root || typeof root.querySelectorAll !== "function") return;
        // GM-only visibility toggle
        if (game.user?.isGM) {
          const gmOnly = root.querySelectorAll(".ace-qol-gm-only") ?? [];
          for (const el of gmOnly) el.setAttribute("data-ace-gm", "true");
        }
        // Revert-button click binding (idempotent)
        const btns = root.querySelectorAll("[data-action='aceQolPolymorphRevert']") ?? [];
        for (const btn of btns) {
          if (btn.dataset.aceQolBound === "1") continue;
          btn.dataset.aceQolBound = "1";
          btn.addEventListener("click", (ev) => TransformationEngine._onRevertButtonClick(ev));
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | revert-button binding failed:`, err);
      }
    };
    Hooks.on("renderChatMessage",     _onRenderChat); // V12
    Hooks.on("renderChatMessageHTML", _onRenderChat); // V13

    // ── Concentration linkage ──
    // The existing `dnd5e.dependentOn` chain (Layer 1-5 in ace-qol.mjs) takes
    // care of this for FREE: when the caster's Concentrating effect is
    // deleted/disabled, dnd5e auto-deletes any Active Effects flagged as
    // dependents. We register a dummy "Polymorphed" Active Effect on the
    // target, flagged dependent on the caster's Concentrating effect.
    // When that effect is auto-deleted by dnd5e → our deleteActiveEffect
    // hook detects it as a transform marker → calls revert(). Wired below.

    Hooks.on("deleteActiveEffect", async (effect /*, opts, userId */) => {
      try {
        if (!game.user.isGM) return;
        if (!effect) return;

        // ── Path A: our marker effect was deleted ──
        // (dnd5e dependent cascade route — fires when caster's Concentrating
        // effect is deleted and dnd5e auto-cleans up dependents that have
        // flags.dnd5e.dependentOn pointing at it.)
        const marker = effect.flags?.[MODULE_ID]?.transformMarker;
        if (marker) {
          const targetActor = effect.parent;
          if (!targetActor) return;
          const state = this.getState(targetActor);
          if (!state) return;
          await this.revert(targetActor, REVERT_REASON.CONCENTRATION_END);
          return;
        }

        // ── Path B: a Concentrating effect was deleted directly ──
        // (Parallel safety net for the case where the dnd5e dependent cascade
        // doesn't reach our marker — happens with synthetic/unlinked tokens
        // or when the registry hasn't tracked yet. We iterate all actors
        // whose transformState.concEffectUuid points at this effect's UUID.)
        const isConcentrating = effect.statuses?.has?.("concentrating")
                             || !!effect.flags?.dnd5e?.concentration
                             || String(effect.name ?? "").toLowerCase().includes("concentrating");
        if (!isConcentrating) return;
        await this._revertAllTiedToConc(effect.uuid, "delete");
      } catch (err) {
        console.warn(`${MODULE_ID} | TransformationEngine concentration-end handler failed:`, err);
      }
    });

    // ── Polymorph item-suppression enforcement ──
    // Block any activity whose item is flagged `polymorphSuppressed`. RAW:
    // a polymorphed creature can't cast spells, use weapons, or take actions
    // beyond those of the new form. CustomPolymorph stamps the flag on every
    // suppressible item; this hook makes the flag actually prevent use.
    // The dnd5e.preUseActivity hook is sync-cancellable — return false to
    // block the cast/attack before slot consumption or chat card.
    Hooks.on("dnd5e.preUseActivity", (activity /*, usageConfig, dialogConfig, messageConfig */) => {
      try {
        const item = activity?.item;
        if (!item) return;
        const isSuppressed = item.flags?.[MODULE_ID]?.polymorphSuppressed === true;
        if (!isSuppressed) return;
        // Sanity check: only block if the actor actually has an active
        // polymorph effect. If the flag got orphaned (revert failed somehow),
        // don't penalize the player forever.
        const hasPolymorph = item.actor?.effects?.contents?.some(e =>
          e.flags?.[MODULE_ID]?.polymorphEffect === true && !e.disabled
        );
        if (!hasPolymorph) return;

        ui.notifications?.warn(`${item.actor?.name ?? "This creature"} can't use ${item.name} in its current form.`);
        console.log(`${MODULE_ID} | Polymorph: blocked use of suppressed item "${item.name}" on ${item.actor?.name}`);
        return false; // sync cancel — prevents slot consumption + chat card
      } catch (err) {
        console.error(`${MODULE_ID} | polymorph-suppression hook threw — fail-open:`, err);
      }
    });

    // Concentrating effect being DISABLED (some UIs disable rather than delete)
    Hooks.on("updateActiveEffect", async (effect, changes /*, opts, userId */) => {
      try {
        if (!game.user.isGM) return;
        if (!effect) return;
        if (changes?.disabled !== true) return;

        const isConcentrating = effect.statuses?.has?.("concentrating")
                             || !!effect.flags?.dnd5e?.concentration
                             || String(effect.name ?? "").toLowerCase().includes("concentrating");
        if (!isConcentrating) return;
        await this._revertAllTiedToConc(effect.uuid, "disable");
      } catch (err) {
        console.warn(`${MODULE_ID} | TransformationEngine concentration-disable handler failed:`, err);
      }
    });

    console.log(`${MODULE_ID} | Transformation Engine online (worldTime + HP + concentration triggers)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Transform a target actor into a new form.
   *
   * @param {Actor} target — the actor being transformed (PC or NPC)
   * @param {Actor} sourceActor — the actor whose stat block becomes the new form
   * @param {object} opts
   *   @param {string} opts.source — TRANSFORM_SOURCE.* code
   *   @param {string} [opts.spellName] — display name ("Polymorph", "Wild Shape", etc.)
   *   @param {string} [opts.casterId] — for concentration linkage; null for non-concentration
   *   @param {string} [opts.casterUuid] — caster Actor UUID
   *   @param {string} [opts.concEffectUuid] — caster's Concentrating effect UUID
   *   @param {number|null} [opts.durationSeconds] — null = no timer
   *   @param {boolean} [opts.permanentAfterDuration] — True Polymorph: becomes permanent
   *   @param {boolean} [opts.revertOnZeroHP] — RAW Polymorph default: true
   *   @param {boolean} [opts.revertOnRest] — Wild Shape: true
   *   @param {boolean} [opts.voluntaryRevertOK] — Wild Shape true; forced Polymorph false
   *   @param {string} [opts.preset] — dnd5e transform preset key ("polymorph"/"wildshape")
   * @returns {Promise<boolean>} true on success
   */
  static async transform(target, sourceActor, opts = {}) {
    if (!target || !sourceActor) {
      console.warn(`${MODULE_ID} | TransformationEngine.transform: missing target or sourceActor`);
      return false;
    }
    if (this.isTransformed(target)) {
      // Replace existing transformation? RAW: yes for Polymorph (concentration
      // replacement). Revert old, then transform.
      await this.revert(target, REVERT_REASON.CONCENTRATION_END);
    }

    // ── Mode dispatch: custom (fast) vs dnd5e native (slow but RAW-perfect) ──
    let polymorphMode = "custom";
    try {
      polymorphMode = QolSettings.get("polymorphMode") ?? "custom";
    } catch (_) { /* setting may not be registered yet — default custom */ }

    let transformedActor = null;
    let customRecord = null;     // populated only on custom path
    let flagTarget = target;     // actor we'll setFlag / createEmbeddedDocs on

    if (polymorphMode === "custom") {
      // ── Custom path: stat-override Active Effect, no new actor ──
      const t0 = performance.now();
      customRecord = await CustomPolymorph.transform(target, sourceActor, {
        casterUuid:      opts.casterUuid ?? null,
        durationSeconds: opts.durationSeconds ?? null,
        // Specific token to update — prevents bleed to sibling unlinked tokens
        // that share the same prototype actor id.
        targetTokenId:   opts.targetTokenId ?? null,
        targetTokenUuid: opts.targetTokenUuid ?? null,
      });
      console.log(`${MODULE_ID} | CustomPolymorph.transform took ${(performance.now() - t0).toFixed(0)}ms`);
      if (!customRecord?.success) {
        console.warn(`${MODULE_ID} | CustomPolymorph.transform failed for ${target.name} → ${sourceActor.name} — falling back to dnd5e native`);
        polymorphMode = "dnd5e"; // fall through to native
      } else {
        flagTarget = target; // custom path always operates on `target` directly
      }
    }

    if (polymorphMode === "dnd5e") {
      // ── dnd5e native path: full transformInto ──
      const presetKey = opts.preset ?? this._presetForSource(opts.source);
      const presetCfg = CONFIG.DND5E?.transformation?.presets?.[presetKey];
      let settings;
      try {
        const TS = CONFIG.DND5E?.dataModels?.actor?.TransformationSetting
                ?? globalThis.dnd5e?.dataModels?.actor?.TransformationSetting;
        if (presetCfg && TS) {
          settings = new TS(foundry.utils.deepClone(presetCfg.settings ?? {}));
        } else {
          settings = undefined;
        }
      } catch (_) {
        settings = undefined;
      }

      try {
        transformedActor = await target.transformInto(sourceActor, settings, { renderSheet: false });
        if (!transformedActor) {
          console.warn(`${MODULE_ID} | transformInto returned null for ${target.name} → ${sourceActor.name}`);
          return false;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | transformInto threw for ${target.name}:`, err);
        return false;
      }

      // dnd5e's transformInto returns a TokenDocument (synthetic case) or
      // array of TokenDocuments (linked case), NOT the actor. Resolve the
      // actor for our metadata ops.
      if (!target.isToken) {
        const tokenLike = Array.isArray(transformedActor) ? transformedActor[0] : transformedActor;
        const newActor = tokenLike?.actor ?? null;
        if (newActor) flagTarget = newActor;
      }
    }

    // ── Token image update via TokenCache ──
    // Use the EXACT token ids from customRecord.placedTokens (set by
    // CustomPolymorph from opts.targetTokenId). For dnd5e-mode polymorph
    // we don't have a customRecord, so we fall back to filter-by-actor.
    const explicitTokenIds = customRecord?.originalSnapshot?.placedTokens?.map(p => p.tokenId) ?? null;
    this._applyTokenVariantsImage(flagTarget, sourceActor, explicitTokenIds).catch(err => {
      console.warn(`${MODULE_ID} | TokenCache image update failed (non-fatal):`, err);
    });

    // ── Stamp our metadata ──
    const state = {
      source:                 String(opts.source ?? TRANSFORM_SOURCE.CUSTOM),
      spellName:              opts.spellName ?? null,
      casterId:               opts.casterId ?? null,
      casterUuid:             opts.casterUuid ?? null,
      concEffectUuid:         opts.concEffectUuid ?? null,
      castWorldTime:          Number(game.time?.worldTime ?? 0),
      durationSeconds:        Number.isFinite(opts.durationSeconds) ? Number(opts.durationSeconds) : null,
      permanentAfterDuration: !!opts.permanentAfterDuration,
      revertOnZeroHP:         opts.revertOnZeroHP ?? true,
      revertOnRest:           !!opts.revertOnRest,
      voluntaryRevertOK:      !!opts.voluntaryRevertOK,
      sourceActorUuid:        sourceActor.uuid,
      sourceActorName:        sourceActor.name,
      stampedAt:              Date.now(),
      // Mode-specific bookkeeping: revert() reads this to dispatch correctly
      mode:                   polymorphMode, // "custom" | "dnd5e"
      customRecord:           customRecord,  // null on dnd5e path
    };
    let stampOk = false;
    try {
      await flagTarget.setFlag(MODULE_ID, "transformState", state);
      stampOk = true;
      console.log(`${MODULE_ID} | TransformationEngine: stamped transformState on ${flagTarget.name} (uuid=${flagTarget.uuid}) — concEffectUuid=${state.concEffectUuid ?? "(none)"}, durationSeconds=${state.durationSeconds ?? "(none)"}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | failed to stamp transformState on ${flagTarget.name}:`, err);
    }

    // ── Create the marker Active Effect (for concentration linkage) ──
    if (state.concEffectUuid) {
      try {
        await this._createMarkerEffect(flagTarget, state, sourceActor);
        console.log(`${MODULE_ID} | TransformationEngine: created marker effect on ${flagTarget.name} linked to ${state.concEffectUuid}`);
      } catch (err) {
        console.warn(`${MODULE_ID} | failed to create transform marker effect:`, err);
      }
    } else {
      console.warn(`${MODULE_ID} | TransformationEngine: NO concEffectUuid provided — concentration linkage DISABLED. Drop-concentration revert relies on _revertAllTiedToConc safety net only.`);
    }

    // ── Chat card ──
    await this._postTransformCard(target, sourceActor, state);

    console.log(`${MODULE_ID} | Transformed ${target.name} → ${sourceActor.name} (${state.source}${state.durationSeconds ? `, ${state.durationSeconds}s` : ", no timer"})`);
    return true;
  }

  /**
   * Revert a transformed actor to original form.
   * @param {Actor} actor — the currently-transformed actor
   * @param {string} reason — REVERT_REASON.* code
   * @param {object} [opts]
   *   @param {number} [opts.excessDamage] — for ZERO_HP revert: damage to apply to original HP
   * @returns {Promise<boolean>}
   */
  static async revert(actor, reason = REVERT_REASON.VOLUNTARY, opts = {}) {
    if (!actor) return false;
    const state = this.getState(actor);
    if (!state) {
      // Not transformed (or already reverted) — no-op
      return false;
    }

    // ── Re-entry guard ──
    // When a polymorph spell expires, BOTH triggers can fire near-simultaneously:
    //   - duration sweep (worldTime hook)
    //   - concentration-end hook (Concentrating effect being deleted)
    // Without a guard the second one races against the first's cleanup and
    // hits "Actor X does not exist!" errors that Foundry escalates to red
    // toasts. Per-actor lock makes the second call a clean no-op. The lock
    // is released in `finally` at the end of revert.
    if (!this._revertingActors) this._revertingActors = new Set();
    const lockKey = actor.uuid ?? actor.id ?? `_anon_${Math.random()}`;
    if (this._revertingActors.has(lockKey)) {
      console.log(`${MODULE_ID} | revert: ${actor.name} already in-flight (race-guard) — skipping duplicate (reason: ${reason})`);
      return false;
    }
    this._revertingActors.add(lockKey);
    try {

    // ── Permanent-locked check (True Polymorph after 1 hour) ──
    if (state.permanentAfterDuration && reason !== REVERT_REASON.PERMANENT_LOCKED) {
      const elapsed = (game.time?.worldTime ?? 0) - state.castWorldTime;
      if (Number.isFinite(state.durationSeconds) && elapsed >= state.durationSeconds) {
        console.log(`${MODULE_ID} | revert blocked: ${actor.name} is permanently transformed (True Polymorph past duration)`);
        return false;
      }
    }

    // ── Voluntary revert gate (Wild Shape OK, forced Polymorph not OK) ──
    if (reason === REVERT_REASON.VOLUNTARY && !state.voluntaryRevertOK) {
      console.log(`${MODULE_ID} | voluntary revert blocked on ${actor.name} — ${state.source} disallows it`);
      return false;
    }

    // ── Clean up marker effect FIRST so the deleteActiveEffect hook doesn't
    //    bounce back into revert() recursively ──
    try {
      // Clear our state flag BEFORE deleting marker, so the hook's
      // `getState() return` early-exit fires before dnd5e re-fires it.
      await actor.unsetFlag(MODULE_ID, "transformState");

      // Find the marker, then re-check existence right before delete. dnd5e's
      // dependent cascade or duration tracker may have already removed it,
      // and a stale .find() result will throw "ActiveEffect X does not exist"
      // — Foundry escalates that to a red toast.
      const marker = actor.effects?.contents?.find(e => e.flags?.[MODULE_ID]?.transformMarker);
      if (marker) {
        const stillPresent = actor.effects?.get?.(marker.id);
        if (stillPresent) {
          try { await stillPresent.delete(); } catch (err) {
            const msg = String(err?.message ?? err ?? "");
            if (!/does not exist/i.test(msg)) {
              console.warn(`${MODULE_ID} | revert: marker delete failed:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | revert: cleanup of state/marker failed:`, err);
    }

    // ── Dispatch revert based on the mode that was used to transform ──
    let reverted = null;
    if (state.mode === "custom" && state.customRecord) {
      // ── Custom path: use CustomPolymorph.revert ──
      const t0 = performance.now();
      const ok = await CustomPolymorph.revert(actor, state.customRecord, {
        excessDamage: opts?.excessDamage ?? 0,
      });
      console.log(`${MODULE_ID} | CustomPolymorph.revert took ${(performance.now() - t0).toFixed(0)}ms (ok=${ok})`);
      reverted = actor;
    } else {
      // ── dnd5e native path: call revertOriginalForm ──
      // Pre-check: if a parallel cleanup already removed the polymorphed actor
      // (race we couldn't fully prevent — e.g. another module deleted it), bail
      // before calling revertOriginalForm so Foundry doesn't escalate the
      // "Actor X does not exist" server error to a red toast.
      const stillPolymorphed = actor?.isPolymorphed === true;
      const actorStillExists = actor?.uuid && (game.actors.get(actor.id) || actor.token);
      if (!stillPolymorphed) {
        console.log(`${MODULE_ID} | revert: ${actor?.name} no longer flagged polymorphed — skipping revertOriginalForm`);
      } else if (!actorStillExists) {
        console.log(`${MODULE_ID} | revert: ${actor?.name} already removed from world — skipping revertOriginalForm`);
      } else {
        try {
          reverted = await actor.revertOriginalForm({ renderSheet: false });
        } catch (err) {
          const msg = String(err?.message ?? err ?? "");
          if (/does not exist/i.test(msg)) {
            console.log(`${MODULE_ID} | revert: revertOriginalForm hit a race (actor already gone) — benign`);
          } else {
            console.warn(`${MODULE_ID} | revertOriginalForm threw for ${actor.name}:`, err);
          }
        }
      }
    }

    // ── Apply excess damage carryover (ZERO_HP path) ──
    // dnd5e mode only — custom mode handles this inside CustomPolymorph.revert
    // using the snapshotted original HP (more accurate).
    if (state.mode !== "custom"
      && reason === REVERT_REASON.ZERO_HP
      && Number.isFinite(opts.excessDamage)
      && opts.excessDamage > 0) {
      const targetForDmg = reverted ?? actor;
      const currentHP = Number(targetForDmg.system?.attributes?.hp?.value ?? 0);
      const newHP = Math.max(0, currentHP - opts.excessDamage);
      try {
        await targetForDmg.update({ "system.attributes.hp.value": newHP });
        console.log(`${MODULE_ID} | ${targetForDmg.name} excess damage carryover: ${opts.excessDamage} → original HP ${currentHP} - ${opts.excessDamage} = ${newHP}`);
      } catch (err) {
        console.warn(`${MODULE_ID} | excess damage carryover failed:`, err);
      }
    }

    // ── Chat card ──
    await this._postRevertCard(reverted ?? actor, state, reason, opts);

    console.log(`${MODULE_ID} | Reverted ${actor.name} (reason: ${reason})`);
    return true;
    } finally {
      // Always release the re-entry lock, even on throw or early return below
      if (this._revertingActors) this._revertingActors.delete(lockKey);
    }
  }

  /** Quick check: is this actor currently transformed via OUR engine? */
  static isTransformed(actor) {
    return !!actor?.flags?.[MODULE_ID]?.transformState;
  }

  /** Get the transformation state, or null. */
  static getState(actor) {
    return actor?.flags?.[MODULE_ID]?.transformState ?? null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — preset selection
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Map our source code to the dnd5e built-in preset key.
   * Falls through to "polymorph" preset for forced shape changes.
   */
  static _presetForSource(source) {
    const s = String(source ?? "");
    if (s === TRANSFORM_SOURCE.FEATURE_WILD_SHAPE) return "wildshape";
    if (s.startsWith("spell.")) return "polymorph";
    if (s.startsWith("trap.")) return "polymorph";
    if (s === TRANSFORM_SOURCE.CURSE_LYCANTHROPY) return "polymorph";
    return "polymorph"; // safe default
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — marker effect for concentration linkage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates a small Active Effect on the target with `flags.dnd5e.dependentOn`
   * pointing at the caster's Concentrating effect. When the caster's
   * concentration ends, dnd5e's auto-cascade deletes this marker, which
   * fires our deleteActiveEffect handler → revert().
   *
   * Marker also acts as a visible status indicator on the token HUD.
   */
  static async _createMarkerEffect(target, state, sourceActor = null) {
    // Pick an icon that's guaranteed to exist. Foundry's hosted server doesn't
    // ship `icons/svg/paw.svg` so hardcoding that path triggers a 404 + a
    // PIXI loadTexture error every frame the token is rendered. Prefer the
    // source actor's image (always exists since we just transformed into it),
    // fall back to a known-good system icon.
    const safeIcon = sourceActor?.img
                  || sourceActor?.prototypeToken?.texture?.src
                  || "icons/svg/mystery-man.svg";

    const effData = {
      name: `Transformed: ${state.sourceActorName}`,
      icon: safeIcon,
      img:  safeIcon, // V13 sometimes uses img, sometimes icon
      origin: state.casterUuid ?? null,
      duration: {
        seconds: state.durationSeconds ?? null,
        startTime: state.castWorldTime,
      },
      flags: {
        [MODULE_ID]: {
          transformMarker: {
            source: state.source,
            spellName: state.spellName,
            castWorldTime: state.castWorldTime,
            stampedAt: Date.now(),
          },
        },
        dnd5e: {
          dependentOn: state.concEffectUuid,
        },
      },
      statuses: ["polymorphed"],
    };
    await target.createEmbeddedDocuments("ActiveEffect", [effData]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — Token Variants integration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply Token Variants's image-rewrite logic to the placed tokens of the
   * just-transformed actor. No-op if TVA isn't installed/active.
   *
   * Why this exists: dnd5e's transformInto uses an UPDATE pathway, which
   * bypasses TVA's preCreateToken/createToken hooks. So polymorph tokens
   * end up with the raw `prototypeToken.texture.src` from the compendium
   * (e.g. ddb-images/.../Almiraj.webp) instead of the user's curated
   * mapping (e.g. NPCs/Almiraj.webp).
   *
   * Calling TVA's `doImageSearch` with searchType: "Token" replicates what
   * happens when the actor is dragged onto the canvas — searches the
   * configured searchPaths (in priority order), finds a name-matching image,
   * applies it via `updateTokenImage`.
   */
  static async _applyTokenVariantsImage(transformedActor, sourceActor, explicitTokenIds = null) {
    // Prefer caller-provided token ids (from CustomPolymorph). Falls back
    // to actor-reference filter if no explicit ids passed (e.g. dnd5e-mode
    // polymorph or trap-driven where the caller doesn't have a tokenDoc).
    let tokens;
    if (Array.isArray(explicitTokenIds) && explicitTokenIds.length) {
      tokens = explicitTokenIds
        .map(id => canvas?.scene?.tokens?.get?.(id))
        .filter(Boolean);
    } else {
      tokens = (canvas?.scene?.tokens?.contents ?? []).filter(t => t.actor === transformedActor);
    }
    if (!tokens.length) return;

    // ── Single source: ace-qol's TokenCache ──
    // No TVA, no fallback. If our cache has it, apply. If not, the token
    // keeps whatever image dnd5e/CustomPolymorph already set (compendium
    // prototypeToken default). This keeps polymorph instant — no slow API
    // lookups, ever.
    let cachedPath = null;
    try {
      cachedPath = TokenCache.get(sourceActor.name);
    } catch (err) {
      console.warn(`${MODULE_ID} | TokenCache lookup threw:`, err);
      return;
    }
    if (!cachedPath) {
      console.log(`${MODULE_ID} | TokenCache: no curated image for "${sourceActor.name}" — using compendium default`);
      return;
    }

    for (const tokenDoc of tokens) {
      try {
        await tokenDoc.update({ "texture.src": cachedPath });
      } catch (err) {
        console.warn(`${MODULE_ID} | TokenCache: token update failed for "${tokenDoc.name}":`, err);
      }
    }
    console.log(`${MODULE_ID} | TokenCache: applied "${cachedPath}" to ${tokens.length} placed token(s) of ${transformedActor.name} (instant)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — concentration sweep (parallel safety net)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Iterate all transformed actors and revert any whose transformState's
   * concEffectUuid matches the given UUID. Called when a Concentrating
   * effect is deleted or disabled, in case dnd5e's dependent cascade missed
   * our marker (synthetic-actor edge cases, registry timing, etc.).
   */
  static async _revertAllTiedToConc(concEffectUuid, source) {
    if (!concEffectUuid) return;

    // Gather all actors with our transformState
    const actors = [];
    for (const a of game.actors?.contents ?? []) {
      if (this.isTransformed(a)) actors.push(a);
    }
    if (canvas?.scene) {
      for (const t of canvas.scene.tokens?.contents ?? []) {
        if (t.actor && this.isTransformed(t.actor) && !actors.includes(t.actor)) {
          actors.push(t.actor);
        }
      }
    }

    let reverted = 0;
    for (const actor of actors) {
      const state = this.getState(actor);
      if (!state?.concEffectUuid) continue;
      if (state.concEffectUuid !== concEffectUuid) continue;
      try {
        await this.revert(actor, REVERT_REASON.CONCENTRATION_END);
        reverted++;
      } catch (err) {
        console.warn(`${MODULE_ID} | _revertAllTiedToConc: revert failed for ${actor.name}:`, err);
      }
    }
    if (reverted > 0) {
      console.log(`${MODULE_ID} | TransformationEngine [${source}] — concentration ended, reverted ${reverted} polymorphed actor(s)`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — duration sweep
  // ═══════════════════════════════════════════════════════════════════════════

  static async _sweepExpiredTransformations(worldTime) {
    // Gather actors with our state flag (world + canvas synthetic)
    const actors = [];
    for (const a of game.actors?.contents ?? []) {
      if (this.isTransformed(a)) actors.push(a);
    }
    if (canvas?.scene) {
      for (const t of canvas.scene.tokens?.contents ?? []) {
        if (t.actor && this.isTransformed(t.actor) && !actors.includes(t.actor)) {
          actors.push(t.actor);
        }
      }
    }

    if (actors.length > 0) {
      console.log(`${MODULE_ID} | TransformationEngine: worldTime sweep — found ${actors.length} transformed actor(s), checking durations...`);
    }

    for (const actor of actors) {
      const state = this.getState(actor);
      if (!state) continue;
      if (!Number.isFinite(state.durationSeconds)) continue; // no timer
      const elapsed = worldTime - state.castWorldTime;
      if (elapsed < state.durationSeconds) continue; // not yet expired

      // ── Permanent-after-duration trick (True Polymorph) ──
      // Don't revert; instead, lock the state as permanent.
      if (state.permanentAfterDuration) {
        try {
          await actor.setFlag(MODULE_ID, "transformState", { ...state, permanentLocked: true });
          await this._postPermanentLockCard(actor, state);
          console.log(`${MODULE_ID} | ${actor.name} True Polymorph passed 1-hour mark — now permanent`);
        } catch (err) {
          console.warn(`${MODULE_ID} | failed to lock permanent transform for ${actor.name}:`, err);
        }
        continue;
      }

      // Standard duration revert
      try {
        await this.revert(actor, REVERT_REASON.DURATION_EXPIRED);
      } catch (err) {
        console.warn(`${MODULE_ID} | duration revert failed for ${actor.name}:`, err);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal — HP threshold revert with damage carryover
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Transient cache of pre-clamp excess damage values.
   * Populated by `dnd5e.preApplyDamage` hook + ace-qol's damage-applicator.
   * Read + cleared by `_handleZeroHPRevert` when a polymorphed actor hits 0.
   *
   * Key: actor.id (or token uuid for unlinked clones — see recordPendingExcess)
   * Value: number (damage that exceeded current HP at application time)
   */
  static _pendingExcess = new Map();

  /**
   * Records pre-clamp excess damage for a polymorphed actor.
   * Called from:
   *   1. dnd5e.preApplyDamage hook (catches all dnd5e damage)
   *   2. ace-qol's damage-applicator (belt-and-suspenders for our own pipeline)
   *
   * Uses both actor.id AND tokenDoc.uuid as keys so unlinked clones don't
   * collide (same actor.id can map to multiple placed tokens).
   */
  static recordPendingExcess(actor, excess) {
    if (!actor || !Number.isFinite(excess) || excess <= 0) return;
    // Key by actor.id for the most common case (linked actors, sheet damage)
    this._pendingExcess.set(actor.id, excess);
    // Also key by tokenDoc.uuid for any active token, in case the revert
    // path looks up by token instead of actor (e.g., synthetic actors).
    const tokens = actor.getActiveTokens?.() ?? [];
    for (const t of tokens) {
      const uuid = t?.document?.uuid ?? t?.uuid;
      if (uuid) this._pendingExcess.set(uuid, excess);
    }
    // Auto-expire after 10s — defensive, in case revert never fires.
    setTimeout(() => {
      this._pendingExcess.delete(actor.id);
      for (const t of tokens) {
        const uuid = t?.document?.uuid ?? t?.uuid;
        if (uuid) this._pendingExcess.delete(uuid);
      }
    }, 10000);
  }

  /**
   * Reads + clears the pending excess for an actor.
   */
  static consumePendingExcess(actor) {
    if (!actor) return 0;
    let excess = this._pendingExcess.get(actor.id) ?? 0;
    this._pendingExcess.delete(actor.id);
    if (!excess) {
      // Try by token uuid (unlinked clone case)
      const tokens = actor.getActiveTokens?.() ?? [];
      for (const t of tokens) {
        const uuid = t?.document?.uuid ?? t?.uuid;
        if (uuid && this._pendingExcess.has(uuid)) {
          excess = this._pendingExcess.get(uuid) ?? 0;
          this._pendingExcess.delete(uuid);
          if (excess) break;
        }
      }
    } else {
      // Clean up token-uuid keys too
      const tokens = actor.getActiveTokens?.() ?? [];
      for (const t of tokens) {
        const uuid = t?.document?.uuid ?? t?.uuid;
        if (uuid) this._pendingExcess.delete(uuid);
      }
    }
    return excess;
  }

  static async _handleZeroHPRevert(actor, state, changes) {
    // RAW (Polymorph): "When the creature drops to 0 hit points, any excess
    // damage carries over to its normal form."
    //
    // The excess is captured at damage-application time via the
    // `dnd5e.preApplyDamage` hook (catches all damage paths). We read it
    // out of _pendingExcess here and pass it to revert(), which (for
    // custom mode) hands it to CustomPolymorph.revert which subtracts it
    // from the snapshotted original HP.
    //
    // If no excess was captured (e.g., damage came from a non-dnd5e path
    // or the cache expired), we fall back to 0 excess — the creature
    // reverts at full original HP. GM can manually adjust if the table
    // wants stricter accounting.
    const excess = TransformationEngine.consumePendingExcess(actor);
    if (QolSettings.get?.("debugMode")) {
      console.log(`${MODULE_ID} | Polymorph ZERO_HP revert for ${actor.name}: excess=${excess}`);
    }
    await this.revert(actor, REVERT_REASON.ZERO_HP, { excessDamage: excess });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat cards
  // ═══════════════════════════════════════════════════════════════════════════

  static async _postTransformCard(target, sourceActor, state) {
    try {
      const spellName = state.spellName ?? "transformation";
      const sourceLabel = TransformationEngine._sourceLabel(state.source);
      const durationLabel = Number.isFinite(state.durationSeconds)
        ? this._formatDuration(state.durationSeconds)
        : "indefinite";
      // Manual-revert button — only meaningful for the GM. Players see the
      // card but the button is hidden via CSS class. Click triggers a
      // VOLUNTARY-reason revert (no excess damage carryover).
      const targetUuid = target.uuid;
      const targetName = target.name;
      const sourceName = sourceActor.name;
      const targetImg  = target.img || target.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg";
      const sourceImg  = sourceActor.img || sourceActor.prototypeToken?.texture?.src || "icons/svg/mystery-man.svg";
      const html = `
        <div class="ace-qol-transform-card">
          <div class="ace-qol-tx-header">
            <i class="fas fa-paw"></i>
            <strong>${targetName}</strong> transformed into <strong>${sourceName}</strong>
            <span class="ace-qol-tx-source">(${sourceLabel})</span>
          </div>
          <div class="ace-qol-tx-thumbs">
            <img src="${targetImg}" class="ace-qol-tx-thumb" title="${targetName} (original)" />
            <i class="fas fa-arrow-right ace-qol-tx-arrow"></i>
            <img src="${sourceImg}" class="ace-qol-tx-thumb" title="${sourceName} (current form)" />
          </div>
          <div class="ace-qol-tx-body">
            <span class="ace-qol-tx-spell">${spellName}</span>
            <span class="ace-qol-tx-duration">Duration: ${durationLabel}</span>
          </div>
          <div class="ace-qol-tx-actions ace-qol-gm-only">
            <button type="button"
                    class="ace-qol-btn ace-qol-tx-revert-btn"
                    data-action="aceQolPolymorphRevert"
                    data-target-uuid="${targetUuid}"
                    title="End the transformation now — original form returns at current beast HP">
              <i class="fas fa-undo-alt"></i> Revert Now
            </button>
          </div>
        </div>
      `;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: target }),
        content: html,
        flags: {
          [MODULE_ID]: {
            type: "transformStart",
            actorId: target.id,
            actorUuid: target.uuid,
            source: state.source,
          },
        },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | transform chat card failed:`, err);
    }
  }

  /**
   * Click handler for the chat-card "Revert Now" button.
   * Bound globally in init() so the button works after page reload.
   *
   * Uses GM_FORCED reason (not VOLUNTARY) because the Polymorph spell sets
   * `state.voluntaryRevertOK = false` per RAW (only the caster ending
   * concentration can dismiss the spell). The GM clicking "Revert Now" is
   * GM fiat — overrides RAW restrictions, like dispel-magic-equivalent.
   */
  static async _onRevertButtonClick(event) {
    try {
      const btn = event.target?.closest?.("[data-action='aceQolPolymorphRevert']");
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      if (!game.user.isGM) {
        ui.notifications?.warn("Only the GM can end a transformation from the chat card.");
        return;
      }
      const uuid = btn.dataset.targetUuid;
      if (!uuid) return;
      const resolved = await fromUuid(uuid).catch(() => null);
      if (!resolved) {
        ui.notifications?.error("Polymorph: target actor not found (may have been deleted).");
        return;
      }
      const realActor = resolved.actor ?? resolved; // handle TokenDocument vs Actor

      // Diagnose state BEFORE attempting revert — surfaces clearer error
      // messages than "not currently transformed" (which is misleading
      // when the actor IS transformed but a guard blocked the revert).
      const state = TransformationEngine.getState(realActor);
      if (!state) {
        ui.notifications?.warn(`Polymorph: ${realActor.name} is not currently transformed (state cleared).`);
        return;
      }

      // Disable the button immediately so double-click can't fire twice
      btn.disabled = true;
      btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Reverting…`;

      // GM_FORCED bypasses the voluntaryRevertOK gate (Polymorph spell
      // disallows voluntary self-revert; GM fiat overrides).
      const ok = await TransformationEngine.revert(realActor, REVERT_REASON.GM_FORCED);
      if (!ok) {
        ui.notifications?.warn(`Polymorph: revert returned false for ${realActor.name} — check console for details.`);
        btn.disabled = false;
        btn.innerHTML = `<i class="fas fa-undo-alt"></i> Revert Now`;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | revert button click failed:`, err);
      ui.notifications?.error(`Polymorph revert error: ${err.message ?? err}`);
    }
  }

  static async _postRevertCard(actor, state, reason, opts) {
    try {
      const spellName = state.spellName ?? "transformation";
      const reasonLabel = TransformationEngine._reasonLabel(reason);
      const excessNote = (reason === REVERT_REASON.ZERO_HP && opts?.excessDamage > 0)
        ? ` <span class="ace-qol-tx-excess">(${opts.excessDamage} excess damage carried over)</span>`
        : "";
      const html = `
        <div class="ace-qol-transform-card ace-qol-transform-revert">
          <div class="ace-qol-tx-header">
            <i class="fas fa-undo-alt"></i>
            <strong>${actor.name}</strong> reverted from <strong>${state.sourceActorName ?? "transformed form"}</strong>
            <span class="ace-qol-tx-source">(${reasonLabel})</span>
          </div>
          <div class="ace-qol-tx-body">
            <span class="ace-qol-tx-spell">${spellName}</span>${excessNote}
          </div>
        </div>
      `;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: html,
        flags: { [MODULE_ID]: { type: "transformEnd", actorId: actor.id, reason } },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | revert chat card failed:`, err);
    }
  }

  static async _postPermanentLockCard(actor, state) {
    try {
      const html = `
        <div class="ace-qol-transform-card ace-qol-transform-permanent">
          <div class="ace-qol-tx-header">
            <i class="fas fa-infinity"></i>
            <strong>${actor.name}</strong> is now permanently <strong>${state.sourceActorName}</strong>
            <span class="ace-qol-tx-source">(True Polymorph — 1 hour passed)</span>
          </div>
          <div class="ace-qol-tx-body">
            <span class="ace-qol-tx-spell">${state.spellName ?? "True Polymorph"}</span>
            <span class="ace-qol-tx-perm-note">No longer requires concentration. Reversal requires Dispel Magic, Wish, or another transformation.</span>
          </div>
        </div>
      `;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: html,
        flags: { [MODULE_ID]: { type: "transformPermanent", actorId: actor.id } },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | permanent-lock chat card failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  static _sourceLabel(source) {
    const s = String(source ?? "");
    if (s === TRANSFORM_SOURCE.SPELL_POLYMORPH)        return "Polymorph spell";
    if (s === TRANSFORM_SOURCE.SPELL_TRUE_POLYMORPH)   return "True Polymorph";
    if (s === TRANSFORM_SOURCE.SPELL_ANIMAL_SHAPES)    return "Animal Shapes";
    if (s === TRANSFORM_SOURCE.SPELL_MASS_POLYMORPH)   return "Mass Polymorph";
    if (s === TRANSFORM_SOURCE.TRAP_POLYMORPH)         return "Polymorph trap";
    if (s === TRANSFORM_SOURCE.FEATURE_WILD_SHAPE)     return "Wild Shape";
    if (s === TRANSFORM_SOURCE.CURSE_LYCANTHROPY)      return "Lycanthropy";
    if (s === TRANSFORM_SOURCE.INNATE_SHAPECHANGER)    return "Innate shapeshift";
    if (s === TRANSFORM_SOURCE.ITEM_TRANSFORM)         return "Magic item";
    return s || "Transformation";
  }

  static _reasonLabel(reason) {
    switch (reason) {
      case REVERT_REASON.CONCENTRATION_END: return "concentration ended";
      case REVERT_REASON.DURATION_EXPIRED:  return "duration expired";
      case REVERT_REASON.ZERO_HP:           return "dropped to 0 HP";
      case REVERT_REASON.VOLUNTARY:         return "voluntary";
      case REVERT_REASON.GM_FORCED:         return "GM forced revert";
      case REVERT_REASON.CURSE_REMOVED:     return "curse removed";
      case REVERT_REASON.PERMANENT_LOCKED:  return "permanent";
      default: return String(reason ?? "ended");
    }
  }

  static _formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "instant";
    if (seconds < 60)    return `${seconds}s`;
    if (seconds < 3600)  return `${Math.round(seconds / 60)}min`;
    if (seconds < 86400) return `${Math.round(seconds / 3600 * 10) / 10}hr`;
    return `${Math.round(seconds / 86400)}d`;
  }
}
