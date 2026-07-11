// ─── ACE: QOL — OverTime Effects Engine ──────────────────────────────────────
// Handles recurring effects that deal damage or force saves at the start/end
// of a creature's turn during combat. Reads OverTime data from Active Effects
// and processes them automatically when combat turns change.
//
// Supported flag paths:
//   flags.ace-qol.OverTime   — native format
//   flags.midi-qol.OverTime  — midi-qol compat (same structure)
//
// OverTime data format:
//   {
//     turn:             "start" | "end",
//     damageRoll:       "2d6",           // optional
//     damageType:       "fire",          // optional
//     saveDC:           15,              // optional
//     saveAbility:      "con",           // optional
//     saveRemove:       true,            // remove effect on successful save?
//     halfDamageOnSave: false,           // half damage on save success?
//     label:            "Burning",       // display label
//     condition:        "poisoned",      // optional: apply condition on fail
//     allowRepeatSave:  true,            // allow save each turn to end
//     macroOnFail:      "macroName",     // optional: run macro on failed save
//     macroOnSuccess:   "macroName",     // optional: run macro on passed save
//   }
//
// When triggered, posts a whispered-to-GM chat card showing save result,
// damage dealt, and buttons to APPLY damage or DISMISS the effect.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DamageApplicator } from "./damage-applicator.mjs";
import { aceWithinFt } from "./geometry-utils.mjs";

export class OverTimeEngine {

