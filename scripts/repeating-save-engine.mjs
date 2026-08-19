// ─── ACE: QOL — Repeating Save Engine ─────────────────────────────────────────
// Handles RAW end-of-turn re-saves for concentration save-or-suck spells:
// Hold Person, Hold Monster, Banishment, Tasha's Hideous Laughter,
// Dominate Person/Monster, Charm Person (some readings), etc.
//
// Flow:
//   1. save-engine applies condition + stamps `flags.ace-qol.repeatingSave`
//      on the resulting Active Effect:
//        { ability: "wis", dc: 15, trigger: "endOfTurn", spellName: "Hold Person", stampedAt }
//   2. On combat turn change: when a creature's turn ends, scan its tagged
//      effects, roll the re-save, post a chat card, delete on success.
//   3. Out-of-combat: on world time advancement >= 6s (~1 round), do the same
//      sweep across all actors with tagged effects.
//
// Cleanup: when a tagged effect is deleted on success, the existing
// concentration-cleanup chain (deleteActiveEffect hook + dnd5e.dependentOn
// registry untrack) handles the rest. We don't have to do anything special.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { replyIsFromTheUserWeAsked } from "./socket-authority.mjs";
import { registerChatCardHandler } from "./chat-render-utils.mjs";
import { safeShowForRoll, awaitDiceSettle } from "./dsn-utils.mjs";
import { saveBonus, naturalD20 } from "./rolldata-utils.mjs";

const MIN_RT_FOR_OOC_SAVE = 6;     // 1 round = 6s
const MAX_OOC_SAVES_PER_EVENT = 10; // cap for big time jumps

export class RepeatingSaveEngine {

  // Pending owner-roll round-trips, keyed by requestId → resolve fn. The GM emits
  // a "showReSaveRoll" to the owning player and awaits their "reSaveRollResult".
  static _reSaveRequests = new Map();
  // Same key → { actor, ability, dc, spell, ownerName } so the GM's nudge card
  // (and its ROLL FOR THEM button) can roll the right save later.
  static _reSaveContexts = new Map();
  /** How long before the GM gets the "roll for them" card. Never auto-rolls. */
  static GM_NUDGE_MS = 30000;
  /** Player-side: requestId → the open save prompt, so the GM rolling instead
   *  can close it remotely (otherwise the player could roll a second time). */
  static _openPlayerPrompts = new Map();

