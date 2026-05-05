// ─── ACE: QOL — Attack Resolution Pipeline ───────────────────────────────────
// Hooks into D&D 5e attack rolls. When an attack lands:
//   1. Assess every target's full state
//   2. Determine hit/miss/crit per target
//   3. Hand off to damage calculation (Phase 4)
//
// This is the orchestrator — it connects the attack roll to the target state
// assessment and eventually to the damage pipeline.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { TargetState } from "./target-state.mjs";
import { CombatState } from "./combat-state.mjs";
import { QolSettings } from "./settings.mjs";
import { FlagsEngine } from "./flags-engine.mjs";
import { MergeCard } from "./merge-card.mjs";
import { CoverEngine } from "./cover-engine.mjs";
import { pendingAttackChoices, awaitDsnRoll, showCenterToast } from "./attack-prompt.mjs";

export class AttackPipeline {

  constructor() {
    /** @type {WeakSet<Roll>} v0.4.22.9 — dedupe Set keyed on Roll object
     *  reference. Replaces the v0.4.22 `_processedAttackKeys` Map which
     *  was keyed on `messageId|activityId|formula`. That key collided
     *  catastrophically: `messageId` is null at the rollAttackV2 hook
     *  stage (chat message hasn't been created yet), and `activityId +
     *  formula` is identical across every attack made with the same
     *  weapon. Every Jeth rapier swing within 10s produced the same
     *  key, so swings 2-N got silently deduped → "swing 1 fires, no
     *  cards on subsequent swings."
     *
     *  Roll-reference dedup is correct: the dual `rollAttackV2 +
     *  rollAttack` hooks fire with the SAME Roll instance, so
     *  `WeakSet.has(roll)` is true on the second fire. Distinct
     *  attacks produce distinct Roll instances, so they pass through.
     *  WeakSet auto-cleans when Roll references go out of scope —
     *  no memory leak, no TTL needed. */
    this._processedAttackRolls = new WeakSet();

    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── PRE-ROLL: Force advantage/disadvantage based on combat state ──
    // This fires BEFORE the dice roll — we can modify the roll config
    Hooks.on("dnd5e.preRollAttackV2", (config, dialog, message) => {
      return this._onPreAttackRoll(config, dialog, message);
    });

    // ── POST-ROLL: Assess results, post card ──
    //
    // v0.4.22.9: Dedupe via the Roll OBJECT REFERENCE, not a string key.
    // Both `rollAttackV2` and `rollAttack` hooks fire with the same Roll
    // instance for a given attack — WeakSet identity check catches the
    // duplicate. Distinct attacks have distinct Roll instances and pass
    // through. WeakSet auto-cleans when refs are GC'd; no TTL needed.
    //
    // Previous (v0.4.22) implementation used a string key
    // `messageId|activityId|formula`, which collided across every attack
    // made with the same weapon: `messageId` was null at this hook stage,
    // and `activityId + formula` are identical for repeat swings. Net
    // effect: only the first swing per ~10 seconds posted a card.
    const dedupedAttackHandler = (rolls, data) => {
      try {
        const rollRef = rolls?.[0];
        if (rollRef && typeof rollRef === "object") {
          if (this._processedAttackRolls.has(rollRef)) {
            // Silent dedupe — log only in debug
            try {
              if (game.settings.get(MODULE_ID, "debugMode")) {
                console.log(`${MODULE_ID} | rollAttack dedupe: dual-hook duplicate for Roll ${rollRef?.formula ?? "?"}`);
              }
            } catch (_) { /* setting not ready */ }
            return;
          }
          this._processedAttackRolls.add(rollRef);
        }
        // If rollRef is missing or non-object (shouldn't happen but safe),
        // we skip dedup — better to risk a duplicate card than to block
        // a legitimate attack.

        return this._onAttackRoll(rolls, data);
      } catch (err) {
        console.warn(`${MODULE_ID} | dedupedAttackHandler failed:`, err);
        return this._onAttackRoll(rolls, data);
      }
    };

    Hooks.on("dnd5e.rollAttackV2", dedupedAttackHandler);
    Hooks.on("dnd5e.rollAttack",   dedupedAttackHandler);

    // ── DIALOG RENDER: Swap the d20 icon with our BD20 dice image ──
    Hooks.on("renderApplication", (app, html) => this._onRenderRollDialog(app, html));
    Hooks.on("renderApplicationV2", (app, html) => this._onRenderRollDialog(app, html));

    console.log(`${MODULE_ID} | Attack pipeline hooks registered (pre-roll + post-roll + dialog render)`);
  }

