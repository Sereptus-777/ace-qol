// ─── ACE: QOL — Post-Hit Saves ───────────────────────────────────────────────
// Self-contained subsystem for saves triggered after damage is dealt.
// Handles: detection, save card rendering, save rolling, results card,
// condition application, and save-gated bonus damage with full defensive checks.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { DamageConstants } from "./damage-engine.mjs";

const PHYSICAL_TYPES = new Set(["bludgeoning", "piercing", "slashing"]);

export class PostHitSaves {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Check for Post-Hit Effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * After damage is dealt, check the item description for additional effects:
   *   - Saving throws (DC 14 DEX save or be grappled)
   *   - Effect tables (roll d6: 1-2 Decay, 3-4 Grapple, 5-6 Topple)
   *   - Conditions to apply
   *   - Creature-type-gated bonus damage (Giant Slayer)
   */
  static async checkPostHitEffects(item, actor, hits, damageResults) {
    if (!item) return;

    const parsed = DescriptionParser.parse(item);
    if (!parsed.saves.length && !parsed.effectTable) return;

    // Only process targets that were actually HIT
    const hitTargets = hits.filter(h => h.hitResult === "hit" || h.hitResult === "critical");
    if (!hitTargets.length) return;

    // ── Post-hit save required ──
    if (parsed.saves.length) {
      const save = parsed.saves[0];

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

      await PostHitSaves.postSaveCard(item, actor, targetData, {
        save,
        effectTable: parsed.effectTable,
        bonusDamage: parsed.bonusDamage,
        conditions: parsed.conditions,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post Save Card (the "Roll Saves" prompt)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a save card that appears AFTER the damage card for post-hit saves.
   */
  static async postSaveCard(item, actor, targetData, opts) {
    const { save, effectTable, bonusDamage, conditions } = opts;
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

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
  //  Roll Saves + Apply Effects
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * When GM clicks ROLL SAVES on a post-hit save card:
   * 1. Roll the save for each target
   * 2. If failed and there's an effect table, roll the table
   * 3. Apply conditions and/or bonus damage from the result
   * 4. Post results card
   */
  static async rollPostHitSaves(message) {
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

        try { if (game.dice3d) await game.dice3d.showForRoll(saveRoll, game.user, true); } catch (err) { console.warn("ace-qol | PostHitSaves dice3d save roll display failed:", err); }

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
        effects: [],
      };

      if (!passed) {
        // ── Failed save — check for effect table ──
        if (effectTable) {
          const tableRoll = new Roll(effectTable.die === "d6" ? "1d6" : `1${effectTable.die}`);
          await tableRoll.evaluate();
          try { if (game.dice3d) await game.dice3d.showForRoll(tableRoll, game.user, true); } catch (err) { console.warn("ace-qol | PostHitSaves dice3d table roll display failed:", err); }

          const tableResult = tableRoll.total;
          result.tableRoll = tableResult;
          result.tableDie = effectTable.die;

          console.log(`${MODULE_ID} | POST-HIT TABLE: ${tgt.name} failed save → rolled ${effectTable.die} = ${tableResult}`);
          console.log(`${MODULE_ID} | POST-HIT TABLE: entries:`, effectTable.entries.map(e => `[${e.range[0]}-${e.range[1]}] ${e.name}`).join(", "));

          const matchedEntry = effectTable.entries.find(e =>
            tableResult >= e.range[0] && tableResult <= e.range[1]
          );

          console.log(`${MODULE_ID} | POST-HIT TABLE: matched entry:`, matchedEntry ? `"${matchedEntry.name}" with ${matchedEntry.effects?.length ?? 0} effects` : "NO MATCH");

          if (matchedEntry) {
            result.tableEntry = matchedEntry.name;
            result.tableDesc = matchedEntry.description;

            const autoApply = QolSettings.get("autoApplyConditions") ?? true;
            console.log(`${MODULE_ID} | POST-HIT TABLE: applying ${matchedEntry.effects?.length ?? 0} effects from "${matchedEntry.name}" (autoApply=${autoApply})`);
            const condImmunities = new Set((targetActor.system?.traits?.ci?.value ?? []).map(s => s.toLowerCase()));
            for (const fx of matchedEntry.effects) {
              console.log(`${MODULE_ID} | POST-HIT TABLE: effect:`, fx);
              if (fx.type === "condition") {
                const condKey = (fx.condition ?? "").toLowerCase();
                if (condImmunities.has(condKey)) {
                  result.effects.push({ type: "condition", condition: fx.condition, blocked: true, reason: `Immune to ${fx.condition}` });
                  console.log(`${MODULE_ID} | POST-HIT TABLE: ${tgt.name} IMMUNE to "${fx.condition}" — skipped`);
                } else {
                  result.effects.push({ type: "condition", condition: fx.condition });
                  if (autoApply) {
                    try {
                      await tokenDoc?.actor?.toggleStatusEffect?.(fx.condition, { active: true });
                      console.log(`${MODULE_ID} | POST-HIT TABLE: applied condition "${fx.condition}" to ${tgt.name}`);
                    } catch (err) {
                      console.warn(`${MODULE_ID} | Could not apply ${fx.condition}:`, err);
                    }
                  }
                }
              } else if (fx.type === "damage") {
                await PostHitSaves._rollAndApplySaveDamage(fx, targetActor, item, result);
              }
            }
          }
        } else {
          // No table — apply fail conditions directly (e.g., Giant Slayer)
          const autoApply = QolSettings.get("autoApplyConditions") ?? true;
          const condImmunities = new Set((targetActor.system?.traits?.ci?.value ?? []).map(s => s.toLowerCase()));
          for (const cond of (conditions ?? [])) {
            const condKey = (cond.condition ?? "").toLowerCase();
            if (condImmunities.has(condKey)) {
              result.effects.push({ type: "condition", condition: cond.condition, blocked: true, reason: `Immune to ${cond.condition}` });
              console.log(`${MODULE_ID} | ${tgt.name} is IMMUNE to ${cond.condition} — skipped`);
            } else {
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
      }

      results.push(result);
    }

    // Post results card
    await PostHitSaves.postSaveResults(item, casterActor, results, save);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save-Gated Damage (with full defensive profile check)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Roll save-gated damage and check target's defensive profile.
   * Pushes the result into result.effects.
   */
  static async _rollAndApplySaveDamage(fx, targetActor, item, result) {
    const dmgRoll = new Roll(fx.formula);
    await dmgRoll.evaluate();
    try { if (game.dice3d) await game.dice3d.showForRoll(dmgRoll, game.user, true); } catch (err) { console.warn("ace-qol | PostHitSaves dice3d damage roll display failed:", err); }

    const rawTotal = dmgRoll.total;
    let finalTotal = rawTotal;
    let dmgModifier = "normal";
    let dmgModReason = null;
    const tgtTraits = targetActor.system?.traits ?? {};
    const resistSet = new Set((tgtTraits.dr?.value ?? []).map(s => s.toLowerCase()));
    const immuneSet = new Set((tgtTraits.di?.value ?? []).map(s => s.toLowerCase()));
    const vulnSet = new Set((tgtTraits.dv?.value ?? []).map(s => s.toLowerCase()));
    const drBypasses = new Set(tgtTraits.dr?.bypasses ?? []);
    const diBypasses = new Set(tgtTraits.di?.bypasses ?? []);
    const dmgType = (fx.damageType ?? "").toLowerCase();

    // Determine weapon properties for bypass checks
    const riderItemProps = new Set(item?.system?.properties ?? []);
    const riderIsMagical = riderItemProps.has("mgc") || !!item?.system?.magicAvailable;
    const riderIsSilvered = riderItemProps.has("sil");
    const riderIsAdamantine = riderItemProps.has("ada");

    if (immuneSet.has(dmgType)) {
      if (PHYSICAL_TYPES.has(dmgType) && diBypasses.size > 0) {
        const bypassed = (diBypasses.has("mgc") && riderIsMagical)
                      || (diBypasses.has("sil") && riderIsSilvered)
                      || (diBypasses.has("ada") && riderIsAdamantine);
        if (!bypassed) {
          finalTotal = 0;
          dmgModifier = "immune";
          dmgModReason = `Immune to ${dmgType}`;
        }
      } else {
        finalTotal = 0;
        dmgModifier = "immune";
        dmgModReason = `Immune to ${dmgType}`;
      }
    } else if (resistSet.has(dmgType)) {
      if (PHYSICAL_TYPES.has(dmgType) && drBypasses.size > 0) {
        const bypassed = (drBypasses.has("mgc") && riderIsMagical)
                      || (drBypasses.has("sil") && riderIsSilvered)
                      || (drBypasses.has("ada") && riderIsAdamantine);
        if (!bypassed) {
          finalTotal = Math.floor(rawTotal / 2);
          dmgModifier = "resistant";
          dmgModReason = `Resists ${dmgType} (half damage)`;
        }
      } else {
        finalTotal = Math.floor(rawTotal / 2);
        dmgModifier = "resistant";
        dmgModReason = `Resists ${dmgType} (half damage)`;
      }
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
    console.log(`${MODULE_ID} | POST-HIT TABLE: rolled ${fx.formula} ${fx.damageType} = ${rawTotal}${dmgModifier !== "normal" ? ` → ${finalTotal} (${dmgModifier})` : ""}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Save Results Card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post the results card showing save outcomes, table rolls, and applied effects.
   */
  static async postSaveResults(item, actor, results, save) {
    const abilityLabel = CONFIG.DND5E?.abilities?.[save.ability]?.label ?? save.ability.toUpperCase();

    const hasDamage = results.some(r => r.effects.some(fx => fx.type === "damage"));

    const rows = results.map(r => {
      const passClass = r.passed ? "ace-qol-save-pass" : "ace-qol-save-fail";
      const resultLabel = r.isAutoFail ? "AUTO-FAIL" : r.passed ? "PASS" : "FAIL";
      const rollDisplay = r.isAutoFail ? "—" : r.saveTotal;

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
          const color = DamageConstants.DAMAGE_COLORS[fx.damageType] ?? "#ccc";
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
          // Build dice display
          let fxDieDisplay = fx.formula;
          if (fx.roll?.terms) {
            const fxDice = [];
            for (const fxTerm of fx.roll.terms) {
              if (fxTerm.faces) {
                for (const fxR of (fxTerm.results ?? [])) {
                  const fxImgPath = DamageConstants.getDiceImagePath(fxTerm.faces, fxR.result);
                  const fxFallback = DamageConstants.DIE_ICONS[fxTerm.faces] ?? "fa-dice";
                  fxDice.push(
                    `<span class="ace-qol-die">`
                    + `<img class="ace-qol-die-img" src="${fxImgPath}" alt="d${fxTerm.faces}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
                    + `<i class="fas ${fxFallback} ace-qol-die-fallback" style="display:none"></i>`
                    + `<span class="ace-qol-die-result">${fxR.result}</span>`
                    + `</span>`
                  );
                }
              }
            }
            if (fxDice.length) fxDieDisplay = fxDice.join(' <span class="ace-qol-dmg-plus">+</span> ');
          }
          effectsHtml += `<div class="ace-qol-dmg-component" style="padding-left: 0;">
            ${fxDieDisplay}
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

    // Build damage results for Apply/Undo flags
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
      flags: {
        [MODULE_ID]: {
          type: "postHitSaveResult",
          ...(damageResults.length ? { damageResults } : {}),
        }
      },
    });
  }
}
