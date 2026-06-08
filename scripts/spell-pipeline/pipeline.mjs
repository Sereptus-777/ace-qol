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
  static _castLevelCache = new Map(); // key: `${actorId}|${itemId}` → number

  // Dedup tracker — postCreateUsageMessage can fire multiple times for one cast
  static _handledActivities = new WeakSet();

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  static initialize() {
    // ── Pre-cast: registry check + slot deferral + stale-target clear ──
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      try {
        const entry = SpellPipeline._getEntry(activity?.item);
        if (!entry) return; // not ours — fall through to dnd5e

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

        // Dedup — only run once per Activity reference
        if (SpellPipeline._handledActivities.has(activity)) {
          console.debug(`${MODULE_ID} | SpellPipeline: duplicate postCreateUsageMessage for ${activity.item?.name} — skipped`);
          return;
        }
        SpellPipeline._handledActivities.add(activity);

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
    if (!item || item.type !== "spell") return null;
    const name = String(item.name ?? "").trim().toLowerCase();
    if (!name) return null;
    const raw = SPELL_REGISTRY[name];
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
    const result = await UnifiedSpellPicker.pick({ ...ctx, pickerType });

    if (!result) {
      // Cancelled — refund slot, no card, return clean
      await SpellPipeline._refundSlotIfDeferred(ctx.activity);
      ui.notifications?.info(`${ctx.item.name}: cancelled — slot not consumed.`);
      console.debug(`${MODULE_ID} | SpellPipeline: ${ctx.item.name} picker cancelled, slot refunded`);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  static _cacheKey(activity) {
    return `${activity?.item?.actor?.id ?? ""}|${activity?.item?.id ?? ""}`;
  }
}