  /**
   * When the D&D 5e attack roll dialog renders, swap the d20 icon
   * with our BD20 dice PNG.
   */
  _onRenderRollDialog(app, html) {
    // ── v0.4.22 hardened ──
    // Tighter dialog-class detection (RollConfigurationDialog only) and
    // narrower image selector that requires the d20 alt/src match BEFORE
    // querying the DOM. Previous selector `ul.dice img, .dice img` could
    // pick up unrelated dice elements if Foundry/dnd5e refactor the dialog
    // structure. Now we scope to the recognized dnd5e dialog tree first
    // and short-circuit aggressively. Wrapped in try/catch so a CSS shift
    // can't break the entire render hook chain.
    try {
      const isRollDialog = app?.constructor?.name?.includes("RollConfigurationDialog")
        || app?.options?.classes?.includes?.("roll-configuration");
      if (!isRollDialog) return;

      const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
      if (!el?.querySelectorAll) return;

      // Scope the search to the dialog's actual dice container — fall back
      // to the broader selector only if the scoped one finds nothing
      let diceImgs = el.querySelectorAll(".roll-configuration ul.dice img");
      if (!diceImgs.length) {
        diceImgs = el.querySelectorAll("ul.dice img");
      }

      for (const img of diceImgs) {
        // Only replace d20 icons (alt text or src containing "d20")
        const altLc = (img.alt ?? "").toLowerCase();
        const srcLc = (img.src ?? "").toLowerCase();
        const isD20 = altLc.includes("d20") || srcLc.includes("d20");
        if (!isD20) continue;

        // Skip if we already swapped (idempotent re-render guard)
        if (img.dataset.aceQolSwapped === "1") continue;

        img.src = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-20_nobg.png`;
        img.style.filter = "drop-shadow(0 2px 4px rgba(0,0,0,0.5))";
        img.dataset.aceQolSwapped = "1";
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | _onRenderRollDialog dice-icon swap failed (non-fatal):`, err?.message ?? err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRE-ROLL: Force advantage/disadvantage based on combat state
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called BEFORE the attack roll dice are thrown.
   * Assesses attacker + all targets, determines advantage/disadvantage,
   * and injects it into the roll configuration.
   *
   * dnd5e.preRollAttackV2 passes: (config, dialogConfig, messageConfig)
   * config.rolls[0] contains the roll config we can modify.
   */
  _onPreAttackRoll(config, dialog, message) {
    // Runs on ALL clients (GM + players) — handles advantage/disadvantage detection,
    // range checks, and incapacitation blocks. The pre-roll dialog is client-local.
    if (!QolSettings.get("autoCheckHit")) return;

    const subject = config?.subject;
    if (!subject) return;

    const item = subject.item;
    const actor = subject.actor;
    if (!item || !actor) return;

    // ── Block attacks from incapacitated attackers ──
    //
    // v0.4.22: alongside the center toast (auto-dismissing), also post a
    // `ui.notifications.warn` so the block reason persists in the Foundry
    // notification stack. Center toasts can be missed if the player isn't
    // looking at the screen center; the notification stays visible until
    // the user dismisses or another notification replaces it.
    const atkStatuses = actor.statuses ?? new Set();
    if (atkStatuses.has("paralyzed") || atkStatuses.has("stunned")
     || atkStatuses.has("unconscious") || atkStatuses.has("incapacitated")
     || atkStatuses.has("petrified")) {
      const condition = ["paralyzed", "stunned", "unconscious", "incapacitated", "petrified"]
        .find(c => atkStatuses.has(c))?.toUpperCase();
      const msg = `${actor.token?.name ?? actor.name} is ${condition} — cannot attack`;
      showCenterToast(msg, 2500);
      ui.notifications?.warn(`ACE QOL: ${msg}`);
      return false; // Block the roll
    }

    const targets = game.user.targets;
    if (!targets.size) return; // Item.use shim hard-blocks no-target weapons; silent fallback for other paths

    // ── Melee multi-target lockout ──
    // A melee weapon swings at one creature unless the actor has a cleave-style
    // feature (Cleave, Great Weapon Master, Whirlwind Attack, etc.). If the GM
    // or player has multiple tokens targeted by accident, block the attack and
    // tell them to retarget. Skips when the actor genuinely has multi-target
    // melee features so Whirlwind/Cleave still work as designed.
    if (targets.size > 1 && AttackPipeline._isMeleeAttack(item, subject)
        && !AttackPipeline._actorHasMultiTargetMelee(actor, item)) {
      const msg = `Melee attack — only one target allowed (${targets.size} targeted; retarget single creature)`;
      showCenterToast(msg, 2500);
      ui.notifications?.warn(`ACE QOL: ${msg}`);
      this._debug(`Blocked: ${actor.name} melee attack with ${targets.size} targets, no cleave/whirlwind feature`);
      return false; // Block the roll
    }

    // ── Range check: block attacks on out-of-range targets ──
    const firstTarget = targets.first();
    const rangeCheck = this._checkRange(actor, firstTarget, item);
    if (rangeCheck.blocked) {
      const msg = `Out of range — ${rangeCheck.distanceFt}ft away (${rangeCheck.rangeDesc})`;
      showCenterToast(msg, 2500);
      ui.notifications?.warn(`ACE QOL: ${msg}`);
      return false; // Block the roll
    }

    // Assess combat state for the first target (primary target)
    // If multiple targets, use the first — advantage is per-attack, not per-target
    const combatState = CombatState.assess(actor, firstTarget, item);
    if (!combatState) return;

    // Store the combat state for the post-roll handler
    this._lastCombatState = combatState;
    this._lastCombatStates = CombatState.assessAll(actor, item);

    // ── Inject advantage/disadvantage into the roll dialog + config ──
    // Set the dialog's default button so the correct mode is pre-selected
    // AND set it on the roll config for fast-forward rolls (no dialog)
    dialog.options = dialog.options ?? {};

    const rollConfig = config.rolls?.[0];

    // ── User prompt choice (from attack-prompt.mjs) overrides auto-detection ──
    const userChoice = pendingAttackChoices.get(actor.id);
    if (userChoice) {
      pendingAttackChoices.delete(actor.id);
      if (userChoice === "advantage") {
        dialog.options.defaultButton = "advantage";
        if (rollConfig?.options) rollConfig.options.advantage = true;
        config.advantage = true;
      } else if (userChoice === "disadvantage") {
        dialog.options.defaultButton = "disadvantage";
        if (rollConfig?.options) rollConfig.options.disadvantage = true;
        config.disadvantage = true;
      }
      // "normal" → leave config alone; dnd5e applyKeybindings sets NORMAL.
      this._debug(`PRE-ROLL: Using user prompt choice: ${userChoice}`);
      return;
    }

    if (combatState.finalRollMode === "advantage") {
      dialog.options.defaultButton = "advantage";
      // dnd5e applyKeybindings reads roll.options.advantage / config.advantage (booleans),
      // NOT advantageMode — it overwrites advantageMode based on those three sources.
      if (rollConfig?.options) rollConfig.options.advantage = true;
      config.advantage = true;

      this._debug(`PRE-ROLL: Setting ADVANTAGE for ${item.name} → ${firstTarget.actor?.name}`);
      for (const src of combatState.advantageSources) {
        this._debug(`  → ${src.reason}`);
      }
    } else if (combatState.finalRollMode === "disadvantage") {
      dialog.options.defaultButton = "disadvantage";
      if (rollConfig?.options) rollConfig.options.disadvantage = true;
      config.disadvantage = true;

      this._debug(`PRE-ROLL: Setting DISADVANTAGE for ${item.name} → ${firstTarget.actor?.name}`);
      for (const src of combatState.disadvantageSources) {
        this._debug(`  → ${src.reason}`);
      }
    }

    // Don't return false — let the roll continue
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  POST-ROLL: Attack Roll Handler
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when a D&D 5e attack roll completes.
   * Assesses all targets and determines hit/miss/crit.
   */
  async _onAttackRoll(rolls, data) {
    if (!game.user.isGM) return;

    const subject = data?.subject;
    if (!subject) return;

    const item = subject.item;
    const actor = subject.actor;
    if (!item || !actor) return;

    // Check if auto-check hit is enabled
    if (!QolSettings.get("autoCheckHit")) return;

    const roll = rolls?.[0];
    if (!roll) return;

    // Get targeted tokens
    const targets = game.user.targets;
    if (!targets.size) {
      this._debug("No targets selected — skipping attack resolution");
      return;
    }

    let attackTotal = roll.total;
    const d20Result = roll.dice?.[0]?.total ?? roll.result;
    const isCritRoll = d20Result === 20;
    const isFumbleRoll = d20Result === 1;

    // Determine attack type — use the activity's getter (handles thrown, spell, etc.)
    const actionType = subject.actionType ?? item.system?.actionType ?? "mwak";
    const isMelee = ["mwak", "msak"].includes(actionType);
    const isSpell = item.type === "spell" || ["msak", "rsak"].includes(actionType);

    // ── Optional Bonus Prompts (Bardic Inspiration, Lucky, Precision Attack, etc.) ──
    // Check if the actor has any optional bonuses available for this attack roll.
    // Route to the correct player (owner of the attacking actor) via socket.
    try {
      const optionalResult = await FlagsEngine.routeOptionalPrompt(
        actor, "attack", actionType, attackTotal, d20Result
      );
      if (optionalResult.bonuses.length > 0) {
        attackTotal = optionalResult.newTotal;
        this._debug(`Optional bonuses applied: ${optionalResult.bonuses.map(b => `${b.label} +${b.total}`).join(", ")} → new total ${attackTotal}`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Optional prompt failed (non-blocking):`, err);
    }

    // ── Use pre-roll combat states if available, otherwise assess now ──
    const combatStates = this._lastCombatStates?.length
      ? this._lastCombatStates
      : CombatState.assessAll(actor, item);

    // ── Calculate cover for each target and build results ──
    const atkToken = CoverEngine.getAttackerToken(actor);
    const results = [];
    for (const cs of combatStates) {
      // ── Cover calculation: add AC bonus from cover ──
      let coverResult = null;
      let effectiveAC = cs.target.ac;
      try {
        if (QolSettings.get("enableCoverCalculation") && atkToken && cs.targetToken) {
          coverResult = CoverEngine.calculateCover(atkToken, cs.targetToken);
          if (coverResult.isFullCover) {
            this._debug(`COVER: ${cs.target.name} has FULL COVER — untargetable`);
          } else if (coverResult.acBonus > 0) {
            effectiveAC += coverResult.acBonus;
            this._debug(`COVER: ${cs.target.name} has ${coverResult.label} — AC ${cs.target.ac} → ${effectiveAC}`);
          }
          // Show visual indicator on target
          CoverEngine.showCoverIndicator(cs.targetToken, coverResult);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Cover calculation failed (non-blocking):`, err);
      }

      // ── CUTTING WORDS — Lore Bard reaction to reduce attack roll ──
      // Must happen BEFORE hit determination since it changes the attack total.
      let adjustedAttackTotal = attackTotal;
      try {
        const reactionEng = game.aceQol?.reactionEngine;
        if (reactionEng && !isFumbleRoll && !isCritRoll) {
          const cwResult = await reactionEng.checkCuttingWords({
            actor: actor,
            token: atkToken,
            rollType: "attack",
            total: attackTotal,
            description: `${actor.name}'s attack with ${item.name}`,
          });
          if (cwResult.reduced) {
            adjustedAttackTotal = cwResult.newTotal;
            this._debug(`Cutting Words reduced attack total: ${attackTotal} → ${adjustedAttackTotal}`);
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Cutting Words check failed (non-blocking):`, err);
      }

      // ── Determine hit/miss ──
      let hitResult;
      if (isFumbleRoll) {
        hitResult = "fumble";
      } else if (coverResult?.isFullCover) {
        hitResult = "miss"; // Full cover = can't be hit
      } else if (isCritRoll || cs.autoCrit) {
        hitResult = "critical";
      } else if (adjustedAttackTotal >= effectiveAC) {
        hitResult = "hit";
      } else {
        hitResult = "miss";
      }

      results.push({
        ...cs,           // full combat state (attacker + target + modifiers)
        name: cs.target.name,
        img: cs.target.img,
        ac: cs.target.ac,
        effectiveAC,
        coverResult,
        hitResult,
        attackTotal: adjustedAttackTotal,
        originalAttackTotal: attackTotal,
        d20Result,
        isCritRoll,
        isFumbleRoll,
      });
    }

    // Clear pre-roll cache
    this._lastCombatStates = null;
    this._lastCombatState = null;

    // ── POST-HIT REACTIONS (Shield, etc.) ──
    // Check before posting results so that Shield can change hits to misses.
    // The reactionEngine is accessed via the global API (avoids circular imports).
    const reactionEng = game.aceQol?.reactionEngine;
    if (reactionEng) {
      try {
        const modifiedResults = await reactionEng.checkPostHitReactions(results, item, actor);
        // Replace results in-place if modified (Shield may flip hit→miss)
        if (modifiedResults) {
          results.length = 0;
          results.push(...modifiedResults);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | Post-hit reaction check failed:`, err);
      }
    }

    // ── SILVERY BARBS — force reroll on successful attacks ──
    // Opponents within 60ft can force the attacker to reroll the d20.
    if (reactionEng) {
      try {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.hitResult !== "hit" && r.hitResult !== "critical") continue;
          const sbResult = await reactionEng.checkSilveryBarbs({
            actor: actor,
            token: atkToken,
            rollType: "attack",
            total: r.attackTotal,
            dc: r.effectiveAC,
            description: `${actor.name}'s attack against ${r.name}`,
          });
          if (sbResult.rerolled) {
            // Re-evaluate hit with new d20
            const newTotal = sbResult.newTotal ?? r.attackTotal;
            if (newTotal < r.effectiveAC && !r.isCritRoll) {
              results[i] = { ...r, hitResult: "miss", attackTotal: newTotal, silveryBarbsRerolled: true };
              this._debug(`Silvery Barbs: ${actor.name}'s attack rerolled → ${newTotal} vs AC ${r.effectiveAC} → MISS`);
            }
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Silvery Barbs check failed (non-blocking):`, err);
      }
    }

    // ── Log results ──
    const hits = results.filter(r => r.hitResult === "hit" || r.hitResult === "critical");
    const misses = results.filter(r => r.hitResult === "miss" || r.hitResult === "fumble");

    this._debug(`Attack: ${item.name} (${attackTotal}) → ${hits.length} hits, ${misses.length} misses`);

    // ── Post attack results to chat ──
    await this._postAttackResults(item, actor, results, { isMelee, isSpell, roll, subject });

    // ── Store results for damage phase ──
    // The damage pipeline (Phase 4) will read this to apply damage
    this._lastAttackResults = results;
    this._lastAttackItem = item;
    this._lastAttackActor = actor;

    // Emit a hook that other modules/phases can listen to
    Hooks.callAll(`${MODULE_ID}.attackComplete`, {
      item,
      actor,
      results,
      hits,
      misses,
      actionType,
      subject,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Card — Attack Results
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a compact attack results card to chat.
   * Shows roll formula with modifier breakdown, big result number,
   * per-target hit/miss with state tags.
   */
  async _postAttackResults(item, actor, results, opts = {}) {
    if (!results.length) return;

    const r0 = results[0];
    const rollTotal = r0.attackTotal;
    const d20 = r0.d20Result;

    // ── Build modifier breakdown from the actual roll terms ──
    // Parse the roll formula to extract each modifier
    const formulaParts = [];
    const rollObj = opts.roll;

    // ── MERGE CARD: store attack data instead of posting separate card ──
    // When merge mode is enabled, we skip posting the attack card here.
    // Instead, we cache the attack results so the damage engine can build
    // a combined card when damage is calculated.
    if (MergeCard.isEnabled) {
      // Still build formula parts so the merge card can use them
      this._buildFormulaPartsForMerge(item, actor, results, opts);
      MergeCard.storeAttackResult({
        item, actor, results,
        roll: rollObj,
        opts,
        formulaParts: this._lastFormulaPartsHtml ?? "",
      });
      return; // Don't post the separate attack card
    }
    const rollFormula = rollObj?.formula ?? "";
    const rollTerms = rollObj?.terms ?? [];

    // ── Ability modifier — use the activity's computed ability (handles Battle Smith,
    //    finesse, spell attacks, thrown weapons, etc. automatically via the system) ──
    const actorAbilities = actor.system?.abilities ?? {};
    const profBonus = actor.system?.attributes?.prof ?? 0;
    const activity = opts.subject; // AttackActivity from dnd5e.rollAttackV2 hook

    // activity.ability resolves: explicit override → spellcasting → availableAbilities
    // (Battle Smith INT, finesse highest of STR/DEX, spell CHA/INT/WIS, ranged DEX, melee STR)
    let resolvedAbility = activity?.ability
      || item.system?.attack?.ability || item.system?.ability || "";
    // dnd5e v5: ability can be a Set — unwrap it
    if (resolvedAbility instanceof Set || resolvedAbility instanceof Array) resolvedAbility = [...resolvedAbility][0] ?? "";
    if (typeof resolvedAbility !== "string") resolvedAbility = String(resolvedAbility || "");
    let abilityLabel = resolvedAbility.toUpperCase() || "";
    let abilityMod = resolvedAbility ? (actorAbilities[resolvedAbility]?.mod ?? 0) : 0;

    // Fallback only if activity wasn't available (e.g., old dnd5e version)
    if (!abilityLabel) {
      const actionType = activity?.actionType ?? item.system?.actionType ?? "mwak";
      const isFinesse = item.system?.properties?.has?.("fin");
      const isThrown = item.system?.properties?.has?.("thr");
      const strMod = actorAbilities.str?.mod ?? 0;
      const dexMod = actorAbilities.dex?.mod ?? 0;

      if (isFinesse) {
        if (dexMod > strMod) { abilityLabel = "DEX"; abilityMod = dexMod; }
        else { abilityLabel = "STR"; abilityMod = strMod; }
      } else if (isThrown && actionType === "rwak") {
        abilityLabel = "STR"; abilityMod = strMod;
      } else if (["rwak", "rsak"].includes(actionType)) {
        abilityLabel = "DEX"; abilityMod = dexMod;
      } else {
        abilityLabel = "STR"; abilityMod = strMod;
      }
    }

    // Build the display formula
    const bd20Path = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-${d20}_nobg.png`;
    formulaParts.push(
      `<span class="ace-qol-mod-die">`
      + `<img class="ace-qol-atk-d20-img" src="${bd20Path}" alt="d20" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
      + `<i class="fas fa-dice-d20 ace-qol-atk-d20-fallback" style="display:none"></i>`
      + `<span class="ace-qol-atk-d20-result">${d20}</span>`
      + `</span>`
    );
    // Always show the ability label so users know which stat is used (even when +0)
    formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${abilityMod >= 0 ? "+" : ""}${abilityMod}</span><span class="ace-qol-mod-label">${abilityLabel}</span></span>`);
    if (profBonus) {
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${profBonus}</span><span class="ace-qol-mod-label">PROF</span></span>`);
    }

    // Check for magic bonus on the item
    // Coerce to number — dnd5e stores magicalBonus as a string in some
    // item schemas (Dawnbringer, etc.). Without coercion, downstream
    // math switches to string concatenation: 5 + 3 + "2" + 0 = "820".
    const magicBonus = Number(item.system?.magicalBonus) || 0;
    if (magicBonus) {
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${magicBonus}</span><span class="ace-qol-mod-label ace-qol-mod-magic">MAGIC</span></span>`);
    }

    // Check for attack bonus from item
    const itemAtkBonus = item.system?.attack?.bonus ? parseInt(item.system.attack.bonus) || 0 : 0;
    if (itemAtkBonus) {
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${itemAtkBonus}</span><span class="ace-qol-mod-label">ITEM</span></span>`);
    }

    // Delta detection — sum of displayed parts didn't match the actual roll
    // total. Common cases: summoned creatures with Match Proficiency adding a
    // spell-attack overlay, dnd5e Summon activity's `bonuses.attackDamage`,
    // active effects modifying attack rolls, etc. Show the unaccounted-for
    // chunk as a single labeled line so the breakdown still adds up.
    // Number()-coerce every input — defends against the magicalBonus
    // string-concat trap (see comment above) and any other field that
    // arrives as a string from DDB/legacy data.
    const displayedSum = (Number(abilityMod) || 0)
                       + (Number(profBonus) || 0)
                       + (Number(magicBonus) || 0)
                       + (Number(itemAtkBonus) || 0);
    const expectedBonus = (Number(rollTotal) || d20) - d20;
    const missingBonus = expectedBonus - displayedSum;
    if (missingBonus !== 0 && Number.isFinite(missingBonus)) {
      const isSummon = !!actor?.flags?.dnd5e?.summon;
      const label = isSummon ? "SUMMON" : "BONUS";
      formulaParts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${missingBonus >= 0 ? "+" : ""}${missingBonus}</span><span class="ace-qol-mod-label">${label}</span></span>`);
    }

    const formulaStr = formulaParts.join(" ");

    // ── Roll mode indicator ──
    const rollModeLabel = r0.finalRollMode === "advantage" ? '<span class="ace-qol-roll-mode ace-qol-adv">ADV</span>'
                        : r0.finalRollMode === "disadvantage" ? '<span class="ace-qol-roll-mode ace-qol-disadv">DISADV</span>'
                        : "";

    // ── Hit result class for the big number ──
    const anyHit = results.some(r => r.hitResult === "hit" || r.hitResult === "critical");
    const anyCrit = results.some(r => r.hitResult === "critical");
    const resultClass = anyCrit ? "ace-qol-result-crit"
                      : anyHit ? "ace-qol-result-hit"
                      : "ace-qol-result-miss";

    // ── Target rows ──
    const targetRows = results.map(r => {
      const tags = CombatState.getSummaryTags(r);
      const tagHtml = tags.map(t =>
        `<span class="ace-qol-tag ace-qol-tag-${t.type}"><i class="fas ${t.icon}"></i> ${t.label}</span>`
      ).join("");

      const hitClass = r.hitResult === "critical" ? "ace-qol-crit"
                     : r.hitResult === "hit" ? "ace-qol-hit"
                     : r.hitResult === "fumble" ? "ace-qol-fumble"
                     : "ace-qol-miss";

      const hitLabel = r.hitResult === "critical" ? "CRIT!"
                     : r.hitResult === "hit" ? "HIT"
                     : r.hitResult === "fumble" ? "FUMBLE"
                     : "MISS";

      // ── Cover tag (shown next to AC when cover applies) ──
      const coverLabelShort = r.coverResult?.cover === 5 ? "¾ cover"
                            : r.coverResult?.cover === 2 ? "half cover"
                            : "cover";
      const coverTag = r.coverResult && r.coverResult.acBonus > 0
        ? `<span class="ace-qol-tag ace-qol-tag-cover" title="${r.coverResult.label} — ${r.coverResult.blockedPct}% line of sight blocked"><i class="fas fa-shield-alt"></i> +${r.coverResult.acBonus} AC for ${coverLabelShort}</span>`
        : r.coverResult?.isFullCover
        ? `<span class="ace-qol-tag ace-qol-tag-cover ace-qol-tag-cover-full" title="Full cover — line of sight completely blocked. Cannot be targeted."><i class="fas fa-shield-alt"></i> FULL COVER (untargetable)</span>`
        : "";
      const acDisplay = r.effectiveAC && r.effectiveAC !== r.ac
        ? `AC ${r.effectiveAC} <span class="ace-qol-atk-ac-bonus" title="Base AC ${r.ac} + Cover ${r.effectiveAC - r.ac}">+${r.effectiveAC - r.ac}</span>`
        : `AC ${r.ac}`;

      return `
        <div class="ace-qol-atk-row">
          <div class="ace-qol-atk-target">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-atk-img" />
            <span class="ace-qol-atk-name">${r.name}</span>
            <span class="ace-qol-atk-ac">${acDisplay}</span>
            <span class="ace-qol-atk-result ${hitClass}">${hitLabel}</span>
          </div>
          ${coverTag || tagHtml ? `<div class="ace-qol-atk-tags">${coverTag}${tagHtml}</div>` : ""}
        </div>
      `;
    }).join("");

    // Collapsible item details (embeds the dnd5e description + property tags)
    const itemDetailsHtml = await this._buildItemDetails(item);

    const cardHtml = `
      <div class="ace-qol-attack-card">
        <div class="ace-qol-atk-header">
          <img src="${item.img || "icons/svg/sword.svg"}" class="ace-qol-atk-item-img" />
          <strong class="ace-qol-atk-item-name">${item.name}</strong>
          <button type="button" class="ace-qol-atk-info-toggle" data-action="toggleItemDetails" title="Show item details" aria-expanded="false">
            <i class="fas fa-chevron-down"></i>
          </button>
          ${rollModeLabel}
        </div>
        <div class="ace-qol-atk-item-details ace-qol-collapsed">${itemDetailsHtml}</div>
        <div class="ace-qol-atk-roll">
          <span class="ace-qol-atk-formula">
            ${formulaStr}
            <span class="ace-qol-atk-result-chip">
              <span class="ace-qol-atk-equals">=</span>
              <span class="ace-qol-atk-total ${resultClass}">${rollTotal}</span>
            </span>
          </span>
        </div>
        <div class="ace-qol-atk-results">
          ${targetRows}
        </div>
      </div>
    `;

    // Wait for DSN dice to finish tumbling before posting the result card —
    // otherwise the chat card spoils the d20 result while dice are still rolling.
    await awaitDsnRoll();

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "attackResult",
          itemId: item.id,
          actorId: actor.id,
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Merge Card Support — Pre-build formula HTML for combined display
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the attack formula HTML string for the merge card.
   * Same logic as the formula builder in _postAttackResults, but stored
   * in this._lastFormulaPartsHtml for the MergeCard to consume.
   */
  _buildFormulaPartsForMerge(item, actor, results, opts) {
    const r0 = results[0];
    const d20 = r0.d20Result;
    const parts = [];

    const actorAbilities = actor.system?.abilities ?? {};
    const profBonus = actor.system?.attributes?.prof ?? 0;
    const activity = opts.subject;

    let resolvedAbility2 = activity?.ability
      || item.system?.attack?.ability || item.system?.ability || "";
    if (resolvedAbility2 instanceof Set || resolvedAbility2 instanceof Array) resolvedAbility2 = [...resolvedAbility2][0] ?? "";
    if (typeof resolvedAbility2 !== "string") resolvedAbility2 = String(resolvedAbility2 || "");
    let abilityLabel = resolvedAbility2.toUpperCase() || "";
    let abilityMod = resolvedAbility2 ? (actorAbilities[resolvedAbility2]?.mod ?? 0) : 0;

    if (!abilityLabel) {
      const actionType = activity?.actionType ?? item.system?.actionType ?? "mwak";
      const isFinesse = item.system?.properties?.has?.("fin");
      const isThrown = item.system?.properties?.has?.("thr");
      const strMod = actorAbilities.str?.mod ?? 0;
      const dexMod = actorAbilities.dex?.mod ?? 0;
      if (isFinesse) {
        if (dexMod > strMod) { abilityLabel = "DEX"; abilityMod = dexMod; }
        else { abilityLabel = "STR"; abilityMod = strMod; }
      } else if (isThrown && actionType === "rwak") {
        abilityLabel = "STR"; abilityMod = strMod;
      } else if (["rwak", "rsak"].includes(actionType)) {
        abilityLabel = "DEX"; abilityMod = dexMod;
      } else {
        abilityLabel = "STR"; abilityMod = strMod;
      }
    }

    const bd20Path = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-${d20}_nobg.png`;
    parts.push(
      `<span class="ace-qol-mod-die">`
      + `<img class="ace-qol-atk-d20-img" src="${bd20Path}" alt="d20" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
      + `<i class="fas fa-dice-d20 ace-qol-atk-d20-fallback" style="display:none"></i>`
      + `<span class="ace-qol-atk-d20-result">${d20}</span>`
      + `</span>`
    );
    parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${abilityMod >= 0 ? "+" : ""}${abilityMod}</span><span class="ace-qol-mod-label">${abilityLabel}</span></span>`);
    if (profBonus) {
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${profBonus}</span><span class="ace-qol-mod-label">PROF</span></span>`);
    }
    // Coerce magicalBonus to a number — dnd5e stores it as a string on some
    // items (e.g. Dawnbringer). Without coercion the delta math below uses
    // string concatenation and produces nonsense like "-810 BONUS".
    const magicBonus = Number(item.system?.magicalBonus) || 0;
    if (magicBonus) {
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${magicBonus}</span><span class="ace-qol-mod-label ace-qol-mod-magic">MAGIC</span></span>`);
    }
    const itemAtkBonus = item.system?.attack?.bonus ? parseInt(item.system.attack.bonus) || 0 : 0;
    if (itemAtkBonus) {
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">+${itemAtkBonus}</span><span class="ace-qol-mod-label">ITEM</span></span>`);
    }

    // Delta detection — same logic as _postAttackResults; Number()-coerce
    // every input to defend against string-concat traps.
    const rollTotal = Number(r0?.attackTotal);
    const displayedSum = (Number(abilityMod) || 0)
                       + (Number(profBonus) || 0)
                       + (Number(magicBonus) || 0)
                       + (Number(itemAtkBonus) || 0);
    const expectedBonus = (Number.isFinite(rollTotal) ? rollTotal : d20) - d20;
    const missingBonus = expectedBonus - displayedSum;
    if (missingBonus !== 0 && Number.isFinite(missingBonus)) {
      const isSummon = !!actor?.flags?.dnd5e?.summon;
      const label = isSummon ? "SUMMON" : "BONUS";
      parts.push(`<span class="ace-qol-mod-chip"><span class="ace-qol-mod-num">${missingBonus >= 0 ? "+" : ""}${missingBonus}</span><span class="ace-qol-mod-label">${label}</span></span>`);
    }

    this._lastFormulaPartsHtml = parts.join(" ");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extract all damage types from an item (weapon or spell).
   * Reads from activities (dnd5e v4+) and legacy damage.parts.
   */
  _getItemDamageTypes(item) {
    const types = new Set();
    const sys = item.system ?? {};

    // Activities (dnd5e v4+)
    const activities = sys.activities;
    if (activities) {
      const actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      for (const activity of actList) {
        if (!activity?.damage?.parts) continue;
        for (const part of activity.damage.parts) {
          if (part.types) {
            for (const t of part.types) types.add(t);
          }
        }
      }
    }

    // Legacy damage.parts
    if (sys.damage?.parts) {
      for (const part of sys.damage.parts) {
        if (part[1]) types.add(part[1]);
      }
    }

    // Weapon profile riders (from ACE Artificer)
    try {
      const profile = item.getFlag("ace-artificer", "profile");
      if (profile?.riders) {
        for (const rider of profile.riders) {
          if (rider.damageType) types.add(rider.damageType);
        }
      }
    } catch (err) { console.debug("ace-qol | AttackPipeline artificer rider read:", err); }

    // Bonus damage from active effects (e.g., Frost Brand's 2d6[cold])
    const bonusDmg = item.system?.bonuses?.mwak?.damage ?? "";
    const bracketMatch = bonusDmg.match(/\[(\w+)\]/g);
    if (bracketMatch) {
      for (const m of bracketMatch) {
        types.add(m.replace(/[\[\]]/g, ""));
      }
    }

    return [...types];
  }

  /**
   * Get the last attack results (for Phase 4 damage pipeline to consume).
   */
  getLastAttackResults() {
    return {
      results: this._lastAttackResults ?? [],
      item: this._lastAttackItem ?? null,
      actor: this._lastAttackActor ?? null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Range Check
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if the target is within the weapon's range.
   * For weapons with both melee and ranged capability (e.g., thrown daggers),
   * auto-detect which mode based on distance:
   *   - Within reach → melee
   *   - Beyond reach but within range → ranged
   *   - Beyond all ranges → blocked
   *
   * @returns {{ blocked: boolean, distanceFt: number, rangeDesc: string, isRanged: boolean }}
   */

  /**
   * Detect whether an attack is melee. Checks the activity's actionType first
   * (mwak/msak), then range.units (touch/melee), then activity range value (≤ 5).
   * Throw weapons are NOT considered melee here — at long range they're rwak.
   * @param {Item} item
   * @param {Activity|object} subject - dnd5e activity (5.x) or null (legacy)
   * @returns {boolean}
   */
  static _isMeleeAttack(item, subject) {
    try {
      // Prefer the activity's resolved actionType (it knows about ranged/melee mode)
      const actionType = subject?.actionType ?? item?.system?.actionType ?? "";
      if (actionType === "mwak" || actionType === "msak") return true;

      // Activity-level range (dnd5e 5.x)
      const actRange = subject?.range ?? subject?.system?.range ?? null;
      if (actRange?.units === "touch" || actRange?.units === "self") return true;
      if (actRange?.units === "ft" && (actRange?.value ?? 0) <= 5 && (actRange?.value ?? 0) > 0) return true;

      // Item-level range fallback (legacy)
      const itemRange = item?.system?.range ?? {};
      if (itemRange.units === "touch") return true;
      if (itemRange.units === "ft" && (itemRange.value ?? 0) <= 5 && (itemRange.value ?? 0) > 0) return true;

      return false;
    } catch (err) {
      console.warn(`ace-qol | _isMeleeAttack failed:`, err);
      return false;
    }
  }

  /**
   * Detect whether the attacker has a multi-target melee feature that legitimately
   * lets them swing at more than one creature on a single attack action.
   * Recognizes: Cleave (weapon mastery + feat), Great Weapon Master, Whirlwind
   * Attack, and any UUID/identifier added to the world setting
   * `multiTargetMeleeFeatureIds`.
   *
   * v0.4.22 refactor — three-layer detection (was pure name-matching):
   *
   *   Layer 1: dnd5e weapon mastery property "cleave" on the swung weapon.
   *     If the weapon itself has the cleave mastery, the wielder gets the
   *     multi-target swing regardless of feats. (`item.system.properties`
   *     is a Set in dnd5e 5.x.)
   *
   *   Layer 2: feature identifier match on `system.identifier`.
   *     Stable across translations (the identifier stays in English even
   *     when the displayed name is translated). Catches:
   *       great-weapon-master, cleaving-attack, whirlwind-attack,
   *       improved-whirlwind-attack, cleave (the weapon mastery feat in
   *       homebrew rebrands)
   *
   *   Layer 3: world-configurable allow-list via `multiTargetMeleeFeatureIds`
   *     setting (Array<string>). GMs can drop in UUIDs, identifiers, or
   *     names to extend without code changes. Useful for homebrew or
   *     content packs.
   *
   *   Layer 4 (last resort): English name-matching, kept for back-compat
   *     with older worlds that don't have identifiers populated. Logged at
   *     debug level so brittle matches surface during diagnostic runs.
   *
   * Note: "Multiattack" is NOT included in any layer — that means "make N
   * attack rolls sequentially, each on its own target", not "one attack
   * hits N targets". Different mechanic.
   *
   * @param {Actor} actor - The attacking actor
   * @param {Item}  [weapon] - Optional: the specific weapon being swung,
   *                           used for Layer 1 weapon-mastery detection
   * @returns {boolean}
   */
  static _actorHasMultiTargetMelee(actor, weapon = null) {
    if (!actor?.items) return false;

    // ── Layer 1: weapon mastery "cleave" on the active weapon ──
    try {
      const props = weapon?.system?.properties;
      const hasCleaveMastery = props?.has?.("cleave") === true
                            || (Array.isArray(props) && props.includes("cleave"));
      if (hasCleaveMastery) return true;
    } catch (_) { /* fall through */ }

    // ── Layer 3: world-configurable allow-list ──
    let allowList = [];
    try {
      const raw = game.settings.get(MODULE_ID, "multiTargetMeleeFeatureIds");
      if (Array.isArray(raw)) allowList = raw.map(s => String(s).toLowerCase());
    } catch (_) { /* setting may not be registered yet */ }

    // ── Layer 2 + 3 + 4: scan items ──
    const KNOWN_IDENTIFIERS = new Set([
      "great-weapon-master",
      "cleaving-attack",
      "cleave",
      "whirlwind-attack",
      "improved-whirlwind-attack",
    ]);

    for (const item of actor.items) {
      if (item.type !== "feat" && item.type !== "subclass" && item.type !== "class") continue;

      // Layer 2: stable identifier match
      const id = String(item.system?.identifier ?? "").toLowerCase();
      if (id && KNOWN_IDENTIFIERS.has(id)) return true;

      // Layer 3: world-configured allow-list (matches identifier, name, or UUID)
      if (allowList.length) {
        const uuid = String(item.uuid ?? "").toLowerCase();
        const name = String(item.name ?? "").toLowerCase();
        if (allowList.includes(id) || allowList.includes(name) || allowList.includes(uuid)) return true;
      }

      // Layer 4: legacy English name-matching (back-compat)
      const name = (item.name ?? "").toLowerCase();
      if (name.includes("cleave") || name.includes("cleaving")) {
        try {
          if (game.settings.get(MODULE_ID, "debugMode")) {
            console.log(`${MODULE_ID} | multi-target detection: matched "${item.name}" via legacy name-matching (no identifier set). Recommend setting system.identifier or adding to multiTargetMeleeFeatureIds.`);
          }
        } catch (_) {}
        return true;
      }
      if (name.includes("great weapon master")) return true;
      if (name.includes("whirlwind")) return true;
    }
    return false;
  }

  _checkRange(attackerActor, targetToken, item) {
    const atkToken = attackerActor.getActiveTokens?.()?.[0]
                  ?? canvas.tokens.controlled?.[0];
    if (!atkToken || !targetToken) return { blocked: false, distanceFt: 0, rangeDesc: "", isRanged: false };

    // Measure distance — edge-to-edge for correct Large/Huge/Gargantuan handling
    let distanceFt = CombatState._getDistance(atkToken, targetToken);
    distanceFt = Math.round(distanceFt);

    const sys = item.system ?? {};
    const actionType = sys.actionType ?? "";
    const range = sys.range ?? {};
    const normalRange = range.value ?? 5;
    const longRange = range.long ?? 0;

    // Determine weapon reach for melee
    const props = sys.properties ? new Set(sys.properties) : new Set();
    const meleeReach = props.has("rch") ? 10 : 5;

    // Determine weapon type
    const weaponType = sys.type?.value ?? "";
    const isMeleeType = actionType === "mwak" || weaponType.includes("simpleM") || weaponType.includes("martialM");
    const isRangedType = actionType === "rwak" || weaponType.includes("simpleR") || weaponType.includes("martialR");
    const isThrown = props.has("thr");

    // Dual melee/ranged (thrown weapons like daggers, javelins, handaxes)
    if (isThrown || (isMeleeType && longRange > 0)) {
      if (distanceFt <= meleeReach) {
        // Within melee reach — treat as melee
        return { blocked: false, distanceFt, rangeDesc: `melee reach ${meleeReach}ft`, isRanged: false };
      } else if (distanceFt <= (longRange || normalRange)) {
        // Beyond melee but within thrown/ranged — treat as ranged
        return { blocked: false, distanceFt, rangeDesc: `thrown ${normalRange}/${longRange}ft`, isRanged: true };
      } else {
        // Beyond all ranges
        return { blocked: true, distanceFt, rangeDesc: `reach ${meleeReach}ft / thrown ${normalRange}/${longRange}ft`, isRanged: true };
      }
    }

    // Pure melee weapon
    if (isMeleeType && !isRangedType) {
      if (distanceFt <= meleeReach) {
        return { blocked: false, distanceFt, rangeDesc: `melee reach ${meleeReach}ft`, isRanged: false };
      } else {
        return { blocked: true, distanceFt, rangeDesc: `melee reach ${meleeReach}ft`, isRanged: false };
      }
    }

    // Pure ranged weapon
    if (isRangedType) {
      const maxRange = longRange || normalRange;
      if (distanceFt <= maxRange) {
        return { blocked: false, distanceFt, rangeDesc: `range ${normalRange}/${longRange}ft`, isRanged: true };
      } else {
        return { blocked: true, distanceFt, rangeDesc: `range ${normalRange}/${longRange}ft`, isRanged: true };
      }
    }

    // Unknown weapon type — don't block
    return { blocked: false, distanceFt, rangeDesc: "", isRanged: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item Details (collapsible) — embeds the dnd5e item description + tags
  // ═══════════════════════════════════════════════════════════════════════════

  async _buildItemDetails(item) {
    const sys = item?.system ?? {};

    // Description: enrich so links / inline rolls / references resolve
    let desc = sys.description?.value ?? "";
    try {
      const TE = foundry.applications?.ux?.TextEditor?.implementation
              ?? globalThis.TextEditor;
      if (TE?.enrichHTML) {
        desc = await TE.enrichHTML(desc, {
          rollData: item.actor?.getRollData?.() ?? {},
          relativeTo: item,
          secrets: false,
        });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | enrichHTML failed for ${item.name}:`, err);
    }

    // Property tags — match what dnd5e shows on its item cards
    const tags = [];

    // Activation type (ACTION / BONUS / REACTION)
    const activationType = sys.activation?.type ?? sys.activities?.contents?.[0]?.activation?.type;
    if (activationType) tags.push(String(activationType).toUpperCase());

    // Range / reach
    const reach     = sys.range?.reach ?? (sys.range?.units === "ft" && !sys.range?.long ? sys.range?.value : null);
    const rangeVal  = sys.range?.value;
    const rangeLong = sys.range?.long;
    const rangeUnits = sys.range?.units ?? "ft";
    if (reach && !rangeLong)            tags.push(`REACH ${reach} ${rangeUnits.toUpperCase()}`);
    else if (rangeVal && rangeLong)     tags.push(`RANGE ${rangeVal}/${rangeLong} ${rangeUnits.toUpperCase()}`);
    else if (rangeVal && !reach)        tags.push(`RANGE ${rangeVal} ${rangeUnits.toUpperCase()}`);

    if (sys.attuned || sys.attunement === "attuned")     tags.push("ATTUNED");
    if (sys.equipped)                                    tags.push("EQUIPPED");
    if (sys.proficient || sys.prof?.hasProficiency)      tags.push("PROFICIENT");
    if (sys.magicalBonus || sys.properties?.has?.("mgc")) tags.push("MAGICAL");

    // Weapon mastery (Sap, Vex, Topple, etc.)
    const mastery = sys.mastery;
    if (mastery) {
      const masteryLabel = CONFIG?.DND5E?.weaponMasteries?.[mastery]?.label
        ?? CONFIG?.DND5E?.weaponMasteries?.[mastery]
        ?? mastery;
      tags.push(`MASTERY: ${String(masteryLabel).toUpperCase()}`);
    }

    // Weapon properties (Finesse, Light, Versatile, Two-Handed, Heavy, Reach, etc.)
    const propsCfg = CONFIG?.DND5E?.itemProperties ?? {};
    const propsSet = sys.properties;
    if (propsSet) {
      const propIter = (propsSet instanceof Set) ? [...propsSet] : Object.keys(propsSet);
      for (const p of propIter) {
        const label = propsCfg[p]?.label ?? propsCfg[p] ?? p;
        // Skip the magical bookkeeping property (already shown as MAGICAL above)
        if (p === "mgc") continue;
        tags.push(String(label).toUpperCase());
      }
    }

    const tagsHtml = tags.length
      ? `<div class="ace-qol-atk-itemtags">${tags.map(t => `<span class="ace-qol-atk-itemtag">${t}</span>`).join("")}</div>`
      : "";

    return `<div class="ace-qol-atk-itemdesc">${desc || "<em>No description.</em>"}</div>${tagsHtml}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Debug
  // ═══════════════════════════════════════════════════════════════════════════

  _debug(msg) {
    try {
      if (game.settings.get(MODULE_ID, "debugMode")) {
        console.log(`${MODULE_ID} | ATK | ${msg}`);
      }
    } catch { /* settings not ready */ }
  }
}
