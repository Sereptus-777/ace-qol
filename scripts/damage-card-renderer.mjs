// ─── ACE: QOL — Damage Card Renderer ─────────────────────────────────────────
// All HTML card generation for the damage system: damage buttons, full damage
// cards, target rows, and pre-rolled dice animation. No HP mutation, no hooks.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageConstants, safeShowForRoll } from "./damage-engine.mjs";
import { MergeCard } from "./merge-card.mjs";
import { awaitDsnRoll } from "./attack-prompt.mjs";
import { WeaponMasteries } from "./weapon-masteries.mjs";

export class DamageCardRenderer {

  // ═══════════════════════════════════════════════════════════════════════════
  //  PC Damage Button — slim card with "ROLL DAMAGE" button
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a slim card with a ROLL DAMAGE button. Pre-rolls damage while item
   * still exists (Beneos/BG3 HUD deletes items after attack).
   */
  static async postDamageButton(item, actor, hits, consumedRiders = []) {
    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";
    const anyCrit = hits.some(h => h.hitResult === "critical");
    const targetNames = hits.map(h => h.name ?? h.target?.name ?? "target").join(", ");

    // ── Pre-roll damage while item still exists ──
    DamageConstants.suppressDiceAnimation = true;
    const preRolled = [];
    try {
      for (const hit of hits) {
        const isCrit = hit.hitResult === "critical";
        let components = await DamageCalculator.rollDamageComponents(item, actor, hit, isCrit, critRule);

        // ── ABSORB ELEMENTS — target reaction to halve elemental damage ──
        try {
          const reactionEng = game.aceQol?.reactionEngine;
          if (reactionEng && hit.targetActor && hit.targetToken) {
            const absorbResult = await reactionEng.checkPreDamageReactions(
              components, hit.targetActor, hit.targetToken, actor, item
            );
            if (absorbResult.absorbed) {
              components = absorbResult.modifiedComponents;
            }
          }
        } catch (err) {
          console.warn(`ace-qol | Absorb Elements check failed (non-blocking):`, err);
        }

        const applied = DamageCalculator.applyDamageModifiers(components, hit.damageModifiers ?? {});
        const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
        const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);

        // Serialize components (Roll objects aren't JSON-serializable)
        const serializedComponents = applied.map(c => ({
          name: c.name,
          formula: c.formula,
          total: c.total ?? c.raw,
          raw: c.raw,
          final: c.final,
          modifier: c.modifier,
          reason: c.reason,
          type: c.type,
          isCrit: c.isCrit ?? false,
          normalTotal: c.normalTotal,
          _modMeta: c._modMeta ?? null,
          terms: DamageConstants.serializeRollTerms(c.roll),
        }));

        preRolled.push({
          tokenId: hit.targetToken?.id,
          tokenDocId: hit.targetToken?.document?.id ?? hit.targetToken?.id,
          actorId: hit.targetActor?.id,
          sceneId: canvas.scene?.id,
          hitResult: hit.hitResult,
          isCrit,
          // Carry the natural d20 attack result so secondary-roll riders
          // (Sword of Sharpness, Vorpal Sword) can distinguish a true
          // natural 20 from an expanded crit-range crit. RAW: their sever
          // mechanic only triggers on a literal d20 = 20.
          naturalRoll: hit.d20Result ?? (hit.isCritRoll ? 20 : null),
          name: hit.target?.name ?? hit.name,
          img: hit.target?.img ?? hit.img,
          currentHP: hit.target?.currentHP,
          maxHP: hit.target?.maxHP,
          totalRaw,
          totalFinal,
          components: serializedComponents,
          damageModifiers: hit.damageModifiers,
        });
      }
    } finally {
      DamageConstants.suppressDiceAnimation = false;
    }

