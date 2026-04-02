// ─── ACE: QOL — Damage Calculation Engine ────────────────────────────────────
// Phase 4: Takes attack results from the combat state and calculates damage
// with full type separation, crit rules, slayer bonuses, and per-target
// resistance/immunity/vulnerability application.
//
// This replaces Midi-QOL's damage handling entirely.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";

export class DamageEngine {

  constructor() {
    this._registerHooks();
  }

  _registerHooks() {
    // Listen for our own attack completion
    Hooks.on(`${MODULE_ID}.attackComplete`, (data) => this._onAttackComplete(data));

    // ── PERSISTENT BUTTONS: Re-wire Apply/Undo on ANY damage card render ──
    // This catches both new cards AND old cards after page refresh
    Hooks.on("renderChatMessage", (message, html) => {
      const flags = message.flags?.[MODULE_ID];
      if (!flags?.type || !["damageResult", "damageButton", "postHitSave", "postHitSaveResult"].includes(flags.type)) return;

      const el = html[0] ?? html;
      const applyBtn = el.querySelector?.("[data-action='aceQolApplyDamage']");
      const undoBtn = el.querySelector?.("[data-action='aceQolUndoDamage']");

      if (applyBtn && !applyBtn.dataset.wired) {
        applyBtn.dataset.wired = "1";
        if (flags.applied) {
          applyBtn.disabled = true;
          applyBtn.textContent = "APPLIED ✓";
        } else {
          applyBtn.addEventListener("click", async () => {
            await this._applyDamage(message);
            applyBtn.disabled = true;
            applyBtn.textContent = "APPLIED ✓";
            await message.setFlag(MODULE_ID, "applied", true);
          });
        }
      }

      if (undoBtn && !undoBtn.dataset.wired) {
        undoBtn.dataset.wired = "1";
        if (flags.undone) {
          undoBtn.disabled = true;
          undoBtn.textContent = "UNDONE ✓";
        } else {
          undoBtn.addEventListener("click", async () => {
            await this._undoDamage(message);
            undoBtn.disabled = true;
            undoBtn.textContent = "UNDONE ✓";
            await message.setFlag(MODULE_ID, "undone", true);
          });
        }
      }

      // ── PC "Roll Damage" button ──
      const rollDmgBtn = el.querySelector?.("[data-action='aceQolRollDamage']");
      if (rollDmgBtn && !rollDmgBtn.dataset.wired) {
        rollDmgBtn.dataset.wired = "1";
        rollDmgBtn.addEventListener("click", async () => {
          rollDmgBtn.disabled = true;
          rollDmgBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
          try {
            await this._rollDamageFromButton(message);
            rollDmgBtn.innerHTML = '<i class="fas fa-check"></i> Rolled ✓';
          } catch (err) {
            console.error(`${MODULE_ID} | Roll damage failed:`, err);
            rollDmgBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error — check console';
            rollDmgBtn.disabled = false;
            ui.notifications.error("ACE QOL: Damage roll failed — check console for details.");
          }
        });
      }

      // ── Post-hit "Roll Saves" button (from description parser) ──
      const rollSaveBtn = el.querySelector?.("[data-action='aceQolRollPostHitSaves']");
      if (rollSaveBtn && !rollSaveBtn.dataset.wired) {
        rollSaveBtn.dataset.wired = "1";
        if (flags.rolled) {
          rollSaveBtn.disabled = true;
          rollSaveBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED ✓';
        } else {
          rollSaveBtn.addEventListener("click", async () => {
            rollSaveBtn.disabled = true;
            rollSaveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rolling...';
            try {
              await this._rollPostHitSaves(message);
              rollSaveBtn.innerHTML = '<i class="fas fa-check"></i> ROLLED ✓';
              await message.setFlag(MODULE_ID, "rolled", true);
            } catch (err) {
              console.error(`${MODULE_ID} | Post-hit save failed:`, err);
              rollSaveBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
              rollSaveBtn.disabled = false;
            }
          });
        }
      }
    });

    console.log(`${MODULE_ID} | Damage engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Attack Complete → Calculate + Show Damage Card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when the attack pipeline finishes resolving hits/misses.
   * For each hit target, calculates damage with type separation and crit rules.
   */
  async _onAttackComplete(data) {
    const { item, actor, results, hits } = data;
    if (!hits?.length) return; // No hits, no damage

    // Player characters get a ROLL DAMAGE button — they click to roll
    if (actor.type === "character" || actor.hasPlayerOwner) {
      await this._postDamageButton(item, actor, hits);
      return;
    }

    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";

    // ── Calculate damage for each hit target ──
    const damageResults = [];
    for (const hit of hits) {
      const isCrit = hit.hitResult === "critical";
      const targetState = hit; // hit already contains full combat state

      // Roll all damage components separately by type
      const components = await this._rollDamageComponents(item, actor, targetState, isCrit, critRule);

      // Apply resistance/immunity/vulnerability to each component
      const applied = this._applyDamageModifiers(components, targetState.damageModifiers);

      // Calculate totals
      const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
      const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);

      damageResults.push({
        target: targetState.target,
        targetToken: targetState.targetToken,
        targetActor: targetState.targetActor,
        isCrit,
        components: applied,
        totalRaw,
        totalFinal,
      });
    }

    // ── Post the batch damage card ──
    await this._postDamageCard(item, actor, damageResults, critRule);

    // ── Store for Apply button ──
    this._lastDamageResults = damageResults;
    this._lastDamageItem = item;

    // Emit hook for other modules
    Hooks.callAll(`${MODULE_ID}.damageCalculated`, { item, actor, damageResults });

    // ── Check for post-hit saves from description (Spiked Chain, Giant Slayer, etc.) ──
    await this._checkPostHitEffects(item, actor, hits, damageResults);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll Damage Components — Each Type Separate
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll each damage source separately by type.
   * Returns array of { name, formula, roll, total, type, isCritBonus }
   */
  async _rollDamageComponents(item, actor, targetState, isCrit, critRule) {
    const components = [];
    const sys = item.system ?? {};
    // Use ITEM roll data (not just actor) — the item knows its ability modifier
    // e.g., a longsword sets @mod to STR, a finesse weapon might use DEX
    const rollData = item.getRollData?.() ?? actor.getRollData?.() ?? {};

    // ── Parse item description for conditional damage (save-gated) ──
    // Damage from effects like Spiked Chain's 4d10 necrotic (only on failed save)
    // should NOT be included in the initial hit damage.
    const parsed = DescriptionParser.parse(item);
    const conditionalDamageTypes = new Set();
    if (parsed.saves.length > 0) {
      for (const bd of parsed.bonusDamage) {
        if (bd.damageType) conditionalDamageTypes.add(bd.damageType);
      }
    }

    // ── Base weapon/spell damage from activities ──
    const activities = sys.activities;
    if (activities) {
      const actList = (typeof activities.forEach === "function")
        ? [...(activities.values?.() ?? activities)]
        : (typeof activities === "object" ? Object.values(activities) : []);

      for (const activity of actList) {
        if (!activity?.damage?.parts?.length) continue;

        // Build the full damage formula including ability modifier and magic bonus
        for (let i = 0; i < activity.damage.parts.length; i++) {
          const part = activity.damage.parts[i];

          // Skip conditional damage parts (gated behind a save from the description)
          const partTypes = part.types ? [...part.types] : [];
          if (partTypes.some(t => conditionalDamageTypes.has(t)) && i > 0) {
            continue; // Skip this part — it'll be rolled after the save
          }
          let formula = part.custom?.enabled
            ? part.custom.formula
            : `${part.number ?? 1}d${part.denomination ?? 8}`;

          // Add the part's own bonus if it has one
          if (part.bonus && String(part.bonus) !== "0") {
            const bonusStr = String(part.bonus);
            formula += (bonusStr.startsWith("+") || bonusStr.startsWith("-")) ? bonusStr : `+${bonusStr}`;
          }

          // For the FIRST damage part, add ability modifier + magic bonus
          // (subsequent parts are extra damage dice like bonus elemental)
          if (i === 0) {
            // Ability modifier — @mod in rollData (STR for longsword, DEX for finesse, etc.)
            const abilityMod = rollData.mod ?? 0;
            if (abilityMod !== 0) {
              formula += abilityMod >= 0 ? `+${abilityMod}` : `${abilityMod}`;
            }

            // Magical bonus on the item (e.g., +2 weapon)
            // Guard against double-stacking: if the damage part's own bonus already
            // equals the magical bonus, DDB Importer likely put it in both places.
            const magicBonus = sys.magicalBonus ?? 0;
            const partBonusNum = parseInt(part.bonus) || 0;
            if (magicBonus > 0 && partBonusNum !== magicBonus) {
              formula += `+${magicBonus}`;
            }
          }

          const types = part.types ? [...part.types] : ["untyped"];
          const type = types[0] ?? "untyped";

          const result = await this._rollWithCrit(formula, rollData, isCrit, critRule, `Base ${type}`);
          components.push({ name: item.name, ...result, type });
        }
        break; // Only use first attack activity
      }
    }

    // ── Legacy damage.parts fallback ──
    if (!components.length && sys.damage?.parts?.length) {
      for (const [formula, type] of sys.damage.parts) {
        const result = await this._rollWithCrit(formula, rollData, isCrit, critRule, `Base ${type}`);
        components.push({ name: item.name, ...result, type: type || "untyped" });
      }
    }

    // ── Ability modifier (if not already in formula) ──
    // Most dnd5e formulas already include @mod, so this is handled by rollData

    // ── Attacker bonus damage (Hex, Hunter's Mark, Rage, Sneak Attack) ──
    const bonuses = targetState.attacker?.bonuses ?? targetState.attackerBonuses ?? [];
    for (const bonus of bonuses) {
      if (!bonus.formula) continue; // Skip entries without a formula
      const result = await this._rollWithCrit(bonus.formula, rollData, isCrit, critRule, bonus.name);
      components.push({ name: bonus.name ?? "Bonus", ...result, type: bonus.type ?? components[0]?.type ?? "untyped" });
    }

    // ── Slayer bonus ──
    if (targetState.slayerMatch && targetState.slayerDamage) {
      const result = await this._rollWithCrit(targetState.slayerDamage, rollData, isCrit, critRule, "Slayer");
      components.push({
        name: `Slayer (${targetState.slayerType})`,
        ...result,
        type: components[0]?.type ?? "untyped",
      });
    }

    // ── Creature-type conditional bonus damage ──
    // Parsed from item description: "extra 1d8 radiant damage to undead", etc.
    // If the description mentions a creature type trigger and the target matches,
    // auto-roll the bonus damage. Sources (in priority order):
    //   1. bonusDamage array (separate [[/damage]] tags in description)
    //   2. Creature trigger's embedded formula (parsed from the trigger sentence itself)
    if (parsed.creatureTrigger) {
      const triggerType = parsed.creatureTrigger.creatureType?.toLowerCase();
      const targetType = targetState.creatureType?.toLowerCase() ?? "";
      const targetSubtype = targetState.creatureSubtype?.toLowerCase() ?? "";

      if (triggerType && (targetType === triggerType
          || targetType.includes(triggerType)
          || targetSubtype.includes(triggerType))) {

        let rolled = false;

        // Source 1: bonusDamage array from separate damage tags
        if (parsed.bonusDamage.length > 0) {
          for (const bd of parsed.bonusDamage) {
            if (!bd.formula) continue;
            const dmgType = bd.damageType ?? components[0]?.type ?? "untyped";
            const result = await this._rollWithCrit(bd.formula, rollData, isCrit, critRule, `vs ${triggerType}`);
            components.push({
              name: `${item.name} (vs ${triggerType})`,
              ...result,
              type: dmgType,
            });
            rolled = true;
          }
        }

        // Source 2: formula embedded in the creature trigger sentence itself
        if (!rolled && parsed.creatureTrigger.bonusFormula) {
          const dmgType = parsed.creatureTrigger.bonusType ?? components[0]?.type ?? "untyped";
          const result = await this._rollWithCrit(parsed.creatureTrigger.bonusFormula, rollData, isCrit, critRule, `vs ${triggerType}`);
          components.push({
            name: `${item.name} (vs ${triggerType})`,
            ...result,
            type: dmgType,
          });
          rolled = true;
        }

        if (rolled) {
          console.log(`${MODULE_ID} | Creature bonus: ${item.name} deals extra damage to ${triggerType} (target: ${targetType})`);
        }
      }
    }

    return components;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Roll With Crit Rules
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll a damage formula, applying critical hit rules if applicable.
   *
   * @param {string} formula    — base damage formula (e.g., "2d6+3")
   * @param {object} rollData   — actor roll data for @references
   * @param {boolean} isCrit    — is this a critical hit?
   * @param {string} critRule   — "doubleDice" | "maxPlusRoll" | "maxAll"
   * @param {string} label      — display label
   * @returns {{ formula, normalTotal, critTotal, total, isCrit, breakdown }}
   */
  async _rollWithCrit(formula, rollData, isCrit, critRule, label = "") {
    // Resolve @references in formula
    let resolved = formula;
    if (typeof formula === "string") {
      resolved = formula.replace(/@([a-zA-Z0-9_.]+)/g, (match, path) => {
        const val = path.split(".").reduce((o, k) => o?.[k], rollData);
        return val !== undefined ? String(val) : "0";
      });
    }

    // Roll the base damage
    const baseRoll = new Roll(resolved);
    await baseRoll.evaluate();
    await DamageEngine._showDiceAnimation(baseRoll);
    const normalTotal = baseRoll.total;

    if (!isCrit) {
      return {
        formula: resolved,
        normalTotal,
        critTotal: 0,
        total: normalTotal,
        isCrit: false,
        breakdown: `${resolved} = ${normalTotal}`,
        roll: baseRoll,
      };
    }

    // ── CRITICAL HIT DAMAGE ──
    let critTotal = 0;
    let breakdown = "";

    // Extract dice terms from the formula for crit calculations
    const diceTerms = baseRoll.terms.filter(t => t.faces); // DiceTerm instances
    const flatTerms = baseRoll.terms.filter(t => t.number !== undefined && !t.faces); // NumericTerm

    switch (critRule) {
      case "doubleDice": {
        // RAW: Roll all dice twice. Flat modifiers added once.
        // 2d6+3 → 4d6+3
        const critRoll = new Roll(resolved);
        await critRoll.evaluate();
        await DamageEngine._showDiceAnimation(critRoll);
        critTotal = critRoll.total;
        // Total = base dice + crit dice + modifiers (once)
        const diceTotal = diceTerms.reduce((sum, t) => sum + t.total, 0);
        const critDiceTotal = critRoll.terms.filter(t => t.faces).reduce((sum, t) => sum + t.total, 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = diceTotal + critDiceTotal + flatTotal;
        breakdown = `${resolved} (${normalTotal}) + crit dice (${critDiceTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal, critTotal: critDiceTotal,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      case "maxPlusRoll": {
        // Max normal dice + roll crit dice. Flat modifiers once.
        // 2d6+3 → max(2d6)=12 + roll(2d6) + 3
        const maxDice = diceTerms.reduce((sum, t) => sum + (t.faces * (t.number ?? 1)), 0);
        const critRoll = new Roll(resolved);
        await critRoll.evaluate();
        await DamageEngine._showDiceAnimation(critRoll);
        const critDiceOnly = critRoll.terms.filter(t => t.faces).reduce((sum, t) => sum + t.total, 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = maxDice + critDiceOnly + flatTotal;
        breakdown = `max dice (${maxDice}) + crit roll (${critDiceOnly}) + mods (${flatTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal: maxDice, critTotal: critDiceOnly,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      case "maxAll": {
        // Max ALL dice (normal + crit). Flat modifiers once.
        // 2d6+3 → max(2d6)=12 + max(2d6)=12 + 3 = 27
        const maxDice = diceTerms.reduce((sum, t) => sum + (t.faces * (t.number ?? 1)), 0);
        const flatTotal = flatTerms.reduce((sum, t) => sum + (t.number ?? 0), 0);
        const finalTotal = maxDice + maxDice + flatTotal;
        breakdown = `max dice (${maxDice}) + max crit (${maxDice}) + mods (${flatTotal}) = ${finalTotal}`;
        return {
          formula: resolved, normalTotal: maxDice, critTotal: maxDice,
          total: finalTotal, isCrit: true, breakdown, roll: baseRoll,
        };
      }

      default:
        return {
          formula: resolved, normalTotal, critTotal: 0,
          total: normalTotal, isCrit: false, breakdown: `${resolved} = ${normalTotal}`,
          roll: baseRoll,
        };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply Resistance/Immunity/Vulnerability Per Type
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Take raw damage components and apply per-type modifiers.
   * Returns array with { name, type, raw, final, modifier, reason }
   */
  // ═══════════════════════════════════════════════════════════════════════════
  //  PC Damage Button — slim card with "ROLL DAMAGE" button
  // ═══════════════════════════════════════════════════════════════════════════

  async _postDamageButton(item, actor, hits) {
    const anyCrit = hits.some(h => h.hitResult === "critical");
    const targetNames = hits.map(h => h.name ?? h.target?.name ?? "target").join(", ");

    const cardHtml = `
      <div class="ace-qol-dmg-btn-card">
        <button class="ace-qol-btn ace-qol-btn-roll-dmg" data-action="aceQolRollDamage">
          <i class="fas fa-burst"></i>
          ROLL DAMAGE${anyCrit ? ' <span class="ace-qol-dmg-btn-crit">CRIT!</span>' : ""}
        </button>
        <span class="ace-qol-dmg-btn-targets">→ ${targetNames}</span>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "damageButton",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          hits: hits.map(h => ({
            tokenId: h.targetToken?.id,
            tokenDocId: h.targetToken?.document?.id ?? h.targetToken?.id,
            actorId: h.targetActor?.id,
            sceneId: canvas.scene?.id,
            hitResult: h.hitResult,
            damageModifiers: h.damageModifiers,
            slayerMatch: h.slayerMatch,
            slayerDamage: h.slayerDamage,
            slayerType: h.slayerType,
            attackerBonuses: h.attacker?.bonuses ?? [],
            currentHP: h.target?.currentHP,
            maxHP: h.target?.maxHP,
            name: h.target?.name ?? h.name,
            img: h.target?.img ?? h.img,
          })),
        }
      }
    });
  }

  async _rollDamageFromButton(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags?.hits?.length) return;

    const item = await fromUuid(flags.itemUuid) ?? game.items.get(flags.itemId);
    const actor = game.actors.get(flags.actorId);
    if (!item || !actor) return;

    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";
    // Use item roll data for correct @mod resolution (STR for longsword, DEX for finesse, etc.)
    const rollData = item.getRollData?.() ?? actor.getRollData?.() ?? {};

    const damageResults = [];
    for (const hit of flags.hits) {
      const isCrit = hit.hitResult === "critical";

      // Roll damage components
      const components = await this._rollDamageComponents(item, actor, hit, isCrit, critRule);
      const applied = this._applyDamageModifiers(components, hit.damageModifiers ?? {});

      const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
      const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);

      // Resolve target token for display
      const scene = game.scenes.get(hit.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(hit.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(hit.actorId);

      damageResults.push({
        target: { name: hit.name, img: hit.img, currentHP: targetActor?.system?.attributes?.hp?.value ?? hit.currentHP, maxHP: hit.maxHP },
        targetToken: { id: hit.tokenId, document: { id: hit.tokenDocId } },
        targetActor: targetActor ?? { id: hit.actorId },
        isCrit,
        components: applied,
        totalRaw,
        totalFinal,
      });
    }

    await this._postDamageCard(item, actor, damageResults, critRule);

    // ── Check for post-hit saves from description (same as NPC auto-damage) ──
    await this._checkPostHitEffects(item, actor, flags.hits, damageResults);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post-Hit Effects — Description Parser Integration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * After damage is dealt, check the item description for additional effects:
   *   - Saving throws (DC 14 DEX save or be grappled)
   *   - Effect tables (roll d6: 1-2 Decay, 3-4 Grapple, 5-6 Topple)
   *   - Conditions to apply
   *   - Creature-type-gated bonus damage (Giant Slayer)
   */
  async _checkPostHitEffects(item, actor, hits, damageResults) {
    if (!item) return;

    const parsed = DescriptionParser.parse(item);
    if (!parsed.saves.length && !parsed.effectTable) return;

    // Only process targets that were actually HIT
    const hitTargets = hits.filter(h => h.hitResult === "hit" || h.hitResult === "critical");
    if (!hitTargets.length) return;

    // ── Post-hit save required ──
    if (parsed.saves.length) {
      const save = parsed.saves[0]; // Primary save
      const hasTable = !!parsed.effectTable;

      // Build target info for the save card
      const targetData = hitTargets.map(h => {
        const scene = game.scenes.get(h.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(h.targetToken?.document?.id ?? h.tokenDocId);
        const targetActor = tokenDoc?.actor ?? game.actors.get(h.targetActor?.id ?? h.actorId);
        const token = tokenDoc?.object;

        return {
          tokenDocId: tokenDoc?.id ?? h.tokenDocId ?? h.targetToken?.document?.id,
          actorId: targetActor?.id ?? h.actorId,
          sceneId: scene?.id,
          name: h.target?.name ?? h.name,
          img: h.target?.img ?? h.img,
          targetActor,
          token,
        };
      }).filter(t => t.targetActor);

      if (!targetData.length) return;

      // Post the save prompt card
      await this._postPostHitSaveCard(item, actor, targetData, {
        save,
        effectTable: parsed.effectTable,
        bonusDamage: parsed.bonusDamage,
        conditions: parsed.conditions,
      });
    }
  }

  /**
   * Post a save card that appears AFTER the damage card for post-hit saves.
   * Shows the save requirement, the effect table if any, and a ROLL SAVE button.
   */
  async _postPostHitSaveCard(item, actor, targetData, opts) {
    const { save, effectTable, bonusDamage, conditions } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

    // Target rows
    const targetRows = targetData.map(t => {
      const saveData = t.targetActor?.system?.abilities?.[save.ability]?.save;
      const saveMod = typeof saveData === "number" ? saveData : (saveData?.value ?? saveData?.mod ?? 0);
      return `
        <div class="ace-qol-save-target">
          <div class="ace-qol-save-target-header">
            <img src="${t.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${t.name}</span>
            <span class="ace-qol-save-target-mod">${save.ability.toUpperCase()} +${saveMod}</span>
          </div>
        </div>
      `;
    }).join("");

    // Keep the save card CLEAN — just show DC, ability, and targets.
    // Effects/table results only appear AFTER the save is rolled.
    // No pre-showing grappled, prone, or damage before the save happens.

    const cardHtml = `
      <div class="ace-qol-save-card ace-qol-posthit-save">
        <div class="ace-qol-save-header">
          <img src="${item.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item.name} — Save Required</strong>
            <span class="ace-qol-save-dc">DC ${save.dc} ${abilityLabel} Save</span>
          </div>
        </div>
        <div class="ace-qol-save-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-save-actions">
          <button class="ace-qol-btn ace-qol-btn-roll" data-action="aceQolRollPostHitSaves">
            <i class="fas fa-dice-d20"></i> ROLL SAVES
          </button>
        </div>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "postHitSave",
          itemId: item.id,
          itemUuid: item.uuid,
          actorId: actor.id,
          save: { dc: save.dc, ability: save.ability },
          effectTable: effectTable,
          bonusDamage: bonusDamage,
          conditions: conditions.filter(c => c.requiresSave),
          targets: targetData.map(t => ({
            tokenDocId: t.tokenDocId,
            actorId: t.actorId,
            sceneId: t.sceneId,
            name: t.name,
            img: t.img,
          })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Apply Resistance/Immunity/Vulnerability Per Type
  // ═══════════════════════════════════════════════════════════════════════════

  _applyDamageModifiers(components, damageModifiers) {
    return components.map(c => {
      const mod = damageModifiers[c.type];
      let finalDmg = c.total;
      let modifier = "normal";
      let reason = null;

      if (mod) {
        modifier = mod.modifier;
        reason = mod.reason;

        switch (mod.modifier) {
          case "immune":
            finalDmg = 0;
            break;
          case "resistant":
            finalDmg = Math.floor(c.total / 2);
            break;
          case "vulnerable":
            finalDmg = c.total * 2;
            break;
          default:
            finalDmg = c.total;
        }
      }

      return {
        ...c,
        raw: c.total,
        final: finalDmg,
        modifier,
        reason,
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Card — Batch Results with Apply/Undo
  // ═══════════════════════════════════════════════════════════════════════════

  async _postDamageCard(item, actor, damageResults, critRule) {
    if (!damageResults.length) return;

    const targetRows = damageResults.map(dr => {
      const componentRows = dr.components.map(c => {
        const modBadge = c.modifier === "immune" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-immune">IMMUNE</span>'
                       : c.modifier === "resistant" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-resist">½</span>'
                       : c.modifier === "vulnerable" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">×2</span>'
                       : "";

        const color = DamageEngine.DAMAGE_COLORS[c.type] ?? "#ccc";
        const strikethrough = c.modifier === "immune" ? "opacity: 0.85; text-decoration: line-through; text-decoration-color: #ff1744;" : "";

        // Extract die results and flat modifiers from the roll
        const dieResults = [];
        const flatMods = [];
        if (c.roll?.terms) {
          for (const term of c.roll.terms) {
            if (term.faces) {
              // Dice term — show die type + result
              const dieIcon = DamageEngine.DIE_ICONS[term.faces] ?? "fa-dice";
              for (const r of (term.results ?? [])) {
                dieResults.push(`<span class="ace-qol-die"><i class="fas ${dieIcon}"></i> ${r.result}</span>`);
              }
            } else if (term.number !== undefined && term.number !== 0) {
              flatMods.push(term.number > 0 ? `+${term.number}` : `${term.number}`);
            }
            // Skip operator terms (+, -)
          }
        }

        // Build the display: 🎲8 +2 = 10 radiant
        const dieDisplay = dieResults.join(" + ") || c.formula;
        const modDisplay = flatMods.length ? ` ${flatMods.join(" ")}` : "";
        const critDisplay = c.isCrit ? `<span class="ace-qol-dmg-crit-label">${c.normalTotal !== undefined ? `MAX ${c.normalTotal}` : "CRIT"}</span> + ` : "";

        return `
          <div class="ace-qol-dmg-component" style="${strikethrough}">
            ${critDisplay}${dieDisplay}${modDisplay}
            <span class="ace-qol-dmg-equals">=</span>
            <span class="ace-qol-dmg-value" style="color:${color}">${c.final} ${c.type}</span>
            ${modBadge}
          </div>
        `;
      }).join("");

      const isDead = (dr.target.currentHP - dr.totalFinal) <= 0;

      return `
        <div class="ace-qol-dmg-target">
          <div class="ace-qol-dmg-target-header">
            <img src="${dr.target.img || "icons/svg/mystery-man.svg"}" class="ace-qol-dmg-target-img" />
            <span class="ace-qol-dmg-target-name">${dr.target.name}</span>
            ${dr.isCrit ? '<span class="ace-qol-dmg-crit-badge">CRIT</span>' : ""}
            <span class="ace-qol-dmg-total">${dr.totalFinal} dmg</span>
            ${isDead ? '<span class="ace-qol-dmg-dead">☠</span>' : ""}
          </div>
          <div class="ace-qol-dmg-components">${componentRows}</div>
          <div class="ace-qol-dmg-hp">
            HP: ${dr.target.currentHP} → ${Math.max(0, dr.target.currentHP - dr.totalFinal)}/${dr.target.maxHP}
          </div>
        </div>
      `;
    }).join("");

    const critRuleLabel = { doubleDice: "Double Dice", maxPlusRoll: "Max + Roll", maxAll: "Max All" }[critRule] ?? critRule;
    const anyCrit = damageResults.some(dr => dr.isCrit);

    const cardHtml = `
      <div class="ace-qol-damage-card">
        <div class="ace-qol-dmg-header">
          <img src="${item.img || "icons/svg/sword.svg"}" class="ace-qol-dmg-item-img" />
          <strong class="ace-qol-dmg-item-name">${item.name} — Damage</strong>
          ${anyCrit ? `<span class="ace-qol-dmg-crit-rule">${critRuleLabel}</span>` : ""}
        </div>
        <div class="ace-qol-dmg-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-dmg-actions">
          <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
            <i class="fas fa-heart-crack"></i> Apply Damage
          </button>
          <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage">
            <i class="fas fa-undo"></i> Undo
          </button>
        </div>
      </div>
    `;

    const msg = await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "damageResult",
          damageResults: damageResults.map(dr => ({
            targetId: dr.targetActor.id,
            tokenId: dr.targetToken.id,
            tokenDocId: dr.targetToken.document?.id ?? dr.targetToken.id,
            sceneId: canvas.scene?.id,
            isLinked: dr.targetActor.prototypeToken?.actorLink ?? dr.targetToken.document?.actorLink ?? false,
            totalFinal: dr.totalFinal,
            currentHP: dr.target.currentHP,
            components: dr.components.map(c => ({ name: c.name, type: c.type, raw: c.raw, final: c.final, modifier: c.modifier })),
          })),
        }
      }
    });

    // Buttons are wired by the persistent renderChatMessage hook in _registerHooks
  }

  /**
   * Resolve the correct actor for a damage entry.
   * For unlinked tokens, we need the token's synthetic actor, not the base world actor.
   */
  _resolveTargetActor(entry) {
    // Try to find the token on the current scene
    const scene = game.scenes.get(entry.sceneId) ?? canvas.scene;
    if (scene) {
      const tokenDoc = scene.tokens?.get(entry.tokenDocId);
      if (tokenDoc?.actor) return tokenDoc.actor;
    }

    // Try canvas token
    const canvasToken = canvas.tokens?.get(entry.tokenDocId);
    if (canvasToken?.actor) return canvasToken.actor;

    // Fallback to world actor (works for linked tokens)
    return game.actors.get(entry.targetId);
  }

  /**
   * Apply damage to all targets from a damage card.
   */
  async _applyDamage(message) {
    const data = message.getFlag(MODULE_ID, "damageResults");
    if (!data?.length) return;

    for (const entry of data) {
      const actor = this._resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for token ${entry.tokenDocId}`);
        continue;
      }

      const currentHP = actor.system.attributes.hp.value;
      const newHP = Math.max(0, currentHP - entry.totalFinal);

      await actor.update({ "system.attributes.hp.value": newHP });
      console.log(`${MODULE_ID} | Applied ${entry.totalFinal} damage to ${actor.name}: ${currentHP} → ${newHP}`);
    }

    ui.notifications.info(`ACE QOL: Damage applied to ${data.length} target(s).`);
  }

