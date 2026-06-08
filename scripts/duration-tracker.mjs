// ─── ACE: QOL — Effect Duration Tracker ─────────────────────────────────────
// Replaces the "Times Up" module. Automatically tracks and expires Active
// Effects based on combat round/turn progression, real-time seconds, or
// special duration triggers (turn start, turn end, short/long rest, etc.).
//
// GM-only processing — only the GM evaluates expirations and deletes effects.
// Notifications are posted to chat (whispered to GM by default).
//
// Hooks used:
//   updateCombat        — round/turn advancement → check all combatant effects
//   createActiveEffect  — stamp start round/turn onto newly created effects
//   deleteCombat        — expire "until combat ends" effects
//   restCompleted       — expire short/long rest effects (dnd5e hook)
//
// Settings:
//   enableDurationTracker    — master toggle (default true)
//   expireEffectsOnTurnChange — auto-expire on turn/round change (default true)
//   notifyOnExpiry           — post chat notification on expiry (default true)
//   expiryNotifyAll          — show to all players or GM-only (default false)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

// ─── Special duration types ─────────────────────────────────────────────────
// Stored in flags.ace-qol.specialDuration on each ActiveEffect.
// The tracker checks these at appropriate moments.
const SPECIAL_DURATIONS = {
  turnStart:        "Start of affected creature's next turn",
  turnEnd:          "End of affected creature's next turn",
  turnStartSource:  "Start of the effect source's next turn",
  turnEndSource:    "End of the effect source's next turn",
  shortRest:        "Until short rest",
  longRest:         "Until long rest",
  newDay:           "Until next dawn",
  combat:           "Until combat ends",
  isAttacked:       "Until the creature is attacked",
  isDamaged:        "Until the creature takes damage",
  isSave:           "Until the creature makes a saving throw",
};

// ═══════════════════════════════════════════════════════════════════════════════
//  DurationTracker — main class
// ═══════════════════════════════════════════════════════════════════════════════

export class DurationTracker {

  constructor() {
    /** @type {boolean} Whether hooks have been registered */
    this._hooked = false;
  }

  // ─── Initialization ─────────────────────────────────────────────────────

  /**
   * Register all hooks. Called once from ace-qol.mjs ready hook.
   */
  init() {
    if (this._hooked) return;
    this._hooked = true;

    // ── Combat progression: check for expired effects ──
    Hooks.on("updateCombat", this._onCombatUpdate.bind(this));

    // ── New effects: stamp combat start time ──
    Hooks.on("createActiveEffect", this._onEffectCreated.bind(this));

    // ── Combat ends: expire "until combat ends" effects ──
    Hooks.on("deleteCombat", this._onCombatDeleted.bind(this));

    // ── Rest completed: expire short/long rest effects ──
    // dnd5e fires this hook after a rest is completed
    Hooks.on("dnd5e.restCompleted", this._onRestCompleted.bind(this));

    // ── Damage taken: expire "isDamaged" effects ──
    Hooks.on(`${MODULE_ID}.damageApplied`, this._onDamageApplied.bind(this));

    // ── Attack received: expire "isAttacked" effects ──
    Hooks.on(`${MODULE_ID}.attackComplete`, this._onAttackComplete.bind(this));

    // ── Save attempted: expire "isSave" effects ──
    Hooks.on(`${MODULE_ID}.saveComplete`, this._onSaveComplete.bind(this));

    // ── World time advancement: expire seconds-based effects outside combat ──
    Hooks.on("updateWorldTime", this._onWorldTimeUpdate.bind(this));

    console.debug(`${MODULE_ID} | Duration Tracker initialized`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Combat Update — main expiration check
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called whenever combat updates (turn/round advances).
   * Only the GM processes expirations to avoid duplicate deletes.
   */
  async _onCombatUpdate(combat, change, options, userId) {
    // Only GM processes expirations
    if (!game.user.isGM) return;

    // Check master toggle
    if (!DurationTracker._isEnabled()) return;
    if (!DurationTracker._getSetting("expireEffectsOnTurnChange")) return;

    // Only process when round or turn actually changes
    const roundChanged = "round" in change;
    const turnChanged = "turn" in change;
    if (!roundChanged && !turnChanged) return;

    const currentRound = combat.round;
    const currentTurn = combat.turn;
    const currentCombatant = combat.combatant;
    const previousCombatant = combat.turns[change.turn !== undefined ? (change.turn > 0 ? change.turn - 1 : combat.turns.length - 1) : combat.turn] ?? null;

    this._debug(`Combat update: round=${currentRound} turn=${currentTurn} combatant=${currentCombatant?.name ?? "none"}`);

    // Check ALL combatants for expired effects (not just the current one)
    // This covers round-based durations on any actor
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor) continue;

      await this._checkActorEffects(actor, combat, {
        currentRound,
        currentTurn,
        currentCombatant,
        previousCombatant,
        combatant,
        roundChanged,
        turnChanged,
      });
    }
  }