    // ── Also pre-parse item description for post-hit effects ──
    // Gate must list EVERY parsed field, otherwise weapons whose only
    // post-hit machinery is a tier the gate forgets (hpThresholdRider —
    // Mace of Disruption/Smiting; onKillRider — Blood Halberd; repeatingSave
    // — Hold Person etc.) silently skip the entire post-hit chain.
    let parsedDescription = null;
    try {
      const parsed = DescriptionParser.parse(item);
      if (parsed.saves.length
          || parsed.effectTable
          || parsed.bonusDamage.length
          || parsed.conditions.length
          || parsed.severRider
          || parsed.hpThresholdRider
          || parsed.onKillRider
          || parsed.repeatingSave
          || parsed.creatureTrigger) {
        parsedDescription = {
          saves: parsed.saves,
          effectTable: parsed.effectTable,
          bonusDamage: parsed.bonusDamage,
          conditions: parsed.conditions,
          severRider: parsed.severRider,
          hpThresholdRider: parsed.hpThresholdRider,
          onKillRider: parsed.onKillRider,
          repeatingSave: parsed.repeatingSave,
          creatureTrigger: parsed.creatureTrigger,
        };
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | DescriptionParser.parse failed in postDamageButton:`, e.message);
    }

    console.log(`${MODULE_ID} | postDamageButton: pre-rolled ${preRolled.length} targets, critRule=${critRule}`);

    // ── Push mastery: bundled "ROLL DAMAGE + PUSH 10 FT?" button ──
    // If the attacker has Push mastery + the weapon has push + edition allows
    // it + the FIRST target is within the size cap, offer a second blinking
    // orange button that bundles the roll-damage and push actions into one
    // click. RAW: Push is "you can" — optional — so the player decides via
    // the choice between the plain button and the bundled button.
    let pushBundle = null;
    try {
      const firstHit = hits?.[0];
      const firstTargetActor = firstHit?.targetActor ?? firstHit?.target?.actor ?? null;
      if (firstTargetActor && WeaponMasteries.shouldOfferPush(item, actor, firstTargetActor)) {
        const firstTargetToken = firstHit?.targetToken ?? null;
        const attTok = actor?.getActiveTokens?.()[0] ?? null;
        if (firstTargetToken && attTok) {
          pushBundle = {
            attackerUuid: attTok.document?.uuid ?? attTok.uuid,
            targetUuid:   firstTargetToken.document?.uuid ?? firstTargetToken.uuid,
            targetName:   firstHit?.target?.name ?? firstHit?.name ?? firstTargetToken.name,
          };
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | postDamageButton push-bundle check failed (non-blocking):`, err);
    }