  constructor() {
    /** Track which combatant turn we last processed to avoid double-fires.
     *  Key: `${combatId}-${round}-${turn}` → Set<effectId> */
    this._processed = new Map();

    /** Damage types each actor has taken since its last turn, for RAW
     *  regeneration shut-offs. Key: actor.id → Set<damageType>. Cleared at
     *  the start of that actor's turn. Fed by the `ace-qol.damageApplied` hook. */
    this._dmgTypesTaken = new Map();

    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Primary: updateCombat fires on turn/round changes ──
    // Foundry fires updateCombat with changes = { turn, round }
    Hooks.on("updateCombat", (combat, changes, options, userId) => {
      if (game.users?.activeGM !== game.user) return;
      if (!QolSettings.get("enableOverTimeEffects")) return;
      this._onUpdateCombat(combat, changes);
    });

    // ── Wire buttons on OverTime chat cards (persistent across re-render) ──
    // V13-SAFE: handler reads native element OR jQuery. Registered on BOTH hooks —
    // the V13 `renderChatMessageHTML` was missing, so DoT/regen card buttons were
    // inert on V13.
    const _wireOverTimeCard = (message, html) => {
      const flags = message.flags?.[MODULE_ID];
      if (flags?.type !== "overTimeResult" && flags?.type !== "overTimeRegen") return;

      const el = html instanceof HTMLElement ? html : (html[0] ?? html);
      if (!el?.querySelector) return;

      this._wireOverTimeButtons(el, message, flags);
    };
    Hooks.on("renderChatMessage", _wireOverTimeCard);       // V12
    Hooks.on("renderChatMessageHTML", _wireOverTimeCard);   // V13

    // ── combatTurnChange (some modules/systems fire this custom hook) ──
    Hooks.on("combatTurnChange", (combat, prior, current) => {
      if (game.users?.activeGM !== game.user) return;
      if (!QolSettings.get("enableOverTimeEffects")) return;
      // If updateCombat already handled this, the _processed guard prevents double-fire
      this._processTurnChange(combat, prior?.combatantId, current?.combatantId, combat.round);
    });

    // ── Record damage types taken (for regeneration shut-offs) ──
    // Emitted by DamageApplicator when APPLY ALL lands damage on a target.
    Hooks.on(`${MODULE_ID}.damageApplied`, (payload) => {
      try { this._recordDamageTypes(payload); } catch (_) { /* non-fatal */ }
    });

    console.debug(`${MODULE_ID} | OverTime engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Combat Update Handler
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when combat state updates. Detects turn changes and processes
   * OverTime effects for the appropriate combatants.
   *
   * @param {Combat} combat   - The combat encounter
   * @param {object} changes  - What changed: { turn, round }
   */
  async _onUpdateCombat(combat, changes) {
    // Only care about turn or round changes
    if (!("turn" in changes) && !("round" in changes)) return;

    const currentTurn = combat.turn ?? 0;
    const currentRound = combat.round ?? 1;
    const turns = combat.turns ?? [];
    if (!turns.length) return;

    // Determine the previous combatant (whose turn just ended)
    // and the current combatant (whose turn is starting)
    const currentCombatant = turns[currentTurn];
    let previousCombatant = null;

    if ("turn" in changes) {
      // Turn changed — previous is the combatant at the old turn index
      const prevTurn = changes.turn > 0
        ? currentTurn - 1
        : turns.length - 1; // wrapped around from end of initiative

      // Only valid if we didn't also change rounds (handled below)
      if (!("round" in changes) || currentRound === combat.round) {
        previousCombatant = turns[prevTurn >= 0 ? prevTurn : turns.length - 1];
      }
    }

    if ("round" in changes && currentTurn === 0) {
      // New round started — previous combatant is the LAST in the previous round
      previousCombatant = turns[turns.length - 1];
    }

    // Process "end of turn" effects for the combatant whose turn just ended
    if (previousCombatant) {
      await this._processEffectsForCombatant(combat, previousCombatant, "end", currentRound);
    }

    // Process "start of turn" effects for the combatant whose turn is starting
    if (currentCombatant) {
      await this._processEffectsForCombatant(combat, currentCombatant, "start", currentRound);
    }
  }

  /**
   * Alternative entry point from combatTurnChange hook.
   * @param {Combat} combat
   * @param {string} previousCombatantId
   * @param {string} currentCombatantId
   * @param {number} round
   */
  async _processTurnChange(combat, previousCombatantId, currentCombatantId, round) {
    const turns = combat.turns ?? [];

    if (previousCombatantId) {
      const prev = turns.find(c => c.id === previousCombatantId);
      if (prev) await this._processEffectsForCombatant(combat, prev, "end", round);
    }

    if (currentCombatantId) {
      const curr = turns.find(c => c.id === currentCombatantId);
      if (curr) await this._processEffectsForCombatant(combat, curr, "start", round);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Effect Processing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find and process all OverTime effects on a combatant for the given timing.
   *
   * @param {Combat}    combat     - The combat encounter
   * @param {Combatant} combatant  - The combatant to process
   * @param {"start"|"end"} timing - When in the turn to trigger
   * @param {number}    round      - Current combat round
   */
  async _processEffectsForCombatant(combat, combatant, timing, round) {
    const actor = combatant.actor;
    if (!actor) return;

    // Guard: don't process the same combatant+timing+round twice
    const guardKey = `${combat.id}-${round}-${combatant.id}-${timing}`;
    if (this._processed.has(guardKey)) return;
    this._processed.set(guardKey, true);

    // Prune old guard entries (keep only current and previous round)
    for (const key of this._processed.keys()) {
      const parts = key.split("-");
      const keyRound = parseInt(parts[1]);
      if (isNaN(keyRound) || keyRound < round - 1) {
        this._processed.delete(key);
      }
    }

    // Collect all Active Effects affecting the actor that have OverTime data.
    // appliedEffects includes effects TRANSFERRED from items (e.g. the Forge's
    // "happens automatically each turn" effect lives on the feature item), which
    // actor.effects alone would miss.
    const effects = actor.appliedEffects ?? actor.effects?.contents ?? [];
    const overTimeEffects = [];

    for (const effect of effects) {
      if (effect.disabled || effect.isSuppressed) continue;

      // Read OverTime flags DIRECTLY off effect.flags — NOT via getFlag().
      // In Foundry V13, getFlag("midi-qol", …) THROWS when midi-qol isn't an
      // active module ("Flag scope is not valid or not currently active"). That
      // throw was aborting this whole turn-processing pass the moment a creature
      // carried any non-ACE effect — silently killing regeneration, auras, and
      // every other start/end-of-turn effect. Direct flag reads never throw.
      const aceOT = effect.flags?.[MODULE_ID]?.OverTime;
      if (aceOT) {
        overTimeEffects.push({ effect, data: this._normalizeOverTimeData(aceOT) });
        continue;
      }
      const midiOT = effect.flags?.["midi-qol"]?.OverTime;
      if (midiOT) {
        overTimeEffects.push({ effect, data: this._normalizeOverTimeData(midiOT) });
      }
    }

    // Filter to effects matching this timing
    const matching = overTimeEffects.filter(e => e.data.turn === timing);

    if (matching.length) {
      this._debug(`Processing ${matching.length} OverTime effects (${timing} of turn) for ${actor.name}`);
      // Process each effect sequentially (saves and damage may depend on order)
      for (const { effect, data } of matching) {
        await this._processOverTimeEffect(actor, combatant, effect, data);
      }
    }

    // ── Regeneration (auto-detected monster/creature trait) ──
    // Fires automatically at the START of the creature's turn, honoring the RAW
    // shut-offs (took its weakness, at 0 HP, in sunlight). Skipped when an
    // authored OverTime heal effect already covers it (handled above) so we
    // never double-heal.
    if (timing === "start") {
      const authoredHeal = matching.some(m => m.data.healRoll || m.data.regen);
      if (!authoredHeal) {
        try { await this._processRegeneration(actor, combatant, round); }
        catch (err) { console.error(`${MODULE_ID} | Regeneration processing failed:`, err); }
      }
      // The "damage taken since its last turn" window closes now that this
      // creature's turn has begun — reset it for the next round.
      this._dmgTypesTaken.delete(actor.id);
    }

    // ── Auras (Flavor C): effects that radiate to OTHER creatures within range ──
    try { await this._processAuras(combat, actor, combatant, timing, round); }
    catch (err) { console.error(`${MODULE_ID} | Aura processing failed:`, err); }
  }

  /**
   * Normalize OverTime data — handles both object and string formats.
   * Midi-QOL sometimes stores OverTime as a comma-separated string of key=value pairs.
   *
   * @param {object|string} raw - Raw OverTime data
   * @returns {object} Normalized OverTime data
   */
  _normalizeOverTimeData(raw) {
    // Already an object
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return {
        turn:             raw.turn ?? "start",
        damageRoll:       raw.damageRoll ?? raw.damRoll ?? "",
        damageType:       raw.damageType ?? raw.damType ?? "",
        saveDC:           parseInt(raw.saveDC ?? raw.dc ?? 0) || 0,
        saveAbility:      raw.saveAbility ?? raw.ability ?? "",
        saveRemove:       raw.saveRemove !== false,   // default true
        halfDamageOnSave: !!raw.halfDamageOnSave,
        label:            raw.label ?? "OverTime Effect",
        condition:        raw.condition ?? "",
        allowRepeatSave:  raw.allowRepeatSave !== false, // default true
        macroOnFail:      raw.macroOnFail ?? raw.macroFail ?? "",
        macroOnSuccess:   raw.macroOnSuccess ?? raw.macroPass ?? "",
        // ── Recurring HEALING / regeneration (authored via the Forge) ──
        healRoll:         raw.healRoll ?? raw.heal ?? "",
        regen:            !!raw.regen,
        regenShutoff:     Array.isArray(raw.regenShutoff) ? raw.regenShutoff
                            : (raw.regenShutoff ? String(raw.regenShutoff).split(/[,\s]+/).filter(Boolean) : []),
        requiresMinHp:    !!raw.requiresMinHp,
        noRegenInSunlight:!!raw.noRegenInSunlight,
      };
    }

    // String format: "turn=start, damageRoll=2d6, damageType=fire, saveDC=15, ..."
    if (typeof raw === "string") {
      const data = {
        turn: "start", damageRoll: "", damageType: "", saveDC: 0,
        saveAbility: "", saveRemove: true, halfDamageOnSave: false,
        label: "OverTime Effect", condition: "", allowRepeatSave: true,
        macroOnFail: "", macroOnSuccess: "",
      };

      const pairs = raw.split(",").map(s => s.trim());
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx < 0) continue;
        const key = pair.substring(0, eqIdx).trim();
        const val = pair.substring(eqIdx + 1).trim();

        switch (key) {
          case "turn":             data.turn = val; break;
          case "damageRoll":
          case "damRoll":          data.damageRoll = val; break;
          case "damageType":
          case "damType":          data.damageType = val; break;
          case "saveDC":
          case "dc":               data.saveDC = parseInt(val) || 0; break;
          case "saveAbility":
          case "ability":          data.saveAbility = val; break;
          case "saveRemove":       data.saveRemove = val !== "false" && val !== "0"; break;
          case "halfDamageOnSave": data.halfDamageOnSave = val === "true" || val === "1"; break;
          case "label":            data.label = val; break;
          case "condition":        data.condition = val; break;
          case "allowRepeatSave":  data.allowRepeatSave = val !== "false" && val !== "0"; break;
          case "macroOnFail":
          case "macroFail":        data.macroOnFail = val; break;
          case "macroOnSuccess":
          case "macroPass":        data.macroOnSuccess = val; break;
        }
      }

      return data;
    }

    // Fallback — return defaults
    return {
      turn: "start", damageRoll: "", damageType: "", saveDC: 0,
      saveAbility: "", saveRemove: true, halfDamageOnSave: false,
      label: "OverTime Effect", condition: "", allowRepeatSave: true,
      macroOnFail: "", macroOnSuccess: "",
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Single Effect Processing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a single OverTime effect on a single actor.
   * Steps:
   *   1. If saveDC + saveAbility → roll/prompt save
   *   2. If failed (or no save) → apply damage
   *   3. If saveRemove and passed → remove the effect
   *   4. If condition → apply/remove condition
   *   5. Run macros if defined
   *   6. Post a chat card showing what happened
   *
   * @param {Actor}        actor     - The affected actor
   * @param {Combatant}    combatant - The combatant
   * @param {ActiveEffect} effect    - The Active Effect
   * @param {object}       otData    - Normalized OverTime data
   */
  async _processOverTimeEffect(actor, combatant, effect, otData) {
    // Healing / regeneration effects (authored via the Forge) take a dedicated path.
    if (otData.healRoll || otData.regen) {
      return this._processHealEffect(actor, combatant, effect, otData);
    }

    const label = otData.label || effect.name || "OverTime Effect";
    const tokenDoc = combatant.token ?? actor.getActiveTokens()?.[0]?.document;
    const tokenImg = tokenDoc?.texture?.src ?? actor.img ?? "icons/svg/mystery-man.svg";
    const tokenName = tokenDoc?.name ?? actor.name ?? "Unknown";

    this._debug(`Processing OverTime: "${label}" on ${tokenName} (${otData.turn} of turn)`);

    let saveResult = null;   // { total, passed, ability, dc }
    let damageResult = null; // { total, formula, type }
    let effectRemoved = false;
    let conditionApplied = false;
    let conditionRemoved = false;

    // ── Step 1: Saving Throw (if required) ──
    if (otData.saveDC > 0 && otData.saveAbility) {
      saveResult = await this._rollSave(actor, otData.saveAbility, otData.saveDC);
    }

    const savePassed = saveResult?.passed ?? false;
    const saveFailed = saveResult ? !saveResult.passed : true; // No save = treated as fail

    // ── Step 2: Damage Roll ──
    if (otData.damageRoll) {
      let shouldDealDamage = true;

      // If save was required: full damage on fail, optional half on success
      if (saveResult) {
        if (savePassed && !otData.halfDamageOnSave) {
          shouldDealDamage = false;
        }
      }

      if (shouldDealDamage) {
        damageResult = await this._rollDamage(
          otData.damageRoll,
          otData.damageType,
          actor,
          savePassed && otData.halfDamageOnSave // halve if passed + halfDamageOnSave
        );
      }
    }

    // ── Step 3: Remove effect on successful save ──
    if (saveResult && savePassed && otData.saveRemove) {
      try {
        await effect.delete();
        effectRemoved = true;
        this._debug(`Removed OverTime effect "${label}" from ${tokenName} (save passed)`);
      } catch (err) {
        console.error(`${MODULE_ID} | Failed to remove OverTime effect:`, err);
      }
    }

    // ── Step 4: Condition handling ──
    if (otData.condition) {
      if (saveFailed) {
        // Apply condition on failed save (if not already present)
        const statuses = actor.statuses ?? new Set();
        if (!statuses.has(otData.condition)) {
          try {
            await this._applyCondition(actor, otData.condition);
            conditionApplied = true;
          } catch (err) {
            console.error(`${MODULE_ID} | Failed to apply condition "${otData.condition}":`, err);
          }
        }
      } else if (savePassed && otData.saveRemove) {
        // Remove condition on successful save (if saveRemove is true)
        const statuses = actor.statuses ?? new Set();
        if (statuses.has(otData.condition)) {
          try {
            await this._removeCondition(actor, otData.condition);
            conditionRemoved = true;
          } catch (err) {
            console.error(`${MODULE_ID} | Failed to remove condition "${otData.condition}":`, err);
          }
        }
      }
    }

    // ── Step 5: Execute macros ──
    if (saveFailed && otData.macroOnFail) {
      await this._executeMacro(otData.macroOnFail, actor, effect, otData, saveResult, damageResult);
    }
    if (savePassed && otData.macroOnSuccess) {
      await this._executeMacro(otData.macroOnSuccess, actor, effect, otData, saveResult, damageResult);
    }

    // ── Step 6: Post chat card ──
    await this._postOverTimeCard({
      tokenImg,
      tokenName,
      label,
      timing: otData.turn,
      saveResult,
      damageResult,
      effectRemoved,
      conditionApplied,
      conditionRemoved,
      condition: otData.condition,
      actorId: actor.id,
      effectId: effect.id,
      tokenDocId: tokenDoc?.id,
      // Pass raw damage for the APPLY button
      rawDamage: damageResult?.total ?? 0,
      damageType: otData.damageType,
    });

    // ── Step 7: Auto-apply damage if enabled ──
    if (damageResult && QolSettings.get("autoApplyOverTimeDamage")) {
      await this._applyOverTimeDamage(actor, damageResult.total, otData.damageType);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Rolling
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll a saving throw for an actor.
   * For NPC actors (GM-owned), rolls directly.
   * For PC actors, rolls on their behalf (GM has permission in combat context).
   *
   * @param {Actor}  actor   - The actor rolling
   * @param {string} ability - Ability abbreviation ("con", "dex", etc.)
   * @param {number} dc      - Difficulty Class
   * @returns {{ total: number, passed: boolean, ability: string, dc: number }}
   */
  async _rollSave(actor, ability, dc) {
    try {
      // Use the D&D 5e system's built-in save rolling
      // actor.rollAbilitySave returns a Roll or array of Rolls
      const roll = await actor.rollAbilitySave?.(ability, {
        fastForward: true,     // Skip dialog
        chatMessage: false,    // Don't post to chat (we'll post our own card)
        targetValue: dc,
      });

      // Handle both single Roll and array of Rolls
      const rollObj = Array.isArray(roll) ? roll[0] : roll;
      const total = rollObj?.total ?? 0;
      const passed = total >= dc;

      this._debug(`Save: ${actor.name} ${ability.toUpperCase()} DC ${dc} → ${total} (${passed ? "PASS" : "FAIL"})`);

      return { total, passed, ability, dc };
    } catch (err) {
      // Fallback: if rollAbilitySave is unavailable, try rollSavingThrow (dnd5e v4+)
      try {
        const roll = await actor.rollSavingThrow?.({
          ability,
          target: dc,
          event: { shiftKey: true, target: document.body }, // fast-forward (target preserved for dnd5e buildPost)
          chatMessage: false,
        });
        const rollObj = Array.isArray(roll) ? roll[0] : roll;
        const total = rollObj?.total ?? 0;
        return { total, passed: total >= dc, ability, dc };
      } catch (err2) {
        console.error(`${MODULE_ID} | OverTime save roll failed for ${actor.name}:`, err, err2);
        // Manual fallback: roll a d20 + ability mod
        const mod = actor.system?.abilities?.[ability]?.save ?? 0;
        const fallbackRoll = await new Roll(`1d20 + ${mod}`).evaluate();
        const total = fallbackRoll.total;
        return { total, passed: total >= dc, ability, dc };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Rolling
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll damage for an OverTime effect.
   *
   * @param {string}  formula    - Dice formula (e.g., "2d6")
   * @param {string}  type       - Damage type (e.g., "fire")
   * @param {Actor}   actor      - The affected actor (for resistance checks)
   * @param {boolean} halve      - Whether to halve the damage (save passed)
   * @returns {{ total: number, formula: string, type: string, rawTotal: number }}
   */
  async _rollDamage(formula, type, actor, halve = false) {
    try {
      const roll = await new Roll(formula).evaluate();
      let total = roll.total;
      const rawTotal = total;

      // Apply half damage if save passed
      if (halve) {
        total = Math.floor(total / 2);
      }

      // Check resistances/immunities/vulnerabilities
      const traits = actor.system?.traits ?? {};
      const di = this._getTraitSet(traits.di); // damage immunities
      const dr = this._getTraitSet(traits.dr); // damage resistances
      const dv = this._getTraitSet(traits.dv); // damage vulnerabilities

      let modifier = "normal";
      if (type && di.has(type)) {
        total = 0;
        modifier = "immune";
      } else if (type && dr.has(type)) {
        total = Math.floor(total / 2);
        modifier = "resistant";
      } else if (type && dv.has(type)) {
        total = total * 2;
        modifier = "vulnerable";
      }

      this._debug(`Damage: ${formula} ${type} → ${rawTotal}${halve ? ` (halved to ${Math.floor(rawTotal/2)})` : ""} → ${total} final (${modifier})`);

      return { total, formula, type, rawTotal, modifier };
    } catch (err) {
      console.error(`${MODULE_ID} | OverTime damage roll failed:`, err);
      return { total: 0, formula, type, rawTotal: 0, modifier: "error" };
    }
  }

  /**
   * Extract a Set of damage types from a D&D 5e trait object.
   * Handles both dnd5e v3 (array of strings) and v4+ (Set or object with value).
   *
   * @param {object} trait - e.g., actor.system.traits.dr
   * @returns {Set<string>}
   */
  _getTraitSet(trait) {
    if (!trait) return new Set();
    if (trait instanceof Set) return trait;
    if (trait.value instanceof Set) return trait.value;
    if (Array.isArray(trait.value)) return new Set(trait.value);
    if (Array.isArray(trait)) return new Set(trait);
    return new Set();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Application
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply OverTime damage to an actor's HP.
   *
   * @param {Actor}  actor      - The affected actor
   * @param {number} damage     - Final damage amount
   * @param {string} damageType - Damage type (for logging)
   */
  async _applyOverTimeDamage(actor, damage, damageType) {
    if (!actor || damage <= 0) return;

    try {
      const before = actor.system?.attributes?.hp?.value ?? 0;
      // Route through the canonical HP mutator: temp HP absorbs first (RAW) AND
      // the concentration save fires off the FULL pre-temp damage (applyHPDamage
      // passes aceQol.fullDamage) instead of the post-temp hp delta. Fixes DoT /
      // aura damage under-rating (or skipping) concentration DCs for casters with
      // temporary HP. (2026-06-23 — previously did its own temp-HP write + raw
      // actor.update, which lost the full-damage DC.)
      const { DamageApplicator } = await import("./damage-applicator.mjs");
      const res = await DamageApplicator.applyHPDamage(actor, damage, { label: `overtime:${damageType ?? "?"}` });
      this._debug(`Applied ${damage} ${damageType} damage to ${actor.name}: HP ${before} → ${res?.newHP ?? "?"}`);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to apply OverTime damage:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Regeneration / Recurring Healing
  // ═══════════════════════════════════════════════════════════════════════════

  /** Record the damage types a creature took (fed by the ace-qol.damageApplied hook). */
  _recordDamageTypes({ actor, types } = {}) {
    if (!actor?.id || !Array.isArray(types) || !types.length) return;
    let set = this._dmgTypesTaken.get(actor.id);
    if (!set) { set = new Set(); this._dmgTypesTaken.set(actor.id, set); }
    for (const t of types) set.add(String(t).toLowerCase());
  }

  /**
   * Detect a Regeneration-style trait on an actor by reading its feature text.
   * Returns { amount, shutoff[], requiresMinHp, noRegenInSunlight, label } or null.
   * Covers trolls, vampires, hydras, and any homebrew worded the standard way
   * ("regains N hit points at the start of its turn").
   */
  _detectRegeneration(actor) {
    if (!actor?.items) return null;
    const DMG = ["acid","fire","cold","lightning","thunder","poison","radiant","necrotic","force","psychic"];
    for (const item of actor.items) {
      if (item.type !== "feat") continue;
      const name = String(item.name ?? "");
      const desc = String(item.system?.description?.value ?? "")
        .replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ");
      const text = `${name}. ${desc}`;

      // Heal phrase, wording-tolerant: regains / regenerates / heals / recovers
      // N (hit points|hp). Different modules word this differently and in
      // different order, so we don't require it to sit right before "at the
      // start of" the way the old pattern did.
      const healRe   = /(?:regains?|regenerates?|heals?|recovers?)\s+(\d+)\s+(?:hit\s*points?|hp)\b/i;
      const healMatch = text.match(healRe);
      const startOfTurn = /start of (?:each of )?(?:its|their|his|her|the creature'?s)?\s*turns?/i.test(text);
      const nameRegen   = /regenerat|fast\s*healing/i.test(name);

      // Treat as regeneration if it's NAMED like it (and heals a number), OR it
      // heals N HP at the start of a turn regardless of the feature's name.
      const looksRegen = (nameRegen && /\d+\s+(?:hit\s*points?|hp)\b/i.test(text))
                      || (!!healMatch && startOfTurn);
      if (!looksRegen) continue;

      let amount = healMatch ? parseInt(healMatch[1]) : 0;
      if (!(amount > 0)) {
        const m2 = text.match(/(\d+)\s+(?:hit\s*points?|hp)\b/i);
        amount = m2 ? parseInt(m2[1]) : 0;
      }
      if (!(amount > 0)) continue;

      // Shut-off damage types: "If it takes <types> damage ... doesn't function / can't regenerate"
      const sm = text.match(/takes?\s+([a-z, ]+?)\s+damage[^.]*?(?:doesn'?t|does not|no longer|can'?t|cannot)\s+(?:function|regenerat)/i)
              || text.match(/(?:if it takes|takes?)\s+([a-z, ]+?)\s+damage/i);
      const scope = sm ? sm[1] : "";
      const shutoff = DMG.filter(d => new RegExp(`\\b${d}\\b`, "i").test(scope));
      return {
        amount,
        shutoff,
        requiresMinHp:     /at least 1 hit point/i.test(text),
        noRegenInSunlight: /in (?:direct )?sunlight/i.test(text),
        label:             nameRegen ? name : "Regeneration",
      };
    }
    return null;
  }

  /** Why (if at all) regeneration is suppressed this turn — returns a reason or null. */
  _regenBlocked(actor, combatant, spec) {
    const hp  = actor.system?.attributes?.hp ?? {};
    const cur = Number(hp.value ?? 0);
    const max = Number(hp.max ?? 0);
    if (max && cur >= max) return "full";   // nothing to heal — handled silently
    if (spec.requiresMinHp && cur < 1) return "reduced to 0 HP";
    if (spec.shutoff?.length) {
      const taken = this._dmgTypesTaken.get(actor.id);
      if (taken) {
        const hit = spec.shutoff.find(t => taken.has(t));
        if (hit) return `took ${hit} damage since its last turn`;
      }
    }
    if (spec.noRegenInSunlight && this._tokenInSunlight(combatant)) return "standing in sunlight";
    return null;
  }

  /** Best-effort: is this combatant's token inside an active Sunlight zone? */
  _tokenInSunlight(combatant) {
    try {
      const HS = game.aceQol?.HolySymbol;
      if (!HS?._inAnySunlight || !HS?._activeSunBearers) return false;
      const token = combatant.token?.object ?? combatant.actor?.getActiveTokens?.()?.[0];
      if (!token) return false;
      const bearers = HS._activeSunBearers().map(td => td.object).filter(Boolean);
      return bearers.length ? HS._inAnySunlight(token, bearers) : false;
    } catch (_) { return false; }
  }

  /** Auto-detected regeneration for a creature at the start of its turn. */
  async _processRegeneration(actor, combatant, round) {
    const spec = this._detectRegeneration(actor);
    if (!spec) return;
    await this._runRegen(actor, combatant, spec);
  }

  /** Authored OverTime healing effect (Forge "happens each turn → regain HP"). */
  async _processHealEffect(actor, combatant, effect, otData) {
    let amount = 0;
    const roll = String(otData.healRoll ?? "").trim();
    if (roll) {
      try { amount = (await new Roll(roll).evaluate()).total; }
      catch (_) { amount = parseInt(roll) || 0; }
    }
    if (!(amount > 0)) return;
    await this._runRegen(actor, combatant, {
      amount,
      shutoff:           otData.regenShutoff ?? [],
      requiresMinHp:     !!otData.requiresMinHp,
      noRegenInSunlight: !!otData.noRegenInSunlight,
      label:             otData.label || effect?.name || "Regeneration",
    });
  }

  /** Shared core: check shut-offs, apply the heal (auto or via card button), announce. */
  async _runRegen(actor, combatant, spec) {
    const reason    = this._regenBlocked(actor, combatant, spec);
    const tokenDoc  = combatant.token ?? actor.getActiveTokens?.()?.[0]?.document;
    const tokenImg  = tokenDoc?.texture?.src ?? actor.img ?? "icons/svg/mystery-man.svg";
    const tokenName = tokenDoc?.name ?? actor.name ?? "Creature";

    if (reason) {
      if (reason !== "full") {
        await this._postRegenCard({ tokenImg, tokenName, label: spec.label, amount: spec.amount, healed: 0, blockedReason: reason });
      }
      return;
    }

    const auto = QolSettings.get("autoApplyOverTimeHeal");
    let healed = 0;
    if (auto) {
      const res = await DamageApplicator.applyHPHeal(actor, spec.amount, { label: `Regeneration — ${tokenName}` });
      healed = res?.healedAmount ?? spec.amount;
    }
    this._debug(`Regeneration: ${tokenName} ${auto ? `+${healed} HP` : `pending +${spec.amount}`} (${spec.label})`);
    await this._postRegenCard({
      tokenImg, tokenName, label: spec.label, amount: spec.amount,
      healed, blockedReason: null, applied: auto,
      actorId: actor.id, tokenDocId: tokenDoc?.id,
    });
  }

  /** GM chat card for a regeneration tick (APPLY button shown when not auto-applied). */
  async _postRegenCard(data) {
    const { tokenImg, tokenName, label, amount, healed, blockedReason, applied, actorId, tokenDocId } = data;

    let body = "", btn = "";
    if (blockedReason) {
      body = `<div class="ace-qol-ot-damage"><span class="ace-qol-ot-dmg-detail">Regeneration suppressed — <strong>${blockedReason}</strong>.</span></div>`;
    } else if (applied) {
      body = `<div class="ace-qol-ot-damage"><span class="ace-qol-ot-dmg-detail">Regained <strong>${healed}</strong> HP.</span></div>`;
    } else {
      body = `<div class="ace-qol-ot-damage"><span class="ace-qol-ot-dmg-detail">Should regain <strong>${amount}</strong> HP.</span></div>`;
      btn  = `<div class="ace-qol-ot-buttons ace-qol-dmg-gm-controls">
                <button class="ace-qol-ot-btn ace-qol-ot-heal" data-action="aceQolOtHeal" data-actor-id="${actorId}" data-heal="${amount}" data-token-doc-id="${tokenDocId ?? ""}">
                  <i class="fas fa-heart"></i> APPLY ${amount} HP
                </button>
              </div>`;
    }

    const cardHtml = `
      <div class="ace-qol-overtime-card ace-qol-regen-card">
        <div class="ace-qol-ot-header">
          <img src="${tokenImg}" class="ace-qol-ot-token-img" />
          <div class="ace-qol-ot-header-text">
            <strong class="ace-qol-ot-name">${tokenName}</strong>
            <span class="ace-qol-ot-label">— ${label}</span>
            <span class="ace-qol-ot-timing">(Start of Turn)</span>
          </div>
        </div>
        ${body}
        ${btn}
      </div>`;

    await ChatMessage.create({
      content: cardHtml,
      whisper: [game.user.id],
      speaker: { alias: "Regeneration" },
      flags: { [MODULE_ID]: { type: "overTimeRegen", actorId, tokenDocId, heal: amount, applied: !!applied } },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Auras (Flavor C) — recurring effects that hit OTHER creatures in range
  // ═══════════════════════════════════════════════════════════════════════════

  /** Read OverTimeAura specs off the effects affecting an actor. */
  _collectAuras(actor) {
    const out = [];
    const effects = actor?.appliedEffects ?? actor?.effects?.contents ?? [];
    for (const e of effects) {
      if (e.disabled || e.isSuppressed) continue;
      const a = e.getFlag?.(MODULE_ID, "OverTimeAura") ?? e.flags?.[MODULE_ID]?.OverTimeAura;
      if (a && (Number(a.range) > 0) && a.roll) out.push(a);
    }
    return out;
  }

  /** Disposition filter: does an aura with this targeting mode reach this token? */
  _auraTargetsMatch(sourceToken, targetToken, mode) {
    if (mode === "all" || !mode) return true;
    const sd = sourceToken.document?.disposition ?? 0;
    const td = targetToken.document?.disposition ?? 0;
    if (mode === "allies")  return td === sd;
    if (mode === "enemies") return (sd > 0 && td < 0) || (sd < 0 && td > 0);
    return true;
  }

  /**
   * Process auras at a creature's turn boundary. Two timing models:
   *   on:"source" → on the aura-bearer's turn, it pulses out to everyone in range.
   *   on:"victim" → on each creature's own turn, it's hit by any aura it stands in.
   */
  async _processAuras(combat, actor, combatant, timing, round) {
    const myToken = combatant.token?.object ?? actor.getActiveTokens?.()?.[0];
    if (!myToken) return;
    const placeables = canvas.tokens?.placeables ?? [];

    // (1) This creature's OWN source-auras pulse out on its turn.
    const myAuras = this._collectAuras(actor).filter(a => a.on === "source" && (a.turn ?? "start") === timing);
    for (const aura of myAuras) {
      const victims = placeables.filter(t =>
        t !== myToken && t.actor
        && this._auraTargetsMatch(myToken, t, aura.targets)
        && aceWithinFt(myToken, t, Number(aura.range)));
      await this._applyAura(myToken, victims, aura);
    }

    // (2) This creature is standing in someone else's victim-aura on its own turn.
    for (const src of placeables) {
      if (src === myToken || !src.actor) continue;
      const srcAuras = this._collectAuras(src.actor).filter(a => a.on === "victim" && (a.turn ?? "start") === timing);
      for (const aura of srcAuras) {
        if (!this._auraTargetsMatch(src, myToken, aura.targets)) continue;
        if (!aceWithinFt(src, myToken, Number(aura.range))) continue;
        await this._applyAura(src, [myToken], aura);
      }
    }
  }

  /** Apply one aura to a set of target tokens (auto-applies + posts a card). */
  async _applyAura(sourceToken, targets, aura) {
    if (!targets?.length) return;
    const results = [];
    for (const t of targets) {
      const actor = t.actor;
      if (!actor) continue;
      if (aura.what === "heal") {
        let amount = 0;
        try { amount = (await new Roll(String(aura.roll || "0")).evaluate()).total; }
        catch (_) { amount = parseInt(aura.roll) || 0; }
        if (amount <= 0) continue;
        const res = await DamageApplicator.applyHPHeal(actor, amount, { label: `${aura.label} (aura)` });
        results.push({ name: t.name, text: `+${res?.healedAmount ?? amount} HP` });
      } else {
        const dmg = await this._rollDamage(String(aura.roll || "0"), aura.damageType, actor, false);
        const final = dmg?.total ?? 0;
        if (final > 0) await this._applyOverTimeDamage(actor, final, aura.damageType);
        const mod = dmg?.modifier && dmg.modifier !== "normal" ? ` (${dmg.modifier})` : "";
        results.push({ name: t.name, text: `${final} ${aura.damageType || ""}${mod}`.trim() });
      }
    }
    if (results.length) await this._postAuraCard(sourceToken, aura, results);
  }

  /** GM chat card summarizing an aura pulse. */
  async _postAuraCard(sourceToken, aura, results) {
    const verb = aura.what === "heal" ? "heals nearby" : "hits nearby";
    const rows = results.map(r =>
      `<div class="ace-qol-ot-damage"><span class="ace-qol-ot-dmg-detail">${r.name}: <strong>${r.text}</strong></span></div>`
    ).join("");
    const cardHtml = `
      <div class="ace-qol-overtime-card ace-qol-aura-card">
        <div class="ace-qol-ot-header">
          <img src="${sourceToken.document?.texture?.src ?? sourceToken.actor?.img ?? "icons/svg/aura.svg"}" class="ace-qol-ot-token-img" />
          <div class="ace-qol-ot-header-text">
            <strong class="ace-qol-ot-name">${sourceToken.name}</strong>
            <span class="ace-qol-ot-label">— ${aura.label || "Aura"}</span>
            <span class="ace-qol-ot-timing">(${verb})</span>
          </div>
        </div>
        ${rows}
      </div>`;
    await ChatMessage.create({
      content: cardHtml,
      whisper: [game.user.id],
      speaker: { alias: "Aura" },
      flags: { [MODULE_ID]: { type: "overTimeAura" } },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Condition Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply a condition status to an actor.
   * @param {Actor}  actor     - The target actor
   * @param {string} condition - Status ID (e.g., "poisoned", "prone")
   */
  async _applyCondition(actor, condition) {
    // Foundry v12+ uses toggleStatusEffect
    if (actor.toggleStatusEffect) {
      const statuses = actor.statuses ?? new Set();
      if (statuses.has(condition)) return;   // already present
      try {
        await actor.toggleStatusEffect(condition, { active: true });
        return;
      } catch (err) {
        // "Invalid status ID" → `condition` is a custom (non-Foundry-status) key
        // (a Forge trap / homebrew DoT). Fall through to a manual ActiveEffect
        // instead of throwing and aborting the over-time tick.
        console.debug(`${MODULE_ID} | overtime: "${condition}" isn't a Foundry status id; creating the effect manually (${err?.message ?? err}).`);
      }
    }
    // Fallback: create an ActiveEffect with the status (old Foundry OR custom key)
    const effectData = {
      name: condition.charAt(0).toUpperCase() + condition.slice(1),
      icon: `icons/svg/status-${condition}.svg`,
      statuses: [condition],
    };
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }

  /**
   * Remove a condition status from an actor.
   * @param {Actor}  actor     - The target actor
   * @param {string} condition - Status ID
   */
  async _removeCondition(actor, condition) {
    if (actor.toggleStatusEffect) {
      const statuses = actor.statuses ?? new Set();
      if (!statuses.has(condition)) return;   // not present
      try {
        await actor.toggleStatusEffect(condition, { active: false });
        return;
      } catch (err) {
        // Custom (non-status) key — fall through to the manual delete below.
        console.debug(`${MODULE_ID} | overtime: "${condition}" isn't a Foundry status id on remove; deleting the effect manually (${err?.message ?? err}).`);
      }
    }
    // Fallback: find and delete the effect with this status (old Foundry OR custom key)
    const effect = actor.effects?.find(e => e.statuses?.has(condition));
    if (effect) await effect.delete();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Macro Execution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute a macro by name or UUID.
   * @param {string}       macroRef     - Macro name or UUID
   * @param {Actor}        actor        - The affected actor
   * @param {ActiveEffect} effect       - The OverTime effect
   * @param {object}       otData       - OverTime data
   * @param {object|null}  saveResult   - Save result
   * @param {object|null}  damageResult - Damage result
   */
  async _executeMacro(macroRef, actor, effect, otData, saveResult, damageResult) {
    if (!macroRef) return;

    try {
      let macro = null;

      // Try UUID
      if (macroRef.includes(".")) {
        try { macro = await fromUuid(macroRef); } catch { /* not UUID */ }
      }
      // Try name
      if (!macro) macro = game.macros?.getName(macroRef);
      // Try ID
      if (!macro) macro = game.macros?.get(macroRef);

      if (!macro) {
        console.warn(`${MODULE_ID} | OverTime macro not found: "${macroRef}"`);
        return;
      }

      this._debug(`Executing OverTime macro: ${macro.name} for ${actor.name}`);

      await macro.execute({
        actor,
        effect,
        overTimeData: otData,
        saveResult,
        damageResult,
        MODULE_ID,
      });
    } catch (err) {
      console.error(`${MODULE_ID} | OverTime macro execution failed (${macroRef}):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Card — OverTime Result
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a whispered-to-GM chat card showing the OverTime result.
   *
   * Layout:
   *   [Token Image] [Token Name] — Label (Start/End of Turn)
   *   Save: CON DC 15 → Rolled 12 → FAILED
   *   Damage: 2d6 fire → 7 fire damage
   *   [APPLY] [DISMISS EFFECT]
   */
  async _postOverTimeCard(data) {
    const {
      tokenImg, tokenName, label, timing,
      saveResult, damageResult, effectRemoved,
      conditionApplied, conditionRemoved, condition,
      actorId, effectId, tokenDocId,
      rawDamage, damageType,
    } = data;

    const timingLabel = timing === "start" ? "Start of Turn" : "End of Turn";

    // ── Save row ──
    let saveHtml = "";
    if (saveResult) {
      const passClass = saveResult.passed ? "ace-qol-ot-pass" : "ace-qol-ot-fail";
      const passLabel = saveResult.passed ? "PASSED" : "FAILED";
      const abilityLabel = (saveResult.ability ?? "").toUpperCase();
      saveHtml = `
        <div class="ace-qol-ot-save">
          <span class="ace-qol-ot-save-label">Save:</span>
          <span class="ace-qol-ot-save-detail">
            ${abilityLabel} DC ${saveResult.dc}
            → Rolled <strong>${saveResult.total}</strong>
            → <span class="${passClass}"><strong>${passLabel}</strong></span>
          </span>
        </div>`;
    }

    // ── Damage row ──
    let damageHtml = "";
    if (damageResult && damageResult.total > 0) {
      const modLabel = damageResult.modifier !== "normal"
        ? ` <span class="ace-qol-ot-mod">(${damageResult.modifier})</span>`
        : "";
      damageHtml = `
        <div class="ace-qol-ot-damage">
          <span class="ace-qol-ot-dmg-label">Damage:</span>
          <span class="ace-qol-ot-dmg-detail">
            ${damageResult.formula} ${damageResult.type}
            → <strong>${damageResult.total}</strong> ${damageResult.type} damage${modLabel}
          </span>
        </div>`;
    } else if (damageResult && damageResult.modifier === "immune") {
      damageHtml = `
        <div class="ace-qol-ot-damage">
          <span class="ace-qol-ot-dmg-label">Damage:</span>
          <span class="ace-qol-ot-dmg-detail ace-qol-ot-immune">
            ${damageResult.formula} ${damageResult.type} → <strong>IMMUNE</strong>
          </span>
        </div>`;
    }

    // ── Effect/condition status ──
    let statusHtml = "";
    if (effectRemoved) {
      statusHtml += `<div class="ace-qol-ot-status ace-qol-ot-removed"><i class="fas fa-circle-xmark"></i> Effect removed (save passed)</div>`;
    }
    if (conditionApplied) {
      statusHtml += `<div class="ace-qol-ot-status ace-qol-ot-condition-applied"><i class="fas fa-skull-crossbones"></i> ${condition} applied</div>`;
    }
    if (conditionRemoved) {
      statusHtml += `<div class="ace-qol-ot-status ace-qol-ot-condition-removed"><i class="fas fa-circle-check"></i> ${condition} removed</div>`;
    }

    // ── Action buttons (only if damage is pending application) ──
    const needsApply = damageResult && damageResult.total > 0
      && !QolSettings.get("autoApplyOverTimeDamage");

    let buttonsHtml = "";
    if (needsApply || !effectRemoved) {
      buttonsHtml = `<div class="ace-qol-ot-buttons ace-qol-dmg-gm-controls">`;
      if (needsApply) {
        buttonsHtml += `<button class="ace-qol-ot-btn ace-qol-ot-apply" data-action="aceQolOtApply" data-actor-id="${actorId}" data-damage="${rawDamage}" data-damage-type="${damageType ?? ""}" data-token-doc-id="${tokenDocId ?? ""}">
          <i class="fas fa-heart-crack"></i> APPLY ${rawDamage} DMG
        </button>`;
      }
      if (!effectRemoved && effectId) {
        buttonsHtml += `<button class="ace-qol-ot-btn ace-qol-ot-dismiss" data-action="aceQolOtDismiss" data-actor-id="${actorId}" data-effect-id="${effectId}">
          <i class="fas fa-ban"></i> DISMISS EFFECT
        </button>`;
      }
      buttonsHtml += `</div>`;
    }

    const cardHtml = `
      <div class="ace-qol-overtime-card">
        <div class="ace-qol-ot-header">
          <img src="${tokenImg}" class="ace-qol-ot-token-img" />
          <div class="ace-qol-ot-header-text">
            <strong class="ace-qol-ot-name">${tokenName}</strong>
            <span class="ace-qol-ot-label">— ${label}</span>
            <span class="ace-qol-ot-timing">(${timingLabel})</span>
          </div>
        </div>
        ${saveHtml}
        ${damageHtml}
        ${statusHtml}
        ${buttonsHtml}
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      whisper: [game.user.id],   // GM only
      speaker: { alias: "OverTime" },
      flags: {
        [MODULE_ID]: {
          type: "overTimeResult",
          actorId,
          effectId,
          tokenDocId,
          rawDamage,
          damageType,
          applied: QolSettings.get("autoApplyOverTimeDamage") && rawDamage > 0,
          dismissed: effectRemoved,
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Card Button Wiring
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wire APPLY and DISMISS buttons on OverTime result cards.
   * Called from renderChatMessage hook — handles both new and re-rendered cards.
   *
   * @param {HTMLElement} el      - The card DOM element
   * @param {ChatMessage} message - The chat message
   * @param {object}      flags   - Message flags
   */
  _wireOverTimeButtons(el, message, flags) {
    // ── APPLY DAMAGE button ──
    const applyBtn = el.querySelector("[data-action='aceQolOtApply']");
    if (applyBtn && !applyBtn.dataset.wired) {
      applyBtn.dataset.wired = "1";

      if (flags.applied) {
        applyBtn.disabled = true;
        applyBtn.innerHTML = '<i class="fas fa-check"></i> APPLIED';
      } else {
        applyBtn.addEventListener("click", async () => {
          const actorId = applyBtn.dataset.actorId;
          const damage = parseInt(applyBtn.dataset.damage) || 0;
          const dmgType = applyBtn.dataset.damageType ?? "";
          const actor = game.actors.get(actorId);

          if (!actor || damage <= 0) return;

          await this._applyOverTimeDamage(actor, damage, dmgType);

          applyBtn.disabled = true;
          applyBtn.innerHTML = '<i class="fas fa-check"></i> APPLIED';
          await message.setFlag(MODULE_ID, "applied", true);
        });
      }
    }

    // ── APPLY HEAL button (regeneration cards) ──
    const healBtn = el.querySelector("[data-action='aceQolOtHeal']");
    if (healBtn && !healBtn.dataset.wired) {
      healBtn.dataset.wired = "1";
      if (flags.applied) {
        healBtn.disabled = true;
        healBtn.innerHTML = '<i class="fas fa-check"></i> APPLIED';
      } else {
        healBtn.addEventListener("click", async () => {
          const tokenActor = canvas.tokens?.get(healBtn.dataset.tokenDocId)?.actor;
          const actor = tokenActor ?? game.actors.get(healBtn.dataset.actorId);
          const heal = parseInt(healBtn.dataset.heal) || 0;
          if (!actor || heal <= 0) return;
          await DamageApplicator.applyHPHeal(actor, heal, { label: "Regeneration (manual apply)" });
          healBtn.disabled = true;
          healBtn.innerHTML = '<i class="fas fa-check"></i> APPLIED';
          await message.setFlag(MODULE_ID, "applied", true);
        });
      }
    }

    // ── DISMISS EFFECT button ──
    const dismissBtn = el.querySelector("[data-action='aceQolOtDismiss']");
    if (dismissBtn && !dismissBtn.dataset.wired) {
      dismissBtn.dataset.wired = "1";

      if (flags.dismissed) {
        dismissBtn.disabled = true;
        dismissBtn.innerHTML = '<i class="fas fa-check"></i> DISMISSED';
      } else {
        dismissBtn.addEventListener("click", async () => {
          const actorId = dismissBtn.dataset.actorId;
          const effectId = dismissBtn.dataset.effectId;
          const actor = game.actors.get(actorId);

          if (!actor || !effectId) return;

          const effect = actor.effects?.get(effectId);
          if (effect) {
            try {
              await effect.delete();
              this._debug(`Dismissed OverTime effect ${effectId} from ${actor.name}`);
            } catch (err) {
              console.error(`${MODULE_ID} | Failed to dismiss OverTime effect:`, err);
            }
          }

          dismissBtn.disabled = true;
          dismissBtn.innerHTML = '<i class="fas fa-check"></i> DISMISSED';
          await message.setFlag(MODULE_ID, "dismissed", true);
        });
      }
    }

    // ── Hide GM controls for non-GM users ──
    if (!game.user.isGM) {
      const controls = el.querySelectorAll(".ace-qol-dmg-gm-controls");
      for (const ctrl of controls) {
        ctrl.style.display = "none";
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug
  // ═══════════════════════════════════════════════════════════════════════════

  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | OT | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}
