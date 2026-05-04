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
        // damage carrying over to the original form's HP. Excess = how far
        // below 0 we went (negative HP not allowed in dnd5e, but pre-clamp
        // value gives us the math).
        await this._handleZeroHPRevert(actor, state, changes);
      } catch (err) {
        console.warn(`${MODULE_ID} | TransformationEngine HP-revert failed:`, err);
      }
    });

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

  static async _handleZeroHPRevert(actor, state, changes) {
    // Compute excess damage. Foundry clamps HP at 0 (no negative), so we
    // can't read it directly. Use the BEFORE-update value from the actor's
    // current HP (already applied by the time updateActor fires) plus the
    // delta.
    const beforeHP = (actor.system?.attributes?.hp?.value ?? 0)
                   - (Number.isFinite(changes.system?.attributes?.hp?.value) ?
                      0 : 0); // We have post-update value; need to compute excess differently.

    // Better: take the new value (which is 0 or less), and figure out
    // excess = abs(prevDamageThatBroughtUsHere - prevHP). But we don't
    // track that here. Conservative approach: 0 excess on the first revert,
    // GM can manually adjust if needed. RAW says excess carries over —
    // we'll wire that more precisely once we have a damage interceptor.
    //
    // For now: trigger revert with 0 excess. TODO: integrate with our
    // existing damage-engine to capture pre-clamp delta.
    const excess = 0;
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
      const html = `
        <div class="ace-qol-transform-card">
          <div class="ace-qol-tx-header">
            <i class="fas fa-paw"></i>
            <strong>${target.name}</strong> transformed into <strong>${sourceActor.name}</strong>
            <span class="ace-qol-tx-source">(${sourceLabel})</span>
          </div>
          <div class="ace-qol-tx-body">
            <span class="ace-qol-tx-spell">${spellName}</span>
            <span class="ace-qol-tx-duration">Duration: ${durationLabel}</span>
          </div>
        </div>
      `;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: target }),
        content: html,
        flags: { [MODULE_ID]: { type: "transformStart", actorId: target.id, source: state.source } },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | transform chat card failed:`, err);
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
