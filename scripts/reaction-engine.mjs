// ─── ACE: QOL — Reaction Engine ─────────────────────────────────────────────
// Automates D&D 5e reactions: Shield, Counterspell, Absorb Elements,
// Legendary Resistance, Silvery Barbs, Cutting Words, and OA tracking.
//
// Design:
//   - Each combatant gets ONE reaction per round (PHB 2024/2014 rule).
//   - Reactions reset at the START of each combatant's turn.
//   - Prompts are socket-routed to the owning player (or GM for NPCs).
//   - Timeout: configurable (default 10s), auto-decline on expiry.
//   - All checks are defensive: reaction used? spell prepared? slots? range?
//
// Integration points (called from other engines):
//   AttackPipeline → checkPostHitReactions()   — Shield
//   SaveEngine     → checkPostSaveReactions()  — Legendary Resistance, Silvery Barbs
//   SpellCast hook → checkPreSpellReactions()   — Counterspell
//   DamageEngine   → checkPreDamageReactions()  — Absorb Elements
//   AttackPipeline → checkPostAttackReactions() — Silvery Barbs (on attack success)
//   AttackPipeline → checkPreFinalizeReactions() — Cutting Words (on attack roll)
// ──────────────────────────────────────────────────────────────────────────────

// NOTE: MODULE_ID hardcoded to avoid circular import (ace-qol.mjs imports us)
const MODULE_ID = "ace-qol";
import { QolSettings } from "./settings.mjs";
import { CombatState } from "./combat-state.mjs";

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

const SOCKET_NAME = `module.${MODULE_ID}`;
const FLAG_REACTION_USED = "reactionUsed";

/** Elemental damage types that trigger Absorb Elements */
const ABSORB_ELEMENT_TYPES = new Set(["acid", "cold", "fire", "lightning", "thunder"]);

/** Default timeout for reaction prompts (seconds) */
const DEFAULT_TIMEOUT = 10;

// ═══════════════════════════════════════════════════════════════════════════════
//  ReactionEngine
// ═══════════════════════════════════════════════════════════════════════════════

export class ReactionEngine {

  /**
   * v0.7.17b — Cast barrier registry (2026-06-07).
   * Map of activity-ref → { promise, resolve, resolved, createdAt }.
   *
   * Why this exists:
   *   Foundry's Hooks.on fires every listener in parallel. The Counterspell
   *   handler in _onSpellCast is `async` and awaits the user's prompt — but
   *   the other listeners on the same hook (SpellAutoDamage, Forge FX,
   *   AA triggers, dnd5e's own chat-card creation) DON'T wait. They race
   *   ahead and post the damage card / play the animation BEFORE the user
   *   has even clicked the Counterspell prompt. Result: clicking "Cast
   *   Counterspell" appeared to do nothing because the spell already fully
   *   resolved.
   *
   * The fix:
   *   At `dnd5e.preUseActivity` (which fires BEFORE postCreateUsageMessage),
   *   reaction-engine creates a barrier Promise and stores it keyed by the
   *   activity object reference. Other engines call
   *   `ReactionEngine.awaitCastBarrier(activity)` at the top of their
   *   postCreateUsageMessage handler and await the promise before doing
   *   anything. Reaction-engine resolves the barrier once the user has
   *   decided — with { abort: true } on a successful counterspell,
   *   { abort: false } otherwise. Downstream handlers bail or proceed
   *   based on the abort flag.
   *
   * Safety net: every barrier auto-resolves after 30s in case the
   * reaction handler never finishes (timeout, error, etc.).
   */
  static _castBarriers = new Map();

  /**
   * Create a barrier for the given activity. Called in preUseActivity.
   * Idempotent — calling twice for the same activity is a no-op.
   */
  static _createCastBarrier(activity) {
    if (!activity) return;
    if (ReactionEngine._castBarriers.has(activity)) return;
    let resolveFn;
    const promise = new Promise(r => { resolveFn = r; });
    const entry = { promise, resolve: resolveFn, resolved: false, resolvedWith: null, createdAt: Date.now() };
    ReactionEngine._castBarriers.set(activity, entry);
    console.log(`ace-qol | [BARRIER] CREATE for ${activity?.item?.name ?? '?'} on ${activity?.item?.actor?.name ?? '?'} — map size now ${ReactionEngine._castBarriers.size}`);
    // Safety-net timeout — auto-resolve with { abort: false } after 30s
    setTimeout(() => {
      const b = ReactionEngine._castBarriers.get(activity);
      if (b && !b.resolved) {
        b.resolve({ abort: false, reason: "timeout" });
        b.resolved = true;
      }
      ReactionEngine._castBarriers.delete(activity);
    }, 30000);
  }

  /**
   * Resolve a barrier. Called by reaction-engine after the user decides
   * (or when reaction-engine bails because no reactors / not a spell / etc.).
   */
  static _resolveCastBarrier(activity, result) {
    if (!activity) {
      console.log(`ace-qol | [BARRIER] RESOLVE skipped — no activity`);
      return;
    }
    const b = ReactionEngine._castBarriers.get(activity);
    if (!b) {
      console.log(`ace-qol | [BARRIER] RESOLVE skipped — no barrier for ${activity?.item?.name ?? '?'} (map size: ${ReactionEngine._castBarriers.size})`);
      return;
    }
    if (b.resolved) {
      console.log(`ace-qol | [BARRIER] RESOLVE skipped — already resolved with ${JSON.stringify(b.resolvedWith)}, new request was ${JSON.stringify(result)}`);
      return;
    }
    b.resolve(result);
    b.resolved = true;
    b.resolvedWith = result;
    console.log(`ace-qol | [BARRIER] RESOLVE for ${activity?.item?.name ?? '?'} with ${JSON.stringify(result)}`);
  }

  /**
   * PUBLIC API. Other engines call this at the top of their
   * postCreateUsageMessage handler to wait for reaction resolution.
   *
   * @param {object} activity   the dnd5e activity object
   * @returns {Promise<{abort: boolean, reason: string}>}
   *   abort:true  → the cast was counterspelled; the caller should bail.
   *   abort:false → no reaction or reaction failed; proceed normally.
   */
  static async awaitCastBarrier(activity) {
    if (!activity) {
      console.log(`ace-qol | [BARRIER] await — no activity`);
      return { abort: false, reason: "no_activity" };
    }
    const b = ReactionEngine._castBarriers.get(activity);
    if (!b) {
      console.log(`ace-qol | [BARRIER] await — no barrier for ${activity?.item?.name ?? '?'} (map size: ${ReactionEngine._castBarriers.size}, resolved: ${b?.resolved})`);
      return { abort: false, reason: "no_barrier" };
    }
    console.log(`ace-qol | [BARRIER] AWAITING ${activity?.item?.name ?? '?'} (currently resolved: ${b.resolved})`);
    const result = await b.promise;
    console.log(`ace-qol | [BARRIER] await returned ${JSON.stringify(result)} for ${activity?.item?.name ?? '?'}`);
    return result;
  }

