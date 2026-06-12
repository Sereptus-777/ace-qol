// ─── ACE: QOL — Unified Spell Pipeline Dispatcher ────────────────────────────
// Routes every cast through the registry. Dispatches to the right resolver
// based on the spell's `shape`. Handles slot deferral, edition awareness,
// cancel = no slot lost.
//
// Hook flow (Magic Missile example):
//   1. dnd5e.preUseActivity  — registry has "magic missile" → mark active +
//                              defer slot consumption (so cancel costs nothing)
//   2. (dnd5e shows the cast dialog, user picks slot, confirms)
//   3. dnd5e.useActivity     — cast level resolved; cache it
//   4. dnd5e.postCreateUsageMessage — pipeline dispatches:
//        a. open UnifiedSpellPicker (distribute variant)
//        b. on confirm → DamageResolver.runDistribute → damage card
//        c. AnimationHelper.play → AA fires on the resolved targets
//        d. (Shield check inside DamageResolver before damage rolls)
//
// Spells NOT in the registry: pipeline returns silently → dnd5e default
// flow runs unchanged. Safe failure mode.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";
import { SPELL_REGISTRY } from "./registry/_index.mjs";
import { FEATURE_REGISTRY } from "./registry/features.mjs";
import { UnifiedSpellPicker } from "./picker.mjs";
import { AnimationHelper } from "./animation.mjs";
import { DamageResolver } from "./resolvers/damage.mjs";
import { SaveResolver } from "./resolvers/save.mjs";
import { HealResolver } from "./resolvers/heal.mjs";
import { BuffResolver } from "./resolvers/buff.mjs";
import { TemplateResolver } from "./resolvers/template.mjs";
import { SelfResolver } from "./resolvers/self.mjs";

export class SpellPipeline {

  // Cache cast level captured between preUseActivity and useActivity hooks
  // Key includes activity.uuid (or fallback) + cast-start timestamp so
  // simultaneous casts of the same item (macros, rapid actions) don't
  // overwrite each other. (Audit-mandated 2026-06-08.)
  static _castLevelCache = new Map();

  // Dedup tracker — postCreateUsageMessage can fire multiple times for one cast.
  // v0.7.21: switched from WeakSet on activity object to Set on activity UUID
  // string. dnd5e 5.x clones/wraps activities between hooks, so the WeakSet
  // dedup silently missed re-fires → double dispatch → double slot consumption
  // + double effect application. (Audit-mandated 2026-06-08.)
  static _handledActivities = new Set();

