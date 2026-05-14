// ─── ACE: QOL — Spell Auto-Damage Pipeline ───────────────────────────────────
// Handles damage-type spell activities that have NO attack roll AND NO save.
// Magic Missile, Witch Bolt initial hit, Inflict Wounds (some implementations),
// and any custom AI-generated "auto-hit" damage spell falls into this category.
//
// Without this handler, the vanilla dnd5e flow rolls damage natively but
// completely bypasses our resistance / immunity / vulnerability checks. A
// flesh golem that's immune to force damage would still take full damage
// from Magic Missile. The Shield reaction would never fire on the target.
//
// Pipeline:
//   1. Hook dnd5e.preUseActivity, filter to spell items with activity
//      type === "damage" (not "attack", not "save", not "heal").
//   2. Read user-targeted tokens (game.user.targets).
//   3. Cancel the vanilla flow (return false) so dnd5e doesn't post its own
//      damage card without our resistance gates.
//   4. Roll the activity's damage formula ONCE per target — each gets their
//      own DSN animation, own resistance/immunity application, own card row.
//   5. Build a synthetic hits[] (no attack roll, hitResult: "hit") and route
//      through the existing DamageCardRenderer pipeline so the damage card,
//      apply/undo buttons, override widgets, and post-hit save processing
//      all work identically to a weapon-attack damage card.
//
// Limitations:
//   - Magic Missile's "distribute darts among multiple targets" UI is NOT
//     replicated. Each user-targeted token takes the FULL spell damage.
//     If the player wants per-dart distribution, they target one creature
//     at a time and re-cast (slot consumption is handled by dnd5e since we
//     don't cancel that path).
//   - Spells that have BOTH damage and a save (Phantasmal Killer style)
//     still go through save-engine, not this path. We filter that out.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageCardRenderer } from "./damage-card-renderer.mjs";
import { getSpellTiming, TIMING } from "./spell-timing.mjs";

export class SpellAutoDamage {

  constructor() {
    // Dedup tracker — identity-based WeakSet on Activity references.
    // `dnd5e.postCreateUsageMessage` can fire more than once for the same
    // cast in setups where another module re-posts the usage message
    // (Auto-Animations, custom macros, etc.). Without dedup, our handler
    // posts the damage card twice — same Activity, same target list,
    // double damage on apply. WeakSet by Activity ref catches the second
    // fire; refs go out of scope when the activity is GC'd, so no leak.
    this._handledActivities = new WeakSet();
    this._registerHooks();
  }

