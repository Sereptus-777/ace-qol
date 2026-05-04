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

export class SpellAutoDamage {

  constructor() {
    this._registerHooks();
  }

  _registerHooks() {
    // Hook fires before any other dnd5e activity-use logic. Returning false
    // cancels the activity entirely, BUT we want dnd5e to consume the slot
    // and post the usage card — so we DON'T return false here. Instead we
    // run our pipeline async and suppress the system's auto-damage card via
    // the preCreateChatMessage hook below.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
      if (!SpellAutoDamage._isAutoHitDamageSpell(activity)) return;

      // Mark this activity invocation so the chat-message suppressor knows
      // to drop dnd5e's auto-damage card. Per-actor unique key prevents
      // collisions when multiple casters fire damage spells in parallel.
      const item = activity?.item;
      const actor = item?.actor;
      if (!actor) return;
      SpellAutoDamage._markActiveCast(actor.id, item?.id);

      // Run the pipeline async — never block the hook
      this._handleDamageSpell(activity, usageConfig)
        .catch(err => console.error(`${MODULE_ID} | SpellAutoDamage handler threw:`, err))
        .finally(() => {
          // Clear the marker on a short delay so any system follow-up cards
          // posted within the next ~3s also get suppressed (covers both the
          // damage roll message and any "result" follow-up).
          setTimeout(() => SpellAutoDamage._unmarkActiveCast(actor.id, item?.id), 3000);
        });
    });

    // Suppress dnd5e's auto-damage chat card while our pipeline runs.
    // We only delete messages flagged with our actor+item marker — never
    // touch unrelated messages.
    Hooks.on("preCreateChatMessage", (msg, data, options, userId) => {
      if (!data?.flags?.dnd5e?.activity) return;
      const flagActorId = data.flags.dnd5e.activity?.actor;
      const flagItemId  = data.flags.dnd5e.activity?.item;
      if (!flagActorId) return;
      if (!SpellAutoDamage._isCastActive(flagActorId, flagItemId)) return;

      // Only suppress damage-roll messages — keep usage cards (so the table
      // sees the spell was cast) and other types intact.
      const isDamageRoll = (data.rolls?.length ?? 0) > 0
        && (data.flags.dnd5e.roll?.type === "damage"
            || data.flags.dnd5e.activity?.type === "damage");
      if (!isDamageRoll) return;

      console.log(`${MODULE_ID} | SpellAutoDamage: suppressing vanilla damage card for ${flagItemId}`);
      return false; // cancel the message
    });

    console.log(`${MODULE_ID} | Spell auto-damage pipeline online`);
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