    const cardHtml = `
      <div class="ace-qol-dmg-btn-card">
        <button class="ace-qol-btn ace-qol-btn-roll-dmg" data-action="aceQolRollDamage">
          <i class="fas fa-burst"></i>
          ROLL DAMAGE${anyCrit ? ' <span class="ace-qol-dmg-btn-crit">CRIT!</span>' : ""}
        </button>
        ${pushBundle ? `<button class="ace-qol-btn ace-qol-btn-roll-dmg-push ace-qol-blink-push" data-action="aceQolRollDamagePush"
          data-attacker-uuid="${pushBundle.attackerUuid}"
          data-target-uuid="${pushBundle.targetUuid}">
          <span class="ace-qol-btn-roll-dmg-push-top"><i class="fas fa-burst"></i> ROLL DAMAGE + <i class="fas fa-burst"></i></span>
          <span class="ace-qol-btn-roll-dmg-push-bot">PUSH 10 FT?</span>
        </button>` : ""}
        <span class="ace-qol-dmg-btn-targets">→ ${targetNames}</span>
      </div>
    `;

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "damageButton",
          itemId: item.id,
          itemUuid: item.uuid,
          itemName: item.name,
          itemImg: item.img || "icons/svg/sword.svg",
          actorId: actor.id,
          critRule,
          preRolled,
          parsedDescription,
          consumedRiders: consumedRiders.length ? consumedRiders : undefined,
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Merged Attack + Damage Button
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a merged attack + ROLL DAMAGE button card for PC attacks.
   * Does the same pre-rolling as postDamageButton, but wraps the output
   * in MergeCard's combined layout that includes attack results above.
   */
  static async postMergeDamageButton(item, actor, hits, consumedRiders = []) {
    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";

    // ── Pre-roll damage (same as postDamageButton) ──
    DamageConstants.suppressDiceAnimation = true;
    const preRolled = [];
    try {
      for (const hit of hits) {
        const isCrit = hit.hitResult === "critical";
        const components = await DamageCalculator.rollDamageComponents(item, actor, hit, isCrit, critRule);
        const applied = DamageCalculator.applyDamageModifiers(components, hit.damageModifiers ?? {});
        const totalRaw = applied.reduce((sum, c) => sum + c.raw, 0);
        const totalFinal = applied.reduce((sum, c) => sum + c.final, 0);

        const serializedComponents = applied.map(c => ({
          name: c.name, formula: c.formula, total: c.total ?? c.raw,
          raw: c.raw, final: c.final, modifier: c.modifier, reason: c.reason,
          type: c.type, isCrit: c.isCrit ?? false, normalTotal: c.normalTotal,
          _modMeta: c._modMeta ?? null,
          terms: DamageConstants.serializeRollTerms(c.roll),
        }));

        preRolled.push({
          tokenId: hit.targetToken?.id,
          tokenDocId: hit.targetToken?.document?.id ?? hit.targetToken?.id,
          actorId: hit.targetActor?.id,
          sceneId: canvas.scene?.id,
          hitResult: hit.hitResult, isCrit,
          // Natural d20 result for secondary-roll riders (Sword of Sharpness etc.)
          naturalRoll: hit.d20Result ?? (hit.isCritRoll ? 20 : null),
          name: hit.target?.name ?? hit.name,
          img: hit.target?.img ?? hit.img,
          currentHP: hit.target?.currentHP, maxHP: hit.target?.maxHP,
          totalRaw, totalFinal,
          components: serializedComponents,
          damageModifiers: hit.damageModifiers,
        });
      }
    } finally {
      DamageConstants.suppressDiceAnimation = false;
    }

    // ── Pre-parse description for post-hit effects ──
    // Same gate / storage as postDamageButton — must list every parsed
    // field so weapons whose only post-hit effect is hpThresholdRider,
    // onKillRider, repeatingSave, or creatureTrigger don't silently skip.
    let parsedDescription = null;
    try {
      const parsed = DescriptionParser.parse(item);
      if (parsed.saves.length
          || parsed.effectTable
          || parsed.bonusDamage.length
          || parsed.conditions.length
          || parsed.severRider
          || parsed.hpThresholdRider
          || parsed.onKillRider
          || parsed.repeatingSave
          || parsed.creatureTrigger) {
        parsedDescription = {
          saves: parsed.saves,
          effectTable: parsed.effectTable,
          bonusDamage: parsed.bonusDamage,
          conditions: parsed.conditions,
          severRider: parsed.severRider,
          hpThresholdRider: parsed.hpThresholdRider,
          onKillRider: parsed.onKillRider,
          repeatingSave: parsed.repeatingSave,
          creatureTrigger: parsed.creatureTrigger,
        };
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | DescriptionParser.parse failed in postMergeDamageButton:`, e.message);
    }

    // ── Post the merged card ──
    const attackData = MergeCard.consumeAttackResult();
    await MergeCard.postMergedDamageButton(attackData, item, actor, hits, preRolled, critRule, parsedDescription, consumedRiders);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Full Damage Card — Batch Results with Apply/Undo
  // ═══════════════════════════════════════════════════════════════════════════

  static async postDamageCard(item, actor, damageResults, critRule, consumedRiders = null, refundLink = null) {
    if (!damageResults.length) return;

    // ── Shared formula display (from first target's raw roll — same roll for all) ──
    const firstResult = damageResults[0];
    const formulaRows = firstResult.components.map(c => {
      const dieResults = [];
      const flatMods = [];
      const meta = c._modMeta;
      const usedLabels = new Set();

      if (c.roll?.terms) {
        for (const term of c.roll.terms) {
          if (term.faces) {
            for (const r of (term.results ?? [])) {
              const imgPath = DamageConstants.getDiceImagePath(term.faces, r.result);
              const fallbackIcon = DamageConstants.DIE_ICONS[term.faces] ?? "fa-dice";
              dieResults.push(
                `<span class="ace-qol-die">`
                + `<img class="ace-qol-die-img" src="${imgPath}" alt="d${term.faces}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
                + `<i class="fas ${fallbackIcon} ace-qol-die-fallback" style="display:none"></i>`
                + `<span class="ace-qol-die-result">${r.result}</span>`
                + `</span>`
              );
            }
          } else if (term.number !== undefined && term.number !== 0) {
            const num = term.number;
            let label = "";
            if (meta) {
              if (!usedLabels.has("ability") && meta.abilityMod !== 0 && num === meta.abilityMod) {
                label = meta.abilityName;
                usedLabels.add("ability");
              } else if (!usedLabels.has("magic") && meta.magicBonus > 0 && num === meta.magicBonus) {
                label = "MAGIC";
                usedLabels.add("magic");
              }
            }
            const sign = num > 0 ? "+" : "";
            const labelClass = label === "MAGIC" ? "ace-qol-mod-label ace-qol-mod-magic" : "ace-qol-mod-label";
            const labelHtml = label
              ? `<span class="ace-qol-mod-labeled">${sign}${num} <span class="${labelClass}">${label}</span></span>`
              : `<span class="ace-qol-mod-plain">${sign}${num}</span>`;
            flatMods.push(labelHtml);
          }
        }
      }

      const dieDisplay = dieResults.join(' <span class="ace-qol-dmg-plus">+</span> ') || c.formula;
      const modDisplay = flatMods.length ? ` ${flatMods.join(" ")}` : "";
      const critDisplay = c.isCrit ? `<span class="ace-qol-dmg-crit-label">${c.normalTotal !== undefined ? `MAX ${c.normalTotal}` : "CRIT"}</span> + ` : "";

      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      const typeTotal = `<span class="ace-qol-dmg-equals">=</span> <span class="ace-qol-dmg-type-total" style="color:${color}"><span class="ace-qol-dmg-type-num">${c.final}</span> ${c.type}</span>`;

      // ── Rider source caption (v0.7.15) ──
      // Identify rows that came from a rider/bonus (Searing Smite, Divine
      // Smite, Hex, Hunter's Mark, Radiant Soul, etc.) and add a small label
      // beneath the row so the GM can see WHERE the damage came from. The
      // weapon base row stays uncaptioned by design — its source is implicit.
      // Caption sits on its own line, in the same color as the damage type
      // (not dimmed), one size smaller than the main row.
      const isWeaponBase = c.name === item.name;
      const sourceCaption = (!isWeaponBase && c.name && c.name !== "Bonus")
        ? `<div class="ace-qol-dmg-source-caption" style="color:${color};">${c.name}</div>`
        : "";

      // Inline-flow layout: dice → mods → "= total type" all on one wrapping row
      // (was a 2-column flex with the total floating right, which forced dice
      // into a vertical stack on narrow chat-card widths).
      return `<div class="ace-qol-dmg-component ace-qol-dmg-row">`
        + `${critDisplay}${dieDisplay}${modDisplay}${typeTotal}`
        + `${sourceCaption}`
        + `</div>`;
    }).join("");

    const totalRaw = firstResult.totalRaw;

    // ── Build per-target rows ──
    const targetRows = damageResults.map(dr => DamageCardRenderer.buildTargetRowHtml({
      tokenDocId: dr.targetToken?.document?.id ?? dr.targetToken?.id,
      actorId: dr.targetActor?.id,
      sceneId: canvas.scene?.id,
      name: dr.target.name,
      img: dr.target.img,
      currentHP: dr.target.currentHP,
      maxHP: dr.target.maxHP,
      totalFinal: dr.totalFinal,
      isCrit: dr.isCrit,
      components: dr.components,
    })).join("");

    const critRuleLabel = { doubleDice: "Double Dice", maxPlusRoll: "Max + Roll", maxAll: "Max All" }[critRule] ?? critRule;
    const anyCrit = damageResults.some(dr => dr.isCrit);

    const hasCleave = actor ? DamageConstants.actorHasCleave(actor, item) : false;
    const hasPush   = (actor && item) ? WeaponMasteries.shouldOfferPush(item, actor) : false;

    const cardHtml = `
      <div class="ace-qol-damage-card">
        <div class="ace-qol-dmg-header">
          <img src="${item.img || "icons/svg/sword.svg"}" class="ace-qol-dmg-item-img" />
          <strong class="ace-qol-dmg-item-name">${item.name} — Damage</strong>
          ${anyCrit ? `<span class="ace-qol-dmg-crit-rule">${critRuleLabel}</span>` : ""}
        </div>
        <div class="ace-qol-dmg-roll-section">
          <div class="ace-qol-dmg-components">${formulaRows}</div>
        </div>
        ${hasCleave ? `<div class="ace-qol-dmg-cleave-row">
          <button class="ace-qol-btn ace-qol-btn-cleave" data-action="aceQolCleave">
            <i class="fas fa-khanda"></i> CLEAVE
          </button>
        </div>` : ""}
        ${hasPush ? `<div class="ace-qol-dmg-push-row">
          <button class="ace-qol-btn ace-qol-btn-push-dmg" data-action="aceQolPush">
            <i class="fas fa-hand-back-fist"></i> PUSH 10 FT
          </button>
        </div>` : ""}
        <div class="ace-qol-dmg-targets">
          ${targetRows}
        </div>
        <div class="ace-qol-dmg-gm-controls">
          <div class="ace-qol-dmg-actions">
            <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
              <i class="fas fa-heart-crack"></i> APPLY ALL
            </button>
            <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled>
              <i class="fas fa-undo"></i> UNDO ALL
            </button>
          </div>
        </div>
      </div>
    `;

    // Store raw components for ADD TARGET re-calculation
    const rawComponents = firstResult.components.map(c => ({
      name: c.name, type: c.type, raw: c.raw, formula: c.formula,
    }));

    // Wait for DSN damage dice to settle before posting the result card —
    // otherwise the chat card spoils the totals while dice are still rolling.
    await awaitDsnRoll();

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "damageResult",
          itemUuid: item.uuid,
          actorId: actor.id,
          rawComponents,
          totalRaw,
          consumedRiders: consumedRiders?.length ? consumedRiders : undefined,
          // Cross-card refund linking: damage card knows about the button card
          // so refunds done on either side stay in sync, and refunds already
          // performed on the button card carry over (no duplicate refund buttons).
          refundSourceMsgId: refundLink?.sourceMsgId ?? undefined,
          refundedRiders: refundLink?.alreadyRefunded?.length ? [...refundLink.alreadyRefunded] : undefined,
          damageResults: damageResults.map(dr => ({
            targetId: dr.targetActor.id,
            tokenId: dr.targetToken.id,
            tokenDocId: dr.targetToken.document?.id ?? dr.targetToken.id,
            sceneId: canvas.scene?.id,
            isLinked: dr.targetActor.prototypeToken?.actorLink ?? dr.targetToken.document?.actorLink ?? false,
            totalFinal: dr.totalFinal,
            currentHP: dr.target.currentHP,
            maxHP: dr.target.maxHP,
            name: dr.target.name,
            img: dr.target.img,
            components: dr.components.map(c => ({ name: c.name, type: c.type, raw: c.raw, final: c.final, modifier: c.modifier })),
          })),
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Pre-Rolled Damage Card (from button click)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post damage card from pre-rolled results stored in message flags.
   * Fires Dice So Nice animations, then posts the card.
   * @returns {boolean} true on success
   */
  static async postPreRolledDamageCard(message, flags) {
    const { preRolled, critRule, itemName, itemImg, actorId, parsedDescription } = flags;
    // Resolve the attacker — prefer the TOKEN's actor (canvas instance) over
    // the base actor template. This matters when the GM drag-drops a weapon
    // onto an NPC token mid-battle (e.g. handing a Goblin Boss a Vorpal
    // Scimitar to see how the players handle a sudden head-chopper). Those
    // items live ONLY on the synthetic token actor, not on the world's
    // base actor. The base lookup below would miss them entirely and the
    // sever / on-kill / save-rider chains would all silently no-op.
    const actor = _resolveAttackerActor(message, actorId);

    console.log(`${MODULE_ID} | postPreRolledDamageCard: ${preRolled.length} pre-rolled targets`);

    // Reconstruct damageResults from serialized data
    const damageResults = preRolled.map(pr => {
      const scene = game.scenes.get(pr.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(pr.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(pr.actorId);

      const components = pr.components.map(c => ({
        ...c,
        roll: { terms: (c.terms ?? []).map(t => {
          if (t.type === "die") return { faces: t.faces, results: t.results };
          if (t.type === "num") return { number: t.number };
          return t;
        }) },
      }));

      return {
        target: {
          name: pr.name,
          img: pr.img,
          currentHP: targetActor?.system?.attributes?.hp?.value ?? pr.currentHP,
          maxHP: pr.maxHP,
        },
        targetToken: { id: pr.tokenId, document: { id: pr.tokenDocId } },
        targetActor: targetActor ?? { id: pr.actorId },
        isCrit: pr.isCrit,
        components,
        totalRaw: pr.totalRaw,
        totalFinal: pr.totalFinal,
      };
    });

    // Build a minimal item stand-in for the card header
    const fakeItem = { name: itemName, img: itemImg, uuid: flags.itemUuid };

    // ── Fire Dice So Nice animations FIRST, then post the card ──
    if (game.dice3d) {
      try {
        for (const pr of preRolled) {
          for (const c of (pr.components ?? [])) {
            if (!c.terms?.length) continue;
            const formulaParts = [];
            for (const t of c.terms) {
              if (t.type === "die") formulaParts.push(`${t.results.length}d${t.faces}`);
              else if (t.type === "num" && t.number > 0) formulaParts.push(`+ ${t.number}`);
              else if (t.type === "num" && t.number < 0) formulaParts.push(`- ${Math.abs(t.number)}`);
              else if (t.type === "op") formulaParts.push(t.operator);
            }
            const formula = formulaParts.join(" ") || c.formula;
            if (!formula) continue;

            const roll = new Roll(formula);
            roll._evaluated = true;
            let termIdx = 0;
            for (const term of roll.terms) {
              if (term.faces) {
                const sTerm = c.terms.find((t, i) => t.type === "die" && i >= termIdx);
                if (sTerm) {
                  term._evaluated = true;
                  term.results = sTerm.results.map(r => ({ result: r.result, active: true }));
                  termIdx = c.terms.indexOf(sTerm) + 1;
                }
              }
            }
            roll._total = c.total ?? c.raw;

            // ── DSN via canonical safe helper (v0.7.2) ──
            // safeShowForRoll handles every failure mode (loader missing,
            // half-broken renderer, sync throws, non-thenable returns) and
            // is non-async so it can never hang the pipeline.
            safeShowForRoll(roll, "pre-rolled component");
          }
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Pre-rolled dice animation failed (non-blocking):`, err);
      }
    }

    // ── Post the damage card AFTER dice finish rolling ──
    // Carry refund state forward: damage card links back to the button card,
    // and inherits any rider refunds the GM already performed on the button card.
    const refundLink = {
      sourceMsgId: message.id,
      alreadyRefunded: message.flags?.[MODULE_ID]?.refundedRiders ?? [],
    };
    try {
      await DamageCardRenderer.postDamageCard(fakeItem, actor, damageResults, critRule, flags.consumedRiders, refundLink);
    } catch (err) {
      console.error(`${MODULE_ID} | postPreRolledDamageCard CRASHED:`, err);
      return false;
    }

    // ── Post-hit effects — use pre-parsed description data if item is gone ──
    // The item must be returned to the caller (damage-engine) whenever ANY
    // post-hit machinery needs to run, not just saves. severRider (Sword of
    // Sharpness, Vorpal Sword), effectTable, bonusDamage, and conditions all
    // need the item handed back so PostHitSaves.checkPostHitEffects can fire.
    //
    // Previous bug: gate was `parsedDescription?.saves?.length` only. For
    // Sword of Sharpness — which has a severRider but no saves — the item
    // was never returned, so the sever-roll d20 never fired.
    const hasAnyPostHit = !!(parsedDescription && (
         parsedDescription.saves?.length
      || parsedDescription.severRider
      || parsedDescription.effectTable
      || parsedDescription.bonusDamage?.length
      || parsedDescription.conditions?.length
      || parsedDescription.hpThresholdRider
      || parsedDescription.onKillRider
      || parsedDescription.repeatingSave
      || parsedDescription.creatureTrigger
    ));
    if (hasAnyPostHit) {
      let item = await fromUuid(flags.itemUuid).catch(() => null);
      if (!item) item = actor?.items?.get(flags.itemId);
      if (!item && itemName) item = actor?.items?.getName(itemName);

      if (item) {
        // Return item for caller to run post-hit effects
        return { success: true, item, preRolled, damageResults };
      } else {
        console.warn(`${MODULE_ID} | Item gone, but post-hit effects detected. Post-hit chain skipped (item description unavailable).`);
      }
    }

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Target Row HTML Builder
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build HTML for a single target row in the damage card.
   * Normalized input — works for both initial render and dynamic ADD/CLEAVE.
   */
  static buildTargetRowHtml({ tokenDocId, actorId, sceneId, name, img, currentHP, maxHP, totalFinal, isCrit, components }) {
    const tDocId = tokenDocId ?? "unknown";
    const portrait = img || "icons/svg/mystery-man.svg";
    const newHP = Math.max(0, currentHP - totalFinal);
    const isDead = newHP <= 0;

    // Tracking: which modifier categories were hit, for flavor-hint generation.
    // We pick the strongest single hint to show — vulnerable > immune > resistant.
    const flavorTrigger = { vulnerable: null, immune: null, resistant: null };

    const compLines = (components ?? []).map((c, idx) => {
      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      let modBadge = "";
      let strikeStyle = "";
      let rowClasses = "";

      if (c.modifier === "immune") {
        // Truth-only badge AND truth-only row — players don't see this row at all
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-immune ace-qol-dmg-truth-only" style="background:${color}; color:#000">IMMUNE</span>`;
        strikeStyle = `text-decoration: line-through; text-decoration-color: ${color}; opacity: 0.6;`;
        rowClasses = " ace-qol-dmg-truth-row";
        if (!flavorTrigger.immune) flavorTrigger.immune = c.type;
      } else if (c.modifier === "resistant") {
        // Truth-only badge — players see the halved number but no "RESIST" label
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-resist ace-qol-dmg-truth-only" style="border-color:${color}; color:${color}">½ RESIST</span>`;
        if (!flavorTrigger.resistant) flavorTrigger.resistant = c.type;
      } else if (c.modifier === "vulnerable") {
        // Truth-only badge — players see the doubled number but no "VULN" label
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-vuln ace-qol-dmg-truth-only">×2 VULN</span>`;
        if (!flavorTrigger.vulnerable) flavorTrigger.vulnerable = c.type;
      }

      // Show the raw→final transition only for GM (it leaks the modifier);
      // players see only the final number, no strikethrough hint.
      const rawFinalSpan = (c.raw !== c.final && c.modifier !== "normal")
        ? `<span class="ace-qol-dmg-truth-only" style="color:#666; text-decoration:line-through; font-size:0.75rem">${c.raw}</span> `
        : "";
      const dmgDisplay = `${rawFinalSpan}<strong style="color:${color}">${c.final}</strong>`;
      const clickable = c.final > 0 ? `data-action="aceQolApplyType" data-damage-type="${c.type}" data-damage-amount="${c.final}" data-comp-index="${idx}" title="Click to apply ${c.final} ${c.type} damage"` : "";
      const clickClass = c.final > 0 ? " ace-qol-dmg-type-clickable" : "";
      return `
        <div class="ace-qol-dmg-type-line${clickClass}${rowClasses}" ${clickable} style="${strikeStyle}">
          ${dmgDisplay} <span style="color:${color}; font-weight:600">${c.type}</span> ${modBadge}
        </div>
      `;
    }).join("");

    // Build the player-visible flavor hint (subtle, in-fiction). Visible to
    // everyone — gives players a hint without using definitive language like
    // "IMMUNE" or "RESIST". GM sees it too but they also see the truth badges.
    let flavorHintHtml = "";
    if (flavorTrigger.vulnerable) {
      flavorHintHtml = `<div class="ace-qol-dmg-flavor-hint">…the ${flavorTrigger.vulnerable} damage cuts deeper than expected.</div>`;
    } else if (flavorTrigger.immune) {
      flavorHintHtml = `<div class="ace-qol-dmg-flavor-hint">…the ${flavorTrigger.immune} damage seems to wash over with little effect.</div>`;
    } else if (flavorTrigger.resistant) {
      flavorHintHtml = `<div class="ace-qol-dmg-flavor-hint">…some of the ${flavorTrigger.resistant} damage seems blunted.</div>`;
    }

    const _a = (mult) => (mult === 1) ? " ace-qol-dmg-ovr-active" : "";

    return `
      <div class="ace-qol-dmg-target-row" data-token-doc-id="${tDocId}" data-actor-id="${actorId ?? ""}" data-scene-id="${sceneId ?? ""}">
        <div class="ace-qol-dmg-row-header">
          <img src="${portrait}" class="ace-qol-dmg-tgt-img" />
          <span class="ace-qol-dmg-tgt-name">${name ?? "Unknown"}</span>
          ${isCrit ? '<span class="ace-qol-dmg-crit-badge">CRIT</span>' : ""}
        </div>
        ${compLines ? `<div class="ace-qol-dmg-type-breakdown">${compLines}</div>` : ""}
        ${flavorHintHtml}
        <div class="ace-qol-dmg-gm-controls">
          <div class="ace-qol-dmg-hp-line">
            <span class="ace-qol-dmg-row-dmg">${totalFinal}</span>
            ${isDead ? '<span class="ace-qol-dmg-skull">☠</span>' : ''}
            <span class="ace-qol-dmg-row-hp">HP: <span class="ace-qol-hp-cur">${currentHP}</span> → <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span><span class="ace-qol-hp-max">/${maxHP}</span></span>
          </div>
          <div class="ace-qol-dmg-ovr-line">
            <button class="ace-qol-dmg-ovr-x" data-action="aceQolDmgRemove" data-token-doc-id="${tDocId}">×</button>
            <button class="ace-qol-dmg-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="0.25">¼</button>
            <button class="ace-qol-dmg-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="0.5">½</button>
            <button class="ace-qol-dmg-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-dmg-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="2">2</button>
          </div>
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player Status Summary (post-apply, shown to all users)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Inject player-visible status summary into a damage card after GM applies.
   * Shows "12 slashing applied", "IMMUNE fire", etc.
   */
  static injectPlayerStatus(el, flags) {
    if (!flags.applied || !flags.damageResults?.length) return;

    const existing = el.querySelector(".ace-qol-player-status");
    if (existing) return;

    // Modifier labels are GM-truth — wrapped in `ace-qol-dmg-truth-only` so
    // the visibility-engine can hide them from non-GM viewers. Players see
    // only the damage that landed, never an "IMMUNE/RESIST/VULN" label.
    const MODIFIER_LABELS = {
      immune: { text: "IMMUNE", color: "#ef5350", icon: "fa-shield" },
      resistant: { text: "RESIST", color: "#ffa726", icon: "fa-shield-halved" },
      vulnerable: { text: "VULN ×2", color: "#ab47bc", icon: "fa-burst" },
    };

    let statusHtml = '<div class="ace-qol-player-status">';
    for (const dr of flags.damageResults) {
      statusHtml += `<div class="ace-qol-player-status-target">
        <span class="ace-qol-player-status-name">${dr.name}</span>`;
      for (const c of (dr.components ?? [])) {
        const mod = MODIFIER_LABELS[c.modifier];
        if (c.modifier === "immune") {
          // Whole "IMMUNE fire" pill is truth-only — players don't see it
          statusHtml += `<span class="ace-qol-player-status-line ace-qol-player-status-immune ace-qol-dmg-truth-only">
            <i class="fas ${mod.icon}"></i> ${c.type} <strong>${mod.text}</strong>
          </span>`;
        } else if (mod) {
          // Show the damage that landed to everyone, but the modifier label
          // ("RESIST" / "VULN ×2") is truth-only.
          statusHtml += `<span class="ace-qol-player-status-line" style="color:${mod.color}">
            <i class="fas ${mod.icon}"></i> ${c.final} ${c.type} <strong class="ace-qol-dmg-truth-only">${mod.text}</strong>
          </span>`;
        } else if (c.final > 0) {
          // Green check (applied) + bright blood-red damage amount + small "DMG" label
          statusHtml += `<span class="ace-qol-player-status-line ace-qol-player-status-applied">
            <i class="fas fa-check ace-qol-player-status-check"></i>
            <span class="ace-qol-player-status-dmg">${c.final} ${c.type}</span>
            <span class="ace-qol-player-status-dmg-label">DMG</span>
          </span>`;
        }
      }
      statusHtml += `</div>`;
    }
    statusHtml += '</div>';

    const rollSection = el.querySelector(".ace-qol-dmg-roll-section");
    if (rollSection) {
      rollSection.insertAdjacentHTML("afterend", statusHtml);
    } else {
      const card = el.querySelector(".ace-qol-damage-card");
      if (card) card.insertAdjacentHTML("beforeend", statusHtml);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the attacker actor from a ChatMessage + actorId, preferring the
 * TOKEN'S actor on canvas (with any dynamically-added items) over the
 * base actor template.
 *
 * Why: A GM can drag weapons / items directly onto an NPC token mid-battle
 * via the token's actor sheet. Those items live on the synthetic token
 * actor only, NOT on the world's base actor. Using game.actors.get() alone
 * misses them entirely, which silently breaks any post-hit machinery that
 * inspects the attacker's items (sever riders, on-kill riders, etc.).
 *
 * Resolution order:
 *   1. Token referenced by message.speaker.token on message.speaker.scene
 *   2. Any token on any scene whose actor matches actorId (defensive)
 *   3. Base actor template by actorId
 *
 * @param {ChatMessage} message
 * @param {string}      actorId
 * @returns {Actor|null}
 */
function _resolveAttackerActor(message, actorId) {
  try {
    const tokenId = message?.speaker?.token;
    const sceneId = message?.speaker?.scene;
    if (tokenId && sceneId) {
      const scene = game.scenes.get(sceneId);
      const tdoc = scene?.tokens?.get(tokenId);
      if (tdoc?.actor) return tdoc.actor;
    }
    if (tokenId) {
      for (const scene of game.scenes) {
        const tdoc = scene.tokens?.get(tokenId);
        if (tdoc?.actor) return tdoc.actor;
      }
    }
    if (actorId) {
      for (const scene of game.scenes) {
        for (const tdoc of scene.tokens ?? []) {
          if (tdoc.actor?.id === actorId) return tdoc.actor;
        }
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | _resolveAttackerActor failed (falling back to base actor):`, err);
  }
  return actorId ? game.actors.get(actorId) : null;
}