  constructor() {
    /** Pending reaction prompts awaiting player response.
     *  v0.4.22.12: switched from plain object to Map for cleaner
     *  iteration semantics + protection against prototype-key
     *  collisions (e.g. requestId === "constructor"). */
    this._pendingRequests = new Map();

    /** Counter for unique request IDs */
    this._requestCounter = 0;

    /** v0.4.22.12: WeakSet of activity references already processed by
     *  the V2 `postCreateUsageMessage` hook. The legacy `useActivity`
     *  hook checks this Set and bails if the activity was already
     *  handled — replaces the broken
     *  `_lastCounterspellCheck = ${id}-${Date.now()}` debounce, where
     *  the timestamp made every key unique and the dedup never fired. */
    this._handledActivityRefs = new WeakSet();

    this._registerHooks();
    this._registerSocketHandlers();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration — Reaction Tracking (Turn Reset)
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Reset reaction at the START of each combatant's turn ──
    Hooks.on("combatTurn", (combat, updateData, opts) => {
      if (!game.user.isGM) return;
      this._resetCurrentCombatantReaction(combat);
    });

    // ── Also reset on round change (covers edge cases) ──
    Hooks.on("combatRound", (combat, updateData, opts) => {
      if (!game.user.isGM) return;
      this._resetCurrentCombatantReaction(combat);
    });

    // ── v0.4.22.12: Reset all reactionUsed flags when combat ends ──
    // Without this, an actor's `reactionUsed` flag persists across
    // combats. Next combat, they'd appear to have already used their
    // reaction even though it's a new fight.
    Hooks.on("deleteCombat", () => {
      if (!game.user.isGM) return;
      this._resetAllReactionFlags("combat ended");
    });

    // ── v0.4.22.12: Reset all reactionUsed flags on world reload ──
    // The flag is stored on actor.flags so it persists across saves.
    // Without this cleanup, a session that ends mid-combat would
    // leave stale flags forever.
    Hooks.once("ready", () => {
      if (!game.user.isGM) return;
      this._resetAllReactionFlags("world startup");
    });

    // ── Track opportunity attacks as reaction usage ──
    // When an OA is made, mark the attacker's reaction as used.
    // We detect OAs via the dnd5e system's "opportunity" flag if available,
    // or via the custom hook other modules emit.
    Hooks.on(`${MODULE_ID}.opportunityAttack`, (actorId) => {
      if (!game.user.isGM) return;
      const actor = game.actors.get(actorId);
      if (actor) this._markReactionUsed(actor);
    });

    // ── v0.7.17b — Cast barrier creation (preUseActivity) ──
    // Fires EARLIER than postCreateUsageMessage. Other engines (Spell-
    // AutoDamage, etc.) await this barrier in their postCreateUsageMessage
    // handlers so reactions resolve modally before downstream effects.
    Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
      if (!game.user.isGM) return;
      if (!QolSettings.get("enableReactions")) return;
      if (!QolSettings.get("autoCounterspell")) return;
      const item = activity?.item;
      if (!item || item.type !== "spell") return;
      const lvl = item.system?.level ?? 0;
      if (lvl === 0) return; // cantrips can't be counterspelled
      ReactionEngine._createCastBarrier(activity);
    });

    // ── Counterspell: detect spell casting ──
    // dnd5e 5.x fires postCreateUsageMessage for every activity use.
    // We check if it is a spell and look for Counterspell reactors.
    Hooks.on("dnd5e.postCreateUsageMessage", async (activity, message) => {
      console.log(`ace-qol | [REACTION-V2-HOOK] entry for ${activity?.item?.name ?? '?'} isGM=${game.user.isGM} reactions=${QolSettings.get("enableReactions")} cs=${QolSettings.get("autoCounterspell")}`);
      if (!game.user.isGM) return;
      if (!QolSettings.get("enableReactions")) return;
      if (!QolSettings.get("autoCounterspell")) return;
      console.log(`ace-qol | [REACTION-V2-HOOK] passed gates, calling _onSpellCast for ${activity?.item?.name ?? '?'}`);
      // Mark BEFORE processing so the legacy hook (which fires after
      // this synchronous return) sees the handled state.
      if (activity && typeof activity === "object") {
        this._handledActivityRefs.add(activity);
      }
      await this._onSpellCast(activity, message);
    });
    // Legacy fallback
    Hooks.on("dnd5e.useActivity", async (activity) => {
      if (!game.user.isGM) return;
      if (!QolSettings.get("enableReactions")) return;
      if (!QolSettings.get("autoCounterspell")) return;
      // v0.4.22.12: replaced broken `${id}-${Date.now()}` debounce.
      // Both the V2 and legacy hooks fire with the SAME activity
      // reference for a given cast. The V2 hook adds the ref to
      // `_handledActivityRefs`. If we see it here, V2 already
      // processed and we bail.
      if (activity && this._handledActivityRefs.has(activity)) return;
      await this._onSpellCast(activity, null);
    });

    this._debug("Reaction engine hooks registered");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Socket Handlers — Player ↔ GM Communication
  // ═══════════════════════════════════════════════════════════════════════════

  _registerSocketHandlers() {
    // Socket handlers are registered in ace-qol.mjs's ready hook.
    // This method is called by the main entry to get the handler function.
    // See integration notes at bottom of file.
  }

  /**
   * Handle incoming socket messages for the reaction engine.
   * Called from ace-qol.mjs socket handlers.
   * @param {object} payload - Socket payload
   * @returns {boolean} true if this engine handled the message
   */
  async handleSocketMessage(payload) {
    if (!payload?.action) return false;

    // ── Player responds to a reaction prompt ──
    if (payload.action === "reactionResponse") {
      const { requestId, accepted, choiceData, senderUserId, reactorActorId } = payload;
      const pending = this._pendingRequests.get(requestId);
      if (!pending) return true;

      // v0.4.22.12: Ownership validation (defense-in-depth).
      // Without this, a malicious or buggy client with a known
      // requestId could resolve a reaction belonging to a different
      // actor. Validate that the responder either owns the reactor
      // actor or is a GM.
      if (senderUserId) {
        const senderUser = game.users?.get(senderUserId);
        const expectedActorId = pending.reactorActorId;
        if (senderUser && expectedActorId) {
          const isGm = !!senderUser.isGM;
          const actor = game.actors?.get(expectedActorId);
          const ownsActor = !!actor?.testUserPermission?.(senderUser, "OWNER");
          if (!isGm && !ownsActor) {
            console.warn(`${MODULE_ID} | Rejected reactionResponse from ${senderUser.name}: not GM and doesn't own actor ${expectedActorId}`);
            return true; // silently drop
          }
        }
        // Echo-actor sanity check: if responder echoed an actorId,
        // it must match the stored one.
        if (reactorActorId && expectedActorId && reactorActorId !== expectedActorId) {
          console.warn(`${MODULE_ID} | Rejected reactionResponse: actor mismatch ${reactorActorId} vs ${expectedActorId}`);
          return true;
        }
      }

      clearTimeout(pending.timeout);
      this._pendingRequests.delete(requestId);
      pending.resolve({ accepted: !!accepted, choiceData: choiceData ?? {} });
      return true;
    }

    // ── GM sends a reaction prompt to a player ──
    if (payload.action === "showReactionPrompt") {
      // Only the targeted player should handle this
      if (payload.targetUserId !== game.user.id) return true;
      const result = await ReactionEngine.showReactionDialog(payload.promptData);
      // Send response back to GM. v0.4.22.12: include senderUserId
      // and reactorActorId so the GM-side handler can validate
      // ownership (defense in depth — a stolen requestId alone no
      // longer authenticates a response).
      game.socket.emit(SOCKET_NAME, {
        action: "reactionResponse",
        requestId: payload.requestId,
        accepted: result.accepted,
        choiceData: result.choiceData ?? {},
        senderUserId: game.user.id,
        reactorActorId: payload.promptData?.actorId ?? null,
      });
      return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Reaction State Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if an actor has already used their reaction this round.
   */
  _hasUsedReaction(actor) {
    if (!actor) return true;
    return !!actor.getFlag(MODULE_ID, FLAG_REACTION_USED);
  }

  /**
   * Mark an actor's reaction as used for this round.
   */
  async _markReactionUsed(actor) {
    if (!actor) return;
    await actor.setFlag(MODULE_ID, FLAG_REACTION_USED, true);
    this._debug(`Reaction USED: ${actor.name}`);
  }

  /**
   * Reset reaction for the current combatant at the start of their turn.
   */
  async _resetCurrentCombatantReaction(combat) {
    if (!combat?.current?.combatantId) return;
    const combatant = combat.combatants.get(combat.current.combatantId);
    const actor = combatant?.actor;
    if (!actor) return;

    // Only reset if currently marked as used
    if (actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) {
      await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
      this._debug(`Reaction RESET: ${actor.name} (start of turn)`);
    }
  }

  /**
   * v0.4.22.12: Bulk-reset every actor's reactionUsed flag.
   * Called on `ready` (world startup) and on `deleteCombat` (combat
   * ended). Ensures stale flags don't persist across saves or
   * between combats. GM-gated by callers.
   *
   * @param {string} reason  Human-readable trigger source for log line.
   */
  async _resetAllReactionFlags(reason) {
    let cleared = 0;
    for (const actor of game.actors ?? []) {
      try {
        if (actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) {
          await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
          cleared += 1;
        }
      } catch (err) {
        // Permission errors on actors we don't own are expected;
        // skip them silently. Genuine failures get logged.
        if (!String(err?.message ?? "").toLowerCase().includes("permission")) {
          console.warn(`${MODULE_ID} | _resetAllReactionFlags: failed to clear flag on ${actor?.name}:`, err);
        }
      }
    }
    if (cleared > 0) {
      this._debug(`Reaction flags reset on ${cleared} actor(s) (${reason})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  1. SHIELD — Post-Hit Reaction (after attack hits, before damage)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check all hit targets for Shield spell availability.
   * Called from AttackPipeline after hit determination.
   *
   * @param {object[]} results - Attack results array from AttackPipeline
   *   Each: { hitResult, attackTotal, target: { actor, token, ac, name }, ... }
   * @param {Item} attackItem - The weapon/spell used to attack
   * @param {Actor} attacker - The attacking actor
   * @returns {object[]} Modified results array (hitResult may change to "miss" if Shield turns a hit into a miss)
   */
  async checkPostHitReactions(results, attackItem, attacker) {
    if (!QolSettings.get("enableReactions")) return results;
    if (!QolSettings.get("autoShield")) return results;

    const modified = [];

    for (const result of results) {
      // Only check hits (not crits — Shield doesn't block nat 20)
      if (result.hitResult !== "hit") {
        modified.push(result);
        continue;
      }

      const targetActor = result.target?.actor;
      const targetToken = result.target?.token;
      if (!targetActor) { modified.push(result); continue; }

      // ── Can this target use Shield? ──
      const shieldCheck = this._canUseShield(targetActor);
      if (!shieldCheck.canUse) { modified.push(result); continue; }

      // ── Send prompt to the target's owner ──
      const promptResult = await this._promptReaction({
        reactorActor: targetActor,
        reactorToken: targetToken,
        type: "shield",
        title: "Shield Spell",
        description: `<strong>${attacker.name}</strong> hits <strong>${targetActor.name}</strong> with <strong>${attackItem.name}</strong>.`,
        details: [
          { label: "Attack Roll", value: result.attackTotal },
          { label: "Current AC", value: result.target.ac },
          { label: "AC with Shield", value: result.target.ac + 5 },
          { label: "Result", value: result.attackTotal >= (result.target.ac + 5) ? "STILL HITS" : "WOULD MISS", color: result.attackTotal >= (result.target.ac + 5) ? "#ef5350" : "#66bb6a" },
        ],
        acceptLabel: "Cast Shield (+5 AC)",
        declineLabel: "No Reaction",
        spellSlotLevel: 1,
        availableSlots: shieldCheck.slots,
        icon: "fa-shield-halved",
        accentColor: "#42a5f5",
      });

      if (promptResult.accepted) {
        // ── Consume spell slot ──
        const slotLevel = promptResult.choiceData?.slotLevel ?? 1;
        await this._consumeSpellSlot(targetActor, slotLevel);

        // ── Mark reaction used ──
        await this._markReactionUsed(targetActor);

        // ── Apply Shield active effect (+5 AC until start of caster's next turn) ──
        await this._applyShieldEffect(targetActor);

        // ── Re-evaluate hit ──
        const newAC = result.target.ac + 5;
        if (result.attackTotal < newAC) {
          // Shield turned the hit into a miss!
          this._debug(`Shield BLOCKED: ${targetActor.name} (${result.attackTotal} vs AC ${newAC})`);
          result.hitResult = "miss";
          result.shieldBlocked = true;

          // Post chat notification
          await this._postReactionChat(targetActor, "Shield", `${targetActor.name} casts Shield! AC becomes ${newAC} — attack misses!`, "#42a5f5");
        } else {
          // Shield didn't prevent the hit but still grants +5 AC for the round
          this._debug(`Shield CAST but still hit: ${targetActor.name} (${result.attackTotal} vs AC ${newAC})`);
          result.target.ac = newAC; // Update AC for display
          await this._postReactionChat(targetActor, "Shield", `${targetActor.name} casts Shield! AC becomes ${newAC} — but the attack still hits (${result.attackTotal}).`, "#ef5350");
        }
      }

      modified.push(result);
    }

    return modified;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  1b. SHIELD vs MAGIC MISSILE — Auto-Hit Defense
  //
  //  Shield has a SPECIAL RAW clause: "you take no damage from magic missile."
  //  (2014 + 2024 PHB, identical wording.) Unlike normal attack-vs-Shield
  //  which is +5 AC math, Magic Missile vs Shield is ABSOLUTE — all darts
  //  on that target are nullified, no damage applies.
  //
  //  Magic Missile has no attack roll, so it bypasses checkPostHitReactions().
  //  This method is invoked from SpellAutoDamage's Magic Missile handler
  //  AFTER the picker confirms target distribution but BEFORE damage rolls.
  //
  //  Returns a filtered distribution Map with shielded targets removed.
  //  If every target shields, the returned Map is empty and the caller
  //  should abort the damage card entirely.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check each Magic Missile target for Shield availability and prompt.
   * @param {Map<Actor, number>} distribution - Map of targetActor → dart count
   * @param {Actor} caster - The Magic Missile caster
   * @param {Item} spellItem - The Magic Missile spell item
   * @returns {Promise<Map<Actor, number>>} Filtered distribution (shielded removed)
   */
  async checkMagicMissileShield(distribution, caster, spellItem) {
    if (!QolSettings.get("enableReactions")) return distribution;
    if (!QolSettings.get("autoShield")) return distribution;
    if (!distribution || distribution.size === 0) return distribution;

    const modified = new Map();

    for (const [targetActor, darts] of distribution.entries()) {
      if (!targetActor || darts <= 0) {
        modified.set(targetActor, darts);
        continue;
      }

      // ── Can this target use Shield? (reaction unspent + prepared + slot) ──
      const shieldCheck = this._canUseShield(targetActor);
      if (!shieldCheck.canUse) {
        modified.set(targetActor, darts);
        continue;
      }

      const targetToken = targetActor.getActiveTokens?.()?.[0]
                       ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id)
                       ?? null;

      // ── Prompt the target's owner ──
      const promptResult = await this._promptReaction({
        reactorActor: targetActor,
        reactorToken: targetToken,
        type: "shield",
        title: "Shield — Magic Missile Defense",
        description: `<strong>${caster.name}</strong> casts <strong>Magic Missile</strong> at <strong>${targetActor.name}</strong>.`,
        details: [
          { label: "Darts incoming",   value: String(darts) },
          { label: "Per-dart damage",  value: "1d4 + 1 force" },
          { label: "Effect of Shield", value: "ALL DARTS NULLIFIED — no damage", color: "#66bb6a" },
        ],
        acceptLabel:    "Cast Shield (negate all darts)",
        declineLabel:   "Take the damage",
        spellSlotLevel: 1,
        availableSlots: shieldCheck.slots,
        icon:           "fa-shield-halved",
        accentColor:    "#42a5f5",
      });

      if (promptResult.accepted) {
        // ── Consume slot, mark reaction, apply Shield effect ──
        const slotLevel = promptResult.choiceData?.slotLevel ?? 1;
        await this._consumeSpellSlot(targetActor, slotLevel);
        await this._markReactionUsed(targetActor);
        await this._applyShieldEffect(targetActor);

        // ── Post chat caption noting the negation ──
        await this._postReactionChat(
          targetActor,
          "Shield",
          `${targetActor.name} casts <strong>Shield</strong>! All ${darts} dart${darts !== 1 ? "s" : ""} from ${caster.name}'s Magic Missile are nullified — no damage taken.`,
          "#42a5f5"
        );

        this._debug(`Magic Missile Shield: ${targetActor.name} negated ${darts} darts`);

        // DON'T add this target to the modified distribution — they take no damage.
        // Their darts simply vanish (Shield doesn't redirect; the darts are absorbed).
      } else {
        // Declined or timeout — they take the darts.
        modified.set(targetActor, darts);
      }
    }

    return modified;
  }

  /**
   * Check if an actor can cast Shield.
   * @returns {{ canUse: boolean, slots: object[] }}
   */
  _canUseShield(actor) {
    // Reaction already used?
    if (this._hasUsedReaction(actor)) return { canUse: false, slots: [] };

    // Has Shield spell prepared/known?
    const hasShield = this._hasSpellPrepared(actor, "Shield");
    if (!hasShield) return { canUse: false, slots: [] };

    // Has a spell slot of 1st level or higher?
    const slots = this._getAvailableSlots(actor, 1);
    if (!slots.length) return { canUse: false, slots: [] };

    return { canUse: true, slots };
  }

  /**
   * Apply the Shield spell active effect to an actor.
   * +5 AC until start of the caster's next turn.
   */
  async _applyShieldEffect(actor) {
    // Determine duration: until start of this actor's next turn
    // In combat, that's approximately 1 round from now
    const combat = game.combat;
    let duration = {};
    if (combat) {
      duration = {
        rounds: 1,
        startRound: combat.round,
        startTurn: combat.turn,
      };
    } else {
      // Out of combat, 6 seconds
      duration = { seconds: 6 };
    }

    const effectData = {
      name: "Shield",
      icon: "icons/magic/defensive/shield-barrier-flaming-diamond-blue.webp",
      origin: actor.uuid,
      duration,
      changes: [
        {
          key: "system.attributes.ac.bonus",
          mode: CONST.ACTIVE_EFFECT_MODES.ADD,
          value: "5",
          priority: 20,
        },
      ],
      flags: {
        [MODULE_ID]: {
          type: "reactionEffect",
          reaction: "shield",
          autoRemove: true,
        },
      },
    };

    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
    this._debug(`Shield effect applied to ${actor.name}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  2. COUNTERSPELL — Pre-Spell Reaction (when a creature casts a spell)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Internal handler for spell cast detection.
   * Checks for Counterspell reactors within 60ft.
   */
  async _onSpellCast(activity, message) {
    // EVERY exit point must resolve the cast barrier so downstream engines
    // (SpellAutoDamage, etc.) don't hang awaiting it.
    if (!activity?.item) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_item" });
      return;
    }
    const item = activity.item;
    const casterActor = activity.actor ?? item.actor;

    // Only react to spell-type items
    if (item.type !== "spell") {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "not_spell" });
      return;
    }

    // Cantrips can't be counterspelled
    const spellLevel = item.system?.level ?? 0;
    if (spellLevel === 0) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "cantrip" });
      return;
    }

    // Get the caster's token
    const casterToken = this._getActorToken(casterActor);
    if (!casterToken) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_caster_token" });
      return;
    }

    // Find all eligible Counterspell reactors within 60ft
    const reactors = this._findCounterspellReactors(casterToken, casterActor);
    if (!reactors.length) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_reactors" });
      return;
    }

    this._debug(`Counterspell check: ${casterActor.name} casts ${item.name} (level ${spellLevel}), ${reactors.length} eligible reactors`);

    // Resolve the spell's targets so the prompt can show "casting Bless on
    // Varek Thalor" instead of just "casting Bless". Three sources, in order:
    //   1. dnd5e usage flag on the chat message (most reliable for the player
    //      who initiated the cast)
    //   2. activity.targets if the dnd5e activity carries them
    //   3. game.user.targets fallback on the caster's client
    let targetNames = "";
    try {
      const msgTargets = message?.flags?.dnd5e?.targets ?? message?.flags?.dnd5e?.use?.targets;
      if (Array.isArray(msgTargets) && msgTargets.length) {
        const names = msgTargets.map(t => {
          if (typeof t === "string") {
            const a = fromUuidSync?.(t);
            return a?.name ?? a?.actor?.name;
          }
          return t?.name ?? t?.actor?.name ?? t?.token?.name;
        }).filter(Boolean);
        if (names.length) targetNames = names.join(", ");
      }
      if (!targetNames) {
        const activityTargets = activity?.targets ?? [];
        const names = [...activityTargets].map(t => t?.actor?.name ?? t?.name).filter(Boolean);
        if (names.length) targetNames = names.join(", ");
      }
      if (!targetNames && game.user.targets?.size) {
        const names = [...game.user.targets].map(t => t.name).filter(Boolean);
        if (names.length) targetNames = names.join(", ");
      }
    } catch (_) { /* non-fatal — leave targetNames empty */ }

    // Build the detail rows. Target line only appears when we resolved at least one name.
    const detailRows = [
      { label: "Spell", value: item.name },
      { label: "Spell Level", value: spellLevel },
    ];
    if (targetNames) {
      detailRows.push({ label: "Target", value: targetNames });
    }
    detailRows.push({ label: "Range", value: "60 ft (must see caster)" });

    // Prompt all eligible reactors simultaneously — first to accept wins
    const result = await this._promptMultipleReactors(reactors, {
      type: "counterspell",
      title: "Counterspell",
      description: `<strong>${casterActor.name}</strong> is casting <strong>${item.name}</strong> (Level ${spellLevel} spell)${targetNames ? ` on <strong>${targetNames}</strong>` : ""}.`,
      details: detailRows,
      acceptLabel: "Cast Counterspell",
      declineLabel: "Let It Go",
      spellSlotLevel: 3,
      icon: "fa-hand-sparkles",
      accentColor: "#ab47bc",
      // Pass extra data for slot picker
      extraData: { targetSpellLevel: spellLevel },
    });

    if (result.accepted) {
      const reactor = result.reactor;
      const slotLevel = result.choiceData?.slotLevel ?? 3;

      // Consume spell slot
      await this._consumeSpellSlot(reactor.actor, slotLevel);

      // Mark reaction used
      await this._markReactionUsed(reactor.actor);

      // Determine success
      let countered = false;
      let checkResult = null;

      if (slotLevel >= spellLevel) {
        // Auto-success: counterspell slot >= spell level
        countered = true;
        this._debug(`Counterspell AUTO-SUCCESS: ${reactor.actor.name} (slot ${slotLevel} >= spell ${spellLevel})`);
      } else {
        // Ability check required: DC = 10 + spell level
        const dc = 10 + spellLevel;
        const spellcastingAbility = this._getSpellcastingAbility(reactor.actor);
        const abilityMod = reactor.actor.system?.abilities?.[spellcastingAbility]?.mod ?? 0;
        const profBonus = reactor.actor.system?.attributes?.prof ?? 0;

        // Check for Abjuration Wizard feature (adds proficiency to counterspell checks)
        const hasImprovedAbjuration = this._hasFeature(reactor.actor, "Improved Abjuration");

        // Roll the check
        const roll = await new Roll(`1d20 + ${abilityMod}${hasImprovedAbjuration ? ` + ${profBonus}` : ""}`).evaluate();
        checkResult = roll.total;
        countered = checkResult >= dc;

        this._debug(`Counterspell CHECK: ${reactor.actor.name} rolled ${checkResult} vs DC ${dc} → ${countered ? "SUCCESS" : "FAIL"}`);
      }

      if (countered) {
        // ── Mechanical line + randomized flavor line (v0.7.17b) ──
        const flavorOptions = [
          `${casterActor.name}'s ${item.name} unravels in their hands.`,
          `${casterActor.name}'s ${item.name} is unwoven before it can take form.`,
          `${casterActor.name}'s ${item.name} fizzles into shimmering blue motes.`,
          `${casterActor.name}'s ${item.name} crumbles back into raw arcane noise.`,
          `${casterActor.name}'s ${item.name} dissolves mid-cast, the weave torn apart.`,
        ];
        const flavorText = flavorOptions[Math.floor(Math.random() * flavorOptions.length)];
        const mechanical = `${reactor.actor.name} counterspells ${casterActor.name}'s ${item.name}!${checkResult !== null ? ` (Check: ${checkResult} vs DC ${10 + spellLevel})` : " (auto-success)"}`;
        const flavorBlock = `<div style="margin-top:10px;padding-top:8px;border-top:1px dashed #6b5230;font-size:15px;font-style:italic;color:#e1bee7;font-weight:600;">— ${flavorText}</div>`;
        await this._postReactionChat(reactor.actor, "Counterspell",
          `${mechanical}${flavorBlock}`,
          "#ab47bc");

        // Cancel the spell — set a flag that other engines can check
        // The spell's effects should be suppressed. We flag the message.
        if (message) {
          await message.setFlag(MODULE_ID, "counterspelled", {
            by: reactor.actor.name,
            byActorId: reactor.actor.id,
            spellName: item.name,
            spellLevel,
          });
        }

        // ── v0.7.17b — Play counterspell animations ──
        // Ward bubble on counterspeller (Varek) → 300ms wait → counter-burst
        // on the original caster (Kasimir). One animation per side, both
        // brief, total under 1.5s. Magic Missile's own trajectory animation
        // will be suppressed by SpellAutoDamage when it sees abort:true.
        try {
          await this._playCounterspellAnimations(reactor.actor, casterToken);
        } catch (err) {
          console.warn(`${MODULE_ID} | Counterspell animation failed (non-fatal):`, err);
        }

        // Emit hook for other systems to react
        Hooks.callAll(`${MODULE_ID}.spellCountered`, {
          caster: casterActor,
          spell: item,
          counterspeller: reactor.actor,
          slotUsed: slotLevel,
          checkResult,
        });

        // ── Resolve the barrier with abort:true so downstream engines
        //    (SpellAutoDamage, etc.) bail cleanly. ──
        ReactionEngine._resolveCastBarrier(activity, {
          abort: true,
          reason: "counterspelled",
          counterspeller: reactor.actor.name,
        });

      } else {
        await this._postReactionChat(reactor.actor, "Counterspell",
          `${reactor.actor.name} attempts to counterspell ${casterActor.name}'s ${item.name} but fails! (Check: ${checkResult} vs DC ${10 + spellLevel})`,
          "#ef5350");
        // Counter failed — cast continues
        ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "counter_failed" });
      }
    } else {
      // User declined the counterspell prompt — cast continues
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "declined" });
    }
  }

  /**
   * v0.7.17b — Play the two counterspell animations:
   *   1. Ward bubble on the counterspeller (visual: "I'm protected")
   *   2. After 300ms delay, counter-burst on the original caster (visual:
   *      "your spell unravels at your hands")
   *
   * Requires Sequencer + JB2A. Skips silently if either is missing.
   */
  async _playCounterspellAnimations(counterspellerActor, originalCasterToken) {
    // Sequencer is exposed at globalThis.Sequence (v3+) or window.Sequence.
    const Seq = globalThis.Sequence ?? window.Sequence;
    if (!Seq) {
      console.log(`${MODULE_ID} | Counterspell animation: Sequencer not active — skipping visuals`);
      return;
    }
    const counterspellerToken = this._getActorToken(counterspellerActor);
    if (!counterspellerToken || !originalCasterToken) {
      console.log(`${MODULE_ID} | Counterspell animation: missing tokens — skipping`);
      return;
    }

    // Defensive: only play files that actually exist in the user's
    // Sequencer database. Asset-missing failures leave broken sprites
    // that persist forever (the "circular twisting thing" bug). The
    // pre-check prevents that.
    const wardFile   = "jb2a.shield.03.intro.blue";
    const unravelFile = "jb2a.healing_generic.burst.bluewhite";
    const db = globalThis.Sequencer?.Database;
    const wardOK   = db?.entryExists?.(wardFile)   ?? false;
    const unravelOK = db?.entryExists?.(unravelFile) ?? false;
    if (!wardOK && !unravelOK) {
      console.log(`${MODULE_ID} | Counterspell animation: neither effect available in Sequencer DB — skipping`);
      return;
    }

    const seq = new Seq();
    if (wardOK) {
      // (1) Ward bubble on the counterspeller — brief blue shield flash
      seq.effect()
        .file(wardFile)
        .atLocation(counterspellerToken)
        .scaleToObject(2.0)
        .duration(1200)    // hard cap so a failed asset can't persist
        .fadeIn(150)
        .fadeOut(300);
      // (2) Pause so the cause-effect reads cleanly
      seq.wait(300);
    }
    if (unravelOK) {
      // (3) Unravel burst on the original caster — blue-white burst
      // visually reads as "your spell unravels at your hands"
      seq.effect()
        .file(unravelFile)
        .atLocation(originalCasterToken)
        .scaleToObject(1.8)
        .duration(1200)    // hard cap so a failed asset can't persist
        .fadeIn(100)
        .fadeOut(300);
    }
    seq.play();
  }

  /**
   * Called externally to check if a spell was counterspelled.
   * Other engines should call this after the spell cast to decide whether to proceed.
   * @param {ChatMessage} message - The usage message
   * @returns {boolean} true if the spell was countered
   */
  isSpellCountered(message) {
    return !!message?.flags?.[MODULE_ID]?.counterspelled;
  }

  /**
   * Find all creatures within 60ft that can cast Counterspell.
   * Excludes the caster and allies of the caster.
   */
  _findCounterspellReactors(casterToken, casterActor) {
    const reactors = [];
    if (!canvas.tokens?.placeables) return reactors;

    const casterDisposition = casterToken.document?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      if (token.actor.id === casterActor.id) continue;

      // Same disposition = ally, skip (enemies counter enemies)
      if (token.document?.disposition === casterDisposition) continue;

      // Must be alive
      if ((token.actor.system?.attributes?.hp?.value ?? 1) <= 0) continue;

      // Must have reaction available
      if (this._hasUsedReaction(token.actor)) continue;

      // Must have Counterspell prepared/known
      if (!this._hasSpellPrepared(token.actor, "Counterspell")) continue;

      // Must have a 3rd+ level spell slot
      const slots = this._getAvailableSlots(token.actor, 3);
      if (!slots.length) continue;

      // Must be within 60ft and have line of sight
      const distance = CombatState._getDistance(token, casterToken);
      if (distance > 60) continue;

      reactors.push({ actor: token.actor, token, slots, distance });
    }

    return reactors;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  3. ABSORB ELEMENTS — Pre-Damage Reaction (after damage type known)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a target can use Absorb Elements against incoming damage.
   * Called from DamageEngine before damage is applied.
   *
   * @param {object[]} damageComponents - Array of { type: string, total: number }
   * @param {Actor} targetActor - The target taking damage
   * @param {Token} targetToken - The target's token
   * @param {Actor} attacker - The attacking actor
   * @param {Item} attackItem - The weapon/spell that caused damage
   * @returns {{ modifiedComponents: object[], absorbed: boolean, absorbedType: string|null }}
   */
  async checkPreDamageReactions(damageComponents, targetActor, targetToken, attacker, attackItem) {
    if (!QolSettings.get("enableReactions")) return { modifiedComponents: damageComponents, absorbed: false };
    if (!QolSettings.get("autoAbsorbElements")) return { modifiedComponents: damageComponents, absorbed: false };

    // Check if any damage component is an elemental type
    const elementalComponents = damageComponents.filter(c => ABSORB_ELEMENT_TYPES.has(c.type));
    if (!elementalComponents.length) return { modifiedComponents: damageComponents, absorbed: false };

    // Can the target use Absorb Elements?
    if (this._hasUsedReaction(targetActor)) return { modifiedComponents: damageComponents, absorbed: false };
    if (!this._hasSpellPrepared(targetActor, "Absorb Elements")) return { modifiedComponents: damageComponents, absorbed: false };

    const slots = this._getAvailableSlots(targetActor, 1);
    if (!slots.length) return { modifiedComponents: damageComponents, absorbed: false };

    // Determine the dominant elemental damage type
    const dominantType = elementalComponents.reduce((a, b) => a.total >= b.total ? a : b).type;

    // Build damage breakdown for display
    const damageBreakdown = elementalComponents.map(c => `${c.total} ${c.type}`).join(", ");

    const promptResult = await this._promptReaction({
      reactorActor: targetActor,
      reactorToken: targetToken,
      type: "absorbElements",
      title: "Absorb Elements",
      description: `<strong>${targetActor.name}</strong> is about to take elemental damage from <strong>${attacker?.name ?? "a source"}</strong>.`,
      details: [
        { label: "Elemental Damage", value: damageBreakdown },
        { label: "Dominant Type", value: dominantType.charAt(0).toUpperCase() + dominantType.slice(1) },
        { label: "Resistance Granted", value: `${dominantType} (this hit only)` },
        { label: "Bonus Damage", value: `+1d6 ${dominantType} on next melee attack` },
      ],
      acceptLabel: `Absorb Elements (${dominantType})`,
      declineLabel: "No Reaction",
      spellSlotLevel: 1,
      availableSlots: slots,
      icon: "fa-fire-flame-curved",
      accentColor: this._getElementColor(dominantType),
    });

    if (promptResult.accepted) {
      const slotLevel = promptResult.choiceData?.slotLevel ?? 1;

      // Consume spell slot
      await this._consumeSpellSlot(targetActor, slotLevel);

      // Mark reaction used
      await this._markReactionUsed(targetActor);

      // Apply resistance to the elemental damage components (halve them)
      const modifiedComponents = damageComponents.map(c => {
        if (ABSORB_ELEMENT_TYPES.has(c.type)) {
          return { ...c, total: Math.floor(c.total / 2), absorbElementsResisted: true };
        }
        return c;
      });

      // Apply bonus damage flag for next melee attack
      // Bonus dice scale with slot level: 1d6 base + 1d6 per level above 1st
      const bonusDice = slotLevel;
      await targetActor.setFlag(MODULE_ID, "absorbElementsBonus", {
        type: dominantType,
        formula: `${bonusDice}d6`,
        slotLevel,
        timestamp: Date.now(),
      });

      // Apply a visible effect so the player knows it's active
      await this._applyAbsorbElementsEffect(targetActor, dominantType);

      await this._postReactionChat(targetActor, "Absorb Elements",
        `${targetActor.name} absorbs the ${dominantType} energy! Resistance to ${dominantType} for this hit, +${bonusDice}d6 ${dominantType} on next melee attack.`,
        this._getElementColor(dominantType));

      return { modifiedComponents, absorbed: true, absorbedType: dominantType };
    }

    return { modifiedComponents: damageComponents, absorbed: false, absorbedType: null };
  }

  /**
   * Apply a temporary Absorb Elements active effect.
   */
  async _applyAbsorbElementsEffect(actor, damageType) {
    const combat = game.combat;
    const duration = combat
      ? { rounds: 1, startRound: combat.round, startTurn: combat.turn }
      : { seconds: 6 };

    const effectData = {
      name: `Absorb Elements (${damageType})`,
      icon: "icons/magic/defensive/shield-barrier-flaming-diamond-teal.webp",
      origin: actor.uuid,
      duration,
      flags: {
        [MODULE_ID]: {
          type: "reactionEffect",
          reaction: "absorbElements",
          damageType,
          autoRemove: true,
        },
      },
    };

    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  4. LEGENDARY RESISTANCE — Post-Save Reaction (NPC fails a save)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if any NPC that failed a save has Legendary Resistance.
   * Called from SaveEngine after saves are rolled.
   *
   * @param {object[]} saveResults - Array of save results
   *   Each: { tokenDocId, actorId, actor, name, total, dc, saved, ability }
   * @returns {object[]} Modified results (saved may flip to true)
   */
  async checkPostSaveReactions(saveResults) {
    if (!QolSettings.get("enableReactions")) return saveResults;
    if (!QolSettings.get("autoLegendaryResistance")) return saveResults;

    const modified = [];

    for (const result of saveResults) {
      // Only check failures
      if (result.saved) { modified.push(result); continue; }

      const actor = result.actor ?? game.actors.get(result.actorId);
      if (!actor) { modified.push(result); continue; }

      // ── Check for Legendary Resistance ──
      const lrCheck = this._getLegendaryResistance(actor);
      if (!lrCheck.hasLR || lrCheck.usesRemaining <= 0) {
        modified.push(result);
        continue;
      }

      // Legendary Resistance does NOT cost a reaction — it's a separate resource.
      // So we don't check _hasUsedReaction for this one.

      // ── Prompt the GM ──
      const promptResult = await this._promptReaction({
        reactorActor: actor,
        reactorToken: this._getActorToken(actor),
        type: "legendaryResistance",
        title: "Legendary Resistance",
        description: `<strong>${actor.name}</strong> failed a saving throw!`,
        details: [
          { label: "Save Type", value: result.ability?.toUpperCase() ?? "???" },
          { label: "Rolled", value: result.total },
          { label: "DC", value: result.dc },
          { label: "Uses Remaining", value: `${lrCheck.usesRemaining} / ${lrCheck.usesMax}` },
        ],
        acceptLabel: `Use Legendary Resistance (${lrCheck.usesRemaining} left)`,
        declineLabel: "Accept Failure",
        icon: "fa-crown",
        accentColor: "#ffd54f",
        forceGM: true, // Always prompt GM, even if NPC has a player owner
      });

      if (promptResult.accepted) {
        // Deduct one use
        await this._consumeLegendaryResistance(actor, lrCheck.item);

        // Flip the save to success
        result.saved = true;
        result.legendaryResistance = true;

        await this._postReactionChat(actor, "Legendary Resistance",
          `${actor.name} uses Legendary Resistance to succeed on the ${result.ability?.toUpperCase() ?? ""} saving throw! (${lrCheck.usesRemaining - 1} remaining)`,
          "#ffd54f");
      }

      modified.push(result);
    }

    return modified;
  }

  /**
   * Check if an actor has Legendary Resistance uses remaining.
   */
  _getLegendaryResistance(actor) {
    if (!actor?.items) return { hasLR: false, usesRemaining: 0, usesMax: 0, item: null };

    for (const item of actor.items) {
      const name = item.name?.toLowerCase() ?? "";
      if (name.includes("legendary resistance")) {
        const uses = item.system?.uses;
        if (uses) {
          return {
            hasLR: true,
            usesRemaining: uses.value ?? 0,
            usesMax: uses.max ?? 3,
            item,
          };
        }
        // No uses system — check for "3/Day" in description
        const desc = item.system?.description?.value ?? "";
        const match = desc.match(/(\d+)\/day/i);
        const max = match ? parseInt(match[1]) : 3;
        // Use flag to track consumption if item.uses doesn't exist
        const used = actor.getFlag(MODULE_ID, "legendaryResistanceUsed") ?? 0;
        return {
          hasLR: true,
          usesRemaining: Math.max(0, max - used),
          usesMax: max,
          item,
        };
      }
    }

    // Also check the legendary resistance count from system data (Foundry dnd5e stores this)
    const lr = actor.system?.resources?.legres;
    if (lr && lr.max > 0) {
      return {
        hasLR: true,
        usesRemaining: lr.value ?? 0,
        usesMax: lr.max,
        item: null, // system resource, not an item
      };
    }

    return { hasLR: false, usesRemaining: 0, usesMax: 0, item: null };
  }

  /**
   * Consume one Legendary Resistance use.
   */
  async _consumeLegendaryResistance(actor, lrItem) {
    if (lrItem?.system?.uses) {
      const current = lrItem.system.uses.value ?? 0;
      await lrItem.update({ "system.uses.value": Math.max(0, current - 1) });
    } else if (actor.system?.resources?.legres) {
      const current = actor.system.resources.legres.value ?? 0;
      await actor.update({ "system.resources.legres.value": Math.max(0, current - 1) });
    } else {
      // Fallback: track via flag
      const used = (actor.getFlag(MODULE_ID, "legendaryResistanceUsed") ?? 0) + 1;
      await actor.setFlag(MODULE_ID, "legendaryResistanceUsed", used);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  5. SILVERY BARBS — Post-Success Reaction (attack, save, or check succeeds)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if any creature can cast Silvery Barbs after a success.
   * Called from AttackPipeline (attack hits) or SaveEngine (save succeeds).
   *
   * @param {object} opts
   * @param {Actor} opts.actor - The creature that succeeded
   * @param {Token} opts.token - Their token
   * @param {string} opts.rollType - "attack"|"save"|"check"
   * @param {number} opts.total - The roll total
   * @param {number} opts.dc - The DC/AC that was met
   * @param {string} opts.description - e.g., "Goblin's attack roll" or "Dragon's WIS save"
   * @returns {{ rerolled: boolean, newTotal: number|null, barber: Actor|null }}
   */
  async checkSilveryBarbs(opts) {
    if (!QolSettings.get("enableReactions")) return { rerolled: false };

    const { actor, token, rollType, total, dc, description } = opts;
    if (!actor || !token) return { rerolled: false };

    // Find eligible Silvery Barbs casters within 60ft (opponents of the succeeding creature)
    const reactors = this._findSilveryBarbsReactors(token, actor);
    if (!reactors.length) return { rerolled: false };

    this._debug(`Silvery Barbs check: ${actor.name} ${rollType} succeeded (${total}), ${reactors.length} eligible reactors`);

    const result = await this._promptMultipleReactors(reactors, {
      type: "silveryBarbs",
      title: "Silvery Barbs",
      description: `<strong>${actor.name}</strong> succeeded on a ${rollType}!`,
      details: [
        { label: "Creature", value: actor.name },
        { label: "Roll Type", value: rollType.charAt(0).toUpperCase() + rollType.slice(1) },
        { label: "Total", value: total },
        { label: "Needed", value: dc ?? "N/A" },
      ],
      acceptLabel: "Cast Silvery Barbs (Force Reroll)",
      declineLabel: "Allow It",
      spellSlotLevel: 1,
      icon: "fa-wand-sparkles",
      accentColor: "#ce93d8",
    });

    if (result.accepted) {
      const reactor = result.reactor;
      const slotLevel = result.choiceData?.slotLevel ?? 1;

      // Consume spell slot
      await this._consumeSpellSlot(reactor.actor, slotLevel);

      // Mark reaction used
      await this._markReactionUsed(reactor.actor);

      // Force reroll — roll a new d20 and take the lower
      const reroll = await new Roll("1d20").evaluate();
      const rerollD20 = reroll.total;

      // Reconstruct the total: replace the original d20 with the reroll
      // (we need the modifier portion: total - original d20)
      // Since we don't have the exact breakdown, we use the lower of the two totals
      // In practice, the reroll replaces the d20 — creature uses lower result
      // For simplicity, we treat this as: if reroll d20 < original implied d20, use reroll
      const originalD20Approx = total - (dc ? 0 : 0); // We need better data from caller
      // The correct approach: the creature rerolls the d20 and must use the new result
      // We pass back the reroll and let the caller compute
      const newTotal = total - 0 + 0; // Caller will need to recompute — see integration note

      await this._postReactionChat(reactor.actor, "Silvery Barbs",
        `${reactor.actor.name} casts Silvery Barbs! ${actor.name} must reroll (new d20: ${rerollD20}).`,
        "#ce93d8");

      // Emit hook for the ally advantage portion
      // Reactor chooses an ally within 30ft to gain advantage on next roll
      Hooks.callAll(`${MODULE_ID}.silveryBarbsCast`, {
        caster: reactor.actor,
        target: actor,
        rerollD20,
      });

      return { rerolled: true, newD20: rerollD20, barber: reactor.actor };
    }

    return { rerolled: false };
  }

  /**
   * Find creatures that can cast Silvery Barbs against a succeeding creature.
   */
  _findSilveryBarbsReactors(successToken, successActor) {
    const reactors = [];
    if (!canvas.tokens?.placeables) return reactors;

    const successDisposition = successToken.document?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      if (token.actor.id === successActor.id) continue;

      // Must be an opponent (different disposition)
      if (token.document?.disposition === successDisposition) continue;

      // Must be alive
      if ((token.actor.system?.attributes?.hp?.value ?? 1) <= 0) continue;

      // Must have reaction
      if (this._hasUsedReaction(token.actor)) continue;

      // Must have Silvery Barbs prepared
      if (!this._hasSpellPrepared(token.actor, "Silvery Barbs")) continue;

      // Must have a 1st+ level spell slot
      const slots = this._getAvailableSlots(token.actor, 1);
      if (!slots.length) continue;

      // Must be within 60ft
      const distance = CombatState._getDistance(token, successToken);
      if (distance > 60) continue;

      reactors.push({ actor: token.actor, token, slots, distance });
    }

    return reactors;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  6. CUTTING WORDS (Lore Bard) — Pre-Finalize Reaction
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a Lore Bard can use Cutting Words to reduce a roll.
   * Called from AttackPipeline (attack roll) or DamageEngine (damage roll).
   *
   * @param {object} opts
   * @param {Actor} opts.actor - The creature that rolled
   * @param {Token} opts.token - Their token
   * @param {string} opts.rollType - "attack"|"damage"|"check"
   * @param {number} opts.total - The roll total
   * @param {string} opts.description - Context string
   * @returns {{ reduced: boolean, reduction: number, newTotal: number }}
   */
  async checkCuttingWords(opts) {
    if (!QolSettings.get("enableReactions")) return { reduced: false, reduction: 0 };

    const { actor, token, rollType, total, description } = opts;
    if (!actor || !token) return { reduced: false, reduction: 0 };

    // Find eligible Lore Bards within 60ft
    const reactors = this._findCuttingWordsReactors(token, actor);
    if (!reactors.length) return { reduced: false, reduction: 0 };

    this._debug(`Cutting Words check: ${actor.name} ${rollType} (${total}), ${reactors.length} eligible bards`);

    const result = await this._promptMultipleReactors(reactors, {
      type: "cuttingWords",
      title: "Cutting Words",
      description: `<strong>${actor.name}</strong> rolled a ${total} on a ${rollType}.`,
      details: [
        { label: "Creature", value: actor.name },
        { label: "Roll Type", value: rollType.charAt(0).toUpperCase() + rollType.slice(1) },
        { label: "Total", value: total },
        { label: "Subtract", value: "Bardic Inspiration die" },
      ],
      acceptLabel: "Use Cutting Words",
      declineLabel: "Stay Quiet",
      icon: "fa-comment-slash",
      accentColor: "#ff8a65",
    });

    if (result.accepted) {
      const reactor = result.reactor;

      // Consume a Bardic Inspiration use
      await this._consumeBardicInspiration(reactor.actor);

      // Mark reaction used
      await this._markReactionUsed(reactor.actor);

      // Roll the Bardic Inspiration die
      const bardDie = this._getBardicInspirationDie(reactor.actor);
      const roll = await new Roll(bardDie).evaluate();
      const reduction = roll.total;
      const newTotal = total - reduction;

      await this._postReactionChat(reactor.actor, "Cutting Words",
        `${reactor.actor.name} uses Cutting Words! Subtracts ${reduction} (${bardDie}) from ${actor.name}'s ${rollType} (${total} → ${newTotal}).`,
        "#ff8a65");

      return { reduced: true, reduction, newTotal };
    }

    return { reduced: false, reduction: 0 };
  }

  /**
   * Find Lore Bards with Cutting Words and Bardic Inspiration uses.
   */
  _findCuttingWordsReactors(targetToken, targetActor) {
    const reactors = [];
    if (!canvas.tokens?.placeables) return reactors;

    const targetDisposition = targetToken.document?.disposition ?? 1;

    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      if (token.actor.id === targetActor.id) continue;

      // Must be an opponent
      if (token.document?.disposition === targetDisposition) continue;

      // Must be alive
      if ((token.actor.system?.attributes?.hp?.value ?? 1) <= 0) continue;

      // Must have reaction
      if (this._hasUsedReaction(token.actor)) continue;

      // Must have Cutting Words feature (Lore Bard 3+)
      if (!this._hasFeature(token.actor, "Cutting Words")) continue;

      // Must have Bardic Inspiration uses
      const biUses = this._getBardicInspirationUses(token.actor);
      if (biUses <= 0) continue;

      // Must be within 60ft
      const distance = CombatState._getDistance(token, targetToken);
      if (distance > 60) continue;

      reactors.push({ actor: token.actor, token, distance });
    }

    return reactors;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  7. OPPORTUNITY ATTACK TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark that a creature made an opportunity attack (uses their reaction).
   * Call this from wherever OAs are detected.
   * @param {Actor} actor - The creature that made the OA
   */
  async trackOpportunityAttack(actor) {
    if (!actor) return;
    await this._markReactionUsed(actor);
    this._debug(`Opportunity attack tracked: ${actor.name} (reaction consumed)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Prompt System — Send Reaction Dialogs to Players
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Prompt a single reactor's owner for a reaction choice.
   * Routes to the correct player via socket, or shows locally for GM.
   *
   * @param {object} opts - Prompt configuration
   * @returns {Promise<{ accepted: boolean, choiceData: object }>}
   */
  async _promptReaction(opts) {
    const { reactorActor, reactorToken, forceGM } = opts;
    const timeout = (QolSettings.get("reactionTimeout") ?? DEFAULT_TIMEOUT) * 1000;

    // Determine who should see this prompt
    const ownerId = forceGM ? game.users.find(u => u.isGM)?.id : this._getOwnerUserId(reactorActor);

    // If the owner is the current user (GM or player), show locally
    if (ownerId === game.user.id) {
      return this._promptLocal(opts, timeout);
    }

    // Otherwise, send via socket to the owning player
    return this._promptRemote(opts, ownerId, timeout);
  }

  /**
   * Show a reaction prompt locally (this client).
   */
  async _promptLocal(opts, timeout) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ accepted: false, choiceData: {} });
      }, timeout);

      // ── Serialize reactor reference for the dialog ──
      // showReactionDialog destructures `reactorActorName` / `reactorActorImg`
      // (strings), not the live actor object. The remote socket path serializes
      // these already; the local path was forwarding only the live `reactorActor`
      // object, so the dialog destructure returned undefined and the header fell
      // back to "Unknown". Bug fix: surface the same string fields here.
      ReactionEngine.showReactionDialog({
        ...opts,
        reactorActorName: opts.reactorActor?.name ?? opts.reactorActorName ?? "Reaction",
        reactorActorImg: opts.reactorActor?.img
          ?? opts.reactorToken?.document?.texture?.src
          ?? opts.reactorActorImg
          ?? null,
        timeoutMs: timeout,
      }).then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(() => {
        clearTimeout(timer);
        resolve({ accepted: false, choiceData: {} });
      });
    });
  }

  /**
   * Send a reaction prompt to a remote player via socket.
   */
  async _promptRemote(opts, targetUserId, timeout) {
    return new Promise((resolve) => {
      const requestId = `reaction-${++this._requestCounter}-${Date.now()}`;

      // Set up timeout
      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        resolve({ accepted: false, choiceData: {} });
      }, timeout + 2000); // Extra 2s buffer for network latency

      this._pendingRequests.set(requestId, { resolve, timeout: timer, reactorActorId: opts.reactorActor?.id });

      // Send to player
      game.socket.emit(SOCKET_NAME, {
        action: "showReactionPrompt",
        targetUserId,
        requestId,
        promptData: {
          ...opts,
          // Serialize actor/token references (can't send full objects over socket)
          reactorActorId: opts.reactorActor?.id,
          reactorActorName: opts.reactorActor?.name,
          reactorActorImg: opts.reactorActor?.img ?? opts.reactorToken?.document?.texture?.src,
          reactorTokenId: opts.reactorToken?.id,
          timeoutMs: timeout,
          // Strip non-serializable fields
          reactorActor: undefined,
          reactorToken: undefined,
        },
      });
    });
  }

  /**
   * Prompt multiple reactors simultaneously. First to accept wins.
   * Used for Counterspell and Silvery Barbs where multiple creatures may react.
   *
   * @param {object[]} reactors - Array of { actor, token, slots?, distance }
   * @param {object} promptOpts - Base prompt options (merged with reactor-specific data)
   * @returns {Promise<{ accepted: boolean, reactor: object|null, choiceData: object }>}
   */
  async _promptMultipleReactors(reactors, promptOpts) {
    if (!reactors.length) return { accepted: false, reactor: null, choiceData: {} };

    // If only one reactor, just prompt them directly
    if (reactors.length === 1) {
      const r = reactors[0];
      const result = await this._promptReaction({
        ...promptOpts,
        reactorActor: r.actor,
        reactorToken: r.token,
        availableSlots: r.slots,
      });
      return { ...result, reactor: result.accepted ? r : null };
    }

    // Multiple reactors: race them
    return new Promise((resolve) => {
      let resolved = false;
      const abortControllers = [];

      const onResult = (reactor, result) => {
        if (resolved) return;
        if (result.accepted) {
          resolved = true;
          // Cancel remaining prompts (they'll time out gracefully)
          resolve({ accepted: true, reactor, choiceData: result.choiceData });
        }
      };

      // Send prompts to all reactors
      const promises = reactors.map(async (r) => {
        const result = await this._promptReaction({
          ...promptOpts,
          reactorActor: r.actor,
          reactorToken: r.token,
          availableSlots: r.slots,
        });
        onResult(r, result);
        return result;
      });

      // If all decline, resolve as declined
      Promise.all(promises).then(() => {
        if (!resolved) {
          resolved = true;
          resolve({ accepted: false, reactor: null, choiceData: {} });
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dialog UI — Reaction Prompt Renderer
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render a reaction prompt dialog. Static — can be called on any client.
   * Matches the ACE QOL aesthetic (dark background, gold accents).
   *
   * @param {object} data - Prompt data
   * @returns {Promise<{ accepted: boolean, choiceData: object }>}
   */
  static showReactionDialog(data) {
    return new Promise((resolve) => {
      const {
        type, title, description, details, acceptLabel, declineLabel,
        spellSlotLevel, availableSlots, icon, accentColor,
        reactorActorName, reactorActorImg, timeoutMs, extraData,
      } = data;

      const timeoutSec = Math.ceil((timeoutMs ?? DEFAULT_TIMEOUT * 1000) / 1000);
      const accent = accentColor ?? "#d4af37";
      let resolved = false;

      // ── Build details rows ──
      const detailRows = (details ?? []).map(d =>
        `<div class="ace-qol-reaction-detail">
          <span class="ace-qol-reaction-detail-label">${d.label}</span>
          <span class="ace-qol-reaction-detail-value" ${d.color ? `style="color:${d.color}"` : ""}>${d.value}</span>
        </div>`
      ).join("");

      // ── Build slot picker (if applicable) ──
      let slotPickerHtml = "";
      if (spellSlotLevel && availableSlots?.length) {
        const options = availableSlots.map(s => {
          const label = s.level === 1 ? "1st" : s.level === 2 ? "2nd" : s.level === 3 ? "3rd" : `${s.level}th`;
          const selected = s.level === spellSlotLevel ? "selected" : "";
          return `<option value="${s.level}" ${selected}>${label} level (${s.current}/${s.max})</option>`;
        }).join("");
        slotPickerHtml = `
          <div class="ace-qol-reaction-slot-picker">
            <label>Spell Slot:</label>
            <select class="ace-qol-reaction-slot-select">${options}</select>
          </div>`;
      }

      // ── Countdown timer ──
      const timerHtml = `<div class="ace-qol-reaction-timer">
        <div class="ace-qol-reaction-timer-bar" style="background:${accent}"></div>
        <span class="ace-qol-reaction-timer-text">${timeoutSec}s</span>
      </div>`;

      // ── Full dialog HTML ──
      const html = `
        <div class="ace-qol-reaction-prompt" data-reaction-type="${type}">
          <div class="ace-qol-reaction-header" style="border-color:${accent}">
            ${reactorActorImg ? `<img src="${reactorActorImg}" class="ace-qol-reaction-portrait" />` : ""}
            <div class="ace-qol-reaction-header-text">
              <span class="ace-qol-reaction-actor-name">${reactorActorName ?? "Unknown"}</span>
              <span class="ace-qol-reaction-type-label" style="color:${accent}">
                <i class="fas ${icon ?? "fa-bolt"}"></i> ${title}
              </span>
            </div>
          </div>
          <div class="ace-qol-reaction-body">
            <div class="ace-qol-reaction-description">${description}</div>
            <div class="ace-qol-reaction-details">${detailRows}</div>
            ${slotPickerHtml}
          </div>
          ${timerHtml}
          <div class="ace-qol-reaction-buttons">
            <button class="ace-qol-reaction-accept" style="border-color:${accent}; color:${accent}">
              <i class="fas ${icon ?? "fa-check"}"></i> ${acceptLabel ?? "Use Reaction"}
            </button>
            <button class="ace-qol-reaction-decline">
              <i class="fas fa-xmark"></i> ${declineLabel ?? "Decline"}
            </button>
          </div>
        </div>
      `;

      const dialog = new Dialog({
        title: `⚡ ${title} — ${reactorActorName ?? "Reaction"}`,
        content: html,
        buttons: {},
        render: (jq) => {
          const el = jq[0] ?? jq;

          // ── Countdown animation ──
          const timerBar = el.querySelector(".ace-qol-reaction-timer-bar");
          const timerText = el.querySelector(".ace-qol-reaction-timer-text");
          if (timerBar) {
            timerBar.style.transition = `width ${timeoutSec}s linear`;
            requestAnimationFrame(() => { timerBar.style.width = "0%"; });
          }
          let countdown = timeoutSec;
          const countdownInterval = setInterval(() => {
            countdown--;
            if (timerText) timerText.textContent = `${Math.max(0, countdown)}s`;
            if (countdown <= 0) clearInterval(countdownInterval);
          }, 1000);

          // ── Auto-close on timeout ──
          const autoCloseTimer = setTimeout(() => {
            clearInterval(countdownInterval);
            if (!resolved) {
              resolved = true;
              resolve({ accepted: false, choiceData: {} });
              dialog.close();
            }
          }, timeoutMs ?? DEFAULT_TIMEOUT * 1000);

          // ── Accept button ──
          el.querySelector(".ace-qol-reaction-accept")?.addEventListener("click", () => {
            clearTimeout(autoCloseTimer);
            clearInterval(countdownInterval);
            if (resolved) return;
            resolved = true;

            const slotSelect = el.querySelector(".ace-qol-reaction-slot-select");
            const slotLevel = slotSelect ? parseInt(slotSelect.value) : (spellSlotLevel ?? null);

            resolve({ accepted: true, choiceData: { slotLevel } });
            dialog.close();
          });

          // ── Decline button ──
          el.querySelector(".ace-qol-reaction-decline")?.addEventListener("click", () => {
            clearTimeout(autoCloseTimer);
            clearInterval(countdownInterval);
            if (resolved) return;
            resolved = true;
            resolve({ accepted: false, choiceData: {} });
            dialog.close();
          });
        },
        close: () => {
          if (!resolved) {
            resolved = true;
            resolve({ accepted: false, choiceData: {} });
          }
        },
      }, {
        classes: ["ace-qol-reaction-dialog"],
        width: 460,
        height: "auto",
        // Center on screen — matches the advantage prompt placement so player
        // attention always lands at the same spot for time-critical decisions.
        top: Math.max(40, Math.floor(window.innerHeight / 2 - 240)),
        left: Math.max(20, Math.floor(window.innerWidth / 2 - 230)),
      });

      dialog.render(true);

      // Play a notification sound so the player notices
      try {
        AudioHelper.play({ src: "sounds/notify.wav", volume: 0.4, autoplay: true }, false);
      } catch (err) { console.debug("ace-qol | ReactionEngine notification sound playback:", err); }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Notifications — Reaction Outcome Messages
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a compact reaction notification to chat.
   */
  async _postReactionChat(actor, reactionName, text, accentColor = "#d4af37") {
    // v0.7.17b — inline-styled dark wrapper. The previous CSS-class
    // version inherited Foundry's parchment chat-card background and
    // rendered as light-on-light. Inline styles guarantee the brand
    // look regardless of upstream CSS scope.
    const html = `
      <div style="background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);border:2px solid ${accentColor};border-radius:6px;padding:14px;color:#f0e4c0;font-family:'Signika','Helvetica Neue',sans-serif;box-shadow:0 0 12px ${accentColor}33;">
        <div style="display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;color:${accentColor};text-transform:uppercase;letter-spacing:0.6px;border-bottom:1px solid #4a3a28;padding-bottom:8px;margin-bottom:10px;">
          <i class="fas fa-bolt" style="font-size:18px;color:${accentColor};"></i>
          <span>REACTION — ${reactionName.toUpperCase()}</span>
        </div>
        <div style="font-size:16px;line-height:1.5;color:#f0e4c0;font-weight:500;">${text}</div>
      </div>
    `;

    await ChatMessage.create({
      content: html,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "reactionNotification",
          reaction: reactionName.toLowerCase().replace(/\s+/g, "-"),
          actorId: actor.id,
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Utility — Spell/Feature/Slot Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if an actor has a spell prepared (or known, for spontaneous casters).
   */
  _hasSpellPrepared(actor, spellName) {
    if (!actor?.items) return false;
    const lcName = spellName.toLowerCase();

    for (const item of actor.items) {
      if (item.type !== "spell") continue;
      if (!item.name?.toLowerCase().includes(lcName)) continue;

      // Check preparation mode — always-prepared, prepared, pact, innate, atwill
      const prep = item.system?.preparation;
      if (!prep) return true; // No preparation data = always available (e.g., innate)

      // "always" and "atwill" are always available
      if (prep.mode === "always" || prep.mode === "atwill" || prep.mode === "innate") return true;

      // "prepared" mode must be currently prepared
      if (prep.mode === "prepared" && prep.prepared) return true;

      // Pact magic spells are always prepared
      if (prep.mode === "pact") return true;

      // Spontaneous casters (sorcerer, bard, warlock) don't need preparation
      // They just have the spell in their list
      if (!prep.mode || prep.mode === "") return true;
    }

    return false;
  }

  /**
   * Get available spell slots at or above a minimum level.
   * @returns {object[]} Array of { level, current, max, isPact }
   */
  _getAvailableSlots(actor, minLevel = 1) {
    const slots = [];
    const spells = actor.system?.spells ?? {};

    for (let level = minLevel; level <= 9; level++) {
      const slot = spells[`spell${level}`];
      if (slot && slot.value > 0 && slot.max > 0) {
        slots.push({ level, current: slot.value, max: slot.max });
      }
    }

    // Pact slots
    if (spells.pact?.value > 0 && spells.pact?.max > 0 && (spells.pact.level ?? 1) >= minLevel) {
      slots.push({
        level: spells.pact.level ?? 1,
        current: spells.pact.value,
        max: spells.pact.max,
        isPact: true,
      });
    }

    return slots;
  }

  /**
   * Consume a spell slot from an actor.
   */
  async _consumeSpellSlot(actor, level) {
    const spells = actor.system?.spells ?? {};

    // Try pact slots first if the level matches
    if (spells.pact?.value > 0 && (spells.pact.level ?? 1) === level) {
      await actor.update({ "system.spells.pact.value": spells.pact.value - 1 });
      this._debug(`Consumed pact slot (level ${level}) from ${actor.name}`);
      return;
    }

    // Regular spell slot
    const slotKey = `spell${level}`;
    const slot = spells[slotKey];
    if (slot?.value > 0) {
      await actor.update({ [`system.spells.${slotKey}.value`]: slot.value - 1 });
      this._debug(`Consumed level ${level} spell slot from ${actor.name} (${slot.value - 1} remaining)`);
    }
  }

  /**
   * Check if an actor has a feature/class feature by name.
   */
  _hasFeature(actor, name) {
    if (!actor?.items) return false;
    const lcName = name.toLowerCase();
    for (const item of actor.items) {
      if ((item.type === "feat" || item.type === "class" || item.type === "subclass")
          && item.name?.toLowerCase().includes(lcName)) return true;
    }
    return false;
  }

  /**
   * Get the owning player's user ID for an actor.
   * Returns the GM's user ID for unowned NPCs.
   */
  _getOwnerUserId(actor) {
    if (!actor) return game.user.id;

    // Check for player ownership (not just "observer")
    const ownership = actor.ownership ?? {};
    for (const [userId, level] of Object.entries(ownership)) {
      if (userId === "default") continue;
      if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
        const user = game.users.get(userId);
        if (user && user.active && !user.isGM) return userId;
      }
    }

    // No active player owner — falls to GM
    return game.users.find(u => u.isGM && u.active)?.id ?? game.user.id;
  }

  /**
   * Get a token for an actor (first active token on the current scene).
   */
  _getActorToken(actor) {
    if (!actor) return null;
    const tokens = actor.getActiveTokens?.() ?? [];
    return tokens[0] ?? canvas.tokens?.placeables?.find(t => t.actor?.id === actor.id) ?? null;
  }

  /**
   * Get the spellcasting ability for an actor (INT, WIS, CHA, etc.)
   */
  _getSpellcastingAbility(actor) {
    // Check for explicitly set spellcasting ability
    const spellcastingAbility = actor.system?.attributes?.spellcasting;
    if (spellcastingAbility) return spellcastingAbility;

    // Infer from class
    const classAbilities = {
      wizard: "int", artificer: "int",
      cleric: "wis", druid: "wis", ranger: "wis", monk: "wis",
      bard: "cha", paladin: "cha", sorcerer: "cha", warlock: "cha",
    };

    for (const item of actor.items ?? []) {
      if (item.type === "class") {
        const className = item.name?.toLowerCase() ?? "";
        for (const [cls, ability] of Object.entries(classAbilities)) {
          if (className.includes(cls)) return ability;
        }
        // Check spellcasting.ability on the class item itself
        if (item.system?.spellcasting?.ability) return item.system.spellcasting.ability;
      }
    }

    // Fallback: use highest mental stat
    const abilities = actor.system?.abilities ?? {};
    const mental = [
      { key: "int", mod: abilities.int?.mod ?? 0 },
      { key: "wis", mod: abilities.wis?.mod ?? 0 },
      { key: "cha", mod: abilities.cha?.mod ?? 0 },
    ];
    return mental.reduce((a, b) => a.mod >= b.mod ? a : b).key;
  }

  /**
   * Get Bardic Inspiration remaining uses for an actor.
   */
  _getBardicInspirationUses(actor) {
    for (const item of actor.items ?? []) {
      const name = item.name?.toLowerCase() ?? "";
      if (name.includes("bardic inspiration") && item.system?.uses) {
        return item.system.uses.value ?? 0;
      }
    }
    return 0;
  }

  /**
   * Consume one Bardic Inspiration use.
   */
  async _consumeBardicInspiration(actor) {
    for (const item of actor.items ?? []) {
      const name = item.name?.toLowerCase() ?? "";
      if (name.includes("bardic inspiration") && item.system?.uses) {
        const current = item.system.uses.value ?? 0;
        if (current > 0) {
          await item.update({ "system.uses.value": current - 1 });
          this._debug(`Consumed Bardic Inspiration from ${actor.name} (${current - 1} remaining)`);
        }
        return;
      }
    }
  }

  /**
   * Get the Bardic Inspiration die size for a bard.
   */
  _getBardicInspirationDie(actor) {
    const bardLevel = this._getClassLevel(actor, "bard");
    if (bardLevel >= 15) return "1d12";
    if (bardLevel >= 10) return "1d10";
    if (bardLevel >= 5) return "1d8";
    return "1d6";
  }

  /**
   * Get a class level for an actor.
   */
  _getClassLevel(actor, className) {
    for (const item of actor.items ?? []) {
      if (item.type === "class" && item.name?.toLowerCase().includes(className.toLowerCase())) {
        return item.system?.levels ?? 0;
      }
    }
    return 0;
  }

  /**
   * Get the accent color for an element type (for Absorb Elements display).
   */
  _getElementColor(type) {
    const colors = {
      acid:      "#c6ff00",
      cold:      "#81d4fa",
      fire:      "#ff6d00",
      lightning: "#ffd54f",
      thunder:   "#b39ddb",
    };
    return colors[type] ?? "#d4af37";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug
  // ═══════════════════════════════════════════════════════════════════════════

  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | REACTION | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//
//  CSS — Reaction Dialog & Chat Styles
//
//  Add this to styles/ace-qol.css (or inject inline).
//  See the integration section at the bottom of this file for the full CSS block.
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Inject reaction engine CSS into the document head.
 * Called once during module initialization.
 */
export function injectReactionCSS() {
  if (document.getElementById("ace-qol-reaction-css")) return;

  const style = document.createElement("style");
  style.id = "ace-qol-reaction-css";
  style.textContent = `
/* ═══════════════════════════════════════════════════════════════════════════
   ACE QOL — Reaction Engine Styles
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Dialog Chrome ── */
.ace-qol-reaction-dialog .dialog-content { padding: 0; }
.ace-qol-reaction-dialog .window-content {
  background: linear-gradient(180deg, #111116 0%, #0c0c0f 100%);
}
.ace-qol-reaction-dialog .window-header {
  background: linear-gradient(180deg, #1a1a20 0%, #111116 100%) !important;
  border-bottom: 1px solid rgba(212,175,55,0.25) !important;
}

/* ── Prompt Container ── */
.ace-qol-reaction-prompt {
  padding: 0;
  font-family: 'Rajdhani', sans-serif;
}

/* ── Header (portrait + name + type) ── */
.ace-qol-reaction-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 2px solid rgba(212,175,55,0.3);
  background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%);
}
.ace-qol-reaction-portrait {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 2px solid rgba(212,175,55,0.4);
  object-fit: cover;
}
.ace-qol-reaction-header-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ace-qol-reaction-actor-name {
  font-size: 1rem;
  font-weight: 800;
  color: #e0e0e0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.ace-qol-reaction-type-label {
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.5px;
}

/* ── Body ── */
.ace-qol-reaction-body {
  padding: 10px 12px;
}
.ace-qol-reaction-description {
  font-size: 0.9rem;
  color: #bbb;
  margin-bottom: 8px;
  line-height: 1.4;
}
.ace-qol-reaction-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ace-qol-reaction-detail {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-detail-label {
  font-size: 0.8rem;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.ace-qol-reaction-detail-value {
  font-size: 0.95rem;
  color: #f0f0f0;
  font-weight: 700;
}

/* ── Slot Picker ── */
.ace-qol-reaction-slot-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-slot-picker label {
  font-size: 0.8rem;
  color: #888;
  text-transform: uppercase;
  font-weight: 600;
}
.ace-qol-reaction-slot-select {
  flex: 1;
  font-size: 0.85rem;
  background: #1a1a1e;
  color: #f0f0f0;
  border: 1px solid #555;
  border-radius: 3px;
  padding: 3px 6px;
  font-weight: 600;
}

/* ── Timer ── */
.ace-qol-reaction-timer {
  position: relative;
  height: 20px;
  background: rgba(255,255,255,0.05);
  margin: 0 12px;
  border-radius: 2px;
  overflow: hidden;
}
.ace-qol-reaction-timer-bar {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0.3;
  border-radius: 2px;
}
.ace-qol-reaction-timer-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.7rem;
  font-weight: 800;
  color: #aaa;
  letter-spacing: 1px;
}

/* ── Buttons ── */
.ace-qol-reaction-buttons {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
}
.ace-qol-reaction-accept {
  flex: 1;
  padding: 8px 16px;
  font-size: 0.85rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%);
  border: 1px solid rgba(212,175,55,0.4);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.ace-qol-reaction-accept:hover {
  background: linear-gradient(180deg, rgba(212,175,55,0.15) 0%, rgba(212,175,55,0.05) 100%);
  box-shadow: 0 0 12px rgba(212,175,55,0.25);
}
.ace-qol-reaction-decline {
  padding: 8px 16px;
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 4px;
  color: #999;
  cursor: pointer;
  transition: all 0.2s ease;
}
.ace-qol-reaction-decline:hover {
  background: linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%);
  border-color: rgba(239,83,80,0.4);
  color: #ef5350;
}

/* ── Chat Notification Card ── */
.ace-qol-reaction-chat {
  border-left: 3px solid #d4af37;
  padding: 6px 10px;
  margin: 2px 0;
  background: linear-gradient(90deg, rgba(212,175,55,0.06) 0%, transparent 100%);
  border-radius: 0 4px 4px 0;
  font-family: 'Rajdhani', sans-serif;
}
.ace-qol-reaction-chat-header {
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.ace-qol-reaction-chat-body {
  font-size: 0.85rem;
  color: #e0e0e0;
  line-height: 1.4;
}
`;

  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════════
//
//  INTEGRATION GUIDE
//
//  Below are the exact edits needed in other files to wire up the ReactionEngine.
//  These are documented here for reference — apply them manually.
//
//  1. ace-qol.mjs — Import, init, socket handler, API exposure
//  2. attack-pipeline.mjs — Post-hit Shield check
//  3. save-engine.mjs — Post-save Legendary Resistance check
//  4. settings.mjs — New reaction settings
//
// ═══════════════════════════════════════════════════════════════════════════════
