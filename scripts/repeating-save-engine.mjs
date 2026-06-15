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

const MIN_RT_FOR_OOC_SAVE = 6;     // 1 round = 6s
const MAX_OOC_SAVES_PER_EVENT = 10; // cap for big time jumps

export class RepeatingSaveEngine {

  /**
   * Wire up combat + worldTime hooks. Idempotent — calling init() twice does
   * not double-register because we keep handles on the class.
   */
  static init() {
    if (this._initialized) return;
    this._initialized = true;

    // ── Combat turn change ──
    // We use `combatTurn` because it fires AFTER the turn pointer advances —
    // the previous turn (= the turn that just ended) is in `combat.previous.turn`.
    // For round transitions, this also fires (with previous.round = old round,
    // previous.turn = last combatant of old round).
    Hooks.on("combatTurn", async (combat, _updateData, _opts) => {
      try {
        await this._onCombatTurn(combat);
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSaveEngine.combatTurn failed:`, err);
      }
    });

    // Some flows route through `combatRound` only (e.g. when round advances
    // and turn 0 is already set). Wire it as a safety net — same handler.
    Hooks.on("combatRound", async (combat, _updateData, _opts) => {
      try {
        await this._onCombatTurn(combat);
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSaveEngine.combatRound failed:`, err);
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

    console.debug(`${MODULE_ID} | Repeating Save Engine online (combat + worldTime hooks)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Combat turn handler
  // ═══════════════════════════════════════════════════════════════════════════

  static async _onCombatTurn(combat) {
    if (game.users?.activeGM !== game.user) return;  // activeGM: save cards must only fire once
    if (!combat?.started) return;

    // Resolve which combatant's turn just ENDED
    const prevIdx = combat.previous?.turn;
    if (prevIdx === undefined || prevIdx === null) return;
    const prevCombatant = combat.turns?.[prevIdx];
    const actor = prevCombatant?.actor;
    if (!actor) return;

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
    const formula = `1d20 + @abilities.${ability}.save`;
    const rollData = actor.getRollData?.() ?? {};

    for (let i = 0; i < cap; i++) {
      attempts++;
      let total;
      try {
        const r = await new Roll(formula, rollData).evaluate();
        total = Number(r.total);
      } catch (err) {
        console.warn(`${MODULE_ID} | RepeatingSave: silent roll failed for ${actor.name}:`, err);
        return;
      }
      if (total > bestTotal) bestTotal = total;
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
  static async _rollAndResolve(actor, eff, source) {
    const meta = eff.flags?.[MODULE_ID]?.repeatingSave;
    if (!meta?.ability || !Number.isFinite(meta?.dc)) return true;

    // Defensive: confirm the effect still exists right now (race protection)
    const stillPresent = actor.effects?.get?.(eff.id);
    if (!stillPresent) return false;

    const ability = String(meta.ability).toLowerCase();
    const dc      = Number(meta.dc);
    const spell   = meta.spellName ?? eff.name;

    // ── Roll the save through dnd5e's API ──
    // Use the actor's standard save roll so flags/buffs/penalties all apply.
    let rollResult = null;
    let rollTotal  = null;
    try {
      // dnd5e 5.x API: rollSavingThrow returns array OR single roll
      const rolls = await actor.rollSavingThrow({
        ability,
        target: dc,
        // We don't want a chat card from the system itself — we'll post
        // our own custom one with the spell context. messageConfig=false
        // suppresses the system's auto-chat.
      }, undefined, { create: false });

      const roll = Array.isArray(rolls) ? rolls[0] : rolls;
      if (roll) {
        rollResult = roll;
        rollTotal  = Number(roll.total ?? roll._total ?? null);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | RepeatingSave: rollSavingThrow failed for ${actor.name}:`, err);
      return true; // effect persists if we can't roll
    }

    if (!Number.isFinite(rollTotal)) {
      console.warn(`${MODULE_ID} | RepeatingSave: no roll total for ${actor.name} re-save vs ${spell}`);
      return true;
    }

    const passed = rollTotal >= dc;
    const abilityLabel = (CONFIG.DND5E?.abilities?.[ability]?.label) ?? ability.toUpperCase();

    // ── Post chat card ──
    await this._postChatCard({
      actor, spell, ability, abilityLabel, dc,
      total: rollTotal, passed,
      roll: rollResult,
      source,
    });

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
      return false;
    } else {
      console.log(`${MODULE_ID} | RepeatingSave[${source}] ${actor.name} FAILED ${abilityLabel} ${rollTotal} vs DC ${dc} — "${eff.name}" persists`);
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
  static async _postOOCSummaryCard(actor, meta, { attempts, passed, passOnAttempt, bestTotal, ended }) {
    try {
      const ability = String(meta.ability ?? "").toLowerCase();
      const abilityLabel = (CONFIG.DND5E?.abilities?.[ability]?.label) ?? ability.toUpperCase();
      const spell = meta.spellName ?? "spell";
      const dc = Number(meta.dc);

      let bodyHtml;
      if (ended === "duration") {
        bodyHtml = `
          <div class="ace-qol-rs-body">
            <span class="ace-qol-rs-result ace-qol-rs-pass">DURATION ENDED</span>
          </div>
          <div class="ace-qol-rs-outcome">${actor.name} is no longer affected — the spell's duration ran out.</div>`;
      } else if (passed) {
        bodyHtml = `
          <div class="ace-qol-rs-body">
            <span class="ace-qol-rs-ability">${abilityLabel} save</span>
            <span class="ace-qol-rs-roll">${bestTotal}</span>
            <span class="ace-qol-rs-dc">vs DC ${dc}</span>
            <span class="ace-qol-rs-result ace-qol-rs-pass">SUCCESS</span>
          </div>
          <div class="ace-qol-rs-outcome">${actor.name} broke free on attempt ${passOnAttempt} of ${attempts}.</div>`;
      } else {
        bodyHtml = `
          <div class="ace-qol-rs-body">
            <span class="ace-qol-rs-ability">${abilityLabel} save</span>
            <span class="ace-qol-rs-roll">${bestTotal ?? "—"}</span>
            <span class="ace-qol-rs-dc">vs DC ${dc}</span>
            <span class="ace-qol-rs-result ace-qol-rs-fail">PERSISTS</span>
          </div>
          <div class="ace-qol-rs-outcome">${actor.name} failed all ${attempts} attempts (best roll shown). Still affected.</div>`;
      }

      const html = `
        <div class="ace-qol-repeating-save">
          <div class="ace-qol-rs-header">
            <i class="fas fa-redo-alt"></i>
            <strong>${actor.name}</strong> — Repeating saves vs <strong>${spell}</strong>
            <span class="ace-qol-rs-source">(out of combat — ${attempts} silent roll${attempts === 1 ? "" : "s"})</span>
          </div>
          ${bodyHtml}
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

  static async _postChatCard({ actor, spell, ability, abilityLabel, dc, total, passed, roll, source }) {
    try {
      const resultClass = passed ? "ace-qol-rs-pass" : "ace-qol-rs-fail";
      const resultLabel = passed ? "SUCCESS" : "FAIL";
      const sourceLabel = source.startsWith("worldTime") ? "out of combat" : "end of turn";

      const html = `
        <div class="ace-qol-repeating-save">
          <div class="ace-qol-rs-header">
            <i class="fas fa-redo-alt"></i>
            <strong>${actor.name}</strong> — Repeating save vs <strong>${spell}</strong>
            <span class="ace-qol-rs-source">(${sourceLabel})</span>
          </div>
          <div class="ace-qol-rs-body">
            <span class="ace-qol-rs-ability">${abilityLabel} save</span>
            <span class="ace-qol-rs-roll">${total}</span>
            <span class="ace-qol-rs-dc">vs DC ${dc}</span>
            <span class="ace-qol-rs-result ${resultClass}">${resultLabel}</span>
          </div>
          ${passed ? `<div class="ace-qol-rs-outcome">${actor.name} shakes off the effect.</div>`
                   : `<div class="ace-qol-rs-outcome">${actor.name} remains affected.</div>`}
        </div>
      `;

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: html,
        rolls: roll ? [roll] : [],
        type: roll ? CONST.CHAT_MESSAGE_STYLES?.ROLL ?? 0 : 0,
        flags: {
          [MODULE_ID]: {
            type: "repeatingSave",
            actorId: actor.id,
            spell, ability, dc, total, passed, source,
          },
        },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | RepeatingSave: chat card failed:`, err);
    }
  }
}
