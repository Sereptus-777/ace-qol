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

export class AttackPipeline {

  constructor() {
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
    Hooks.on("dnd5e.rollAttackV2", (rolls, data) => this._onAttackRoll(rolls, data));

    // Fallback for older dnd5e versions
    Hooks.on("dnd5e.rollAttack", (rolls, data) => {
      if (!Hooks.events["dnd5e.rollAttackV2"]?.length) {
        this._onAttackRoll(rolls, data);
      }
    });

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
    // Only target D&D 5e roll configuration dialogs
    const isRollDialog = app?.constructor?.name?.includes("RollConfigurationDialog")
      || app?.options?.classes?.includes?.("roll-configuration");
    if (!isRollDialog) return;

    const el = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!el?.querySelectorAll) return;

    // Find the dice display images inside ul.dice
    const diceImgs = el.querySelectorAll("ul.dice img, .dice img");
    for (const img of diceImgs) {
      // Only replace d20 icons (alt text or src containing "d20")
      const isD20 = img.alt?.toLowerCase()?.includes("d20")
        || img.src?.toLowerCase()?.includes("d20");
      if (!isD20) continue;

      // Use a generic BD20 image (the "neutral" face, BD20-20 is the iconic one)
      img.src = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-20_nobg.png`;
      img.style.filter = "drop-shadow(0 2px 4px rgba(0,0,0,0.5))";
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
    const atkStatuses = actor.statuses ?? new Set();
    if (atkStatuses.has("paralyzed") || atkStatuses.has("stunned")
     || atkStatuses.has("unconscious") || atkStatuses.has("incapacitated")
     || atkStatuses.has("petrified")) {
      const condition = ["paralyzed", "stunned", "unconscious", "incapacitated", "petrified"]
        .find(c => atkStatuses.has(c))?.toUpperCase();
      ui.notifications.warn(`ACE QOL: ${actor.token?.name ?? actor.name} is ${condition} and cannot attack!`);
      return false; // Block the roll
    }

    const targets = game.user.targets;
    if (!targets.size) {
      // ── Friendly "no target" reminder — don't block, just nudge ──
      this._showNoTargetReminder(actor, item);
      return;
    }

    // ── Range check: block attacks on out-of-range targets ──
    const firstTarget = targets.first();
    const rangeCheck = this._checkRange(actor, firstTarget, item);
    if (rangeCheck.blocked) {
      ui.notifications.warn(`ACE QOL: Target is out of range! (${rangeCheck.distanceFt}ft away, ${rangeCheck.rangeDesc})`);
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

    if (combatState.finalRollMode === "advantage") {
      // Pre-select the ADVANTAGE button in the dialog
      dialog.options.defaultButton = "advantage";
      // Also set on roll config for fast-forward mode
      if (rollConfig?.options) rollConfig.options.advantageMode = 1;
      if (rollConfig) rollConfig.advantageMode = 1;

      this._debug(`PRE-ROLL: Setting ADVANTAGE for ${item.name} → ${firstTarget.actor?.name}`);
      for (const src of combatState.advantageSources) {
        this._debug(`  → ${src.reason}`);
      }
    } else if (combatState.finalRollMode === "disadvantage") {
      dialog.options.defaultButton = "disadvantage";
      if (rollConfig?.options) rollConfig.options.advantageMode = -1;
      if (rollConfig) rollConfig.advantageMode = -1;

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
    const resolvedAbility = activity?.ability
      || item.system?.attack?.ability || item.system?.ability || "";
    let abilityLabel = resolvedAbility?.toUpperCase() || "";
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
    formulaParts.push(`<span class="ace-qol-mod-num">${abilityMod >= 0 ? "+" : ""}${abilityMod}</span><span class="ace-qol-mod-label">${abilityLabel}</span>`);
    if (profBonus) {
      formulaParts.push(`<span class="ace-qol-mod-num">+${profBonus}</span><span class="ace-qol-mod-label">PROF</span>`);
    }

    // Check for magic bonus on the item
    const magicBonus = item.system?.magicalBonus ?? 0;
    if (magicBonus) {
      formulaParts.push(`<span class="ace-qol-mod-num">+${magicBonus}</span><span class="ace-qol-mod-label ace-qol-mod-magic">MAGIC</span>`);
    }

    // Check for attack bonus from item
    const itemAtkBonus = item.system?.attack?.bonus ? parseInt(item.system.attack.bonus) || 0 : 0;
    if (itemAtkBonus) {
      formulaParts.push(`<span class="ace-qol-mod-num">+${itemAtkBonus}</span><span class="ace-qol-mod-label">ITEM</span>`);
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
      const coverTag = r.coverResult && r.coverResult.acBonus > 0
        ? `<span class="ace-qol-tag ace-qol-tag-cover" title="${r.coverResult.label} (${r.coverResult.blockedPct}% blocked)"><i class="fas fa-shield-alt"></i> ${r.coverResult.label}</span>`
        : r.coverResult?.isFullCover
        ? `<span class="ace-qol-tag ace-qol-tag-cover" style="color:#ff4444;"><i class="fas fa-shield-alt"></i> Full Cover</span>`
        : "";
      const acDisplay = r.effectiveAC && r.effectiveAC !== r.ac
        ? `AC ${r.effectiveAC} <span style="opacity:0.5;font-size:0.85em;">(${r.ac}+${r.effectiveAC - r.ac})</span>`
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

    const cardHtml = `
      <div class="ace-qol-attack-card">
        <div class="ace-qol-atk-header">
          <img src="${item.img || "icons/svg/sword.svg"}" class="ace-qol-atk-item-img" />
          <strong class="ace-qol-atk-item-name">${item.name}</strong>
          ${rollModeLabel}
        </div>
        <div class="ace-qol-atk-roll">
          <span class="ace-qol-atk-formula">${formulaStr}</span>
          <span class="ace-qol-atk-total ${resultClass}">${rollTotal}</span>
        </div>
        <div class="ace-qol-atk-results">
          ${targetRows}
        </div>
      </div>
    `;

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

    const resolvedAbility = activity?.ability
      || item.system?.attack?.ability || item.system?.ability || "";
    let abilityLabel = resolvedAbility?.toUpperCase() || "";
    let abilityMod = resolvedAbility ? (actorAbilities[resolvedAbility]?.mod ?? 0) : 0;

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
    parts.push(`<span class="ace-qol-mod-num">${abilityMod >= 0 ? "+" : ""}${abilityMod}</span><span class="ace-qol-mod-label">${abilityLabel}</span>`);
    if (profBonus) {
      parts.push(`<span class="ace-qol-mod-num">+${profBonus}</span><span class="ace-qol-mod-label">PROF</span>`);
    }
    const magicBonus = item.system?.magicalBonus ?? 0;
    if (magicBonus) {
      parts.push(`<span class="ace-qol-mod-num">+${magicBonus}</span><span class="ace-qol-mod-label ace-qol-mod-magic">MAGIC</span>`);
    }
    const itemAtkBonus = item.system?.attack?.bonus ? parseInt(item.system.attack.bonus) || 0 : 0;
    if (itemAtkBonus) {
      parts.push(`<span class="ace-qol-mod-num">+${itemAtkBonus}</span><span class="ace-qol-mod-label">ITEM</span>`);
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
    } catch { /* no artificer */ }

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
  //  No-Target Reminder — friendly nudge with humor
  // ═══════════════════════════════════════════════════════════════════════════

  _showNoTargetReminder(actor, item) {
    const name = actor.token?.name ?? actor.name ?? "Adventurer";
    const weapon = item?.name ?? "weapon";

    // Grab a random PLAYER CHARACTER name (not the attacker) for jokes
    // Must be player-owned characters only — no NPCs
    const partyNames = (game.actors ?? [])
      .filter(a => a.type === "character" && a.hasPlayerOwner
        && a.name !== name
        && game.users.some(u => !u.isGM && a.testUserPermission(u, "OWNER")))
      .map(a => a.name);
    const randomAlly = partyNames.length
      ? partyNames[Math.floor(Math.random() * partyNames.length)]
      : "a nearby bookshelf";

    // Build quip pool — ally quips only included when we have a real PC name
    const quips = [
      `No target! <em>The air molecules shriek in terror as ${name}'s ${weapon} cleaves through nothing but atmosphere.</em>`,
      `No target! <em>${name} swings ${weapon} at the ghosts of their imagination. The ghosts are unimpressed.</em>`,
      `No target! <em>${name} whips ${weapon} through the air with devastating precision. The oxygen never stood a chance.</em>`,
      `No target! <em>A faint whistle echoes as ${name}'s ${weapon} carves a beautiful arc through absolutely nothing.</em>`,
      `No target! <em>${name} heroically attacks the empty void. Somewhere, a dust particle writes its last will.</em>`,
      `No target! <em>The wind cries out as ${name} hammers ${weapon} into the space where an enemy should be standing.</em>`,
      `No target! <em>${name} takes a mighty swing. The air parts obediently. Nearby insects scatter in panic.</em>`,
      `No target! <em>${name}'s ${weapon} slices through nothing with such conviction that even the shadows flinch.</em>`,
      `No target! <em>The invisible man would be dead right now, if he existed. Nice swing, ${name}.</em>`,
      `No target! <em>${name} lunges forward with ${weapon} drawn. The cobblestones remain stubbornly uninjured.</em>`,
      `No target! <em>Somewhere in the multiverse, a version of ${name} actually targeted something. Not this one.</em>`,
    ];

    // Party member reactions — only when we have actual PCs to reference
    if (partyNames.length) {
      quips.push(
        `No target! <em>${name} swings ${weapon} at thin air. ${randomAlly} takes a cautious step back.</em>`,
        `No target! <em>${name} attacks nothing. ${randomAlly} and the others exchange worried glances.</em>`,
        `No target! <em>${name} flails ${weapon} wildly. ${randomAlly} quietly questions their choice of adventuring companion.</em>`,
        `No target! <em>"You, uh... you alright there?" mumbles ${randomAlly}, watching ${name} attack the void.</em>`,
        `No target! <em>${name} cleaves the air. ${randomAlly} makes a mental note to sleep further from them tonight.</em>`,
        `No target! <em>${randomAlly} whispers to the group: "Should... should we be concerned about ${name}?"</em>`,
        `No target! <em>${randomAlly} clears their throat. "So... are we just not going to talk about what ${name} just did?"</em>`,
      );
    }

    const quip = quips[Math.floor(Math.random() * quips.length)];

    // Non-blocking notification — attack still goes through normally
    ui.notifications.warn(quip, { permanent: false, localize: false });
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