  /**
   * Undo damage — restore HP to pre-damage values.
   */
  async _undoDamage(message) {
    const data = message.getFlag(MODULE_ID, "damageResults");
    if (!data?.length) return;

    for (const entry of data) {
      const actor = this._resolveTargetActor(entry);
      if (!actor) {
        console.warn(`${MODULE_ID} | Could not find actor for undo on token ${entry.tokenDocId}`);
        continue;
      }

      await actor.update({ "system.attributes.hp.value": entry.currentHP });
      console.log(`${MODULE_ID} | Undid damage on ${actor.name}: restored to ${entry.currentHP}`);
    }

    ui.notifications.info(`ACE QOL: Damage undone for ${data.length} target(s).`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Damage Type Colors
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show dice rolling animation on screen.
   * Uses Dice So Nice (game.dice3d) if available, otherwise no-op.
   */
  static async _showDiceAnimation(roll) {
    if (!roll) return;
    try {
      // Dice So Nice module
      if (game.dice3d) {
        await game.dice3d.showForRoll(roll, game.user, true);
      }
    } catch (err) {
      // Silently fail — dice animation is nice-to-have, not critical
      console.warn(`${MODULE_ID} | Dice animation failed:`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post-Hit Save Rolling (from Description Parser)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When GM clicks ROLL SAVES on a post-hit save card:
   * 1. Roll the save for each target
   * 2. If failed and there's an effect table, roll the table
   * 3. Apply conditions and/or bonus damage from the result
   * 4. Post results card
   */
  async _rollPostHitSaves(message) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags) return;

    const { save, effectTable, bonusDamage, conditions, targets, itemId, itemUuid, actorId } = flags;
    const item = await fromUuid(itemUuid) ?? game.items.get(itemId);
    const casterActor = game.actors.get(actorId);

    const results = [];

    for (const tgt of targets) {
      const scene = game.scenes.get(tgt.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(tgt.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(tgt.actorId);
      if (!targetActor) continue;

      // Check for auto-fail conditions
      const statuses = targetActor.statuses ?? new Set();
      const isAutoFail = (save.ability === "str" || save.ability === "dex")
        && (statuses.has("paralyzed") || statuses.has("stunned") || statuses.has("unconscious"));

      let saveTotal = 0;
      let passed = false;
      let saveRoll = null;

      if (isAutoFail) {
        saveTotal = 0;
        passed = false;
      } else {
        // Check advantage/disadvantage on save
        const hasAdvantage = targetActor.flags?.["midi-qol"]?.advantage?.save?.[save.ability]
          || (statuses.has("magic-resistance") && item?.type === "spell");
        const hasDisadvantage = (save.ability === "dex" && statuses.has("restrained"));

        let rollMode = "normal";
        if (hasAdvantage && !hasDisadvantage) rollMode = "advantage";
        else if (hasDisadvantage && !hasAdvantage) rollMode = "disadvantage";

        const saveRaw = targetActor.system?.abilities?.[save.ability]?.save;
        const saveMod = typeof saveRaw === "number" ? saveRaw : (saveRaw?.value ?? saveRaw?.mod ?? 0);
        const formula = rollMode === "advantage" ? `2d20kh + ${saveMod}`
                      : rollMode === "disadvantage" ? `2d20kl + ${saveMod}`
                      : `1d20 + ${saveMod}`;

        saveRoll = new Roll(formula);
        await saveRoll.evaluate();

        // Show dice animation
        try { if (game.dice3d) await game.dice3d.showForRoll(saveRoll, game.user, true); } catch {}

        saveTotal = saveRoll.total;
        passed = saveTotal >= save.dc;
      }

      // ── Determine outcome ──
      const result = {
        name: tgt.name,
        img: tgt.img,
        tokenDocId: tgt.tokenDocId,
        actorId: tgt.actorId,
        sceneId: tgt.sceneId,
        saveTotal,
        passed,
        isAutoFail,
        saveRoll,
        effects: [], // What happens to this target
      };

      if (!passed) {
        // ── Failed save — check for effect table ──
        if (effectTable) {
          const tableRoll = new Roll(effectTable.die === "d6" ? "1d6" : `1${effectTable.die}`);
          await tableRoll.evaluate();
          try { if (game.dice3d) await game.dice3d.showForRoll(tableRoll, game.user, true); } catch {}

          const tableResult = tableRoll.total;
          result.tableRoll = tableResult;
          result.tableDie = effectTable.die;

          console.log(`${MODULE_ID} | POST-HIT TABLE: ${tgt.name} failed save → rolled ${effectTable.die} = ${tableResult}`);
          console.log(`${MODULE_ID} | POST-HIT TABLE: entries:`, effectTable.entries.map(e => `[${e.range[0]}-${e.range[1]}] ${e.name}`).join(", "));

          // Find matching entry
          const matchedEntry = effectTable.entries.find(e =>
            tableResult >= e.range[0] && tableResult <= e.range[1]
          );

          console.log(`${MODULE_ID} | POST-HIT TABLE: matched entry:`, matchedEntry ? `"${matchedEntry.name}" with ${matchedEntry.effects?.length ?? 0} effects` : "NO MATCH");

          if (matchedEntry) {
            result.tableEntry = matchedEntry.name;
            result.tableDesc = matchedEntry.description;

            // Apply effects from this entry ONLY
            const autoApply = QolSettings.get("autoApplyConditions") ?? true;
            console.log(`${MODULE_ID} | POST-HIT TABLE: applying ${matchedEntry.effects?.length ?? 0} effects from "${matchedEntry.name}" (autoApply=${autoApply})`);
            for (const fx of matchedEntry.effects) {
              console.log(`${MODULE_ID} | POST-HIT TABLE: effect:`, fx);
              if (fx.type === "condition") {
                result.effects.push({ type: "condition", condition: fx.condition });
                if (autoApply) {
                  try {
                    await tokenDoc?.actor?.toggleStatusEffect?.(fx.condition, { active: true });
                    console.log(`${MODULE_ID} | POST-HIT TABLE: applied condition "${fx.condition}" to ${tgt.name}`);
                  } catch (err) {
                    console.warn(`${MODULE_ID} | Could not apply ${fx.condition}:`, err);
                  }
                }
              } else if (fx.type === "damage") {
                const dmgRoll = new Roll(fx.formula);
                await dmgRoll.evaluate();
                try { if (game.dice3d) await game.dice3d.showForRoll(dmgRoll, game.user, true); } catch {}

                // ── Check target resistance/immunity/vulnerability for this damage type ──
                const rawTotal = dmgRoll.total;
                let finalTotal = rawTotal;
                let dmgModifier = "normal";
                let dmgModReason = null;
                const tgtTraits = targetActor.system?.traits ?? {};
                const resistSet = new Set((tgtTraits.dr?.value ?? []).map(s => s.toLowerCase()));
                const immuneSet = new Set((tgtTraits.di?.value ?? []).map(s => s.toLowerCase()));
                const vulnSet = new Set((tgtTraits.dv?.value ?? []).map(s => s.toLowerCase()));
                const dmgType = (fx.damageType ?? "").toLowerCase();

                if (immuneSet.has(dmgType)) {
                  finalTotal = 0;
                  dmgModifier = "immune";
                  dmgModReason = `Immune to ${dmgType}`;
                } else if (resistSet.has(dmgType)) {
                  finalTotal = Math.floor(rawTotal / 2);
                  dmgModifier = "resistant";
                  dmgModReason = `Resists ${dmgType} (half damage)`;
                } else if (vulnSet.has(dmgType)) {
                  finalTotal = rawTotal * 2;
                  dmgModifier = "vulnerable";
                  dmgModReason = `VULNERABLE to ${dmgType} (double damage)`;
                }

                result.effects.push({
                  type: "damage",
                  formula: fx.formula,
                  damageType: fx.damageType,
                  raw: rawTotal,
                  total: finalTotal,
                  roll: dmgRoll,
                  modifier: dmgModifier,
                  reason: dmgModReason,
                });
                console.log(`${MODULE_ID} | POST-HIT TABLE: rolled ${fx.formula} ${fx.damageType} = ${rawTotal}${dmgModifier !== "normal" ? ` → ${finalTotal} (${dmgModifier})` : ""} on ${tgt.name}`);
              }
            }
          }
        } else if (!effectTable) {
          // No table AND no table at all — apply fail conditions directly
          // (Only for simple save-or-condition items like Giant Slayer)
          const autoApply = QolSettings.get("autoApplyConditions") ?? true;
          for (const cond of (conditions ?? [])) {
            result.effects.push({ type: "condition", condition: cond.condition });
            if (autoApply) {
              try {
                await tokenDoc?.actor?.toggleStatusEffect?.(cond.condition, { active: true });
              } catch (err) {
                console.warn(`${MODULE_ID} | Could not apply ${cond.condition}:`, err);
              }
            }
          }
        }
      }

      results.push(result);
    }

    // Post results card
    await this._postPostHitSaveResults(item, casterActor, results, save);
  }

  /**
   * Post the results card showing save outcomes, table rolls, and applied effects.
   */
  async _postPostHitSaveResults(item, actor, results, save) {
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

    // Check if any result has damage to apply
    const hasDamage = results.some(r => r.effects.some(fx => fx.type === "damage"));

    const rows = results.map(r => {
      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const resultLabel = r.isAutoFail ? "AUTO-FAIL" : r.passed ? "PASS" : "FAIL";
      const rollDisplay = r.isAutoFail ? "—" : r.saveTotal;

      // Effects summary
      let effectsHtml = "";
      if (r.tableEntry) {
        effectsHtml += `<div class="ace-qol-table-result">
          <i class="fas fa-dice-d6"></i> Rolled <strong>${r.tableRoll}</strong>: <strong>${r.tableEntry}</strong>
        </div>`;
      }

      for (const fx of r.effects) {
        if (fx.type === "condition") {
          effectsHtml += `<span class="ace-qol-tag ace-qol-tag-debuff"><i class="fas fa-circle-xmark"></i> ${fx.condition.toUpperCase()} applied</span> `;
        } else if (fx.type === "damage") {
          const color = DamageEngine.DAMAGE_COLORS[fx.damageType] ?? "#ccc";
          const modBadge = fx.modifier === "immune" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-immune">IMMUNE</span>'
                         : fx.modifier === "resistant" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-resist">½ RESIST</span>'
                         : fx.modifier === "vulnerable" ? '<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">×2 VULN</span>'
                         : "";
          let displayTotal;
          if (fx.modifier === "immune") {
            displayTotal = `<span style="text-decoration: line-through; text-decoration-color: #ff1744; color: #ccc;">${fx.raw}</span> <strong style="color: #ff1744;">0</strong>`;
          } else if (fx.modifier !== "normal") {
            displayTotal = `<span style="text-decoration: line-through; text-decoration-color: #ff9100; color: #ccc;">${fx.raw}</span> <strong>${fx.total}</strong>`;
          } else {
            displayTotal = `${fx.total}`;
          }
          effectsHtml += `<div class="ace-qol-dmg-component" style="padding-left: 0;">
            <span class="ace-qol-die"><i class="fas ${DamageEngine.DIE_ICONS[10] ?? "fa-dice"}"></i> ${fx.formula}</span>
            <span class="ace-qol-dmg-equals">=</span>
            <span class="ace-qol-dmg-value" style="color:${color}">${displayTotal} ${fx.damageType}</span>
            ${modBadge}
          </div>`;
        }
      }

      // HP line for targets that took damage
      const dmgEffects = r.effects.filter(fx => fx.type === "damage");
      const totalDamage = dmgEffects.reduce((sum, fx) => sum + fx.total, 0);
      let hpHtml = "";
      if (totalDamage > 0) {
        // Resolve current HP
        const scene = game.scenes.get(r.sceneId) ?? canvas.scene;
        const tokenDoc = scene?.tokens?.get(r.tokenDocId);
        const targetActor = tokenDoc?.actor ?? game.actors.get(r.actorId);
        const currentHP = targetActor?.system?.attributes?.hp?.value ?? 0;
        const maxHP = targetActor?.system?.attributes?.hp?.max ?? 0;
        const newHP = Math.max(0, currentHP - totalDamage);
        const isDead = newHP <= 0;
        r._currentHP = currentHP;
        r._maxHP = maxHP;
        r._totalDamage = totalDamage;
        hpHtml = `<div class="ace-qol-dmg-hp">HP: ${currentHP} → ${newHP}/${maxHP}${isDead ? " ☠" : ""}</div>`;
      }

      return `
        <div class="ace-qol-save-result-row">
          <div class="ace-qol-save-result-target">
            <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-save-target-img" />
            <span class="ace-qol-save-target-name">${r.name}</span>
            <span class="ace-qol-save-roll ${passClass}">${rollDisplay}</span>
            <span class="ace-qol-save-result-label ${passClass}">${resultLabel}</span>
          </div>
          ${effectsHtml ? `<div class="ace-qol-posthit-effects">${effectsHtml}</div>` : ""}
          ${hpHtml}
        </div>
      `;
    }).join("");

    // Build Apply/Undo buttons only if there's damage to apply
    const actionsHtml = hasDamage ? `
      <div class="ace-qol-dmg-actions">
        <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
          <i class="fas fa-heart-crack"></i> Apply Damage
        </button>
        <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage">
          <i class="fas fa-undo"></i> Undo
        </button>
      </div>` : "";

    const cardHtml = `
      <div class="ace-qol-save-results-card ace-qol-posthit-results">
        <div class="ace-qol-save-header">
          <img src="${item?.img || "icons/svg/spell.svg"}" class="ace-qol-save-item-img" />
          <div>
            <strong class="ace-qol-save-item-name">${item?.name ?? "Unknown"} — Save Results</strong>
            <span class="ace-qol-save-dc">DC ${save.dc} ${abilityLabel}</span>
          </div>
        </div>
        <div class="ace-qol-save-results">
          ${rows}
        </div>
        ${actionsHtml}
      </div>
    `;

    // Build damage results for Apply/Undo flags (only targets with damage)
    const damageResults = results
      .filter(r => r._totalDamage > 0)
      .map(r => ({
        targetId: r.actorId,
        tokenDocId: r.tokenDocId,
        sceneId: r.sceneId,
        totalFinal: r._totalDamage,
        currentHP: r._currentHP,
      }));

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [game.user.id],
      flags: {
        [MODULE_ID]: {
          type: "postHitSaveResult",
          ...(damageResults.length ? { damageResults } : {}),
        }
      },
    });
  }

  static DIE_ICONS = {
    4:  "fa-dice-d4",
    6:  "fa-dice-d6",
    8:  "fa-dice-d8",
    10: "fa-dice-d10",
    12: "fa-dice-d12",
    20: "fa-dice-d20",
  };

  static DAMAGE_COLORS = {
    slashing:     "#ff6b6b",
    piercing:     "#c0c0c0",
    bludgeoning:  "#6b9dff",
    fire:         "#ff6347",
    cold:         "#add8e6",
    lightning:    "#1e90ff",
    acid:         "#9dcc50",
    poison:       "#8a2be2",
    necrotic:     "#006400",
    radiant:      "#ffd700",
    force:        "#800080",
    psychic:      "#ff1493",
    thunder:      "#708090",
    healing:      "#00e676",
  };
}
