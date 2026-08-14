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
   * v0.7.265 — Counterspell NATIVE-resolution cleanup.
   * The cast barrier stops ACE's OWN downstream engines when a spell is
   * countered — but dnd5e resolves SUMMONS and zone TEMPLATES natively, which
   * ACE never touches, so the barrier can't stop them and the summoned
   * creature / template lands anyway. This kill-list records recently
   * counterspelled casts. A reactive sweep (in _onSpellCast) deletes anything
   * already placed; postSummon / createMeasuredTemplate hooks delete anything
   * that lands AFTER the async counter prompt resolves (the common case — the
   * prompt usually finishes after dnd5e has already summoned). Match is by the
   * casting item's uuid, carried on summoned tokens (flags.dnd5e.summon.origin)
   * and templates (flags.dnd5e.origin).
   */
  static _counterspelledCasts = [];   // [{ itemUuid, activityUuid, casterName, casterTokenUuid, expiresAt }]
  static _recentSummonFx = [];        // [{ id, srcUuid, expiresAt }] — summon Sequencer effects seen at creation, for post-counter cleanup

  static _markCastCounterspelled(activity) {
    try {
      const itemUuid = activity?.item?.uuid ?? null;
      const activityUuid = activity?.uuid ?? null;
      if (!itemUuid && !activityUuid) return;
      // Caster's token uuid — some summon animations (Automated Animations) play
      // ON THE CASTER with origin=null, so we clean those up by source token.
      const casterActor = activity?.item?.actor ?? activity?.actor ?? null;
      let casterTokenUuid = null;
      try { casterTokenUuid = casterActor?.getActiveTokens?.()?.[0]?.document?.uuid ?? null; } catch (_) {}
      ReactionEngine._counterspelledCasts.push({
        itemUuid, activityUuid, casterTokenUuid,
        casterName: activity?.item?.actor?.name ?? "?",
        expiresAt: Date.now() + 30000,   // 30s window covers a slow summon dialog
      });
    } catch (_) { /* non-fatal */ }
  }

  /** True if `origin` (a token/template dnd5e origin string) traces to a
   *  recently counterspelled cast. Prunes expired entries as it scans. */
  static _isCounterspelledOrigin(origin) {
    if (!origin) return false;
    const now = Date.now();
    ReactionEngine._counterspelledCasts = ReactionEngine._counterspelledCasts.filter(c => c.expiresAt > now);
    return ReactionEngine._counterspelledCasts.some(c =>
      (c.activityUuid && origin === c.activityUuid) ||
      (c.itemUuid && typeof origin === "string" && origin.startsWith(c.itemUuid))
    );
  }

  /**
   * v0.7.265 — Reactive sweep: on a successful counter, delete anything dnd5e
   * already resolved natively for THIS cast that the barrier can't stop —
   * summoned tokens + the cast's own zone template. Straggler hooks catch
   * whatever lands after this runs. GM-only (deletes need GM perms).
   */
  static async _sweepCounterspelledResolution(activity) {
    try {
      if (game.users?.activeGM !== game.user) return;
      const itemUuid = activity?.item?.uuid ?? null;
      const activityUuid = activity?.uuid ?? null;
      const matches = (origin) => !!origin && typeof origin === "string" && (
        (activityUuid && origin === activityUuid) ||
        (itemUuid && origin.startsWith(itemUuid))
      );

      // 1) Summoned tokens.
      const tokenIds = [];
      for (const t of (canvas?.scene?.tokens ?? [])) {
        const so = t.actor?.getFlag?.("dnd5e", "summon.origin") ?? t.actor?.flags?.dnd5e?.summon?.origin;
        if (matches(so)) tokenIds.push(t.id);
      }
      if (tokenIds.length) {
        await canvas.scene.deleteEmbeddedDocuments("Token", tokenIds);
        ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted ${tokenIds.length} summoned token(s)`);
      }

      // 2) Zone template(s).
      const tplIds = [];
      for (const tpl of (canvas?.scene?.templates ?? [])) {
        if (matches(tpl?.flags?.dnd5e?.origin)) tplIds.push(tpl.id);
      }
      if (tplIds.length) {
        await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", tplIds);
        ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted ${tplIds.length} template(s)`);
      }

      // 3) End any Sequencer effects tied to this cast. Automated Animations
      //    plays a summon flourish (JB2A) via .origin(item.uuid), so a countered
      //    summon's animation would otherwise linger on the caster with no fey.
      ReactionEngine._endCounterspelledCastEffects();
    } catch (err) {
      console.warn(`${MODULE_ID} | counterspell cleanup sweep failed (non-fatal):`, err);
    }
  }

  /** v0.7.273 — End Sequencer effects tied to a counterspelled cast. Two match
   *  routes, because animation modules tag effects inconsistently:
   *    (a) origin — some modules set `.origin(item.uuid)`; match it directly.
   *    (b) Automated Animations plays a summon flourish ON THE CASTER'S token
   *        with origin=null (proven via live probe: file
   *        "autoanimations.static.magicsign.conjuration…", source = caster token).
   *        So also end any conjuration/summon-type effect SOURCED at the
   *        counterspelled caster's token. The file/name pattern keeps it off
   *        ACE's own counterspell bursts (jb2a.shield / jb2a.healing_generic,
   *        which don't match) and off unrelated caster auras.
   *  Ends by effect id (precise) via endEffects, which broadcasts the removal to
   *  every client. Fire-and-forget. No-op without Sequencer / when nothing is
   *  pending. */
  static _endCounterspelledCastEffects() {
    try {
      const EM = globalThis.Sequencer?.EffectManager;
      if (!EM?.getEffects || !EM?.endEffects) return;
      const now = Date.now();
      const casts = ReactionEngine._counterspelledCasts.filter(c => c.expiresAt > now);
      if (!casts.length) return;
      const casterUuids = new Set(casts.map(c => c.casterTokenUuid).filter(Boolean));
      const SUMMON_FX = /conjuration|summon|magic.?sign|portal|autoanimations\.static/i;
      const toEnd = [];
      for (const fx of (EM.getEffects() ?? [])) {
        const d = fx?.data ?? {};
        const originHit = d.origin && casts.some(c => d.origin === c.itemUuid || d.origin === c.activityUuid);
        const srcUuid = (typeof d.source === "string" ? d.source : d.source?.uuid) ?? null;
        const summonHit = srcUuid && casterUuids.has(srcUuid) && SUMMON_FX.test(`${d.file ?? ""} ${d.name ?? ""}`);
        if ((originHit || summonHit) && fx.id) toEnd.push(fx.id);
      }
      // Also end summon FX RECORDED at creation from these casters — AA plays its
      // persistent sign on the CAST, often before the counter resolves, so the
      // live getEffects() scan alone can miss it (already fired, still on screen).
      if (toEnd.length) EM.endEffects({ effects: toEnd });
      // Recorded-at-creation summon FX from these casters (AA fires its sign on
      // the CAST, so the live scan above can miss it). End by object ref, which
      // doesn't need an id that may not be set yet.
      const recorded = ReactionEngine._recentSummonFx.filter(e => e.expiresAt > now && casterUuids.has(e.srcUuid));
      for (const e of recorded) ReactionEngine._killSummonEffect(e);
      if (recorded.length) {
        const done = new Set(recorded);
        ReactionEngine._recentSummonFx = ReactionEngine._recentSummonFx.filter(e => !done.has(e));
      }
      if (toEnd.length || recorded.length) {
        console.log(`${MODULE_ID} | [COUNTER-CLEANUP] killed summon FX — live=${toEnd.length} recorded=${recorded.length}`);
      }
    } catch (err) { console.warn(`${MODULE_ID} | counterspell Sequencer-FX cleanup failed (non-fatal):`, err); }
  }

  /** End a recorded summon effect by whatever handle we have — the CanvasEffect's
   *  own endEffect() (needs no id) first, then EffectManager by id as a fallback.
   *  Both broadcast/clear locally; belt-and-suspenders. */
  static _killSummonEffect(rec) {
    try { rec?.effect?.endEffect?.(); } catch (_) {}
    try {
      const id = rec?.id ?? rec?.effect?.id ?? rec?.effect?.data?._id ?? null;
      if (id) globalThis.Sequencer?.EffectManager?.endEffects?.({ effects: [id] });
    } catch (_) {}
  }

  /**
   * v0.7.21 — Generate a stable key for the activity.
   * UUID-first; composite fallback when UUID is missing. The previous code
   * fell back to the activity object reference, which collided on parallel
   * casts (macros, rapid actions) when both casts hit the object-ref bucket
   * → Counterspell could resolve the wrong cast, refunding the wrong slot or
   * tearing down the wrong concentration. (Audit-mandated 2026-06-08.)
   *
   * The composite fallback includes a per-activity timestamp stamped at
   * preUseActivity (`activity._aceCastStamp`, also set by SpellPipeline).
   * If both UUID and stamp are missing — extremely unusual — we generate a
   * one-shot stamp here so the key is at least unique per cast attempt.
   */
  static _activityKey(activity) {
    if (!activity) return null;
    if (activity.uuid) return activity.uuid;
    // Stamp the activity if it isn't already, so subsequent lookups land on
    // the same key.
    if (!activity._aceCastStamp) {
      activity._aceCastStamp = `${performance.now?.() ?? Math.random()}`;
    }
    const actorId = activity?.item?.actor?.id ?? "";
    const itemId  = activity?.item?.id ?? "";
    return `${actorId}|${itemId}|${activity._aceCastStamp}`;
  }

  /**
   * Create a barrier for the given activity. Called in preUseActivity.
   * Idempotent — calling twice for the same activity is a no-op.
   */
  static _createCastBarrier(activity) {
    if (!activity) return;
    const key = ReactionEngine._activityKey(activity);
    if (ReactionEngine._castBarriers.has(key)) return;
    let resolveFn;
    const promise = new Promise(r => { resolveFn = r; });
    const entry = { promise, resolve: resolveFn, resolved: false, resolvedWith: null, createdAt: Date.now() };
    ReactionEngine._castBarriers.set(key, entry);
    ReactionEngine._sdebug(`[BARRIER] CREATE for ${activity?.item?.name ?? '?'} on ${activity?.item?.actor?.name ?? '?'} — key=${typeof key === "string" ? key : "[obj]"} map size now ${ReactionEngine._castBarriers.size}`);
    // Safety-net timeout — auto-resolve with { abort: false } after 30s
    setTimeout(() => {
      const b = ReactionEngine._castBarriers.get(key);
      if (b && !b.resolved) {
        b.resolve({ abort: false, reason: "timeout" });
        b.resolved = true;
      }
      ReactionEngine._castBarriers.delete(key);
    }, 30000);
  }

  /**
   * Resolve a barrier. Called by reaction-engine after the user decides
   * (or when reaction-engine bails because no reactors / not a spell / etc.).
   */
  static _resolveCastBarrier(activity, result) {
    if (!activity) {
      ReactionEngine._sdebug(`[BARRIER] RESOLVE skipped — no activity`);
      return;
    }
    const key = ReactionEngine._activityKey(activity);
    const b = ReactionEngine._castBarriers.get(key);
    if (!b) {
      ReactionEngine._sdebug(`[BARRIER] RESOLVE skipped — no barrier for ${activity?.item?.name ?? '?'} (map size: ${ReactionEngine._castBarriers.size})`);
      return;
    }
    if (b.resolved) {
      ReactionEngine._sdebug(`[BARRIER] RESOLVE skipped — already resolved with ${JSON.stringify(b.resolvedWith)}, new request was ${JSON.stringify(result)}`);
      return;
    }
    b.resolve(result);
    b.resolved = true;
    b.resolvedWith = result;
    ReactionEngine._sdebug(`[BARRIER] RESOLVE for ${activity?.item?.name ?? '?'} with ${JSON.stringify(result)}`);
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
      ReactionEngine._sdebug(`[BARRIER] await — no activity`);
      return { abort: false, reason: "no_activity" };
    }
    const key = ReactionEngine._activityKey(activity);
    const b = ReactionEngine._castBarriers.get(key);
    if (!b) {
      ReactionEngine._sdebug(`[BARRIER] await — no barrier for ${activity?.item?.name ?? '?'} (key=${typeof key === "string" ? key : "[obj]"}, map size: ${ReactionEngine._castBarriers.size})`);
      return { abort: false, reason: "no_barrier" };
    }
    ReactionEngine._sdebug(`[BARRIER] AWAITING ${activity?.item?.name ?? '?'} (currently resolved: ${b.resolved})`);
    const result = await b.promise;
    ReactionEngine._sdebug(`[BARRIER] await returned ${JSON.stringify(result)} for ${activity?.item?.name ?? '?'}`);
    return result;
  }

  // ── v0.7.280 — Relay the counter to the CASTER's client for FX cleanup ──
  //  The summon-PLACEMENT gate (0.7.274) was reverted — delaying placeSummons to
  //  wait for the counter broke dnd5e's summon↔concentration link. But the
  //  caster's client still needs to KNOW a summon cast was countered, because AA
  //  plays its animation where the CASTER is (the player's screen for a player
  //  cast) and the counterspelled registry is otherwise GM-only. The GM relays the
  //  verdict over the socket; this records it here so the summon-FX listener +
  //  cleanup can end AA's animation on the caster's side. Player-side only — the
  //  GM already has it via _markCastCounterspelled.
  static _resolveSummonVerdict(activity, result) {
    try {
      if (!result?.abort || game.user.isGM) return;
      const casterActor = activity?.item?.actor ?? activity?.actor ?? null;
      const casterTokenUuid = casterActor?.getActiveTokens?.()?.[0]?.document?.uuid ?? null;
      if (!ReactionEngine._counterspelledCasts.some(c => c.activityUuid && c.activityUuid === activity?.uuid)) {
        ReactionEngine._counterspelledCasts.push({
          itemUuid: activity?.item?.uuid ?? null,
          activityUuid: activity?.uuid ?? null,
          casterTokenUuid,
          casterName: casterActor?.name ?? "?",
          expiresAt: Date.now() + 30000,
        });
      }
      ReactionEngine._endCounterspelledCastEffects();   // end any AA FX already on screen
    } catch (_) { /* non-fatal */ }
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

    // Auto-decline pending requests when the target player disconnects, so
    // the spell pipeline never hangs waiting for a player who is gone.
    Hooks.on("updateUser", (user, changes) => {
      if (changes.active !== false) return;
      for (const [reqId, pending] of this._pendingRequests.entries()) {
        if (pending.targetUserId === user.id) {
          console.log(`${MODULE_ID} | ReactionEngine: auto-declining pending reaction for disconnected user ${user.name}`);
          this._pendingRequests.delete(reqId);
          pending.resolve({ accepted: false, choiceData: {} });
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration — Reaction Tracking (Turn Reset)
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Reset reaction at the START of each combatant's turn ──
    //
    // ⚠️ THIS USED TO LISTEN TO `combatTurn`, AND IT RESET THE WRONG CREATURE.
    // Proven from Foundry V13's own source (client/documents/combat.mjs:291):
    //
    //     Hooks.callAll("combatTurn", this, updateData, updateOptions);
    //     await this.update(updateData, updateOptions);
    //
    // The hook fires BEFORE the update lands, so `combat.current` still points
    // at the combatant whose turn is ENDING. So every turn we cleared the
    // reaction of the creature just finishing — who had already had their
    // chance — while the creature actually starting its turn kept its spent
    // flag. A creature that used a reaction before its own turn (opportunity
    // attack, Shield, Counterspell, Absorb Elements) could not react again
    // until the top of the NEXT round, when the combatRound sweep below
    // happened to clear everyone. RAW: you get it back at the start of YOUR
    // turn. Silently denied reactions, all fight.
    //
    // `combatTurnChange` fires from `_manageTurnEvents` AFTER the state has
    // moved, and hands the new state in directly — the same hook, and the same
    // reasoning, as the turn-end work elsewhere in the suite. It also fires no
    // matter HOW the turn changed (clicking a combatant in the tracker, a
    // module writing combat.turn), which the four nextTurn/previousTurn call
    // sites never covered. (audit F-022, 2026-08-07)
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: reaction reset writes must only fire once
      this._resetCurrentCombatantReaction(combat, current);
    });

    // ── Reset ALL combatants' reactions on round change ──
    // RAW: reactions refresh at the start of each creature's turn. When a
    // GM advances by whole round (Next Round button), per-turn-start hooks
    // for individual combatants may not fire — so every combatant's reaction
    // would stay stale. Refresh everyone in the combat. v0.7.21 fix.
    Hooks.on("combatRound", async (combat, updateData, opts) => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: reaction reset writes must only fire once
      try {
        const cleared = [];
        for (const c of combat.combatants ?? []) {
          const actor = c.actor;
          if (!actor) continue;
          if (actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) {
            await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
            cleared.push(actor.name);
          }
        }
        if (cleared.length) {
          console.log(`${MODULE_ID} | combatRound: refreshed reactions for ${cleared.length} combatants: ${cleared.join(", ")}`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | combatRound reaction-reset failed:`, err);
      }
    });

    // ── v0.4.22.12: Reset all reactionUsed flags when combat ends ──
    // Without this, an actor's `reactionUsed` flag persists across
    // combats. Next combat, they'd appear to have already used their
    // reaction even though it's a new fight.
    Hooks.on("deleteCombat", () => {
      if (game.users?.activeGM !== game.user) return;  // activeGM: reaction flag clear must only run once
      this._resetAllReactionFlags("combat ended");
    });

    // ── Reset reaction on a SHORT or LONG rest (Johnny's houserule) ──
    // RAW already refreshes reactions every turn/round in combat; this makes a
    // rest ALSO clear the flag so a creature can never be stranded "reaction
    // used" OUT of combat (a fight that ended without deleteCombat, a bench
    // test, etc.). dnd5e fires `restCompleted` for BOTH rest types
    // (config.type = "short" | "long"), and only on the RESTING actor's own
    // client — so the owner clears its own flag; no activeGM gate (that would
    // miss player rests, whose hook never fires on the GM's client).
    Hooks.on("dnd5e.restCompleted", async (actor, result, config) => {
      try {
        if (!actor?.isOwner) return;
        if (actor.getFlag(MODULE_ID, FLAG_REACTION_USED)) {
          await actor.unsetFlag(MODULE_ID, FLAG_REACTION_USED);
          this._debug(`Reaction RESET: ${actor.name} (${config?.type ?? "rest"} rest)`);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | rest reaction-reset failed:`, err);
      }
    });

    // ── v0.7.265 — Counterspell native-resolution cleanup (stragglers) ──
    // dnd5e summons/templates usually land AFTER the async counter prompt
    // resolves. These GM-only hooks delete anything whose origin traces to a
    // counterspelled cast (paired with the reactive sweep in _onSpellCast for
    // anything already placed by the time the counter lands).
    Hooks.on("dnd5e.postSummon", async (activity, _profile, createdTokens) => {
      try {
        if (game.users?.activeGM !== game.user) return;
        const origin = activity?.item?.uuid ?? activity?.uuid;
        if (!ReactionEngine._isCounterspelledOrigin(origin)) return;
        const ids = (createdTokens ?? []).map(t => t?.id ?? t?.document?.id).filter(Boolean);
        if (ids.length) {
          await canvas?.scene?.deleteEmbeddedDocuments("Token", ids);
          ReactionEngine._sdebug(`[COUNTER-CLEANUP] postSummon deleted ${ids.length} straggler token(s)`);
        }
      } catch (err) { console.warn(`${MODULE_ID} | postSummon cleanup failed (non-fatal):`, err); }
    });

    // ── v0.7.271 — Late-placement straggler (the player-cast gap) ──
    // dnd5e.postSummon fires on the CLIENT that placed the summon, so a summon a
    // PLAYER casts and places AFTER the counter resolves never reaches the GM-only
    // cleanup above → a "zombie" fey lands with the caster no longer concentrating.
    // createToken is BROADCAST to every client, so it DOES fire on the GM here no
    // matter who dropped the token — match the summoned actor's origin to a
    // counterspelled cast and delete it GM-side. Cheap no-op when nothing was
    // counterspelled recently (the length guard skips the timer entirely).
    Hooks.on("createToken", (tokenDoc) => {
      if (!ReactionEngine._counterspelledCasts.length) return;   // nothing pending — fast exit
      setTimeout(async () => {
        try {
          if (game.users?.activeGM !== game.user) return;
          const fresh = canvas?.scene?.tokens?.get?.(tokenDoc.id);
          if (!fresh) return;
          const origin = fresh.actor?.getFlag?.("dnd5e", "summon.origin")
                      ?? fresh.actor?.flags?.dnd5e?.summon?.origin;
          if (!ReactionEngine._isCounterspelledOrigin(origin)) return;
          await fresh.delete();
          ReactionEngine._endCounterspelledCastEffects();   // also cut AA's on-drop summon flourish
          ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted late-placed summon token ${tokenDoc.id} (counterspelled cast)`);
        } catch (err) { console.warn(`${MODULE_ID} | createToken cleanup failed (non-fatal):`, err); }
      }, 150);
    });

    // flags.dnd5e.origin populates ~async on V13, so re-check on a short delay.
    Hooks.on("createMeasuredTemplate", (tdoc) => {
      setTimeout(async () => {
        try {
          if (game.users?.activeGM !== game.user) return;
          const fresh = canvas?.scene?.templates?.get?.(tdoc.id);
          if (!fresh || !ReactionEngine._isCounterspelledOrigin(fresh?.flags?.dnd5e?.origin)) return;
          await fresh.delete();
          ReactionEngine._sdebug(`[COUNTER-CLEANUP] deleted straggler template ${tdoc.id}`);
        } catch (err) { console.warn(`${MODULE_ID} | template cleanup failed (non-fatal):`, err); }
      }, 150);
    });

    // ── v0.7.278 — Kill AA's summon ANIMATION on a countered cast (sound is left
    // alone — Johnny prefers that to poking AA's internals). AA plays its
    // persistent conjuration sign on the CAST, which can be BEFORE the counter
    // resolves — so we can't match it to a counter at the moment it appears.
    // Instead: RECORD every summon-type Sequencer effect as it's created (id +
    // source token). When a counter lands, _endCounterspelledCastEffects ends the
    // recorded ones from that caster — the sign is persistent, so it vanishes.
    // Also end immediately if the caster's cast is ALREADY counterspelled (AA
    // fired after the counter). Near-zero cost; the record self-prunes.
    Hooks.on("createSequencerEffect", (fx) => {
      try {
        const d = fx?.data ?? {};
        const src = (typeof d.source === "string" ? d.source : d.source?.uuid) ?? null;
        const SUMMON_FX = /conjuration|summon|magic.?sign|portal|autoanimations\.static/i;
        if (!src || !SUMMON_FX.test(`${d.file ?? ""} ${d.name ?? ""}`)) return;   // NB: don't require fx.id — it isn't set yet at hook time
        const now = Date.now();
        ReactionEngine._recentSummonFx = ReactionEngine._recentSummonFx.filter(e => e.expiresAt > now);
        const rec = { effect: fx, id: fx.id ?? d._id ?? null, srcUuid: src, expiresAt: now + 8000 };
        ReactionEngine._recentSummonFx.push(rec);
        const casters = ReactionEngine._counterspelledCasts.filter(c => c.expiresAt > now).map(c => c.casterTokenUuid);
        if (casters.includes(src)) {
          console.log(`${MODULE_ID} | [COUNTER-CLEANUP] killing AA summon FX at creation (caster already countered): ${d.file ?? d.name ?? "?"}`);
          ReactionEngine._killSummonEffect(rec);
        }
      } catch (_) { /* non-fatal */ }
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
      if (actor) this._markReactionUsed(actor, "opportunityAttack");
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
      this._debug(`[REACTION-V2-HOOK] entry for ${activity?.item?.name ?? '?'} isGM=${game.user.isGM} reactions=${QolSettings.get("enableReactions")} cs=${QolSettings.get("autoCounterspell")}`);
      if (!QolSettings.get("enableReactions")) return;
      if (!QolSettings.get("autoCounterspell")) return;
      if (activity?.item?.type !== "spell") return;
      if ((activity?.item?.system?.level ?? 0) === 0) return; // cantrips can't be countered

      // ── v0.7.268 — PLAYER cast path. This hook fires on the CASTER's client,
      // but the counterspell check must run GM-side: it routes prompts to each
      // reactor's owner and its cleanup deletes GM-owned summons/templates,
      // which a player client can't do. So when a PLAYER casts, socket the GM
      // the exact activity uuid; the GM reconstructs it with fromUuid and runs
      // the same _onSpellCast (mirrors ACE's existing player-cast save/heal
      // routing). GM casts fall through and run it directly. ──
      if (!game.user.isGM) {
        try {
          game.socket.emit(SOCKET_NAME, {
            action: "playerSpellCast",
            activityUuid: activity?.uuid ?? null,
            messageId: message?.id ?? null,
          });
        } catch (e) { console.warn(`${MODULE_ID} | playerSpellCast emit failed (non-fatal):`, e); }
        return;
      }

      this._debug(`[REACTION-V2-HOOK] passed gates, calling _onSpellCast for ${activity?.item?.name ?? '?'}`);
      // Mark BEFORE processing so the legacy hook (which fires after
      // this synchronous return) sees the handled state.
      if (activity && typeof activity === "object") {
        this._handledActivityRefs.add(activity);
      }
      await this._onSpellCast(activity, message);
    });
    // Legacy fallback — only fires if dnd5e didn't emit postCreateUsageMessage
    // (older system versions). Defers one tick AND waits a short window so the
    // V2 hook can claim the activity. This prevents the prompt from appearing
    // BEFORE the spell's chat card renders (which happens at
    // dnd5e.postCreateUsageMessage, not dnd5e.useActivity). v0.7.21 fix.
    Hooks.on("dnd5e.useActivity", async (activity) => {
      if (!game.user.isGM) return;
      if (!QolSettings.get("enableReactions")) return;
      if (!QolSettings.get("autoCounterspell")) return;
      // Defer to give the V2 hook (postCreateUsageMessage) a chance to fire and
      // mark this activity as handled. If V2 fires, this hook bails. If V2
      // never fires (old dnd5e), this hook proceeds after the wait.
      await new Promise(r => setTimeout(r, 250));
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
   * @param {Actor} actor
   * @param {string} [reactionType]  e.g. "shield", "counterspell", "absorbElements", "opportunityAttack"
   * @param {Actor}  [targetActor]   the actor the reaction was used against (if applicable)
   */
  async _markReactionUsed(actor, reactionType = "unknown", targetActor = null) {
    if (!actor) return;
    await actor.setFlag(MODULE_ID, FLAG_REACTION_USED, true);
    Hooks.callAll(`${MODULE_ID}.reactionUsed`, { actor, reactionType, targetActor });
    this._debug(`Reaction USED: ${actor.name} (${reactionType})`);
  }

  /**
   * Reset reaction for the combatant whose turn is STARTING.
   *
   * @param {Combat} combat
   * @param {object} [current]  the turn state the hook handed us. Preferred over
   *   reading `combat.current` — see the combatTurnChange registration above for
   *   why reading it off the combat was resetting the wrong creature. Falls back
   *   to `combat.current` only for a caller that has nothing better.
   */
  async _resetCurrentCombatantReaction(combat, current = null) {
    const state = current ?? combat?.current;
    const combatantId = state?.combatantId;
    if (!combatantId) return;
    const combatant = combat?.combatants?.get(combatantId);
    // The TOKEN's actor, so one unlinked copy's reaction doesn't clear the
    // shared sidebar actor's flag for every other copy of that creature.
    const actor = combatant?.token?.actor ?? combatant?.actor;
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
      // v0.7.71 — pass attacker name + portrait so the reactor sees WHO is
      // hitting them, not just the description text. Knowing the attacker
      // changes the math (a Goblin's +4 doesn't deserve a slot; Strahd's +12
      // probably does).
      const attackerToken = attacker?.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === attacker?.id)
        ?? null;
      const attackerImg = attackerToken?.document?.texture?.src
        ?? attacker?.img
        ?? attacker?.prototypeToken?.texture?.src
        ?? null;
      const promptResult = await this._promptReaction({
        reactorActor: targetActor,
        reactorToken: targetToken,
        attackerName: attacker?.name ?? "An attacker",
        attackerImg,
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
        await this._markReactionUsed(targetActor, "shield");

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
      // v0.7.71 — pass caster info as "attacker" so the prompt shows WHO
      // cast Magic Missile (same plumbing as the Shield post-hit prompt).
      const casterToken = caster?.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === caster?.id)
        ?? null;
      const casterImg = casterToken?.document?.texture?.src
        ?? caster?.img
        ?? caster?.prototypeToken?.texture?.src
        ?? null;
      const promptResult = await this._promptReaction({
        reactorActor: targetActor,
        reactorToken: targetToken,
        attackerName: caster?.name ?? "A caster",
        attackerImg: casterImg,
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
        await this._markReactionUsed(targetActor, "shield");
        await this._applyShieldEffect(targetActor);

        // ── Visual flash on the absorbing token ──
        // JB2A free burst with PIXI pulse fallback. Same helper the passive
        // nullification sweep uses, so MM-vs-active-Shield and MM-vs-cast-Shield
        // share the same "absorbed it" visual language.
        try {
          // ⚠️ PATH WAS "../spell-pipeline/…" AND RESOLVED TO NOTHING (fixed
          // 2026-08-06). reaction-engine.mjs lives IN scripts/, so ".." climbs
          // out to the module root; the folder is scripts/spell-pipeline/. The
          // failed import landed in the catch below and was written off as
          // "non-fatal", so the Shield-absorbs-Magic-Missile flash has never
          // played once — silently, since a missing visual raises no complaint.
          // Found by resolving all 864 relative imports in the suite against
          // the filesystem; node --check never follows an import.
          const { AnimationHelper } = await import("./spell-pipeline/animation.mjs");
          AnimationHelper.flashNullification(targetToken, "#42a5f5").catch(() => {});
        } catch (err) {
          console.warn(`${MODULE_ID} | Shield nullification flash unavailable:`, err?.message ?? err);
        }

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
   * Check if an actor can cast Shield as a reaction.
   * @returns {{ canUse: boolean, slots: object[], reason?: string }}
   */
  _canUseShield(actor) {
    // Shield already active? (v0.7.18) — they're already protected, no point
    // in prompting them to cast it again (and would waste a reaction + slot).
    // Match by effect name; defense-in-depth for both "Shield" and "Shield Spell".
    try {
      const hasShieldActive = (actor.effects ?? []).some(e =>
        !e.disabled && /^shield(\s+spell)?$/i.test(String(e.name ?? "").trim())
      );
      if (hasShieldActive) return { canUse: false, slots: [], reason: "Shield already active" };
    } catch (_) { /* fall through */ }

    // Reaction already used?
    if (this._hasUsedReaction(actor)) return { canUse: false, slots: [], reason: "Reaction already used this round" };

    // Has Shield spell prepared/known?
    const hasShield = this._hasSpellPrepared(actor, "Shield");
    if (!hasShield) return { canUse: false, slots: [], reason: "Shield not prepared" };

    // Has a spell slot of 1st level or higher?
    const slots = this._getAvailableSlots(actor, 1);
    if (!slots.length) return { canUse: false, slots: [], reason: "No 1st-level+ slot available" };

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

    // Cantrips can't be counterspelled.
    // CRITICAL: counterspell RAW compares slot level to the level the spell was
    // CAST at (i.e. the upcasted level), NOT the spell's base level. A Haste
    // (base L3) upcast to L6 should require DC 16 against a L3 Counterspell —
    // not auto-succeed because 3 >= 3. Resolve the cast level from the activity
    // usage data; fall back to base level only if nothing else is available.
    // v0.7.21 fix.
    const baseLevel = item.system?.level ?? 0;
    if (baseLevel === 0) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "cantrip" });
      return;
    }
    const messageSystemLevel = Number(message?.system?.spellLevel ?? NaN);
    const messageFlagLevel   = Number(message?.flags?.dnd5e?.use?.spellLevel ?? NaN);
    const activityUsageLevel = Number(activity?.usage?.spellLevel ?? NaN);
    const spellLevel = Number.isFinite(messageSystemLevel) ? messageSystemLevel
                     : Number.isFinite(messageFlagLevel)   ? messageFlagLevel
                     : Number.isFinite(activityUsageLevel) ? activityUsageLevel
                     : baseLevel;
    this._debug(`Counterspell cast-level resolution: base=${baseLevel} msgSys=${messageSystemLevel} msgFlag=${messageFlagLevel} actUsage=${activityUsageLevel} → using ${spellLevel}`);

    // Get the caster's token
    const casterToken = this._getActorToken(casterActor);
    if (!casterToken) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_caster_token" });
      return;
    }

    // Find all eligible Counterspell reactors within 60ft
    let reactors = this._findCounterspellReactors(casterToken, casterActor);
    // Drop reactors whose player owner isn't connected — an offline player can't
    // answer the pop-up, so we don't raise a dead prompt (Johnny 2026-07-13:
    // "block counterspell if the owner isn't logged in"). NPCs (GM-owned, no
    // player owner) stay — the GM is here to decide those. Gate: skipOfflineCounterspell.
    if (QolSettings.get?.("skipOfflineCounterspell") !== false) {
      const before = reactors.length;
      reactors = reactors.filter(r => ReactionEngine._reactorOwnerAvailable(r.actor));
      if (before !== reactors.length) {
        this._debug(`Counterspell: dropped ${before - reactors.length} reactor(s) — owner not connected.`);
      }
    }
    if (!reactors.length) {
      ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_reactors_available" });
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

    // ── v0.7.269 — SEQUENTIAL COUNTERSPELL CASCADE ──
    // RAW: every creature that can see the caster may try to counter the SAME
    // cast. So we don't fire all reactors at once and stop at the first to
    // click — we go ONE AT A TIME, closest first:
    //   • decline          → offer the next reactor
    //   • accept + SUCCESS  → spell countered, STOP (nobody else is prompted)
    //   • accept + FAIL     → the spell is still resolving, so offer the next
    // (Johnny 2026-07-22: Kasimir declines or whiffs → Syrax STILL gets his
    //  shot; if Kasimir lands it, Syrax is never bothered.) The cast barrier's
    //  30s safety net upstream still bounds the whole cascade.
    const orderedReactors = [...reactors].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));

    const promptOpts = {
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
    };

    for (let i = 0; i < orderedReactors.length; i++) {
      const reactor = orderedReactors[i];

      // A failed counter earlier in this cascade already spent that reactor's
      // reaction (and a linked actor can appear on two tokens) — skip anyone
      // no longer holding a reaction.
      if (this._hasUsedReaction(reactor.actor)) continue;

      const result = await this._promptReaction({
        ...promptOpts,
        reactorActor: reactor.actor,
        reactorToken: reactor.token,
        availableSlots: reactor.slots,
      });

      // Declined → pass the shot down the line to the next eligible reactor.
      if (!result.accepted) {
        this._debug(`Counterspell: ${reactor.actor.name} declined — cascading (${i + 1}/${orderedReactors.length}).`);
        continue;
      }

      const slotLevel = result.choiceData?.slotLevel ?? 3;
      // v0.7.21: honor the "Consume Spell Slot" checkbox from the dialog.
      // Defaults to true for PCs, false for NPCs (GM convenience). When
      // missing entirely (legacy callers / non-dialog paths), default true
      // so we don't accidentally make slots free.
      const consumeSlot = result.choiceData?.consumeSlot !== false;

      if (consumeSlot) {
        await this._consumeSpellSlot(reactor.actor, slotLevel);
      } else {
        this._debug(`Counterspell slot consumption SKIPPED for ${reactor.actor.name} (NPC default / checkbox off).`);
      }

      // Mark reaction used (still costs the reaction action regardless of slot consumption)
      await this._markReactionUsed(reactor.actor, "counterspell");

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

        // ── v0.7.265 — Kill the native resolution the barrier can't stop:
        //    summoned creatures + this cast's own zone template. Mark the cast
        //    so stragglers (anything that lands after this) get deleted too, and
        //    sweep anything dnd5e already placed.
        ReactionEngine._markCastCounterspelled(activity);
        await ReactionEngine._sweepCounterspelledResolution(activity);

        // ── v0.7.265 — End the caster's concentration on the countered spell.
        //    RAW: a countered spell fails entirely, so no concentration should
        //    linger. Registered spells get this from the pipeline, but NATIVE
        //    ones (Summon Fey) never hit it — so we do it here for EVERY
        //    counter. Idempotent (no-op if nothing to end). dnd5e can create
        //    the Concentrating effect a TICK after our barrier resolves, so
        //    retry once (same pattern the pipeline uses).
        try {
          const { SpellPipeline } = await import("./spell-pipeline/pipeline.mjs");
          await SpellPipeline._endConcentrationForCancelledSpell(casterActor, item);
          setTimeout(() => {
            SpellPipeline._endConcentrationForCancelledSpell(casterActor, item).catch(() => {});
          }, 400);
        } catch (err) {
          console.warn(`${MODULE_ID} | counterspell concentration cleanup failed (non-fatal):`, err);
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

        // Spell is dead — nobody further down the cascade is prompted.
        return;
      }

      // ── Failed counter — the spell is STILL being cast, so cascade to the
      //    NEXT reactor. Do NOT resolve the barrier here: that would let the
      //    cast resolve before the next reactor even answers. ──
      await this._postReactionChat(reactor.actor, "Counterspell",
        `${reactor.actor.name} attempts to counterspell ${casterActor.name}'s ${item.name} but fails!${checkResult !== null ? ` (Check: ${checkResult} vs DC ${10 + spellLevel})` : ""}`,
        "#ef5350");
      this._debug(`Counterspell: ${reactor.actor.name} failed — cascading to the next reactor if any.`);
    }

    // Every eligible reactor declined or whiffed — the cast goes through.
    ReactionEngine._resolveCastBarrier(activity, { abort: false, reason: "no_counter" });
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
    // RAW opt-in (`counterspellAnyCaster`): offer against ANY caster you can
    // see, ally included. Default OFF = enemies-only. Read ONCE, defensively —
    // a settings hiccup must never throw and kill the whole counterspell check.
    let counterAnyCaster = false;
    try { counterAnyCaster = QolSettings.get("counterspellAnyCaster") === true; } catch (_) { counterAnyCaster = false; }

    for (const token of canvas.tokens.placeables) {
      if (!token.actor) continue;
      if (token.actor.id === casterActor.id) continue;

      // Same disposition = ally, skip (enemies counter enemies) — unless the
      // RAW opt-in read above is on (counter ANY caster you can see).
      if (token.document?.disposition === casterDisposition && !counterAnyCaster) continue;

      // Must be alive
      if ((token.actor.system?.attributes?.hp?.value ?? 1) <= 0) continue;

      // Must have reaction available
      if (this._hasUsedReaction(token.actor)) continue;

      // Must have Counterspell prepared/known
      if (!this._hasSpellPrepared(token.actor, "Counterspell")) continue;

      // Must have a 3rd+ level spell slot
      const slots = this._getAvailableSlots(token.actor, 3);
      if (!slots.length) continue;

      // Must be within 60ft (Counterspell's range)
      const distance = CombatState._getDistance(token, casterToken);
      if (distance > 60) continue;

      // Must have LINE OF SIGHT to the caster — RAW, you have to SEE the
      // creature casting. The 60ft check alone let a reactor counterspell
      // through walls / a locked door, even ~200ft away across rooms
      // (reported 2026-06-28). Test for a sight-blocking wall between the two
      // token centers. Optional-chained + try/caught so a Foundry API shift
      // can't break reactor detection — on any failure we fall through rather
      // than false-block a legitimate counterspell.
      try {
        const losBlocked = CONFIG.Canvas?.polygonBackends?.sight?.testCollision?.(
          token.center, casterToken.center, { type: "sight", mode: "any" }
        );
        if (losBlocked) continue;
      } catch (_) { /* LoS test unavailable — don't false-block */ }

      reactors.push({ actor: token.actor, token, slots, distance });
    }

    return reactors;
  }

  /**
   * True if this reactor can actually answer a reaction pop-up — either it's
   * GM-controlled (NPC, no player owner → the GM is here to decide) or at least
   * one of its player owners is currently connected. Blocks dead counterspell
   * prompts aimed at offline players (Johnny 2026-07-13). Fails OPEN on error so
   * a bug here never silently suppresses a legit reaction.
   */
  static _reactorOwnerAvailable(actor) {
    if (!actor) return false;
    try {
      const owners = game.users?.filter?.(u => u && !u.isGM && actor.testUserPermission?.(u, "OWNER")) ?? [];
      if (!owners.length) return true;          // NPC / GM-owned → GM handles it
      return owners.some(u => u.active);         // an owning player is connected
    } catch (_) {
      return true;   // never suppress a reaction on an error
    }
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
      await this._markReactionUsed(targetActor, "absorbElements");

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

      // ── Gate: Legendary Resistance applies ONLY to an actual saving throw ──
      // Skip any result that didn't involve a save (no save ability or no DC) —
      // e.g. auto-applied / non-save effects that flow through this path. This
      // stops the LR prompt from popping when no save was ever called for.
      // (RAW: attacks never trigger LR either; those don't carry ability+dc.)
      if (!result.ability || !Number.isFinite(Number(result.dc))) {
        modified.push(result);
        continue;
      }

      // ── AND ONLY IF A DIE WAS ACTUALLY THROWN (2026-08-07) ──
      // A caller can hand over a row for a creature whose save was REFUSED
      // before the roll — dead, or immune to everything the power does (ACE's
      // Gate). Those carry a failed-looking shape with no total, and the checks
      // above wave them straight through: the GM gets "X failed a WIS save…
      // Roll vs DC: null vs 17" and can burn a Legendary Resistance charge on a
      // save that never happened. The save engine filters these out at source;
      // this is the belt, so a future caller can't reintroduce it.
      if (result.noRoll || result.pending || !Number.isFinite(Number(result.total))) {
        modified.push(result);
        continue;
      }

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
      // Mirrors the Counterspell prompt's contextual richness: names the effect
      // being resisted in the description + shows Effect / Save / Roll-vs-DC /
      // Uses-Remaining detail rows. Themed gold (crown + gold sparkles via
      // iconExtra) — the "legendary" cousin of Counterspell's purple sparkles.
      const abil = result.ability?.toUpperCase() ?? "???";
      const sourceName = result.sourceName ?? result.itemName ?? null;
      const description = sourceName
        ? `<strong>${actor.name}</strong> failed a ${abil} save against <strong>${sourceName}</strong>. Spend Legendary Resistance to succeed instead?`
        : `<strong>${actor.name}</strong> failed a ${abil} saving throw. Spend Legendary Resistance to succeed instead?`;
      const details = [];
      if (sourceName) details.push({ label: "Effect", value: sourceName });
      details.push({ label: "Save", value: abil });
      details.push({ label: "Roll vs DC", value: `${result.total} vs ${result.dc}` });
      details.push({ label: "Uses Remaining", value: `${lrCheck.usesRemaining} / ${lrCheck.usesMax}` });

      const promptResult = await this._promptReaction({
        reactorActor: actor,
        reactorToken: this._getActorToken(actor),
        type: "legendaryResistance",
        title: "Legendary Resistance",
        description,
        details,
        acceptLabel: `Use Legendary Resistance (${lrCheck.usesRemaining} left)`,
        declineLabel: "Accept Failure",
        icon: "fa-crown",
        iconExtra: "fa-hand-sparkles",   // gold sparkles alongside the crown (gold via accentColor)
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
      await this._markReactionUsed(reactor.actor, "silveryBarbs");

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
      await this._markReactionUsed(reactor.actor, "cuttingWords");

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
    await this._markReactionUsed(actor, "opportunityAttack");
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
    // v0.7.21: reaction-prompt timeout REMOVED — reactions wait
    // indefinitely for an explicit user click. (See _promptLocal +
    // showReactionDialog for rationale.) Cast-barrier 30s safety net
    // upstream still prevents spell-pipeline hangs.

    // Determine who should see this prompt
    const ownerId = forceGM ? game.users.find(u => u.isGM)?.id : this._getOwnerUserId(reactorActor);

    // If the owner is the current user (GM or player), show locally
    if (ownerId === game.user.id) {
      return this._promptLocal(opts);
    }

    // Otherwise, send via socket to the owning player
    return this._promptRemote(opts, ownerId);
  }

  /**
   * Show a reaction prompt locally (this client).
   *
   * v0.7.21: outer auto-resolve timer REMOVED. The reaction dialog now waits
   * indefinitely for an explicit Accept/Decline click — RAW decisions
   * shouldn't be racing a stopwatch. (Cast-barrier 30s safety net still
   * exists upstream so the spell pipeline never hangs forever.)
   */
  async _promptLocal(opts) {
    // ── Detect PC vs NPC reactor so the dialog can default the
    // "Consume Spell Slot" checkbox appropriately. NPCs default OFF
    // (GM convenience — don't track NPC slot economy). PCs default ON.
    const reactorIsNpc = !opts.reactorActor?.hasPlayerOwner
                      && opts.reactorActor?.type !== "character";

    return ReactionEngine.showReactionDialog({
      ...opts,
      reactorActorName: opts.reactorActor?.name ?? opts.reactorActorName ?? "Reaction",
      reactorActorImg: opts.reactorActor?.img
        ?? opts.reactorToken?.document?.texture?.src
        ?? opts.reactorActorImg
        ?? null,
      // v0.7.71: forward attacker name + portrait (Shield prompt UX polish)
      attackerName: opts.attackerName ?? null,
      attackerImg:  opts.attackerImg  ?? null,
      reactorIsNpc,
    }).catch(() => ({ accepted: false, choiceData: {} }));
  }

  /**
   * Send a reaction prompt to a remote player via socket.
   *
   * v0.7.21: outer auto-resolve timer REMOVED. The remote prompt waits
   * indefinitely for the player to click. (Cast-barrier safety net upstream
   * still prevents the spell pipeline from hanging.) `reactorIsNpc` is
   * computed locally and passed to the dialog for slot-checkbox default —
   * but remote prompts only fire for PC reactors, so this is effectively
   * always false on the receiving end.
   */
  async _promptRemote(opts, targetUserId) {
    return new Promise((resolve) => {
      const requestId = `reaction-${++this._requestCounter}-${Date.now()}`;
      this._pendingRequests.set(requestId, { resolve, reactorActorId: opts.reactorActor?.id, targetUserId });

      const reactorIsNpc = !opts.reactorActor?.hasPlayerOwner
                        && opts.reactorActor?.type !== "character";

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
          // v0.7.71: attacker name + portrait (Shield prompt UX polish) — these
          // are already primitives/strings, so they survive the socket roundtrip.
          attackerName: opts.attackerName ?? null,
          attackerImg:  opts.attackerImg  ?? null,
          reactorIsNpc,
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
        spellSlotLevel, availableSlots, icon, iconExtra, accentColor,
        reactorActorName, reactorActorImg, reactorIsNpc, extraData,
        // v0.7.71 — attacker portrait + name (Shield UX polish)
        attackerName, attackerImg,
      } = data;

      const accent = accentColor ?? "#d4af37";
      let resolved = false;

      // ── Build attacker row (v0.7.71 — Shield UX polish) ──
      // Shows WHO is attacking the reactor, with a portrait, so the player
      // can make an informed reaction call without scanning chat. Renders
      // only when attacker data is provided (Shield + MM-Shield set it).
      const attackerRowHtml = attackerName ? `
        <div class="ace-qol-reaction-attacker" style="border-color:${accent}">
          ${attackerImg ? `<img src="${attackerImg}" class="ace-qol-reaction-attacker-portrait" alt="${attackerName}" />` : ""}
          <div class="ace-qol-reaction-attacker-text">
            <div class="ace-qol-reaction-attacker-label">Attacker</div>
            <div class="ace-qol-reaction-attacker-name">${attackerName}</div>
          </div>
          <i class="fas fa-arrow-right ace-qol-reaction-attacker-arrow"></i>
          <div class="ace-qol-reaction-attacker-vs">
            <div class="ace-qol-reaction-attacker-label">You</div>
            <div class="ace-qol-reaction-attacker-name">${reactorActorName ?? "Reactor"}</div>
          </div>
        </div>` : "";

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

      // ── v0.7.21: Consume Spell Slot checkbox ──
      // RAW: counterspell consumes a slot. For PCs, default ON (they pay
      // the cost). For NPCs, default OFF (GM convenience — don't track
      // NPC slot economy strictly; otherwise it's "cheating" the GM out
      // of unlimited NPC casts which is the normal table rule).
      // Only render the checkbox when a slot picker is present (i.e.
      // spell-slot-consuming reaction like Counterspell — Shield etc.
      // don't need this control).
      const consumeSlotDefault = reactorIsNpc ? "" : "checked";
      // v0.7.21: GM-only interaction. PCs see the checkbox state (transparent
      // about whether the slot gets consumed) but can't toggle it — RAW says
      // counterspell consumes a slot, and players shouldn't be able to opt
      // out. GM is the only one with authority to grant slot-free reactions
      // (typically for NPCs, but also occasional narrative grace).
      const consumeSlotDisabled = game.user.isGM ? "" : "disabled";
      const consumeSlotClass = game.user.isGM ? "" : "ace-qol-reaction-consume-slot-locked";
      const lockedHint = game.user.isGM ? "" : " <em style='opacity:0.55;font-size:0.8em;'>(GM-only)</em>";
      const consumeSlotHtml = spellSlotLevel && availableSlots?.length ? `
        <div class="ace-qol-reaction-consume-slot ${consumeSlotClass}">
          <label>
            <input type="checkbox" class="ace-qol-reaction-consume-slot-checkbox" ${consumeSlotDefault} ${consumeSlotDisabled} />
            <span>Consume Spell Slot${reactorIsNpc ? " <em style='opacity:0.7;font-size:0.85em;'>(NPC default: off)</em>" : ""}${lockedHint}</span>
          </label>
        </div>` : "";

      // ── Full dialog HTML ──
      // v0.7.21: countdown timer REMOVED. The user wants the reaction
      // decision to be binary (Accept / Decline) with no time pressure.
      // Upstream cast-barrier 30s safety net still prevents the spell
      // pipeline from hanging if the player walks away.
      const html = `
        <div class="ace-qol-reaction-prompt" data-reaction-type="${type}">
          <div class="ace-qol-reaction-header" style="border-color:${accent}">
            ${reactorActorImg ? `<img src="${reactorActorImg}" class="ace-qol-reaction-portrait" />` : ""}
            <div class="ace-qol-reaction-header-text">
              <span class="ace-qol-reaction-actor-name">${reactorActorName ?? "Unknown"}</span>
              <span class="ace-qol-reaction-type-label" style="color:${accent}">
                <i class="fas ${icon ?? "fa-bolt"}"></i>${iconExtra ? ` <i class="fas ${iconExtra}"></i>` : ""} ${title}
              </span>
            </div>
          </div>
          <div class="ace-qol-reaction-body">
            ${attackerRowHtml}
            <div class="ace-qol-reaction-description">${description}</div>
            <div class="ace-qol-reaction-details">${detailRows}</div>
            ${slotPickerHtml}
            ${consumeSlotHtml}
          </div>
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

          // ── Accept button ──
          el.querySelector(".ace-qol-reaction-accept")?.addEventListener("click", () => {
            if (resolved) return;
            resolved = true;

            const slotSelect = el.querySelector(".ace-qol-reaction-slot-select");
            const slotLevel = slotSelect ? parseInt(slotSelect.value) : (spellSlotLevel ?? null);
            const consumeBox = el.querySelector(".ace-qol-reaction-consume-slot-checkbox");
            // If the checkbox isn't shown at all (non-slot reactions like
            // Shield), default to true so spell-slot reactions don't
            // accidentally skip consumption. If shown, honor the checkbox.
            const consumeSlot = consumeBox ? consumeBox.checked : true;

            resolve({ accepted: true, choiceData: { slotLevel, consumeSlot } });
            dialog.close();
          });

          // ── Decline button ──
          el.querySelector(".ace-qol-reaction-decline")?.addEventListener("click", () => {
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
        width: 540,                     // v0.7.71: wider to fit 16px+ body text + attacker row
        height: "auto",
        // Center on screen — matches the advantage prompt placement so player
        // attention always lands at the same spot for time-critical decisions.
        top: Math.max(40, Math.floor(window.innerHeight / 2 - 280)),
        left: Math.max(20, Math.floor(window.innerWidth / 2 - 270)),
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
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:4px;font-size:16px;font-weight:700;color:${accentColor};text-transform:uppercase;letter-spacing:0.6px;border-bottom:1px solid #4a3a28;padding-bottom:8px;margin-bottom:10px;">
          <i class="fas fa-bolt" style="font-size:18px;color:${accentColor};flex-shrink:0;"></i>
          <span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">REACTION — ${reactionName.toUpperCase()}</span>
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

  /** Static sibling of _debug — used by the static barrier methods
   *  (_createCastBarrier / _resolveCastBarrier / awaitCastBarrier),
   *  which have no `this`. Gated on debugMode so it's silent in production. */
  static _sdebug(msg) {
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

/* ── Header (portrait + name + type) ──
   v0.7.71: bumped portrait + font sizes to meet CLAUDE.md §4b minimums
   (16px body / 18px heading) for any dialog popping over Foundry chrome. */
.ace-qol-reaction-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 2px solid rgba(212,175,55,0.3);
  background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%);
}
.ace-qol-reaction-portrait {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid rgba(212,175,55,0.4);
  object-fit: cover;
}
.ace-qol-reaction-header-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ace-qol-reaction-actor-name {
  font-size: 1.2rem;        /* ≈19px — heading */
  font-weight: 800;
  color: #f0e4c0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.ace-qol-reaction-type-label {
  font-size: 1rem;          /* 16px — body */
  font-weight: 700;
  letter-spacing: 0.5px;
}

/* ── Body ── */
.ace-qol-reaction-body {
  padding: 12px 14px;
}
.ace-qol-reaction-description {
  font-size: 1rem;          /* 16px — body */
  color: #d4cdb8;
  margin-bottom: 10px;
  line-height: 1.5;
}

/* ── Attacker row (v0.7.71 — Shield UX polish) ──
   Side-by-side attacker | arrow | reactor portraits with name labels.
   Helps the reactor see WHO is attacking so they can decide whether the
   slot is worth burning. Renders only when the prompt passes attacker data
   (Shield post-hit + Magic Missile defense; legendary resistance etc. don't). */
.ace-qol-reaction-attacker {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-left: 3px solid;        /* color set inline from accent */
  border-radius: 4px;
}
.ace-qol-reaction-attacker-portrait {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 2px solid rgba(239,83,80,0.45);
  object-fit: cover;
  flex-shrink: 0;
}
.ace-qol-reaction-attacker-text,
.ace-qol-reaction-attacker-vs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;     /* let names truncate inside flex */
}
.ace-qol-reaction-attacker-vs {
  text-align: right;
}
.ace-qol-reaction-attacker-label {
  font-size: 0.85rem;       /* 13.6px — hint */
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.ace-qol-reaction-attacker-name {
  font-size: 1.1rem;        /* ≈17.6px — heading-adjacent */
  color: #f0e4c0;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ace-qol-reaction-attacker-arrow {
  font-size: 1.2rem;
  color: rgba(239,83,80,0.7);
  flex-shrink: 0;
}

.ace-qol-reaction-details {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ace-qol-reaction-detail {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-detail-label {
  font-size: 0.9rem;        /* 14.4px — hint */
  color: #a8a098;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.ace-qol-reaction-detail-value {
  font-size: 1.05rem;       /* ≈16.8px — body */
  color: #f0e4c0;
  font-weight: 700;
}

/* ── Slot Picker ──
   v0.7.71: bumped to body-size minimums per CLAUDE.md §4b. */
.ace-qol-reaction-slot-picker {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-slot-picker label {
  font-size: 0.9rem;        /* 14.4px — hint */
  color: #a8a098;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.ace-qol-reaction-slot-select {
  flex: 1;
  font-size: 1rem;          /* 16px — body */
  background: #1a1a1e;
  color: #f0e4c0;
  border: 1px solid #555;
  border-radius: 3px;
  padding: 5px 8px;
  font-weight: 600;
}

/* ── Consume Spell Slot Checkbox (v0.7.21) ── */
.ace-qol-reaction-consume-slot {
  margin-top: 6px;
  padding: 6px 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.06);
}
.ace-qol-reaction-consume-slot label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;          /* v0.7.71: 16px — body min */
  color: #e8e0c8;
  cursor: pointer;
  font-weight: 600;
}
.ace-qol-reaction-consume-slot input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: #ab47bc;
}
/* v0.7.21: Locked state for non-GM clients — they see the checkbox but
   can't toggle. Visually muted so the player understands it's read-only. */
.ace-qol-reaction-consume-slot.ace-qol-reaction-consume-slot-locked {
  opacity: 0.6;
  background: rgba(255,255,255,0.015);
}
.ace-qol-reaction-consume-slot.ace-qol-reaction-consume-slot-locked label {
  cursor: not-allowed;
  color: #888;
}
.ace-qol-reaction-consume-slot.ace-qol-reaction-consume-slot-locked input[type="checkbox"] {
  cursor: not-allowed;
  pointer-events: none;
}

/* ── Timer (legacy — preserved for any non-counterspell reactions
   that might still want a visible time pressure indicator in future.
   The counterspell flow no longer renders these elements as of v0.7.21.) ── */
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

/* ── Buttons ──
   v0.7.71: bumped to 16px min per CLAUDE.md §4b — the accept button
   especially needs to read clearly under time pressure. */
.ace-qol-reaction-buttons {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
}
.ace-qol-reaction-accept {
  flex: 1;
  padding: 10px 18px;
  font-size: 1rem;          /* 16px — body min */
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
  padding: 10px 18px;
  font-size: 1rem;          /* 16px — body min */
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 4px;
  color: #a8a098;
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