  // Auto-evict handled-activity entries after 30s — bounded memory.
  static _evictHandledActivity(key) {
    setTimeout(() => SpellPipeline._handledActivities.delete(key), 30000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  static initialize() {
    // ── Pre-cast: registry check + slot deferral + stale-target clear ──
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      try {
        const entry = SpellPipeline._getEntry(activity?.item);
        if (!entry) return; // not ours — fall through to dnd5e

        // Stamp a per-cast token onto the activity so _cacheKey can produce
        // a stable, collision-free key across simultaneous casts of the same
        // item. Uses performance.now() to avoid the disallowed Date.now() in
        // worker context. Sticks for the activity's lifetime.
        if (!activity._aceCastStamp) {
          activity._aceCastStamp = `${performance.now?.() ?? Math.random()}`;
        }

        // Defer slot consumption — restore on confirm or refund on cancel
        if (usageConfig?.consume?.spellSlot !== undefined) {
          usageConfig.consume.spellSlot = false;
          activity._aceSlotDeferred = true;
        }

        // Cache the proposed slot level (may be overwritten by useActivity)
        const itemBaseLevel = activity?.item?.system?.level ?? 1;
        const key = SpellPipeline._cacheKey(activity);
        SpellPipeline._castLevelCache.set(key, itemBaseLevel);

        // ── Clear stale targets from any prior cast ──
        // The picker will re-target via its own UI. Without this clear,
        // (a) cast 2 of Magic Missile pre-fills with cast 1's tokens, and
        // (b) AA's cast-time hook fires the animation at the stale targets
        //     BEFORE the picker even opens. Both are confusing/wrong.
        // Only clear for picker-using shapes — self/template/aura spells
        // don't open a picker and don't want their targets nuked here.
        const pickerShapes = new Set(["distribute", "multi-buff", "multi-heal", "save-single", "touch", "chained"]);
        if (pickerShapes.has(entry.shape)) {
          SpellPipeline._clearUserTargets();
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | SpellPipeline.preUseActivity threw:`, err);
      }
    });

    // ── Mid-cast: capture the real upcast level after user picks slot ──
    Hooks.on("dnd5e.useActivity", (activity, usageConfig) => {
      try {
        const entry = SpellPipeline._getEntry(activity?.item);
        if (!entry) return;

        const resolvedLevel = Number(
          usageConfig?.spell?.level
          ?? usageConfig?.spellLevel
          ?? activity?.usage?.spellLevel
          ?? activity?.item?.system?.level
          ?? 1
        );
        const key = SpellPipeline._cacheKey(activity);
        SpellPipeline._castLevelCache.set(key, resolvedLevel);
      } catch (err) {
        console.warn(`${MODULE_ID} | SpellPipeline.useActivity threw:`, err);
      }
    });

    // ── Post-cast: dispatch to the right shape resolver ──
    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      try {
        const entry = SpellPipeline._getEntry(activity?.item);
        if (!entry) return;

        // Dedup — key by activity UUID + cast timestamp via _cacheKey, NOT
        // by activity object reference. dnd5e 5.x clones/wraps activities
        // between hooks, making WeakSet ref-based dedup miss duplicates →
        // double dispatch → double slot consumption + double effect application.
        // (Audit-mandated 2026-06-08.)
        const dedupKey = SpellPipeline._cacheKey(activity);
        if (SpellPipeline._handledActivities.has(dedupKey)) {
          console.debug(`${MODULE_ID} | SpellPipeline: duplicate postCreateUsageMessage for ${activity.item?.name} (key=${dedupKey}) — skipped`);
          return;
        }
        SpellPipeline._handledActivities.add(dedupKey);
        SpellPipeline._evictHandledActivity(dedupKey);  // 30s auto-evict

        SpellPipeline._dispatch(activity, message)
          .catch(err => console.error(`${MODULE_ID} | SpellPipeline dispatch threw for ${activity?.item?.name}:`, err));
      } catch (err) {
        console.warn(`${MODULE_ID} | SpellPipeline.postCreateUsageMessage threw:`, err);
      }
    });

    console.debug(`${MODULE_ID} | SpellPipeline online — ${Object.keys(SPELL_REGISTRY).length} spells in registry`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — called by spell-auto-damage to decide if pipeline owns a spell
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns the registry entry for an item, or null if not registered.
   * Case-insensitive name lookup with edition-aware overrides applied.
   * Used by other engines (spell-auto-damage, engagement-gate) to check
   * whether the pipeline owns a given spell.
   */
  static _getEntry(item) {
    if (!item) return null;
    const type = item.type;
    // The doorway: the pipeline now accepts FEATURES (feats), not just spells.
    if (type !== "spell" && type !== "feat") return null;
    const name = String(item.name ?? "").trim().toLowerCase();
    if (!name) return null;
    // Spells use the spell registry. Features check the feature registry first,
    // then fall back to the spell registry — so an ability identical to a spell
    // (a monster's Banishment, Hold-type gaze, Bless-like buff) reuses that
    // spell's entry + resolver with zero duplication. "Banish is Banish."
    const raw = (type === "feat")
      ? (FEATURE_REGISTRY[name] ?? SPELL_REGISTRY[name])
      : SPELL_REGISTRY[name];
    if (!raw) return null;
    return SpellPipeline._applyEdition(raw);
  }

  /**
   * Convenience wrapper for external callers — returns true if pipeline
   * owns the spell (so callers can skip their own handling).
   */
  static ownsSpell(item) {
    return SpellPipeline._getEntry(item) !== null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EDITION HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  static _applyEdition(entry) {
    let editionKey = null;
    try {
      const rv = game.settings.get("dnd5e", "rulesVersion");
      if (rv === "legacy") editionKey = "legacy";
      else if (rv === "modern") editionKey = "modern";
    } catch (_) { /* fall through */ }

    if (!editionKey || !entry.byEdition?.[editionKey]) return entry;
    return { ...entry, ...entry.byEdition[editionKey] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISPATCH
  // ═══════════════════════════════════════════════════════════════════════════

  static async _dispatch(activity, message) {
    const item  = activity?.item;
    const actor = item?.actor;
    if (!item || !actor) return;

    const entry = SpellPipeline._getEntry(item);
    if (!entry) return;

    // Resolve cast level — defense-in-depth, mirrors spell-auto-damage's chain
    const messageSystemLevel = Number(message?.system?.spellLevel ?? NaN);
    const messageFlagLevel   = Number(message?.flags?.dnd5e?.use?.spellLevel ?? NaN);
    const cachedLevel        = SpellPipeline._castLevelCache.get(SpellPipeline._cacheKey(activity));
    const activityLevel      = Number(activity?.usage?.spellLevel ?? NaN);
    const baseLevel          = Number(item?.system?.level ?? 1);

    const castLevel = Number.isFinite(messageSystemLevel) ? messageSystemLevel
                    : Number.isFinite(messageFlagLevel)   ? messageFlagLevel
                    : Number.isFinite(cachedLevel)        ? cachedLevel
                    : Number.isFinite(activityLevel)      ? activityLevel
                    : baseLevel;

    const spellMod = actor?.system?.attributes?.spellmod
                  ?? actor?.system?.abilities?.[actor?.system?.attributes?.spellcasting ?? "int"]?.mod
                  ?? 0;

    const ctx = { entry, item, actor, activity, castLevel, spellMod, message };

    // ── v0.7.21: Counterspell barrier check at the PIPELINE level ──
    // The reaction-engine creates a barrier promise at preUseActivity and
    // resolves it after counterspell prompts complete. If the counterspell
    // succeeded, the spell must NOT proceed — no resolver runs, no effect
    // applies, slot is refunded.
    // Magic Missile (spell-auto-damage) had this check; the pipeline did not,
    // so Bless / Haste / Hold Person / etc. would fire even after a successful
    // counterspell. This gates ALL shapes uniformly.
    try {
      const { ReactionEngine } = await import("../reaction-engine.mjs");
      const reactionResult = await ReactionEngine.awaitCastBarrier(activity);
      if (reactionResult?.abort) {
        console.log(`${MODULE_ID} | SpellPipeline: ${item.name} aborted by ${reactionResult.reason ?? "reaction"} — slot refunded + concentration torn down`);
        await SpellPipeline._refundSlotIfDeferred(activity);
        // ── v0.7.21 — Tear down orphan concentration ──
        // dnd5e's activity-use flow auto-starts concentration BEFORE our
        // barrier knows the cast got counterspelled. End that concentration
        // now so the caster isn't stuck "concentrating on Haste" on a spell
        // that never actually happened. Universal — applies to every
        // concentration spell the pipeline owns.
        await SpellPipeline._endConcentrationForCancelledSpell(actor, item);
        SpellPipeline._castLevelCache.delete(SpellPipeline._cacheKey(activity));
        return;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | SpellPipeline: counterspell barrier check threw (non-blocking):`, err);
    }

    console.debug(`${MODULE_ID} | SpellPipeline: dispatching "${item.name}" shape=${entry.shape} L=${castLevel}`);

    try {
      switch (entry.shape) {
        case "self":
          await SelfResolver.run(ctx);
          await SpellPipeline._commitSlotIfDeferred(activity, castLevel);
          break;

        case "distribute":
          await SpellPipeline._runPickerAndResolve(ctx, "distribute");
          break;

        case "multi-buff":
        case "multi-heal":
          await SpellPipeline._runPickerAndResolve(ctx, "multi");
          break;

        case "save-single":
          await SpellPipeline._runPickerAndResolve(ctx, "single");
          break;

        case "touch":
          await SpellPipeline._runPickerAndResolve(ctx, "single-adjacent");
          break;

        case "template-save":
          await TemplateResolver.runSave(ctx);
          await SpellPipeline._commitSlotIfDeferred(activity, castLevel);
          break;

        case "template-trigger":
          await TemplateResolver.runTrigger(ctx);
          await SpellPipeline._commitSlotIfDeferred(activity, castLevel);
          break;

        case "aura":
          await TemplateResolver.runAura(ctx);
          await SpellPipeline._commitSlotIfDeferred(activity, castLevel);
          break;

        case "chained":
          await SpellPipeline._runPickerAndResolve(ctx, "single"); // primary; secondaries auto
          break;

        case "attack-single":
          // Fall through to dnd5e attack flow — no pipeline action needed
          await SpellPipeline._commitSlotIfDeferred(activity, castLevel);
          break;

        default:
          console.warn(`${MODULE_ID} | SpellPipeline: unknown shape "${entry.shape}" for ${item.name} — refunding slot`);
          await SpellPipeline._refundSlotIfDeferred(activity);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | SpellPipeline dispatch failed for ${item.name}:`, err);
      await SpellPipeline._refundSlotIfDeferred(activity);
    } finally {
      SpellPipeline._castLevelCache.delete(SpellPipeline._cacheKey(activity));
    }
  }

  static async _runPickerAndResolve(ctx, pickerType) {
    const result = await SpellPipeline._pickTargets(ctx, pickerType);

    if (!result) {
      // Cancelled — refund slot, end concentration (if dnd5e started it
      // during the activity flow), no card, return clean.
      await SpellPipeline._refundSlotIfDeferred(ctx.activity);
      await SpellPipeline._endConcentrationForCancelledSpell(ctx.actor, ctx.item);
      ui.notifications?.info(`${ctx.item.name}: cancelled — slot not consumed.`);
      console.debug(`${MODULE_ID} | SpellPipeline: ${ctx.item.name} picker cancelled, slot refunded, concentration cleared`);
      return;
    }

    // Commit slot now that we have confirmed targets
    await SpellPipeline._commitSlotIfDeferred(ctx.activity, ctx.castLevel);

    // Route to resolver by shape
    switch (ctx.entry.shape) {
      case "distribute":
        await DamageResolver.runDistribute(ctx, result);
        break;
      case "multi-buff":
        await BuffResolver.runMulti(ctx, result);
        break;
      case "multi-heal":
        await HealResolver.runMulti(ctx, result);
        break;
      case "save-single":
        await SaveResolver.runSingle(ctx, result);
        break;
      case "touch":
        // Heal or damage based on entry shape
        if (ctx.entry.heal) await HealResolver.runSingle(ctx, result);
        else await DamageResolver.runSingle(ctx, result);
        break;
      case "chained":
        await DamageResolver.runChained(ctx, result);
        break;
    }

    // Trigger AA on the resolved targets (after damage card so trajectory lands right)
    await AnimationHelper.play(ctx, result);

    // ── Clear targets 1.5s after damage card (mirrors v0.7.17 cleanup) ──
    // AA needs ~1s to finish its trajectory; we leave targets set during that
    // window so the animation aims correctly, then clear so the next cast
    // doesn't inherit them. Without this, cast 2 pre-fills with cast 1's
    // tokens. The pre-cast clear in preUseActivity is the belt; this is
    // the suspenders.
    setTimeout(() => {
      try { SpellPipeline._clearUserTargets(); }
      catch (_) { /* non-fatal */ }
    }, 1500);
  }

  /**
   * Target selection for the pipeline. DISTRIBUTE (Magic Missile's +/- counters)
   * still uses the unified picker — those counters only exist there. Every other
   * shape uses the purple SpellTargetPicker (the tile UI we standardized on); we
   * adapt its Actor[] return into the { target, targets } candidate shape the
   * resolvers + AnimationHelper already consume, so the working logic is untouched.
   */
  static async _pickTargets(ctx, pickerType) {
    if (pickerType === "distribute") {
      return UnifiedSpellPicker.pick({ ...ctx, pickerType });
    }

    const { entry, item, actor, castLevel } = ctx;
    const isSingle  = pickerType === "single" || pickerType === "single-adjacent";
    const N         = isSingle ? 1 : (entry.countResolver?.(castLevel, actor.system?.details?.level ?? 1) ?? 1);
    const rangeFt   = pickerType === "single-adjacent" ? 5 : (entry.range ?? undefined);
    const allowSelf = entry.picker?.allowSelf === true;

    let actors = [];
    try {
      const { SpellTargetPicker } = await import("../spell-target-picker.mjs");
      actors = await SpellTargetPicker.pick({
        spellItem:   item,
        casterActor: actor,
        maxTargets:  N,
        rangeFt,
        allowSelf,
      });
    } catch (err) {
      console.error(`${MODULE_ID} | SpellPipeline._pickTargets: purple picker failed:`, err);
      return null;
    }

    if (!actors || actors.length === 0) return null;   // cancelled / none picked

    // Adapt Actor[] → candidate objects ({ actor, token, ... }) the resolvers expect.
    const targets = actors.map(a => {
      const token = a.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === a.id)
        ?? null;
      return {
        actor: a, token,
        tokenId: token?.id ?? null,
        name: token?.name ?? a.name,
        img: token?.document?.texture?.src ?? a.img,
      };
    }).filter(t => t.token);

    if (!targets.length) return null;
    return { target: targets[0], targets };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * V13-correct per-Token target clearing. The old User#updateTokenTargets
   * API was removed; setTarget(false) per token + Set#clear() is the path.
   */
  static _clearUserTargets() {
    try {
      const targets = [...(game.user?.targets ?? [])];
      for (const t of targets) {
        t.setTarget?.(false, { user: game.user, releaseOthers: false, groupSelection: false });
      }
      game.user?.targets?.clear?.();
    } catch (err) {
      console.warn(`${MODULE_ID} | SpellPipeline._clearUserTargets threw:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SLOT MANAGEMENT — deferred consumption
  // ═══════════════════════════════════════════════════════════════════════════

  static async _commitSlotIfDeferred(activity, castLevel) {
    if (!activity?._aceSlotDeferred) return;
    activity._aceSlotDeferred = false; // clear marker first

    const actor = activity?.item?.actor;
    if (!actor) return;
    if (castLevel < 1) return; // cantrips don't consume slots

    try {
      // Try pact first (warlock); fall through to leveled slot
      const pact = actor.system?.spells?.pact;
      if (pact && pact.value > 0 && pact.level === castLevel) {
        await actor.update({ "system.spells.pact.value": pact.value - 1 });
        console.debug(`${MODULE_ID} | SpellPipeline: consumed pact slot (L${castLevel})`);
        return;
      }
      const slotKey = `spell${castLevel}`;
      const slot = actor.system?.spells?.[slotKey];
      if (slot && slot.value > 0) {
        await actor.update({ [`system.spells.${slotKey}.value`]: slot.value - 1 });
        console.debug(`${MODULE_ID} | SpellPipeline: consumed L${castLevel} slot (${slot.value} → ${slot.value - 1})`);
      } else {
        console.warn(`${MODULE_ID} | SpellPipeline: no L${castLevel} slot available to consume for ${actor.name}`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | SpellPipeline: slot consume threw:`, err);
    }
  }

  static async _refundSlotIfDeferred(activity) {
    // Nothing to refund — slot was deferred, never consumed. Just clear marker.
    if (activity?._aceSlotDeferred) activity._aceSlotDeferred = false;
  }

  /**
   * When the picker is cancelled, dnd5e may have already started concentration
   * on the caster during the activity-use flow. Clean it up so the caster
   * isn't stuck concentrating on a spell they never actually committed to.
   *
   * Multi-strategy match (aggressive — we want to catch everything):
   *   1. actor.concentration.effects with matching origin
   *   2. actor.effects scan for the "Concentrating" status with matching origin
   *   3. actor.effects scan by name matching the spell
   *   4. Cleanup flags.dnd5e.itemData pointing at this item
   */
  static async _endConcentrationForCancelledSpell(actor, item) {
    if (!actor || !item) return;
    try {
      const itemUuid = item.uuid;
      const itemId = item.id;
      const spellName = String(item.name ?? "").toLowerCase().trim();
      const toEnd = new Set();

      // Strategy 1: concentration registry
      const conc = actor.concentration;
      if (conc?.effects?.size) {
        for (const eff of conc.effects) {
          if (SpellPipeline._effectMatchesSpell(eff, itemUuid, itemId, spellName)) {
            toEnd.add(eff);
          }
        }
      }

      // Strategy 2: scan actor.effects for the "Concentrating" status effect itself
      for (const eff of actor.effects ?? []) {
        if (eff.statuses?.has?.("concentrating")) {
          if (SpellPipeline._effectMatchesSpell(eff, itemUuid, itemId, spellName)) {
            toEnd.add(eff);
          }
        }
      }

      // Strategy 3: scan actor.effects for any effect named after this spell
      // (catches the buff effect itself if it was applied early, before our cancel)
      for (const eff of actor.effects ?? []) {
        const effNameLower = String(eff.name ?? "").toLowerCase().trim();
        if (effNameLower === spellName && eff.statuses?.has?.("concentrating")) {
          toEnd.add(eff);
        }
      }

      for (const eff of toEnd) {
        try {
          await eff.delete();
          console.debug(`${MODULE_ID} | SpellPipeline: ended effect "${eff.name}" after cancel`);
        } catch (err) {
          console.warn(`${MODULE_ID} | concentration end failed for "${eff.name}":`, err);
        }
      }

      if (toEnd.size === 0) {
        console.debug(`${MODULE_ID} | SpellPipeline: no concentration effects found to end for cancelled ${item.name}`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | _endConcentrationForCancelledSpell threw (non-fatal):`, err);
    }
  }

  /**
   * Check if an ActiveEffect is tied to a given spell item via any of the
   * common identification paths (origin UUID, partial origin match,
   * dnd5e itemData flag, or by spell name).
   */
  static _effectMatchesSpell(eff, itemUuid, itemId, spellName) {
    try {
      const origin = String(eff.origin ?? "");
      if (origin === itemUuid) return true;
      if (origin.endsWith(`.${itemId}`)) return true;
      if (origin.includes(itemUuid)) return true;
      // dnd5e tags some concentration effects with flags.dnd5e.itemData
      const itemDataName = eff.flags?.dnd5e?.itemData?.name;
      if (itemDataName && String(itemDataName).toLowerCase().trim() === spellName) return true;
      // Concentration effect name often matches spell name (e.g. "Concentrating on Haste")
      const effNameLower = String(eff.name ?? "").toLowerCase();
      if (effNameLower.includes(spellName) && eff.statuses?.has?.("concentrating")) return true;
    } catch (_) { /* fall through */ }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find the caster's existing Concentrating effect tied to the given spell.
   * SINGLE SOURCE OF TRUTH — replaces the identical helpers that previously
   * lived in BuffResolver and SaveResolver. (Audit-mandated 2026-06-08.)
   *
   * dnd5e starts concentration during the activity-use flow (before our
   * resolvers run), so the effect should already exist by call time.
   * Three-strategy lookup with name-substring fallback for compendium items.
   *
   * @param {Actor}  caster
   * @param {Item}   spellItem
   * @returns {ActiveEffect|null}
   */
  static findCasterConcentrationFor(caster, spellItem) {
    try {
      if (!caster?.effects) return null;
      const itemUuid = spellItem?.uuid;
      const itemId = spellItem?.id;
      const spellNameLower = String(spellItem?.name ?? "").toLowerCase();

      // Strategy 1: caster.concentration.effects (registry)
      const conc = caster.concentration;
      if (conc?.effects?.size) {
        for (const eff of conc.effects) {
          const origin = String(eff.origin ?? "");
          if (itemUuid && (origin === itemUuid || origin.endsWith(`.${itemId}`))) return eff;
          const itemDataName = eff.flags?.dnd5e?.itemData?.name;
          if (itemDataName && String(itemDataName).toLowerCase() === spellNameLower) return eff;
        }
      }

      // Strategy 2: scan caster.effects for "concentrating" status with matching origin
      for (const eff of caster.effects) {
        if (!eff.statuses?.has?.("concentrating")) continue;
        const origin = String(eff.origin ?? "");
        if (itemUuid && (origin === itemUuid || origin.endsWith(`.${itemId}`))) return eff;
        const itemDataName = eff.flags?.dnd5e?.itemData?.name;
        if (itemDataName && String(itemDataName).toLowerCase() === spellNameLower) return eff;
        const effNameLower = String(eff.name ?? "").toLowerCase();
        if (spellNameLower && effNameLower.includes(spellNameLower)) return eff;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | SpellPipeline.findCasterConcentrationFor threw:`, err);
    }
    return null;
  }

  /**
   * Stable per-cast key for caches + dedup.
   * v0.7.21: include activity.uuid AND a per-activity timestamp stamped at
   * preUseActivity so simultaneous casts of the same item (macros, rapid
   * re-cast, autofire) don't collide on a shared (actorId, itemId) key.
   * (Audit-mandated 2026-06-08.)
   */
  static _cacheKey(activity) {
    const uuid = activity?.uuid ?? "";
    if (uuid) return uuid;
    // Fallback for activities that don't expose .uuid in some dnd5e versions
    const actorId = activity?.item?.actor?.id ?? "";
    const itemId  = activity?.item?.id ?? "";
    const stamp   = activity?._aceCastStamp ?? "";
    return `${actorId}|${itemId}|${stamp}`;
  }
}