  /**
   * Check all effects on a single actor for expiration.
   * @private
   */
  async _checkActorEffects(actor, combat, ctx) {
    const toExpire = [];

    for (const effect of actor.effects) {
      if (effect.disabled) continue;

      const reason = this._shouldExpire(effect, combat, actor, ctx);
      if (reason) {
        toExpire.push({ effect, reason });
      }
    }

    // Expire them
    for (const { effect, reason } of toExpire) {
      await this._expireEffect(actor, effect, reason);
    }
  }

  /**
   * Determine if an effect should expire right now.
   * Returns a reason string if yes, null if no.
   * @private
   */
  _shouldExpire(effect, combat, actor, ctx) {
    const duration = effect.duration;
    const flags = effect.flags?.[MODULE_ID] ?? {};
    const specialDuration = flags.specialDuration;

    // ── Special duration: turn start of affected creature ──
    if (specialDuration === "turnStart") {
      const actorCombatant = combat.combatants.find(c => c.actorId === actor.id);
      if (actorCombatant && ctx.currentCombatant?.id === actorCombatant.id) {
        // It's this actor's turn starting — check if at least 1 full round has passed
        const startRound = duration.startRound ?? 0;
        const startTurn = duration.startTurn ?? 0;
        if (ctx.currentRound > startRound || (ctx.currentRound === startRound && ctx.currentTurn > startTurn)) {
          return `${effect.name}: turn start expiry`;
        }
      }
    }

    // ── Special duration: turn end of affected creature ──
    if (specialDuration === "turnEnd") {
      // The previous combatant just ended their turn
      const actorCombatant = combat.combatants.find(c => c.actorId === actor.id);
      if (actorCombatant && ctx.previousCombatant?.id === actorCombatant.id) {
        const startRound = duration.startRound ?? 0;
        const startTurn = duration.startTurn ?? 0;
        if (ctx.currentRound > startRound || (ctx.currentRound === startRound && ctx.currentTurn > startTurn)) {
          return `${effect.name}: turn end expiry`;
        }
      }
    }

    // ── Special duration: turn start of source ──
    if (specialDuration === "turnStartSource") {
      const sourceActorId = this._getSourceActorId(effect);
      if (sourceActorId) {
        const sourceCombatant = combat.combatants.find(c => c.actorId === sourceActorId);
        if (sourceCombatant && ctx.currentCombatant?.id === sourceCombatant.id) {
          const startRound = duration.startRound ?? 0;
          if (ctx.currentRound > startRound) {
            return `${effect.name}: source's turn start expiry`;
          }
        }
      }
    }

    // ── Special duration: turn end of source ──
    if (specialDuration === "turnEndSource") {
      const sourceActorId = this._getSourceActorId(effect);
      if (sourceActorId) {
        const sourceCombatant = combat.combatants.find(c => c.actorId === sourceActorId);
        if (sourceCombatant && ctx.previousCombatant?.id === sourceCombatant.id) {
          const startRound = duration.startRound ?? 0;
          if (ctx.currentRound > startRound) {
            return `${effect.name}: source's turn end expiry`;
          }
        }
      }
    }

    // ── Standard round-based duration ──
    if (duration.rounds != null && duration.rounds > 0 && duration.startRound != null) {
      const elapsed = ctx.currentRound - (duration.startRound ?? 0);
      if (elapsed >= duration.rounds) {
        return `${effect.name}: ${duration.rounds} round duration expired`;
      }
    }

    // ── Turn-based duration (rare, but some effects last N turns) ──
    if (duration.turns != null && duration.turns > 0 && duration.startRound != null) {
      const elapsedRounds = ctx.currentRound - (duration.startRound ?? 0);
      const elapsedTurns = elapsedRounds * combat.combatants.size + (ctx.currentTurn - (duration.startTurn ?? 0));
      if (elapsedTurns >= duration.turns) {
        return `${effect.name}: ${duration.turns} turn duration expired`;
      }
    }

    // ── Seconds-based duration (in-game time via combat rounds — 1 round = 6 seconds) ──
    if (duration.seconds != null && duration.seconds > 0 && duration.startRound != null) {
      const elapsedRounds = ctx.currentRound - (duration.startRound ?? 0);
      const elapsedSeconds = elapsedRounds * 6; // 6 seconds per round
      if (elapsedSeconds >= duration.seconds) {
        return `${effect.name}: ${duration.seconds}s duration expired`;
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Effect Created — stamp start time
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When a new Active Effect is created, stamp the current combat round/turn
   * so the duration tracker knows when it started.
   */
  async _onEffectCreated(effect, options, userId) {
    // Only the creating user stamps (avoids duplicates)
    if (game.userId !== userId) return;
    if (!DurationTracker._isEnabled()) return;

    const combat = game.combat;
    const duration = effect.duration;

    // Only stamp if the effect has a duration and it hasn't been stamped already
    const hasDuration = (duration.rounds ?? 0) > 0
                     || (duration.turns ?? 0) > 0
                     || (duration.seconds ?? 0) > 0
                     || effect.flags?.[MODULE_ID]?.specialDuration;

    if (!hasDuration) return;

    // ── Outside combat: stamp worldTimeStart for seconds-based effects ──
    if (!combat?.started) {
      if ((duration.seconds ?? 0) > 0 && !effect.flags?.[MODULE_ID]?.worldTimeStart) {
        try {
          await effect.update({
            [`flags.${MODULE_ID}.worldTimeStart`]: game.time.worldTime,
            [`flags.${MODULE_ID}.createdWorldTime`]: game.time.worldTime,
          });
          this._debug(`Stamped worldTimeStart on "${effect.name}" (out-of-combat): ${game.time.worldTime}`);
        } catch (err) {
          console.warn(`${MODULE_ID} | Failed to stamp world time on "${effect.name}":`, err.message);
        }
      }
      return;
    }

    // Don't re-stamp if already set
    if (duration.startRound != null && duration.combat) return;

    // Stamp the start time — combat round/turn + world time for post-combat tracking
    const updateData = {
      "duration.startRound": combat.round,
      "duration.startTurn": combat.turn,
      "duration.combat": combat.id,
      [`flags.${MODULE_ID}.createdWorldTime`]: game.time.worldTime,
    };

    // If this effect has a seconds-based duration, also stamp worldTimeStart
    // so it can expire via world time advancement after combat ends
    if ((duration.seconds ?? 0) > 0) {
      updateData[`flags.${MODULE_ID}.worldTimeStart`] = game.time.worldTime;
    }

    try {
      await effect.update(updateData);
      this._debug(`Stamped duration start on "${effect.name}": round=${combat.round} turn=${combat.turn} worldTime=${game.time.worldTime}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to stamp duration on "${effect.name}":`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Combat Deleted — expire "until combat ends" effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When combat ends, remove all effects flagged with specialDuration "combat".
   */
  async _onCombatDeleted(combat, options, userId) {
    if (!game.user.isGM) return;
    if (!DurationTracker._isEnabled()) return;

    const combatId = combat.id;
    this._debug(`Combat ended (${combatId}), checking for combat-duration effects`);

    // ── Phase 1: explicit "Until combat ends" + combat-linked rounds ────────
    // The original behaviour: anything stamped with the ending combat's id
    // and a round-based duration is expired alongside the combat itself.
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor) continue;

      for (const effect of actor.effects) {
        if (effect.disabled) continue;

        const flags = effect.flags?.[MODULE_ID] ?? {};
        const specialDuration = flags.specialDuration;

        // Expire "until combat ends" effects
        if (specialDuration === "combat") {
          await this._expireEffect(actor, effect, `${effect.name}: combat ended`);
          continue;
        }

        // Also expire any effect whose duration.combat matches this combat
        // and has a round-based duration (it was tied to this combat)
        if (effect.duration?.combat === combatId && (effect.duration.rounds ?? 0) > 0) {
          await this._expireEffect(actor, effect, `${effect.name}: combat ended (duration was combat-linked)`);
        }
      }
    }

    // ── Phase 2: Combat Wind-Down (configurable safety net) ────────────────
    // Short-duration buffs (Bless, Bane, Haste, Faerie Fire, Spirit Shroud,
    // smite spells, etc.) often have 1-minute / 10-round durations. When the
    // GM clicks End Combat with 5 rounds left, RAW says the buff continues
    // for another ~30 seconds of game time — but narratively the next scene
    // is minutes/hours later and those buffs should have worn off. This pass
    // catches any effect on a combatant whose REMAINING duration is at or
    // below the wind-down threshold (default 10 min). Long-duration buffs
    // like Mage Armor (8 h) and Stoneskin (1 h) are far above the threshold
    // and survive untouched.
    await this._windDownAfterCombat(combat);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Combat Wind-Down — expire short-duration buffs after combat ends
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * After combat ends, expire any active effect on a combatant whose
   * remaining duration is at or below the wind-down threshold.
   *
   * Gated by two settings:
   *   combatWindDownEnabled       (Boolean, default true)
   *   combatWindDownThresholdMin  (Number,  default 10 minutes)
   *
   * Remaining-duration logic:
   *   - seconds-based: worldTime now − worldTimeStart vs duration.seconds
   *   - rounds-based:  (duration.rounds − elapsedRounds) × 6 sec/round
   * If neither, the effect is skipped (treated as permanent for our purposes).
   *
   * @private
   */
  async _windDownAfterCombat(combat) {
    const enabled = DurationTracker._getSetting("combatWindDownEnabled") ?? true;
    if (!enabled) return;

    const thresholdMin = DurationTracker._getSetting("combatWindDownThresholdMin") ?? 10;
    const thresholdSec = thresholdMin * 60;

    this._debug(`Wind-down: checking for effects with ≤${thresholdMin}min remaining`);

    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor) continue;

      const toExpire = [];
      for (const effect of actor.effects) {
        if (effect.disabled) continue;

        const dur = effect.duration;
        if (!dur) continue;
        const hasRoundsDur  = (dur.rounds  ?? 0) > 0;
        const hasSecondsDur = (dur.seconds ?? 0) > 0;
        if (!hasRoundsDur && !hasSecondsDur) continue;  // permanent — leave alone

        const flags = effect.flags?.[MODULE_ID] ?? {};

        // Compute remaining duration in seconds. Prefer seconds-based math
        // (more accurate for spells with explicit time durations).
        let remainingSec = Infinity;
        if (hasSecondsDur) {
          const startWT = flags.worldTimeStart ?? flags.createdWorldTime;
          if (startWT != null) {
            const elapsed = game.time.worldTime - startWT;
            remainingSec = dur.seconds - elapsed;
          } else {
            remainingSec = dur.seconds;  // can't tell elapsed; assume full
          }
        } else if (hasRoundsDur) {
          const startRound = dur.startRound ?? 1;
          const elapsedRounds = Math.max(0, combat.round - startRound);
          const remainingRounds = Math.max(0, dur.rounds - elapsedRounds);
          remainingSec = remainingRounds * 6;  // 6 sec per round (5e RAW)
        }

        if (remainingSec > 0 && remainingSec <= thresholdSec) {
          const remMin = Math.max(1, Math.round(remainingSec / 60));
          toExpire.push({
            effect,
            reason: `${effect.name}: combat wind-down (≤${thresholdMin}min remaining)`
          });
        }
      }

      // Delete after iteration (don't mutate the collection mid-loop)
      for (const { effect, reason } of toExpire) {
        await this._expireEffect(actor, effect, reason);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rest Completed — expire short/long rest effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When an actor completes a rest, expire effects flagged for that rest type.
   * dnd5e hook signature: (actor, result)
   */
  async _onRestCompleted(actor, result) {
    if (!game.user.isGM) return;
    if (!DurationTracker._isEnabled()) return;

    const restType = result?.type; // "short" or "long"
    if (!restType) return;

    this._debug(`Rest completed: ${actor.name} (${restType} rest)`);

    for (const effect of actor.effects) {
      if (effect.disabled) continue;

      const flags = effect.flags?.[MODULE_ID] ?? {};
      const specialDuration = flags.specialDuration;

      if (specialDuration === "shortRest" && (restType === "short" || restType === "long")) {
        await this._expireEffect(actor, effect, `${effect.name}: short rest`);
      } else if (specialDuration === "longRest" && restType === "long") {
        await this._expireEffect(actor, effect, `${effect.name}: long rest`);
      } else if (specialDuration === "newDay" && restType === "long") {
        // "New day" effects also expire on long rest (approximation)
        await this._expireEffect(actor, effect, `${effect.name}: new day (long rest)`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Applied — expire "isDamaged" effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When damage is applied to an actor, expire "isDamaged" special duration effects.
   * Expects payload: { actor, tokenDoc, damage }
   */
  async _onDamageApplied(payload) {
    if (!game.user.isGM) return;
    if (!DurationTracker._isEnabled()) return;

    const actor = payload?.actor;
    if (!actor) return;

    for (const effect of actor.effects) {
      if (effect.disabled) continue;
      const specialDuration = effect.flags?.[MODULE_ID]?.specialDuration;
      if (specialDuration === "isDamaged") {
        await this._expireEffect(actor, effect, `${effect.name}: took damage`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Attack Received — expire "isAttacked" effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When an attack targets an actor, expire "isAttacked" special duration effects
   * on the targets.
   * Expects payload: { item, actor, results, hits, misses }
   */
  async _onAttackComplete(payload) {
    if (!game.user.isGM) return;
    if (!DurationTracker._isEnabled()) return;

    const results = payload?.results;
    if (!results?.length) return;

    for (const result of results) {
      const targetActor = result.actor;
      if (!targetActor) continue;

      for (const effect of targetActor.effects) {
        if (effect.disabled) continue;
        const specialDuration = effect.flags?.[MODULE_ID]?.specialDuration;
        if (specialDuration === "isAttacked") {
          await this._expireEffect(targetActor, effect, `${effect.name}: was attacked`);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Attempted — expire "isSave" effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When a creature makes a saving throw, expire "isSave" special duration effects.
   * Expects payload: { actor, tokenDocId, saveAbility, passed }
   */
  async _onSaveComplete(payload) {
    if (!game.user.isGM) return;
    if (!DurationTracker._isEnabled()) return;

    const actor = payload?.actor;
    if (!actor) return;

    for (const effect of actor.effects) {
      if (effect.disabled) continue;
      const specialDuration = effect.flags?.[MODULE_ID]?.specialDuration;
      if (specialDuration === "isSave") {
        await this._expireEffect(actor, effect, `${effect.name}: made a saving throw`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World Time Update — expire seconds-based effects outside combat
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When game world time advances (travel, rest, manual advance), check all
   * actors for seconds-based effects that have expired. This handles the case
   * where Mage Armor (8 hours), Longstrider (1 hour), etc. should expire
   * outside of combat when the GM advances time.
   */
  async _onWorldTimeUpdate(worldTime, delta, options, userId) {
    if (!game.user.isGM) return;
    if (!DurationTracker._isEnabled()) return;
    if (delta <= 0) return; // Only care about forward time advancement

    this._debug(`World time advanced by ${delta}s (new time: ${worldTime})`);

    // Check all active actors (in the current scene + any with linked tokens)
    const actorsToCheck = new Set();

    // All actors with tokens on the current scene
    if (canvas.scene) {
      for (const tokenDoc of canvas.scene.tokens) {
        if (tokenDoc.actor) actorsToCheck.add(tokenDoc.actor);
      }
    }

    // Also check player characters (they may not be on the current scene)
    for (const user of game.users) {
      if (user.character) actorsToCheck.add(user.character);
    }

    for (const actor of actorsToCheck) {
      const toExpire = [];

      for (const effect of actor.effects) {
        if (effect.disabled) continue;

        const duration = effect.duration;
        const seconds = duration?.seconds;
        if (!seconds || seconds <= 0) continue;

        // Check world time start stamp
        const worldTimeStart = effect.flags?.[MODULE_ID]?.worldTimeStart;
        if (worldTimeStart != null) {
          const elapsed = worldTime - worldTimeStart;
          if (elapsed >= seconds) {
            toExpire.push({ effect, reason: `${effect.name}: ${DurationTracker._formatSeconds(seconds)} duration expired (world time)` });
            continue;
          }
        }

        // Fallback: check combat-stamped effects that have duration.seconds
        // These were created during combat but combat has ended
        if (duration.startRound != null && !game.combat?.started) {
          // Effect was combat-linked but combat is over — check against world time
          // Use the creation timestamp if available
          const createdTime = effect.flags?.[MODULE_ID]?.createdWorldTime;
          if (createdTime != null) {
            const elapsed = worldTime - createdTime;
            if (elapsed >= seconds) {
              toExpire.push({ effect, reason: `${effect.name}: ${DurationTracker._formatSeconds(seconds)} duration expired (post-combat world time)` });
            }
          }
        }
      }

      for (const { effect, reason } of toExpire) {
        await this._expireEffect(actor, effect, reason);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Effect Expiration — delete + notify
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Expire (delete) an effect and post a chat notification.
   * @param {Actor} actor — the owning actor
   * @param {ActiveEffect} effect — the effect to expire
   * @param {string} reason — human-readable reason for logging
   */
  async _expireEffect(actor, effect, reason) {
    const effectName = effect.name;
    const actorName = actor.name;
    const isConcentration = effect.flags?.[MODULE_ID]?.concentration
                         || effect.statuses?.has("concentrating");

    this._debug(`Expiring "${effectName}" on ${actorName}: ${reason}`);

    try {
      await effect.delete();
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to delete expired effect "${effectName}" on ${actorName}:`, err);
      return;
    }

    // ── Chat notification ──
    if (DurationTracker._getSetting("notifyOnExpiry")) {
      const notifyAll = DurationTracker._getSetting("expiryNotifyAll");
      const whisper = notifyAll ? [] : ChatMessage.getWhisperRecipients("GM").map(u => u.id);

      const content = `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-left:3px solid #888;background:rgba(0,0,0,0.05);border-radius:3px;font-size:13px;">
        <i class="fas fa-hourglass-end" style="color:#888;"></i>
        <span><strong>${effectName}</strong> has expired on <strong>${actorName}</strong></span>
      </div>`;

      try {
        await ChatMessage.create({
          content,
          whisper,
          speaker: { alias: "Duration Tracker" },
          flags: { [MODULE_ID]: { durationExpiry: true, effectName, actorName } },
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to post expiry notification:`, err.message);
      }
    }

    // ── If this was a concentration effect, fire a hook so the ConcentrationWidget can clean up ──
    if (isConcentration) {
      Hooks.callAll(`${MODULE_ID}.concentrationExpired`, { actor, effectName });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Static Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get human-readable remaining duration text for an effect.
   * Useful for UI display in token HUD or effects panels.
   *
   * @param {ActiveEffect} effect — the effect to check
   * @param {Combat} [combat] — current combat (defaults to game.combat)
   * @returns {string} — e.g., "3 rounds remaining", "Until end of next turn", "Permanent"
   */
  static getRemainingText(effect, combat) {
    combat = combat ?? game.combat;
    const duration = effect.duration;
    const flags = effect.flags?.[MODULE_ID] ?? {};
    const specialDuration = flags.specialDuration;

    // ── Special durations ──
    if (specialDuration && SPECIAL_DURATIONS[specialDuration]) {
      return SPECIAL_DURATIONS[specialDuration];
    }

    // ── No combat active ──
    if (!combat?.started) {
      if (duration.seconds > 0) return DurationTracker._formatSeconds(duration.seconds);
      if (duration.rounds > 0) return `${duration.rounds} rounds`;
      return "Until removed";
    }

    // ── Round-based ──
    if (duration.rounds != null && duration.rounds > 0 && duration.startRound != null) {
      const elapsed = combat.round - duration.startRound;
      const remaining = Math.max(0, duration.rounds - elapsed);
      if (remaining <= 0) return "Expired";
      if (remaining === 1) return "1 round remaining";
      return `${remaining} rounds remaining`;
    }

    // ── Turn-based ──
    if (duration.turns != null && duration.turns > 0 && duration.startRound != null) {
      const elapsedRounds = combat.round - duration.startRound;
      const elapsedTurns = elapsedRounds * combat.combatants.size + (combat.turn - (duration.startTurn ?? 0));
      const remaining = Math.max(0, duration.turns - elapsedTurns);
      if (remaining <= 0) return "Expired";
      if (remaining === 1) return "1 turn remaining";
      return `${remaining} turns remaining`;
    }

    // ── Seconds-based ──
    if (duration.seconds != null && duration.seconds > 0 && duration.startRound != null) {
      const elapsedRounds = combat.round - duration.startRound;
      const elapsedSeconds = elapsedRounds * 6;
      const remaining = Math.max(0, duration.seconds - elapsedSeconds);
      if (remaining <= 0) return "Expired";
      return DurationTracker._formatSeconds(remaining);
    }

    // ── Permanent / no duration info ──
    if (duration.seconds === -1) return "Permanent";
    return "Until removed";
  }

  /**
   * Get all special duration type keys and labels.
   * @returns {object} — { turnStart: "Start of ...", ... }
   */
  static getSpecialDurations() {
    return { ...SPECIAL_DURATIONS };
  }

  /**
   * Check if an effect is expired right now (without waiting for hook).
   * Useful for manual checks or UI display.
   *
   * @param {ActiveEffect} effect — the effect to check
   * @param {Combat} [combat] — current combat
   * @returns {boolean}
   */
  static isExpired(effect, combat) {
    combat = combat ?? game.combat;
    if (!combat?.started) return false;

    const duration = effect.duration;
    if (!duration.startRound && duration.startRound !== 0) return false;

    // Round-based
    if (duration.rounds != null && duration.rounds > 0) {
      const elapsed = combat.round - duration.startRound;
      if (elapsed >= duration.rounds) return true;
    }

    // Seconds-based
    if (duration.seconds != null && duration.seconds > 0) {
      const elapsedSeconds = (combat.round - duration.startRound) * 6;
      if (elapsedSeconds >= duration.seconds) return true;
    }

    return false;
  }

  // ─── Settings Helpers ──────────────────────────────────────────────────

  /**
   * Check if the duration tracker is enabled.
   * @private
   */
  static _isEnabled() {
    return DurationTracker._getSetting("enableDurationTracker");
  }

  /**
   * Read a setting safely.
   * @private
   */
  static _getSetting(key) {
    try {
      return game.settings.get(MODULE_ID, key);
    } catch {
      // Settings not registered yet — return sensible defaults
      const defaults = {
        enableDurationTracker: true,
        expireEffectsOnTurnChange: true,
        notifyOnExpiry: true,
        expiryNotifyAll: false,
      };
      return defaults[key] ?? true;
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────

  /**
   * Extract the source actor ID from an effect's origin field.
   * Origin is typically a UUID like "Actor.abc123.Item.def456"
   * @private
   */
  _getSourceActorId(effect) {
    const origin = effect.origin;
    if (!origin) return null;

    // Try to extract Actor ID from origin UUID
    // Common formats: "Actor.XXX", "Actor.XXX.Item.YYY", "Scene.X.Token.Y.Actor.Z"
    const actorMatch = origin.match(/Actor\.([a-zA-Z0-9]+)/);
    if (actorMatch) return actorMatch[1];

    // If origin is an actor UUID stored in flags
    const sourceActorId = effect.flags?.[MODULE_ID]?.sourceActorId;
    if (sourceActorId) return sourceActorId;

    return null;
  }

  /**
   * Format seconds into human-readable text.
   * @private
   */
  static _formatSeconds(seconds) {
    if (seconds <= 0) return "Expired";
    if (seconds < 60) return `${seconds} seconds`;
    if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      return mins === 1 ? "1 minute" : `${mins} minutes`;
    }
    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      return hours === 1 ? "1 hour" : `${hours} hours`;
    }
    const days = Math.floor(seconds / 86400);
    return days === 1 ? "1 day" : `${days} days`;
  }

  /**
   * Debug logging helper.
   * @private
   */
  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | DT | ${msg}`);
      }
    } catch { /* settings not ready yet */ }
  }

  // ─── API Registration ──────────────────────────────────────────────────

  /**
   * Register the DurationTracker on the module's public API.
   */
  static registerAPI(instance) {
    const mod = game.modules.get(MODULE_ID);
    if (mod) {
      mod.api = { ...(mod.api ?? {}), durations: DurationTracker, durationTracker: instance };
      console.debug(`${MODULE_ID} | DurationTracker registered on module API`);
    }
  }
}