  _registerHooks() {
    // ── KILL SWITCH: setting `spellAutoDamageEnabled` (default true) ──
    // When OFF, our pipeline doesn't intercept anything. dnd5e handles
    // auto-hit damage spells natively. Use this if our suppression
    // misbehaves and you need a clean fallback at the table.
    if (QolSettings.get?.("spellAutoDamageEnabled") === false) {
      console.log(`${MODULE_ID} | SpellAutoDamage DISABLED via setting — dnd5e handles auto-damage spells natively`);
      return;
    }

    // ── Mark cast active EARLY (preUseActivity) so the rollDamage
    //    prototype patch knows to suppress the dialog + chat card.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      if (!SpellAutoDamage._isAutoHitDamageSpell(activity)) return;
      const actor = activity?.item?.actor;
      const itemId = activity?.item?.id;
      if (!actor) return;
      SpellAutoDamage._markActiveCast(actor.id, itemId);
      // Auto-clear after 5s — covers slot dialog wait + cast finalize.
      setTimeout(() => SpellAutoDamage._unmarkActiveCast(actor.id, itemId), 5000);
    });

    // ── Post our damage card AFTER cast is confirmed ──
    // dnd5e has consumed the slot, posted the usage card, fired its
    // cast-time hooks (AA's animation triggers from those). Now we
    // post our damage card.
    Hooks.on("dnd5e.postCreateUsageMessage", (activity /*, message */) => {
      if (!SpellAutoDamage._isAutoHitDamageSpell(activity)) return;
      const actor = activity?.item?.actor;
      if (!actor) return;
      // Dedup: same Activity ref → already handled this fire of the hook
      if (activity && this._handledActivities.has(activity)) {
        console.log(`${MODULE_ID} | SpellAutoDamage: duplicate postCreateUsageMessage for ${activity.item?.name} — skipped`);
        return;
      }
      if (activity) this._handledActivities.add(activity);
      this._handleDamageSpell(activity, null)
        .catch(err => console.error(`${MODULE_ID} | SpellAutoDamage handler threw:`, err));
    });

    // ── Suppress dnd5e's damage flow via prototype patch ──
    // dnd5e 5.3.1 has NO preRollDamage hook (only post-roll
    // rollDamage / rollDamageV2). The damage dialog is opened inside
    // activity.rollDamage(). To stop both the dialog AND the
    // resulting chat card, we wrap rollDamage on the damage-activity
    // prototype: if our marker is active, return [] (empty rolls,
    // no dialog, no chat). Otherwise call the original.
    SpellAutoDamage._patchActivityRollDamage();

    // Belt-and-suspenders: chat-message suppressor for any path that
    // bypasses our prototype patch (custom activity subclasses, etc.)
    Hooks.on("preCreateChatMessage", (msg, data) => {
      if (!data?.flags?.dnd5e?.activity) return;
      const flagActorId = data.flags.dnd5e.activity?.actor;
      const flagItemId  = data.flags.dnd5e.activity?.item;
      if (!flagActorId) return;
      if (!SpellAutoDamage._isCastActive(flagActorId, flagItemId)) return;

      const isDamageRoll = (data.rolls?.length ?? 0) > 0
        && (data.flags.dnd5e.roll?.type === "damage"
            || data.flags.dnd5e.activity?.type === "damage");
      if (!isDamageRoll) return;
      return false;
    });

    console.log(`${MODULE_ID} | Spell auto-damage pipeline online (prototype patch active)`);
  }

  /**
   * Monkey-patch CONFIG.DND5E.activityTypes.damage.documentClass.prototype.rollDamage
   * so we can intercept damage activity rolls without canceling the cast.
   *
   * Called once during init. Idempotent — checks for prior patch via flag.
   * Wrap in try/catch — if dnd5e changes the prototype shape, fail-open
   * (vanilla flow continues, our card just shows "Roll Damage" without
   * suppression and the user gets the double-prompt they're trying to
   * avoid; minor regression, no crash).
   */
  static _patchActivityRollDamage() {
    try {
      const damageActivityClass = CONFIG.DND5E?.activityTypes?.damage?.documentClass;
      if (!damageActivityClass?.prototype) return;
      if (damageActivityClass.prototype._aceQolRollDamagePatched) return;

      const original = damageActivityClass.prototype.rollDamage;
      damageActivityClass.prototype.rollDamage = async function (...args) {
        try {
          // NO_SAVE_AUTO spells (Spike Growth, Wall of Thorns, Cloud of
          // Daggers) — the damage activity should NEVER be rolled here.
          // The concentration widget applies per-tick damage on token
          // movement. Suppress unconditionally so the dialog never appears
          // even if the GM clicks the spell card's DAMAGE button by habit.
          try {
            const item = this?.item;
            if (item) {
              const timing = getSpellTiming(item);
              if (timing?.timing === TIMING.NO_SAVE_AUTO) {
                console.log(`${MODULE_ID} | rollDamage suppressed for ${item.name} (NO_SAVE_AUTO — handled by concentration widget movement-damage)`);
                return [];
              }
            }
          } catch (_) { /* fall through to active-cast check */ }

          const actorId = this?.actor?.id ?? this?.item?.actor?.id;
          const itemId  = this?.item?.id;
          if (actorId && SpellAutoDamage._isCastActive(actorId, itemId)) {
            console.log(`${MODULE_ID} | rollDamage suppressed for ${this?.item?.name} (ace-qol owns this cast)`);
            return []; // skip dialog + chat creation
          }
        } catch (_) { /* fall through to original */ }
        return original.apply(this, args);
      };
      damageActivityClass.prototype._aceQolRollDamagePatched = true;
      console.log(`${MODULE_ID} | activity.rollDamage prototype patch applied`);
    } catch (err) {
      console.warn(`${MODULE_ID} | activity.rollDamage patch failed (non-fatal — vanilla flow will run):`, err);
    }
  }

  /**
   * Detect whether this activity is an AUTO-HIT, NO-SAVE damage spell.
   * Returns true ONLY when:
   *   - The parent item is a spell (item.type === "spell")
   *   - The activity type is "damage" (not "attack", "save", "heal", "summon")
   *   - The activity has no attack roll definition
   *   - The activity has no save definition
   */
  static _isAutoHitDamageSpell(activity) {
    try {
      if (!activity) return false;
      const item = activity.item;
      if (!item || item.type !== "spell") return false;

      const type = activity.type ?? activity.constructor?.metadata?.type ?? "";
      if (type !== "damage") return false;

      // Defensive — if the activity has an attack or save block, it's not auto-hit
      if (activity.attack?.ability) return false;
      if (activity.save?.ability) return false;

      // Must have actual damage parts
      const parts = activity.damage?.parts ?? [];
      if (!parts.length) return false;

      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | _isAutoHitDamageSpell check failed:`, err);
      return false;
    }
  }

  // ── Active-cast tracker (used to suppress vanilla damage cards) ──
  // Static map so any chat-message hook fired anywhere in the system can
  // check "is this damage card from a spell I'm currently handling?".
  static _activeCasts = new Map();
  static _key(actorId, itemId) { return `${actorId ?? ""}|${itemId ?? ""}`; }
  static _markActiveCast(actorId, itemId) { SpellAutoDamage._activeCasts.set(SpellAutoDamage._key(actorId, itemId), Date.now()); }
  static _unmarkActiveCast(actorId, itemId) { SpellAutoDamage._activeCasts.delete(SpellAutoDamage._key(actorId, itemId)); }
  static _isCastActive(actorId, itemId) {
    const ts = SpellAutoDamage._activeCasts.get(SpellAutoDamage._key(actorId, itemId));
    if (!ts) return false;
    // Stale-entry sweep
    if (Date.now() - ts > 10000) {
      SpellAutoDamage._activeCasts.delete(SpellAutoDamage._key(actorId, itemId));
      return false;
    }
    return true;
  }

  /**
   * Run the spell damage pipeline:
   *   1. Collect targets (user.targets, fall back to single-target dialog).
   *   2. Build synthetic hits[] (no attack roll, hitResult: "hit").
   *   3. Route through DamageCardRenderer.postDamageButton so all the
   *      existing damage card UX (apply/undo, override, per-type clicks,
   *      post-hit saves, riders) works.
   */
  async _handleDamageSpell(activity, usageConfig) {
    const item  = activity.item;
    const actor = item?.actor;
    if (!actor) return;

    // Movement-damage spells (Spike Growth, Wall of Thorns, Cloud of Daggers)
    // have a damage activity that dnd5e wants to roll, but the damage is
    // actually applied per-token-movement by concentration-widget. We must
    // NOT defer to vanilla here — that would show the dnd5e damage roll
    // dialog (the "2d4 piercing" popup) which the user has to dismiss
    // every cast. Keep the active-cast mark in place so the rollDamage
    // prototype patch silently suppresses the dialog + chat card.
    try {
      const timing = getSpellTiming(item);
      if (timing?.timing === TIMING.NO_SAVE_AUTO) {
        console.log(`${MODULE_ID} | SpellAutoDamage: ${item.name} is movement-damage (NO_SAVE_AUTO) — suppressing dnd5e damage flow (concentration-widget owns per-tick application)`);
        return; // leave mark active; rollDamage prototype patch returns [] silently
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | SpellAutoDamage: movement-damage check failed`, err);
    }

    const targets = [...(game.user.targets ?? [])];
    if (!targets.length) {
      // No targets — let vanilla flow proceed (dnd5e may prompt the user to
      // pick a target). We unmark so the suppressor doesn't block the
      // resulting damage card.
      SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
      console.log(`${MODULE_ID} | SpellAutoDamage: ${item.name} cast with no targets — deferring to vanilla flow`);
      return;
    }

    // Build synthetic hits — every targeted token takes the full damage
    // (auto-hit, no roll). Each gets per-target resistance/immunity applied.
    const hits = targets.map(token => {
      const tActor = token.actor;
      return {
        target:        { name: token.name, img: token.actor?.img ?? token.document?.texture?.src, currentHP: tActor?.system?.attributes?.hp?.value ?? 0, maxHP: tActor?.system?.attributes?.hp?.max ?? 0 },
        targetActor:   tActor,
        targetToken:   token,
        hitResult:     "hit",
        d20Result:     null,                // auto-hit — no attack roll
        isCritRoll:    false,
        damageModifiers: tActor ? DamageCalculator.getTargetDamageModifiers(tActor, item) : {},
        // Standard token info for the renderer
        name:          token.name,
        img:           token.actor?.img ?? token.document?.texture?.src,
        ac:            tActor?.system?.attributes?.ac?.value ?? 0,
      };
    });

    console.log(`${MODULE_ID} | SpellAutoDamage: routing ${item.name} → ${hits.length} target(s)`);

    // Route through the existing damage card pipeline — gives us the
    // ROLL DAMAGE button + per-target apply/undo/override widgets for free.
    try {
      await DamageCardRenderer.postDamageButton(item, actor, hits);
    } catch (err) {
      console.error(`${MODULE_ID} | SpellAutoDamage postDamageButton failed:`, err);
      // On crash, unmark so the user isn't stuck without a damage card
      SpellAutoDamage._unmarkActiveCast(actor.id, item?.id);
    }
  }
}