  /**
   * Wire up combat + worldTime hooks. Idempotent — calling init() twice does
   * not double-register because we keep handles on the class.
   */
  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // ── Combat turn change ──
    // `combatTurnChange` hands us the PRIOR state EXPLICITLY: (combat, prior,
    // current), where prior.combatantId is exactly whose turn just ended —
    // for plain turn advances AND round rollovers. The old approach read
    // `combat.previous.turn` inside `combatTurn`/`combatRound`, but that field
    // is not yet refreshed when those hooks fire, so "whose turn ended" LAGGED
    // A FULL TURN — every creature's end-of-turn was credited to the creature
    // before it, and no re-save ever fired for the right actor (proven from
    // Johnny's live heartbeat log, 2026-07-27: advancing past Kasimir
    // processed "ended=Syrax").
    Hooks.on("combatTurnChange", async (combat, prior, _current) => {
      try {
        await this._onTurnChange(combat, prior);
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSaveEngine.combatTurnChange failed:`, err);
      }
    });

    // ── World time advance (out-of-combat) ──
    Hooks.on("updateWorldTime", async (worldTime, dt /*, opts, userId */) => {
      try {
        await this._onWorldTimeAdvance(dt);
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSaveEngine.updateWorldTime failed:`, err);
      }
    });

    // ── GM nudge card button: "ROLL FOR THEM" ──
    // Both hook names for V12 + V13 (renderChatMessage was replaced by
    // renderChatMessageHTML in V13 — the suite pattern).
    const wireNudgeButton = (_message, html) => {
      try {
        const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
        const btn = el?.querySelector?.('[data-action="ace-resave-gm-roll"]');
        if (!btn || btn.dataset.aceWired === "1") return;
        btn.dataset.aceWired = "1";
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          RepeatingSaveEngine.gmRollForPlayer(btn.dataset.requestId, btn);
        });
      } catch (_) { /* never break chat rendering */ }
    };
    // Both render hooks + a sweep of cards that were drawn before this
    // registered. See chat-render-utils — the raw hooks leave those
    // undecorated forever, which is how GM-only content reached a player.
    registerChatCardHandler(wireNudgeButton, "repeating-save cards");

    console.debug(`${MODULE_ID} | Repeating Save Engine online (combat + worldTime hooks)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Who rolls? — the owner rolls their own dice; the GM only rolls NPCs
  // ═══════════════════════════════════════════════════════════════════════════

  /** The active, connected, non-GM user who OWNS this actor (PC, summon,
   *  familiar, pet). That player rolls its saves. Null for a GM-only NPC, or
   *  when the owner is offline. Mirrors SaveEngine._casterUser. */
  static _ownerUser(actor) {
    if (!actor) return null;
    try {
      const assigned = game.users?.find(u => u.active && !u.isGM && u.character?.id === actor.id);
      if (assigned) return assigned;
      return game.users?.find(u => u.active && !u.isGM && actor.testUserPermission?.(u, "OWNER")) ?? null;
    } catch (_) { return null; }
  }

  /** Pull the natural d20 out of a roll (for the card's breakdown). Hardened:
   *  walks .dice AND raw .terms so an exotic roll shape can't hide the die —
   *  the card must ALWAYS show the number rolled (Johnny's card rule). */
  /** The natural d20 face. Delegates to the shared reader — the overtime engine
   *  needs the same thing, and two copies of this drift apart. */
  static _extractNat(roll) {
    return naturalD20(roll);
  }

  /**
   * Get a save roll for a re-save. If a player owns this actor and is online,
   * THEY roll their own dice (dnd5e's native dialog on their client); otherwise
   * the GM rolls silently so the turn never hangs.
   * Returns { total, natural, roll? } — `roll` is set ONLY for a GM-side roll
   * (used to fire DSN GM-side; a player's roll already animated on their client).
   */
  static async _obtainReSaveRoll(actor, ability, dc, spell) {
    const owner = this._ownerUser(actor);
    if (owner) {
      try {
        const info = await this._requestOwnerRoll(owner, actor, ability, dc, spell);
        if (info && Number.isFinite(info.total)) return info;   // player rolled
        // timeout / cancel / bad reply → fall through to a GM roll
      } catch (err) {
        console.warn(`${MODULE_ID} | re-save owner round-trip failed — GM rolling instead:`, err);
      }
    }
    return this._gmRollSave(actor, ability, dc);
  }

  /** GM-side silent roll (no dialog) — NPCs, and the offline-owner fallback. */
  static async _gmRollSave(actor, ability, dc) {
    try {
      const rolls = await actor.rollSavingThrow({ ability, target: dc }, { configure: false }, { create: false });
      const roll = Array.isArray(rolls) ? rolls[0] : rolls;
      if (!roll) return null;
      const total = Number(roll.total ?? roll._total ?? NaN);
      if (!Number.isFinite(total)) return null;
      return { total, natural: this._extractNat(roll), roll };
    } catch (err) {
      console.warn(`${MODULE_ID} | GM re-save roll failed for ${actor?.name}:`, err);
      return null;
    }
  }

  /** GM → owner socket round-trip: the owner's client rolls the save (native
   *  dnd5e dialog, their own dice + DSN); we await the total. 45s safety timeout
   *  so a turn never hangs on an idle player. Returns { total, natural } or null. */
  static async _requestOwnerRoll(owner, actor, ability, dc, spell) {
    const requestId = foundry.utils.randomID();
    let resolveFn;
    const reply = new Promise(res => { resolveFn = res; });
    this._reSaveRequests.set(requestId, resolveFn);
    this._reSaveContexts.set(requestId, { actor, ability, dc, spell, ownerName: owner.name, ownerUserId: owner.id });
    // NEVER auto-roll for a connected player (Johnny 2026-07-27: "I don't want
    // it rolling automatically for him"). The wait is OPEN-ENDED — the player's
    // dice are theirs. After a nudge delay the GM gets a small chat card with a
    // ROLL FOR THEM button (for the genuinely-AFK case); nothing resolves until
    // the player rolls or the GM clicks that button.
    // CONVERGED onto the shared nudge (2026-07-28). This engine used to own the
    // only copy of the "waited too long, hand it to the GM" behaviour, so the
    // MAIN save flow silently had none and hung forever. The timer, card and
    // button now live in pc-save-nudge.mjs and every waiting path uses them;
    // only the "what actually rolls it" callback differs per engine.
    let PcSaveNudge = null;
    try {
      ui.notifications?.info(`${actor.name}: waiting for ${owner.name} to roll their save…`);
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "showReSaveRoll",
        requestId, userId: owner.id,
        actorUuid: actor.uuid, ability, dc, spell,   // spell names the source on ACE's prompt
      });
      try {
        ({ PcSaveNudge } = await import("./pc-save-nudge.mjs"));
        PcSaveNudge.arm({
          key: requestId,
          targetName: actor.name,
          playerName: owner.name,
          abilityLabel: (CONFIG.DND5E?.abilities?.[ability]?.label) ?? String(ability).toUpperCase(),
          dc,
          sourceName: spell ?? "Repeating save",
          onRoll: () => RepeatingSaveEngine.gmRollForPlayer(requestId, null),
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | couldn't arm the re-save nudge (non-fatal):`, err);
      }
      return await reply;   // { total, natural } — from the player OR the GM's button
    } finally {
      try { PcSaveNudge?.disarm(requestId, `${actor.name}'s save is settled.`); } catch (_) {}
      this._reSaveRequests.delete(requestId);
      this._reSaveContexts.delete(requestId);
    }
  }

  /** GM-only nudge card: "<player> hasn't rolled — [ROLL FOR THEM]". Posted
   *  only after the nudge delay, and only while the request is still pending. */
  static async _postGmRollForPlayerCard(requestId) {
    try {
      if (!this._reSaveRequests.has(requestId)) return;   // already rolled — no card
      const ctx = this._reSaveContexts.get(requestId);
      if (!ctx) return;
      const abilityLabel = (CONFIG.DND5E?.abilities?.[ctx.ability]?.label) ?? String(ctx.ability).toUpperCase();
      const html = `
        <div class="ace-qol-rsv2">
          <div class="ace-qol-rsv2-head">
            <i class="fas fa-hourglass-half"></i>&nbsp;<b>${ctx.spell ?? "Repeating save"}</b>&nbsp;— waiting on ${ctx.ownerName}
          </div>
          <div class="ace-qol-rsv2-foot">
            <b>${ctx.actor.name}</b> hasn't rolled their ${abilityLabel} save (DC ${ctx.dc}) yet.
          </div>
          <button type="button" data-action="ace-resave-gm-roll" data-request-id="${requestId}"
                  style="width:100%;margin-top:6px;font-weight:700;">
            <i class="fas fa-dice-d20"></i> ROLL FOR THEM
          </button>
        </div>`;
      await ChatMessage.create({
        content: html,
        whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
        speaker: ChatMessage.getSpeaker({ actor: ctx.actor }),
        flags: { [MODULE_ID]: { type: "reSaveGmNudge", requestId } },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | GM nudge card failed (non-fatal):`, err);
    }
  }

  /** Retire a nudge card once its save is settled — so a stale "ROLLING…"
   *  button can never sit there implying the roll is still pending. */
  static async _markNudgeCardDone(requestId, note) {
    try {
      const msg = game.messages?.contents?.slice(-40).reverse()
        .find(m => m.flags?.[MODULE_ID]?.type === "reSaveGmNudge"
                && m.flags?.[MODULE_ID]?.requestId === requestId);
      if (!msg) return;
      await msg.update({
        content: `<div class="ace-qol-rsv2"><div class="ace-qol-rsv2-foot">
          <i class="fas fa-check"></i> ${note}</div></div>`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | couldn't retire the nudge card (non-fatal):`, err);
    }
  }

  /** GM clicked ROLL FOR THEM — roll GM-side and resolve the pending request. */
  static async gmRollForPlayer(requestId, buttonEl = null) {
    try {
      const ctx = this._reSaveContexts.get(requestId);
      if (!ctx || !this._reSaveRequests.has(requestId)) {
        ui.notifications?.info("That save was already resolved.");
        if (buttonEl) buttonEl.disabled = true;
        return;
      }
      if (buttonEl) { buttonEl.disabled = true; buttonEl.innerHTML = `<i class="fas fa-dice-d20"></i> Rolling…`; }
      const info = await this._gmRollSave(ctx.actor, ctx.ability, ctx.dc);
      if (!info) { ui.notifications?.warn("Roll failed — try again."); if (buttonEl) buttonEl.disabled = false; return; }
      // NOTE: do NOT fire DSN here — the main path (_rollAndResolve) fires it,
      // waits for the dice to settle, then posts the card. Firing it here too
      // rolled the dice TWICE on screen (live, 2026-07-27).

      // The player's prompt is now moot — close it on their client so they
      // can't roll a second time into a request that's already resolved.
      try {
        game.socket.emit(`module.${MODULE_ID}`, {
          action: "closeReSavePrompt", requestId, userId: ctx.ownerUserId ?? null,
        });
      } catch (_) { /* best-effort */ }

      this.resolveReSaveRequest(requestId, info);
      RepeatingSaveEngine._markNudgeCardDone(requestId, `Rolled by the GM — ${info.total} vs DC ${ctx.dc}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | gmRollForPlayer failed:`, err);
    }
  }

  /** GM-side: the owner's client replied with their roll. Resolves the pending
   *  promise so _obtainReSaveRoll continues. Called by the socket handler. */
  static resolveReSaveRequest(requestId, data, payload = null) {
    const fn = this._reSaveRequests.get(requestId);
    if (!fn) return;
    // ⚠️ Only the owner we asked may answer. The addressee is already recorded
    // in the context map, so nothing new needs storing — it was simply never
    // consulted. A stranger answering here reports a save result on a creature
    // that is not theirs, which decides whether a condition ends.
    if (payload) {
      const ctx = this._reSaveContexts.get(requestId);
      if (!replyIsFromTheUserWeAsked(ctx?.ownerUserId, payload, "reSaveRollResult")) return;
    }
    // A null reply = the player cancelled/closed the prompt. That is NOT
    // permission to roll for them — surface the GM's ROLL FOR THEM card
    // immediately and keep waiting. Only a real roll resolves this.
    if (!data || !Number.isFinite(data.total)) {
      RepeatingSaveEngine._postGmRollForPlayerCard(requestId);
      return;
    }
    this._reSaveRequests.delete(requestId);
    fn(data);
  }

  /** Player-side: roll MY actor's save with dnd5e's native dialog (I roll my own
   *  dice; DSN fires on my client + broadcasts). The system chat card is
   *  suppressed — the GM posts the single ACE outcome card. Returns { total,
   *  natural } or null. Called by the socket handler on the owning player. */
  /** Player-side: the GM rolled instead — close this player's open prompt so
   *  they can't roll into an already-resolved request. */
  static closePlayerPrompt(requestId) {
    try {
      const dlg = RepeatingSaveEngine._openPlayerPrompts?.get(requestId);
      if (dlg) {
        RepeatingSaveEngine._openPlayerPrompts.delete(requestId);
        try { dlg.close(); } catch (_) { /* already gone */ }
        ui.notifications?.info("The GM rolled that save for you.");
      }
    } catch (_) { /* non-fatal */ }
  }

  static async playerRollReSave({ actorUuid, ability, dc, spell, requestId }) {
    try {
      const resolved = await fromUuid(actorUuid);
      const actor = resolved?.actor ?? resolved;
      if (!actor) return null;
      // ACE OWNS THE PAUSE (Johnny 2026-07-27). This used to pass
      // `{ configure: true }`, which opened dnd5e's own "Constitution Saving
      // Throw" dialog on the player's screen — exactly what must never happen.
      // Now: ACE's own save prompt, then roll FAST-FORWARDED with their choice.
      const { showSavePrompt } = await import("./attack-prompt.mjs");
      const abilityLabel = (CONFIG.DND5E?.abilities?.[ability]?.label) ?? String(ability).toUpperCase();
      const choice = await showSavePrompt({
        creature: actor.name,
        abilityLabel, dc,
        sourceName: spell ?? "",
        suggested: "normal",
        isPC: !!actor.hasPlayerOwner,
        // Registered so the GM's "ROLL FOR THEM" can close this prompt remotely.
        registerAs: requestId ? (dlg) => RepeatingSaveEngine._openPlayerPrompts.set(requestId, dlg) : null,
      });
      if (requestId) RepeatingSaveEngine._openPlayerPrompts.delete(requestId);
      if (!choice) return null;   // closed/cancelled — GM's nudge card takes over
      const cfg = { ability, target: dc };
      if (choice === "advantage") cfg.advantage = true;
      else if (choice === "disadvantage") cfg.disadvantage = true;
      const rolls = await actor.rollSavingThrow(cfg, { configure: false }, { create: false });
      const roll = Array.isArray(rolls) ? rolls[0] : rolls;
      if (!roll) return null;
      const total = Number(roll.total ?? roll._total ?? NaN);
      if (!Number.isFinite(total)) return null;
      // THE DICE RULE: let the player's dice finish + a 500ms beat BEFORE the
      // result goes back to the GM — so the GM's card can never beat the dice
      // the table is watching. Raced against a 3s cap (DSN-hang protection).
      // Was a hand-rolled copy of awaitDiceSettle (show → race 3s → +500ms).
      // Same behaviour, but it called showForRoll RAW, so the animation was
      // never registered and no other card could wait on it. One door now.
      safeShowForRoll(roll, "player re-save");
      await awaitDiceSettle();
      return { total, natural: this._extractNat(roll) };
    } catch (err) {
      console.warn(`${MODULE_ID} | player re-save roll failed:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Combat turn handler
  // ═══════════════════════════════════════════════════════════════════════════

  static async _onTurnChange(combat, prior) {
    if (game.users?.activeGM !== game.user) return;  // activeGM: save cards must only fire once
    if (!combat?.started) return;

    // Resolve which combatant's turn just ENDED — from the hook's EXPLICIT
    // prior state, never from combat.previous (which lags a full turn).
    const prevCombatant = (prior?.combatantId ? combat.combatants?.get(prior.combatantId) : null)
      ?? (Number.isInteger(prior?.turn) ? combat.turns?.[prior.turn] : null);
    const actor = prevCombatant?.actor;
    if (!actor) return;

    // ── Diagnostic heartbeat (2026-07-27) ──
    // One line per turn change: whose turn ended + how many of their effects
    // carry a repeating-save tag. tagged=0 on a staged creature = stamp failed;
    // no line at all = hook resolution failed.
    try {
      const taggedCount = (actor.effects?.contents ?? []).filter(e =>
        String(e.flags?.[MODULE_ID]?.repeatingSave?.trigger ?? "").includes("endOfTurn")).length;
      console.log(`${MODULE_ID} | RepeatingSave[turn-change] ended=${prevCombatant?.name ?? actor.name} tagged=${taggedCount}`);
    } catch (_) { /* diagnostics never block */ }

    await this._processActorEndOfTurn(actor, "combatTurn");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World time handler (out-of-combat) — SILENT BATCH MODE
  //
  //  Key UX decision: don't spam the chat with one card per round when the GM
  //  advances the calendar. Instead:
  //    1. Compute how many save chances are available this event:
  //         dtRounds = Math.floor(dt / 6)
  //    2. For each tagged effect on each actor, also compute the spell's
  //       remaining duration in rounds (math-correct cap — Hold Person at
  //       round 5 only has 5 rounds left of its 10-round duration, NOT a
  //       fresh 10).
  //    3. Final cap = min(dtRounds, durationRounds, MAX_OOC_SAVES_PER_EVENT).
  //    4. Roll silently in a tight loop, no DSN, no per-roll chat cards.
  //    5. Stop on first success (effect ends).
  //    6. Post ONE summary card per actor per event with the outcome.
  // ═══════════════════════════════════════════════════════════════════════════

  static async _onWorldTimeAdvance(dt) {
    if (game.users?.activeGM !== game.user) return;  // activeGM: updateWorldTime fires on all clients
    if (!Number.isFinite(dt) || dt < MIN_RT_FOR_OOC_SAVE) return;
    // Skip if a combat is currently running — the combat hook owns timing
    if (game.combat?.started) return;

    const dtRounds = Math.min(MAX_OOC_SAVES_PER_EVENT, Math.floor(dt / MIN_RT_FOR_OOC_SAVE));
    if (dtRounds < 1) return;

    // Collect all actors that might have tagged effects
    const actors = [];
    for (const a of game.actors?.contents ?? []) actors.push(a);
    if (canvas?.scene) {
      for (const t of canvas.scene.tokens?.contents ?? []) {
        if (t.actor && !actors.includes(t.actor)) actors.push(t.actor);
      }
    }

    for (const actor of actors) {
      try {
        await this._processActorOOCBatch(actor, dtRounds);
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSave OOC batch failed for ${actor.name}:`, err);
      }
    }
  }

  /**
   * Process all tagged effects on this actor as a SILENT batch.
   * One summary chat card per (actor, effect) at the end.
   */
  static async _processActorOOCBatch(actor, dtRounds) {
    if (!actor) return;

    const tagged = (actor.effects?.contents ?? []).filter(e => {
      const meta = e.flags?.[MODULE_ID]?.repeatingSave;
      if (!meta?.trigger) return false;
      return String(meta.trigger).includes("endOfTurn");
    });
    if (!tagged.length) return;

    // Skip if actor is dead
    const isDead = actor.statuses?.has?.("dead")
                || (actor.system?.attributes?.hp?.value ?? 1) <= 0;
    if (isDead) return;

    for (const eff of tagged) {
      try {
        await this._oocBatchRollOne(actor, eff, dtRounds);
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSave OOC batch failed for ${actor.name} / "${eff.name}":`, err);
      }
    }
  }

  /**
   * Silent mass-roll for one effect. Math-correct cap. Single summary card.
   */
  static async _oocBatchRollOne(actor, eff, dtRounds) {
    const meta = eff.flags?.[MODULE_ID]?.repeatingSave;
    if (!meta?.ability || !Number.isFinite(meta?.dc)) return;

    // Effect still present?
    const stillPresent = actor.effects?.get?.(eff.id);
    if (!stillPresent) return;

    // Same voiding rule as the in-combat path — an out-of-combat batch must not
    // grind through saves for a chain that cannot land.
    if (await RepeatingSaveEngine._voidIfImmuneToEscalation(actor, stillPresent, meta, "ooc")) return;

    // ── Compute remaining-duration cap (math-correct) ──
    let durationRounds = MAX_OOC_SAVES_PER_EVENT; // fallback when duration unknown
    if (Number.isFinite(meta.durationSeconds) && Number.isFinite(meta.castWorldTime)) {
      const elapsed = Math.max(0, (game.time?.worldTime ?? 0) - meta.castWorldTime);
      const remainingSec = Math.max(0, meta.durationSeconds - elapsed);
      durationRounds = Math.ceil(remainingSec / MIN_RT_FOR_OOC_SAVE);

      // Spell already expired at advance time → just delete the effect
      // silently (the duration tracker should have done this anyway, but
      // belt-and-braces).
      if (durationRounds <= 0) {
        try { await stillPresent.delete(); } catch (_) {}
        await this._postOOCSummaryCard(actor, meta, {
          attempts: 0,
          passed: true,
          ended: "duration",
          bestTotal: null,
        });
        return;
      }
    }

    const cap = Math.min(dtRounds, durationRounds, MAX_OOC_SAVES_PER_EVENT);
    if (cap < 1) return;

    // ── Silent roll loop (no DSN, no chat per roll) ──
    let passed = false;
    let attempts = 0;
    let bestTotal = -Infinity;
    let passOnAttempt = null;

    const ability = String(meta.ability).toLowerCase();
    const dc      = Number(meta.dc);
    const rollData = actor.getRollData?.() ?? {};
    // ⚠️ Resolve the bonus to a NUMBER before it goes near the formula. In
    // dnd5e 5.x `@abilities.x.save` is an object, and interpolating it produced
    // an unevaluatable StringTerm that killed every out-of-combat save.
    const bonus   = saveBonus(rollData, ability);
    const formula = `1d20 + ${bonus}`;

    // ⚠️ KEEP THE DIE, NOT JUST THE TOTAL. A card that shows "22" and nothing
    // else gives the GM no way to tell a real roll from a bug — which is
    // exactly what happened when this path was silently throwing and Johnny
    // could not see why the number looked wrong. The standing rule is that the
    // d20 is always shown, silent batch or not.
    let bestFace = null;

    for (let i = 0; i < cap; i++) {
      attempts++;
      let total, face = null;
      try {
        const r = await new Roll(formula, rollData).evaluate();
        total = Number(r.total);
        face  = this._extractNat(r);   // THE die reader — walks .dice and .terms
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSave: silent roll failed for ${actor.name}:`, err);
        return;
      }
      if (total > bestTotal) { bestTotal = total; bestFace = face; }
      if (total >= dc) {
        passed = true;
        passOnAttempt = attempts;
        break;
      }
    }

    // ── Apply outcome ──
    if (passed) {
      try {
        await stillPresent.delete();
      } catch (err) {
        const msg = String(err?.message ?? err ?? "");
        if (!/does not exist/i.test(msg)) {
          console.warn(`${MODULE_ID} | RepeatingSave OOC: failed to delete "${eff.name}" from ${actor.name}:`, err);
        }
      }
    }

    console.log(`${MODULE_ID} | RepeatingSave[OOC-batch] ${actor.name}: ${attempts} silent ${ability.toUpperCase()} save(s) vs DC ${dc}, best=${bestTotal}, ${passed ? `PASSED on attempt ${passOnAttempt} — "${eff.name}" removed` : `all FAILED — effect persists`}`);

    // ── ONE summary card per event ──
    await this._postOOCSummaryCard(actor, meta, {
      attempts,
      passed,
      passOnAttempt,
      bestTotal: bestTotal === -Infinity ? null : bestTotal,
      bestFace,
      bonus,
      ended: passed ? "save" : null,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Per-actor processor — finds endOfTurn-tagged effects, rolls re-saves
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns true if at least one tagged effect remained after this pass.
   * (Used by OOC loop to decide whether to keep iterating.)
   */
  static async _processActorEndOfTurn(actor, source) {
    if (!actor) return false;

    // Find tagged effects that fire on end-of-turn
    const tagged = (actor.effects?.contents ?? []).filter(e => {
      const meta = e.flags?.[MODULE_ID]?.repeatingSave;
      if (!meta?.trigger) return false;
      // "endOfTurn" or "endOfTurn|onDamage" both qualify here
      return String(meta.trigger).includes("endOfTurn");
    });

    if (!tagged.length) return false;

    // Skip if actor is dead — no saves while dead (RAW)
    const isDead = actor.statuses?.has?.("dead")
                || actor.effects?.contents?.some(e => e.statuses?.has?.("dead"))
                || (actor.system?.attributes?.hp?.value ?? 1) <= 0;
    if (isDead) {
      console.log(`${MODULE_ID} | RepeatingSave[${source}] skipped — ${actor.name} is dead`);
      return tagged.length > 0;
    }

    let anyRemaining = false;
    for (const eff of tagged) {
      try {
        const survived = await this._rollAndResolve(actor, eff, source);
        if (survived) anyRemaining = true;
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSave[${source}] roll failed for ${actor.name} / "${eff.name}":`, err);
      }
    }
    return anyRemaining;
  }

  /**
   * Roll the re-save for one effect on one actor. On success: delete the
   * effect + post chat card. On failure: post chat card. Returns true if the
   * effect persisted (failed or no roll), false if it was removed.
   */
  /**
   * A staged chain that can only ever end in a condition the creature is IMMUNE
   * to is void — RAW, the creature "begins to turn to stone" only because it is
   * becoming stone. If it cannot be petrified, it was never turning to stone.
   *
   * So: drop the staging effect and skip the save entirely. Rolling a re-save
   * whose only possible consequence is impossible is theatre — and worse, the
   * escalation used to fire regardless and stone an immune creature.
   * (Earth Elemental, live console 2026-07-28.)
   *
   * @returns {Promise<boolean>} true if the chain was voided and the caller
   *                             should stop processing this effect.
   */
  static async _voidIfImmuneToEscalation(actor, eff, meta, source) {
    if (!meta?.onFailureApply) return false;
    try {
      const { CombatContext } = await import("./combat-context.mjs");
      const { ConditionLibrary } = await import("./condition-library.mjs");
      // The library key ("petrified") maps to the status id(s) immunity is
      // actually stored against — ask it rather than assuming they're equal.
      const statuses = ConditionLibrary.statusesFor?.(meta.onFailureApply)
        ?? [String(meta.onFailureApply).toLowerCase()];
      if (!statuses.length) return false;
      if (!statuses.every(s => CombatContext.conditionImmune(actor, s))) return false;

      try { await eff.delete(); } catch (_) { /* already gone */ }
      console.log(`${MODULE_ID} | RepeatingSave[${source}] ${actor.name} is IMMUNE to "${meta.onFailureApply}" — staged chain VOID, effect removed, no save rolled.`);
      // An effect vanishing off a token with no explanation is an invisible
      // outcome — the GM is left wondering why the restraint dropped. Tell them,
      // via a notification rather than a new card format (no parallel formats).
      // GM-only: this is cleanup of impossible state, not a table-facing event.
      if (game.user?.isGM) {
        ui.notifications?.info(`${actor.name} is immune to ${meta.onFailureApply} — "${eff.name}" was void and has been removed.`);
      }
      return true;
    } catch (err) {
      // Never let an immunity read break a turn — fall through and save normally.
      console.warn(`${MODULE_ID} | RepeatingSave: immunity pre-check failed for ${actor.name}:`, err);
      return false;
    }
  }

  static async _rollAndResolve(actor, eff, source) {
    const meta = eff.flags?.[MODULE_ID]?.repeatingSave;
    if (!meta?.ability || !Number.isFinite(meta?.dc)) return true;

    // Defensive: confirm the effect still exists right now (race protection)
    const stillPresent = actor.effects?.get?.(eff.id);
    if (!stillPresent) return false;

    if (await RepeatingSaveEngine._voidIfImmuneToEscalation(actor, stillPresent, meta, source)) return false;

    // RAW staged conditions (petrifying gaze): the creature is tagged at the
    // START of its turn and re-saves "at the end of its NEXT turn". The first
    // end-of-turn after tagging is therefore a grace turn, not a save. Consume
    // the one-shot flag and roll normally from the following turn onward.
    if (meta.skipFirstEndOfTurn) {
      try { await stillPresent.update({ [`flags.${MODULE_ID}.repeatingSave.skipFirstEndOfTurn`]: false }); }
      catch (err) { console.warn(`${MODULE_ID} | RepeatingSave: couldn't clear skipFirstEndOfTurn for ${actor.name}:`, err); }
      console.log(`${MODULE_ID} | RepeatingSave[${source}] ${actor.name} — grace turn, re-save comes at the end of the NEXT turn ("${eff.name}")`);
      return true;
    }

    const ability = String(meta.ability).toLowerCase();
    const dc      = Number(meta.dc);
    const spell   = meta.spellName ?? eff.name;

    // ── Roll the save — the OWNER rolls their own dice ─────────────────────
    // A player-owned actor (PC, summon, familiar, pet) rolls its OWN re-save on
    // the owner's client — dnd5e's native save dialog, their own DSN dice. Only
    // a GM-only NPC — or a player-owned actor whose owner is offline — rolls
    // silently on the GM side, so a turn never hangs. (Johnny 2026-07-25: "the
    // owner rolls for summons and whatever else — I don't want automatic rolls.")
    const rollInfo = await this._obtainReSaveRoll(actor, ability, dc, spell);
    if (!rollInfo || !Number.isFinite(rollInfo.total)) {
      console.warn(`${MODULE_ID} | RepeatingSave: no roll obtained for ${actor.name} re-save vs ${spell}`);
      return true; // effect persists if we couldn't roll
    }
    const rollTotal = rollInfo.total;
    const natural   = Number.isFinite(rollInfo.natural) ? rollInfo.natural : null;
    const modifier  = (natural != null) ? rollTotal - natural : null;
    const passed = rollTotal >= dc;
    const abilityLabel = (CONFIG.DND5E?.abilities?.[ability]?.label) ?? ability.toUpperCase();

    // DSN: a GM-side roll (NPC / offline owner) fires the dice here; a player's
    // OWN roll already animated (and settled — see playerRollReSave) on their
    // client, so `rollInfo.roll` is set only for the GM-side path.
    // THE DICE RULE (Johnny 2026-07-27): the card NEVER appears while the dice
    // are still rolling — wait for DSN to finish + a 500ms beat. Raced against
    // a 3s cap so a wedged DSN can never stall the turn (the await-external-
    // promises lesson: never trust an external module's promise unguarded).
    if (rollInfo.roll) {
      safeShowForRoll(rollInfo.roll, "repeating save");
      await awaitDiceSettle();
    }

    // ⚠️ RESOLVE FIRST, ANNOUNCE SECOND (2026-07-28).
    // The card used to be posted HERE, before either branch ran, and decided
    // whether to say "petrified" from meta.onFailureApply — the condition we
    // INTENDED to apply. So a refused or failed escalation still produced a
    // card announcing the stone. Johnny read that card and reasonably believed
    // his immune Earth Elemental had been petrified; the token never was.
    // The card now posts after the outcome is known and reports the condition
    // that ACTUALLY landed (null if none did).
    let escalatedTo = null;

    if (passed) {
      // Effect ends — delete. Existing cleanup chain handles dependents.
      try {
        await stillPresent.delete();
        console.log(`${MODULE_ID} | RepeatingSave[${source}] ${actor.name} PASSED ${abilityLabel} ${rollTotal} vs DC ${dc} — "${eff.name}" removed`);
      } catch (err) {
        const msg = String(err?.message ?? err ?? "");
        if (/does not exist/i.test(msg)) {
          // Already gone — fine
        } else {
          console.warn(`${MODULE_ID} | RepeatingSave: failed to delete "${eff.name}" from ${actor.name}:`, err);
        }
      }
      await this._postChatCard({
        actor, spell, ability, abilityLabel, dc,
        total: rollTotal, natural, modifier, passed,
        onFailureApply: null, source,
      });
      return false;
    } else {
      // ── Escalation on failure (staged conditions, e.g. a petrifying gaze) ──
      // Optional directive stamped by the gaze engine. Normally a failed
      // re-save just means the effect persists; for a STAGED condition a
      // failure ADVANCES it to something worse (turning-to-stone → petrified).
      // Fail-safe: if anything here throws we fall through and simply leave
      // the staging effect in place. A bug must never break a turn.
      if (meta.onFailureApply) {
        try {
          const { ConditionLibrary } = await import("./condition-library.mjs");
          // Remove the staging effect FIRST, while we still hold a live
          // reference to it, THEN apply the end state. Doing it the other way
          // around left the "turning to stone" restrained tag stuck on the
          // token alongside the petrified condition.
          try { await stillPresent.delete(); } catch (_) { /* already gone */ }
          // Check the RESULT before announcing it. This used to log "ESCALATED"
          // unconditionally — so a refused apply (immunity) still printed the
          // escalation to console and still drove the card's petrified styling.
          // A log that reports what we ASKED for instead of what HAPPENED sent
          // me chasing the wrong root cause for an hour.
          const applied = await ConditionLibrary.applyEffect(actor, meta.onFailureApply, { source: spell });
          if (applied) {
            escalatedTo = meta.onFailureApply;
            console.log(`${MODULE_ID} | RepeatingSave[${source}] ${actor.name} FAILED ${abilityLabel} ${rollTotal} vs DC ${dc} — ESCALATED to "${meta.onFailureApply}" (${spell})`);
          } else {
            console.log(`${MODULE_ID} | RepeatingSave[${source}] ${actor.name} FAILED ${abilityLabel} ${rollTotal} vs DC ${dc} — but is IMMUNE to "${meta.onFailureApply}"; staging cleared, nothing applied (${spell})`);
          }
          await this._postChatCard({
            actor, spell, ability, abilityLabel, dc,
            total: rollTotal, natural, modifier, passed,
            onFailureApply: escalatedTo, source,
          });
          return false;
        } catch (err) {
          console.warn(`${MODULE_ID} | RepeatingSave: escalation to "${meta.onFailureApply}" failed for ${actor.name} — leaving staging effect in place:`, err);
        }
      }
      console.log(`${MODULE_ID} | RepeatingSave[${source}] ${actor.name} FAILED ${abilityLabel} ${rollTotal} vs DC ${dc} — "${eff.name}" persists`);
      // Reached either because there was no escalation directive, or because the
      // escalation threw and we deliberately left the staging effect in place.
      // Either way nothing new landed — the card must not claim it did.
      await this._postChatCard({
        actor, spell, ability, abilityLabel, dc,
        total: rollTotal, natural, modifier, passed,
        onFailureApply: null, source,
      });
      return true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Single summary card for a silent OOC batch. Designed to be informative
   * but quiet — no roll dice, no per-attempt detail. Just outcome + count.
   */
  static async _postOOCSummaryCard(actor, meta, {
    attempts, passed, passOnAttempt, bestTotal, bestFace, bonus, ended,
  }) {
    try {
      const ability = String(meta.ability ?? "").toLowerCase();
      const abilityLabel = (CONFIG.DND5E?.abilities?.[ability]?.label) ?? ability.toUpperCase();
      const spell = meta.spellName ?? "spell";
      const dc = Number(meta.dc);
      const esc = (v) => foundry.utils.escapeHTML(String(v ?? ""));

      // ⚠️ STACKED LINES, NOT A FLEX ROW.
      // This card used to put the name, "Repeating saves vs", the effect name
      // and a parenthetical on ONE line, then four more items on a second.
      // A chat sidebar is about 280px wide, so all eight wrapped independently
      // and the card came apart — Johnny's screenshot had the creature's name
      // broken across three lines and "vs DC 12" stacked vertically.
      // Each line below owns its own row and is allowed to be long.
      const S = {
        wrap:  "padding:2px 0;line-height:1.5;",
        who:   "font-size:15px;font-weight:700;color:#f0e4c0;",
        what:  "font-size:13px;color:#b3a88a;margin-bottom:5px;",
        roll:  "font-size:15px;color:#f0e4c0;margin-top:2px;",
        dim:   "color:#8c7a4b;",
        good:  "color:#7fc98b;font-weight:700;",
        bad:   "color:#d67a7f;font-weight:700;",
        note:  "font-size:13px;color:#b3a88a;margin-top:4px;font-style:italic;",
      };

      // ⚠️ THE d20 IS ALWAYS SHOWN. This card was explicitly built "silent —
      // no roll dice", which left the GM staring at a bare total with no way to
      // tell a real roll from a broken one. Johnny's standing card rule wins.
      const sign = (Number(bonus) || 0) < 0 ? "−" : "+";
      const working = (bestFace !== null && bestFace !== undefined && bonus !== undefined)
        ? `<span style="${S.dim}">d20</span> (<b>${esc(bestFace)}</b>) <span style="${S.dim}">${sign}</span> ${Math.abs(Number(bonus) || 0)} <span style="${S.dim}">=</span> <b>${esc(bestTotal)}</b>`
        : `<b>${esc(bestTotal ?? "—")}</b>`;

      let rollLine, noteLine;
      if (ended === "duration") {
        rollLine = `<div style="${S.roll}"><span style="${S.good}">DURATION ENDED</span></div>`;
        noteLine = `<div style="${S.note}">The spell ran its course — ${esc(actor.name)} is free of it.</div>`;
      } else if (passed) {
        rollLine = `<div style="${S.roll}">${working} <span style="${S.dim}">vs DC ${esc(dc)}</span> — <span style="${S.good}">SUCCESS</span></div>`;
        noteLine = `<div style="${S.note}">Broke free on ${attempts === 1 ? "the first attempt" : `attempt ${esc(passOnAttempt)} of ${esc(attempts)}`}, out of combat.</div>`;
      } else {
        rollLine = `<div style="${S.roll}">${working} <span style="${S.dim}">vs DC ${esc(dc)}</span> — <span style="${S.bad}">HELD</span></div>`;
        noteLine = `<div style="${S.note}">${attempts === 1 ? "One attempt" : `${esc(attempts)} attempts`} out of combat, best roll shown. Still affected.</div>`;
      }

      const html = `
        <div class="ace-qol-repeating-save" style="${S.wrap}">
          <div style="${S.who}"><i class="fas fa-redo-alt" style="${S.dim}"></i> ${esc(actor.name)}</div>
          <div style="${S.what}">Repeating save — ${esc(spell)} (${esc(abilityLabel)})</div>
          ${rollLine}
          ${noteLine}
        </div>
      `;

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: html,
        flags: {
          [MODULE_ID]: {
            type: "repeatingSaveOocSummary",
            actorId: actor.id,
            spell, ability, dc, attempts, passed, bestTotal,
          },
        },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | RepeatingSave: OOC summary card failed:`, err);
    }
  }

  static async _postChatCard({ actor, spell, ability, abilityLabel, dc, total, natural, modifier, passed, onFailureApply, source }) {
    // SAME look as the regular save card (Johnny 2026-07-27: "it still is just a
    // save card — why did you make up a new format?"). Black-gold d20 face from
    // the save engine's own helper, "raw = total" in result colors, PASS/FAIL
    // badge, and the footer line carries the outcome (→ Petrified / breaks free).
    const petrifies   = !passed && onFailureApply === "petrified";
    const resultLabel = passed ? "PASS" : "FAIL";
    const sourceLabel = String(source ?? "").startsWith("worldTime") ? "out of combat" : "end of turn";
    const footer = passed
      ? `<b>${actor.name}</b> breaks free — the effect ends.`
      : (petrifies
          ? `<i class="fas fa-skull"></i> <b>${actor.name}</b> → <b class="ace-qol-rsv2-petr">Petrified</b>`
          : `<i class="fas fa-skull"></i> <b>${actor.name}</b> → still <b>Restrained</b> — re-save at the end of their next turn`);
    try {
      const { aceD20FaceImg } = await import("./save-engine.mjs");
      const numCls = passed ? "ace-qol-rsv2-green" : "ace-qol-rsv2-red";
      const html = `
        <div class="ace-qol-rsv2">
          <div class="ace-qol-rsv2-head">
            <i class="fas fa-hourglass-half"></i>&nbsp;<b>${spell}</b>&nbsp;— repeating ${abilityLabel} save, DC ${dc}
            <span class="ace-qol-rsv2-src">${sourceLabel}</span>
          </div>
          <div class="ace-qol-rsv2-row">
            ${aceD20FaceImg(Number.isFinite(natural) ? natural : total, { size: 46 })}
            <span class="ace-qol-rsv2-name">${actor.name}</span>
            <span class="ace-qol-rsv2-math"><span class="${numCls}">${Number.isFinite(natural) ? natural : "—"}</span> = <span class="${numCls}">${Number.isFinite(total) ? total : "—"}</span></span>
            <span class="ace-qol-rsv2-badge ${passed ? "ace-qol-rsv2-pass" : "ace-qol-rsv2-fail"}">${resultLabel}</span>
          </div>
          <div class="ace-qol-rsv2-foot ${passed ? "ace-qol-rsv2-foot-pass" : "ace-qol-rsv2-foot-fail"}">${footer}</div>
        </div>
      `;
      const msg = await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: html,
        flags: {
          [MODULE_ID]: {
            type: "repeatingSave",
            actorId: actor.id,
            spell, ability, dc, total, natural, modifier, passed, source,
          },
        },
      });
      console.log(`${MODULE_ID} | RepeatingSave card posted (${passed ? "PASS" : (petrifies ? "FAIL → Petrified" : "FAIL")}) for ${actor.name} — message ${msg?.id ?? "?"}`);
    } catch (err) {
      // A re-save must NEVER resolve invisibly — if the styled card failed,
      // post a bare-bones one so the table always sees the outcome.
      console.warn(`${MODULE_ID} | RepeatingSave: styled card failed — posting fallback:`, err);
      try {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<b>${actor.name}</b> — ${spell} re-save: <b>${total}</b> vs DC ${dc} — <b>${resultLabel}${petrifies ? " → Petrified" : ""}</b>`,
        });
      } catch (err2) {
        console.error(`${MODULE_ID} | RepeatingSave: even the fallback card failed:`, err2);
      }
    }
  }
}
