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

    console.log(`${MODULE_ID} | Attack pipeline hooks registered (pre-roll + post-roll)`);
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
    if (!game.user.isGM) return;
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
    if (!targets.size) return;

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

    const attackTotal = roll.total;
    const d20Result = roll.dice?.[0]?.total ?? roll.result;
    const isCritRoll = d20Result === 20;
    const isFumbleRoll = d20Result === 1;

    // Determine attack type
    const actionType = item.system?.actionType ?? "mwak";
    const isMelee = ["mwak", "msak"].includes(actionType);
    const isSpell = item.type === "spell" || ["msak", "rsak"].includes(actionType);

    // ── Use pre-roll combat states if available, otherwise assess now ──
    const combatStates = this._lastCombatStates?.length
      ? this._lastCombatStates
      : CombatState.assessAll(actor, item);

    // ── Build results from combat state ──
    const results = [];
    for (const cs of combatStates) {
      // ── Determine hit/miss ──
      let hitResult;
      if (isFumbleRoll) {
        hitResult = "fumble";
      } else if (isCritRoll || cs.autoCrit) {
        hitResult = "critical";
      } else if (attackTotal >= cs.target.ac) {
        hitResult = "hit";
      } else {
        hitResult = "miss";
      }

      results.push({
        ...cs,           // full combat state (attacker + target + modifiers)
        name: cs.target.name,
        img: cs.target.img,
        ac: cs.target.ac,
        hitResult,
        attackTotal,
        d20Result,
        isCritRoll,
        isFumbleRoll,
      });
    }

    // Clear pre-roll cache
    this._lastCombatStates = null;
    this._lastCombatState = null;

    // ── Log results ──
    const hits = results.filter(r => r.hitResult === "hit" || r.hitResult === "critical");
    const misses = results.filter(r => r.hitResult === "miss" || r.hitResult === "fumble");

    this._debug(`Attack: ${item.name} (${attackTotal}) → ${hits.length} hits, ${misses.length} misses`);

    // ── Post attack results to chat ──
    await this._postAttackResults(item, actor, results, { isMelee, isSpell, roll });

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
    const rollFormula = rollObj?.formula ?? "";
    const rollTerms = rollObj?.terms ?? [];

    // Try to extract meaningful labels from roll data
    const atkAbility = item.system?.attack?.ability || item.system?.ability || "";
    const actorAbilities = actor.system?.abilities ?? {};
    const profBonus = actor.system?.attributes?.prof ?? 0;

    // Find the ability used — check all abilities for a mod that matches
    let abilityLabel = atkAbility?.toUpperCase() || "";
    let abilityMod = atkAbility ? (actorAbilities[atkAbility]?.mod ?? 0) : 0;

    // If we couldn't find the ability from the item, try to figure it out
    // by matching the roll total breakdown
    if (!abilityLabel) {
      // For melee: usually STR, for finesse/ranged: usually DEX
      const actionType = item.system?.actionType ?? "mwak";
      if (["rwak", "rsak"].includes(actionType)) {
        abilityLabel = "DEX";
        abilityMod = actorAbilities.dex?.mod ?? 0;
      } else {
        // Melee — check if STR or DEX is higher (finesse)
        const strMod = actorAbilities.str?.mod ?? 0;
        const dexMod = actorAbilities.dex?.mod ?? 0;
        const isFinesse = item.system?.properties?.has?.("fin");
        if (isFinesse && dexMod > strMod) {
          abilityLabel = "DEX";
          abilityMod = dexMod;
        } else {
          abilityLabel = "STR";
          abilityMod = strMod;
        }
      }
    }

    // Build the display formula
    formulaParts.push(`<span class="ace-qol-mod-die"><i class="fas fa-dice-d20"></i> ${d20}</span>`);
    if (abilityMod !== 0) {
      formulaParts.push(`<span class="ace-qol-mod-num">${abilityMod >= 0 ? "+" : ""}${abilityMod}</span><span class="ace-qol-mod-label">${abilityLabel}</span>`);
    }
    if (profBonus) {
      formulaParts.push(`<span class="ace-qol-mod-num">+${profBonus}</span><span class="ace-qol-mod-label">PROF</span>`);
    }

    // Check for magic bonus on the item
    const magicBonus = item.system?.magicalBonus ?? 0;
    if (magicBonus) {
      formulaParts.push(`<span class="ace-qol-mod-num">+${magicBonus}</span><span class="ace-qol-mod-label">MAGIC</span>`);
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

      return `
        <div class="ace-qol-atk-row">
          <div class="ace-qol-atk-target">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-atk-img" />
            <span class="ace-qol-atk-name">${r.name}</span>
            <span class="ace-qol-atk-ac">AC ${r.ac}</span>
            <span class="ace-qol-atk-result ${hitClass}">${hitLabel}</span>
          </div>
          ${tagHtml ? `<div class="ace-qol-atk-tags">${tagHtml}</div>` : ""}
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
      whisper: [game.user.id],
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
