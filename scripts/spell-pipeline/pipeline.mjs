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
import { CombatState } from "../combat-state.mjs";
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
import { Situation } from "../situation.mjs";

// ─── Creature snapshot access (2026-07-28) ───────────────────────────────────
// Facts about a creature come from the ONE reader, never from actor.system —
// the audit found every pipeline reaching into raw data and getting shapes
// wrong. Cached briefly; expired fast because state changes mid-fight.
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
  // key → timestamp. A Map, not a Set: presence alone can't tell a same-cast
  // double-fire from a legitimate re-cast, and the difference between those two
  // is the difference between a working ability and a mystery 30s cooldown.
  static _handledActivities = new Map();

  // Auto-evict handled-activity entries — bounded memory only. The real
  // decision is the per-key time window at the call site, so this just stops
  // the map growing over a long session.
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
        const pickerShapes = new Set(["distribute", "attack-multi", "multi-buff", "multi-heal", "save-single", "touch", "chained"]);
        if (pickerShapes.has(entry.shape)) {
          SpellPipeline._clearUserTargets();
          // OUR picker owns targeting for these shapes — suppress dnd5e's native
          // template placement so the player doesn't get a redundant "place the
          // template" prompt (and a leftover template they can't use) ALONGSIDE our
          // picker. dnd5e reads create.measuredTemplate at use-time (defaults it true
          // via ??= when the activity has a template), so setting it false here wins.
          // (2026-06-24 — Sleep / Faerie Fire etc.)
          if (usageConfig) {
            usageConfig.create ??= {};
            usageConfig.create.measuredTemplate = false;
          }
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
    // ── Attack-multi roll kill-switch ──
    // The volley rolls its own d20s. ANY foreign initiator (hotbar/HUD
    // auto-attack, chat-card button, macro) driving dnd5e's native attack
    // roll for an attack-multi spell would double-path the attack — cancel
    // it at the roll gate. The pipeline's picker + volley is the ONLY path.
    // (Live-fire 2026-07-10 10:13: EB's old dnd5e attack roll still fired.)
    Hooks.on("dnd5e.preRollAttackV2", (config) => {
      try {
        const item = config?.subject?.item;
        if (!item) return;
        if (SpellPipeline.ownsAttackRoll(item)) {
          console.log(`${MODULE_ID} | pipeline owns "${item.name}" (attack-multi) — native attack roll suppressed`);
          return false;
        }
      } catch (_) { /* never block foreign rolls on an error here */ }
    });

    Hooks.on("dnd5e.postCreateUsageMessage", (activity, message) => {
      try {
        const entry = SpellPipeline._getEntry(activity?.item);
        if (!entry) return;

        // Dedup — key by the CHAT MESSAGE id, NOT the activity UUID. Each cast
        // creates exactly ONE usage message; dnd5e firing this hook twice for
        // the SAME cast re-notifies the SAME message → same id → skipped. But
        // the activity UUID is STABLE across casts, so keying on it wrongly
        // blocked a legit SECOND cast for 30s (Johnny 2026-07-11: "Ghostly Howl
        // won't fire twice in a row — I have to wait ~30s"). Message id has no
        // such collision. Fall back to _cacheKey only when there's no message.
        // ── REGRESSION GUARD (2026-07-28) ──
        // The message-id key above assumed a usage message always exists. As of
        // 0.7.332 ACE stops dnd5e creating one, so `message` arrives as plain
        // config data with NO id — and this fell straight back to the activity
        // UUID, which is STABLE across casts. That silently re-armed the exact
        // 30-second block Johnny reported on 2026-07-11: Ghostly Howl refused to
        // fire twice in a row until the evict timer expired.
        //
        // So the WINDOW has to match how unique the key actually is. A real
        // message id belongs to exactly one cast, so holding it 30s is free.
        // The activity UUID belongs to every cast forever, so it may only guard
        // against dnd5e firing this hook twice for the SAME cast — a same-tick
        // event. Anything longer is a cooldown the game never asked for.
        const msgId    = message?.id ?? null;
        const dedupKey = msgId ?? SpellPipeline._cacheKey(activity);
        const windowMs = msgId ? 30000 : 400;

        const seenAt = SpellPipeline._handledActivities.get(dedupKey);
        if (seenAt != null && (Date.now() - seenAt) < windowMs) {
          console.debug(`${MODULE_ID} | SpellPipeline: duplicate postCreateUsageMessage for ${activity.item?.name} (key=${dedupKey}, within ${windowMs}ms) — skipped`);
          return;
        }
        SpellPipeline._handledActivities.set(dedupKey, Date.now());
        SpellPipeline._evictHandledActivity(dedupKey);  // housekeeping only

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
  /**
   * Does the pipeline own this item at all?
   *
   * ⚠️🔴 IF ACE IS GOING TO CAST IT, ACE MUST NOT ASK WHICH BUTTON TO
   * PRESS. Johnny's imported Magic Missile carries two activities that both
   * cost an action and both burn a slot, so dnd5e stopped and asked him to
   * choose between "Damage" and "Use" before anything could happen. Neither
   * answer means anything: the pipeline is going to throw 3 darts of 1d4+1
   * force, plus one more per upcast, whichever row he picks.
   *
   * Johnny, 2026-08-25: "How the fuck is that useful to me? It's got to be just
   * like a normal thing where I consume a spell slot: what level do you want to
   * cast it at? How many darts?"
   *
   * He is right. The activity is an implementation detail of the item; the
   * pipeline is the thing that decides what the spell does. So when the answer
   * is "ACE handles this spell", the question never gets asked.
   *
   * @param {Item5e} item
   * @returns {boolean}
   */
  static owns(item) {
    try { return !!SpellPipeline._getEntry(item); }
    catch (_) { return false; }
  }

  /**
   * Does THIS pipeline own the native attack roll for this item?
   *
   * ⚠️🔴 TWO PLACES ASKED THIS AND ONLY ONE KNEW THE ANSWER. The spell
   * pipeline cancels dnd5e's own attack roll for multi-beam spells because it
   * has already rolled every beam itself. The ATTACK pipeline did not know
   * that, so when the cancelled roll reached it with no target left selected,
   * it helpfully opened its own "who are you hitting?" picker — for a roll that
   * was about to be thrown away.
   *
   * Johnny cast Eldritch Blast on 2026-08-25 and got the target picker twice:
   * once from the spell pipeline, which worked, and then a second one that did
   * nothing at all when he pressed it, because the roll behind it had already
   * been cancelled. "I push it and it does nothing."
   *
   * ⚠️ SO THE TEST LIVES IN ONE PLACE AND BOTH SIDES CALL IT. A second copy
   * of "is this attack-multi" in the attack pipeline would answer correctly
   * today and wrongly the first time a shape is added here.
   *
   * @param {Item5e} item
   * @returns {boolean}
   */
  static ownsAttackRoll(item) {
    try { return SpellPipeline._getEntry(item)?.shape === "attack-multi"; }
    catch (_) { return false; }
  }

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
    // Honors the ACE QOL gameRulesEdition master override (was a raw dnd5e read).
    const editionKey = CombatState.getActiveRulesVersion();
    if (!entry.byEdition?.[editionKey]) return entry;
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

    const spellMod = _aceCreature(actor)?.spellMod
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
        // dnd5e can PERSIST the Concentrating effect a tick AFTER our barrier
        // resolves, so an immediate teardown finds nothing and it lingers on a
        // counterspelled cast. Retry shortly to catch the late-created one.
        setTimeout(() => {
          SpellPipeline._endConcentrationForCancelledSpell(actor, item).catch(() => {});
        }, 400);
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
          // ⚠️ SWEEP THE CLASS, NOT THE INSTANCE. Every branch that could ever
          // involve a template now goes through the same helper, which asks the
          // activity whether it declares one and commits immediately when it
          // does not. That way a spell added to the registry later cannot
          // quietly land in a branch that burns the slot on cancel — which is
          // how "aura" ended up as the one shape left behind.
          await SpellPipeline._commitSlotOnTemplatePlaced(activity, castLevel);
          break;

        case "distribute":
          await SpellPipeline._runPickerAndResolve(ctx, "distribute");
          break;

        case "attack-multi":
          // The PURPLE picker (Johnny's standard — stated three times, heard).
          // Pick up to N targets; the resolver round-robins the beams across
          // them in pick order and rolls a spell attack per beam.
          await SpellPipeline._runPickerAndResolve(ctx, "multi");
          break;

        case "multi-buff":
        case "multi-heal":
          await SpellPipeline._runPickerAndResolve(ctx, "multi");
          break;

        case "save-single":
          await SpellPipeline._runPickerAndResolve(ctx, "single");
          break;

        case "save-area":
          // Emanation save — no picker; everyone in range saves. (Frightful
          // Presence, aura-of-fear, gaze pulses.)
          await SaveResolver.runArea(ctx);
          await SpellPipeline._commitSlotOnTemplatePlaced(activity, castLevel);
          break;

        case "touch":
          await SpellPipeline._runPickerAndResolve(ctx, "single-adjacent");
          break;

        case "template-save":
          await TemplateResolver.runSave(ctx);
          // Slot rides on the template actually landing — see the helper.
          await SpellPipeline._commitSlotOnTemplatePlaced(activity, castLevel);
          break;

        case "template-trigger":
          await TemplateResolver.runTrigger(ctx);
          // Slot rides on the template actually landing — see the helper.
          await SpellPipeline._commitSlotOnTemplatePlaced(activity, castLevel);
          break;

        case "aura":
          await TemplateResolver.runAura(ctx);
          // ⚠️ THE THIRD TEMPLATE SHAPE, LEFT BEHIND (Brock audit, 2026-08-19).
          // template-save and template-trigger were given "cancel = no slot
          // lost" and this one was not, so cancelling Spirit Guardians burned
          // a 3rd-level slot — the exact bug the other two were fixed for, one
          // case-block further down. Fixing two of three is how a fix becomes
          // a bug report.
          //
          // Safe for the non-template auras too: the helper checks whether the
          // activity actually declares a template and commits immediately when
          // it does not, so Aura of Vitality and Holy Weapon are unaffected.
          await SpellPipeline._commitSlotOnTemplatePlaced(activity, castLevel);
          break;

        case "chained":
          await SpellPipeline._runPickerAndResolve(ctx, "single"); // primary; secondaries auto
          break;

        case "attack-single":
          // Fall through to dnd5e attack flow — no pipeline action needed
          await SpellPipeline._commitSlotOnTemplatePlaced(activity, castLevel);
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
      case "attack-multi":
        await DamageResolver.runAttackMulti(ctx, result);
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
    // PUNCH-LIST #11 (Johnny): single-creature spells KEEP the target for
    // the next action; only multi-creature resolutions clear.
    const resolvedTargetCount = result?.distribution instanceof Map
      ? result.distribution.size
      : (result?.targets?.length ?? 0);
    if (resolvedTargetCount > 1) {
      setTimeout(() => {
        try { SpellPipeline._clearUserTargets(); }
        catch (_) { /* non-fatal */ }
      }, 1500);
    }
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
    const charLevel = _aceCreature(actor)?.level
      ?? 1;
    const N         = isSingle ? 1 : (entry.countResolver?.(castLevel, charLevel) ?? 1);
    // v0.7.74 AUDIT FIX — was hardcoding rangeFt to 5 for single-adjacent
    // pickers regardless of entry.range. That silently capped Healing Word
    // (range 60), Heal (range 60), Mass Cure Wounds (range 60), and any
    // other touch-shape ranged spell to adjacent targets only. Honor the
    // entry's actual range with a 5-ft floor when the entry doesn't supply
    // one (true touch spells like Cure Wounds, Greater Restoration).
    const rangeFt   = pickerType === "single-adjacent" ? (entry.range ?? 5) : (entry.range ?? undefined);
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

    // ── "Must hear you" gate (RAW) — a deafened target can't receive
    // Suggestion-class spells. All targets deaf → null, which refunds the
    // deferred slot upstream (same semantics as a cancelled picker).
    try {
      const { HearingGate } = await import("../rules/hearing-gate.mjs");
      const gate = HearingGate.filterDeafTargets(item, targets.map(t => t.token).filter(Boolean));
      if (gate.blocked.length) {
        await HearingGate.postBlockedCard(item, actor, gate.blocked, gate.entry);
        const blockedIds = new Set(gate.blocked.map(b => b.token?.id));
        const remaining = targets.filter(t => !blockedIds.has(t.tokenId));
        console.log(`${MODULE_ID} | hearing gate: ${gate.blocked.length} deafened target(s) removed from "${item.name}"`);
        if (!remaining.length) {
          ui.notifications?.info(`${item.name}: no valid targets — the deafened can't hear you. Slot not consumed.`);
          return null;
        }
        return { target: remaining[0], targets: remaining };
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | hearing gate failed (non-blocking):`, err);
    }

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


  /**
   * Commit the slot only if a template actually reaches the canvas.
   *
   * ⚠️ THE WHOLE POINT OF PUTTING FIREBALL IN THE PIPELINE WAS "cancel = no
   * slot lost" — and it never worked. The template resolvers are deliberate
   * no-ops (see resolvers/template.mjs), so `runSave()` returns instantly and
   * the very next line committed the slot. dnd5e then showed the placement
   * preview; the caster right-clicked to cancel; the slot was already gone.
   * Fireball, Lightning Bolt, Web and Spirit Guardians were registered
   * specifically TO GET this behaviour and were the only shapes that did not.
   * (Grok audit 2026-08-18.)
   *
   * A template arriving is the only honest proof the cast happened, so we wait
   * for `createMeasuredTemplate` carrying this activity's origin.
   *
   * ⚠️ THE TIMEOUT *IS* THE CANCEL SIGNAL. There is no "user cancelled" hook —
   * dnd5e simply never creates the template. My first version treated the
   * timeout as "could not tell" and committed anyway, which meant cancel still
   * burned the slot, just 30 seconds later. That is the same bug wearing a
   * hat.
   *
   * So: if this activity DECLARES a template and none arrives, the cast was
   * abandoned and the slot is kept. If it declares no template, there is
   * nothing to wait for and we commit immediately — that is the only case
   * where waiting would wrongly hand back a slot.
   */
  static async _commitSlotOnTemplatePlaced(activity, castLevel, { timeoutMs = 30000 } = {}) {
    if (!activity?._aceSlotDeferred) return;
    const wanted = activity.uuid;
    if (!wanted) { await SpellPipeline._commitSlotIfDeferred(activity, castLevel); return; }

    // Does this activity actually place a template? If not, there is nothing
    // to wait for and holding the slot open would be wrong.
    const declaresTemplate = !!(activity.target?.template?.type
                             ?? activity.item?.system?.target?.template?.type);
    if (!declaresTemplate) {
      await SpellPipeline._commitSlotIfDeferred(activity, castLevel);
      return;
    }

    const placed = await new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        Hooks.off("createMeasuredTemplate", onCreate);
        clearTimeout(timer);
        resolve(val);
      };
      const onCreate = (doc) => {
        try {
          const origin = doc?.flags?.dnd5e?.origin ?? doc?.getFlag?.("dnd5e", "origin");
          if (origin && String(origin) === String(wanted)) finish(true);
        } catch (_) { /* keep waiting */ }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);  // no template = abandoned
      Hooks.on("createMeasuredTemplate", onCreate);
    });

    if (!placed) {
      console.log(`${MODULE_ID} | SpellPipeline: no template placed for "${activity?.item?.name}" ` +
        `within ${timeoutMs}ms — treating as CANCELLED, slot kept.`);
      await SpellPipeline._refundSlotIfDeferred(activity);
      return;
    }
    await SpellPipeline._commitSlotIfDeferred(activity, castLevel);
  }

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
        console.debug(`${MODULE_ID} | SpellPipeline: no L${castLevel} slot to consume for ${actor.name} (innate/at-will or slotless caster — expected).`);
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

      // Strategy 2: scan actor.effects for the "Concentrating"/"Concentration" status effect
      for (const eff of actor.effects ?? []) {
        if (eff.statuses?.has?.("concentration") || eff.statuses?.has?.("concentrating")) {
          if (SpellPipeline._effectMatchesSpell(eff, itemUuid, itemId, spellName)) {
            toEnd.add(eff);
          }
        }
      }

      // Strategy 3: scan actor.effects for any effect named after this spell
      for (const eff of actor.effects ?? []) {
        const effNameLower = String(eff.name ?? "").toLowerCase().trim();
        if (effNameLower === spellName
            && (eff.statuses?.has?.("concentration") || eff.statuses?.has?.("concentrating"))) {
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
      if (effNameLower.includes(spellName)
          && (eff.statuses?.has?.("concentration") || eff.statuses?.has?.("concentrating"))) return true;
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
          // dnd5e 5.x: a concentration effect's origin is the ACTIVITY uuid
          // ("…Item.<id>.Activity.<id>"), so it equals neither the item uuid nor
          // ends with the item id. Match by item-uuid PREFIX too, or the link
          // never resolves and the buff never auto-cleans when concentration ends.
          if (itemUuid && (origin === itemUuid || origin.startsWith(`${itemUuid}.`) || origin.endsWith(`.${itemId}`))) return eff;
          const itemDataName = eff.flags?.dnd5e?.itemData?.name;
          if (itemDataName && String(itemDataName).toLowerCase() === spellNameLower) return eff;
        }
      }

      // Strategy 2: scan caster.effects for concentration status with matching origin
      for (const eff of caster.effects) {
        if (!eff.statuses?.has?.("concentration") && !eff.statuses?.has?.("concentrating")) continue;
        const origin = String(eff.origin ?? "");
        // Match by item-uuid PREFIX too (dnd5e 5.x activity-uuid origins).
        if (itemUuid && (origin === itemUuid || origin.startsWith(`${itemUuid}.`) || origin.endsWith(`.${itemId}`))) return eff;
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
