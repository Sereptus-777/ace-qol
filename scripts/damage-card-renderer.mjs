// ─── ACE: QOL — Damage Card Renderer ─────────────────────────────────────────
// All HTML card generation for the damage system: damage buttons, full damage
// cards, target rows, and pre-rolled dice animation. No HP mutation, no hooks.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DescriptionParser } from "./description-parser.mjs";
import { DamageCalculator } from "./damage-calculator.mjs";
import { DamageConstants, safeShowForRoll } from "./damage-engine.mjs";
import { awaitDiceSettle } from "./dsn-utils.mjs";
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
  static async postDamageButton(item, actor, hits, consumedRiders = [], activityId = null) {
    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";
    const anyCrit = hits.some(h => h.hitResult === "critical");
    const targetNames = hits.map(h => h.name ?? h.target?.name ?? "target").join(", ");

    // ── Pre-roll damage while item still exists ──
    DamageConstants.suppressDiceAnimation = true;
    const preRolled = [];
    try {
      for (const hit of hits) {
        const isCrit = hit.hitResult === "critical";
        let components = await DamageCalculator.rollDamageComponents(item, actor, hit, isCrit, critRule, activityId);

        // ── ⚠️🔴 UNCANNY DODGE DOES NOT BELONG HERE ANY MORE ────────
        //
        // This runs while the ATTACK card is being built, before the player has
        // pressed Roll Damage. ACE pre-rolls the damage behind the scenes, so it
        // could confidently offer "halve 14 to 7" for dice nobody had seen
        // thrown. Johnny, 2026-08-26:
        //
        //   "The dice didn't even roll yet. He didn't roll the damage. It's
        //    going to have to be AFTER the guy rolls the damage. That's where
        //    the hook has to go. Otherwise it's going to look awfully funny."
        //
        // He is right, and it is how it plays at a table: the damage is rolled,
        // everyone sees the number, THEN the rogue decides. The Uncanny Dodge
        // call moved to `postPreRolledDamageCard`, after the dice are on screen.
        //
        // ⚠️ ABSORB ELEMENTS STAYS. It answers elemental damage from any
        // source, including saves that never produce an attack card, and it has
        // worked from here for months. Moving both would be one change too many
        // in a hot path at the end of a long night.
        try {
          const reactionEng = game.aceQol?.reactionEngine;
          if (reactionEng && hit.targetActor && hit.targetToken) {
            // ⚠️ PASS THE HIT. Uncanny Dodge only triggers on an ATTACK
            // ROLL that landed, so the reaction engine has to be able to see
            // which it was; without it a save-based spell would offer a
            // reaction the rules do not allow.
            const preResult = await reactionEng.checkPreDamageReactions(
              components, hit.targetActor, hit.targetToken, actor, item, hit,
              { skipUncannyDodge: true }
            );
            // ⚠️ TAKE THE COMPONENTS WHENEVER SOMETHING CHANGED THEM, not
            // only when `absorbed` is set. Uncanny Dodge halves damage without
            // absorbing anything, and testing the old flag alone would have
            // thrown its result away and left the rogue on full damage — the
            // same "declared but never consulted" shape this feature already
            // died of once.
            if (preResult.absorbed || preResult.uncannyDodged) {
              components = preResult.modifiedComponents;
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
          <i class="fas fa-burst"></i>
          <span class="ace-qol-btn-roll-dmg-push-text">ROLL DAMAGE + PUSH 10 FT?</span>
          <i class="fas fa-burst"></i>
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
          // WHICH activity produced this damage — the button path re-rolls from
          // the card, and without this it would fall back to "first damaging
          // activity" and can pick a sibling on a multi-activity item.
          activityId: activityId ?? null,
          itemName: item.name,
          itemImg: item.img || "icons/svg/sword.svg",
          actorId: actor.id,
          // Non-GM users who OWN the attacking creature — the player who
          // controls a companion/summon/wild-shape rolls its OWN damage, GM
          // applies (2026-07-11). Computed GM-side so it's correct for unlinked
          // synthetic tokens too (game.actors.get can't resolve those).
          attackerOwnerUserIds: game.users.filter(u => !u.isGM && actor.testUserPermission?.(u, "OWNER")).map(u => u.id),
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
  static async postMergeDamageButton(item, actor, hits, consumedRiders = [], activityId = null) {
    const critRule = QolSettings.get("critRule") ?? "maxPlusRoll";

    // ── Pre-roll damage (same as postDamageButton) ──
    DamageConstants.suppressDiceAnimation = true;
    const preRolled = [];
    try {
      for (const hit of hits) {
        const isCrit = hit.hitResult === "critical";
        const components = await DamageCalculator.rollDamageComponents(item, actor, hit, isCrit, critRule, activityId);
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

  /**
   * Render the dice-and-modifier rows for a set of damage components — the
   * real die faces, the bonus chips, and the "= N type" total.
   *
   * ⚠️ EXTRACTED 2026-08-12 so the FALL card can show dice too. It was inline
   * inside postDamageCard, which is why a fall printed a bare number: there was
   * no way to reach this without an attacker and an item, and hand-rolling a
   * second copy is exactly the "built beside instead of on" mistake. Every card
   * that shows damage dice must come through here, so the configured die colour
   * and the crit/rider labelling stay identical everywhere.
   *
   * @param {object[]} components  damage components, each optionally carrying `roll`
   * @param {object}  [opts]
   * @param {string}  [opts.baseName]  the component treated as the "base" row,
   *        which gets no source caption. For a weapon that is the item's name;
   *        for a fall it is the fall row itself, since the header already says it.
   * @returns {string} HTML
   */
  static buildComponentRowsHtml(components, { baseName = null } = {}) {
    return (components ?? []).map(c => {
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

      // Flat-only riders (Radiant Soul's +CHA) have no dice — falling back to
      // the formula echoed the value twice ("5 +5 = 5", live-fire 2026-07-10).
      // With mod chips present, the chip alone tells the truth ("+5 = 5").
      const dieDisplay = dieResults.length
        ? dieResults.join(' <span class="ace-qol-dmg-plus">+</span> ')
        : (flatMods.length ? "" : c.formula);
      const modDisplay = flatMods.length ? ` ${flatMods.join(" ")}` : "";
      const critDisplay = c.isCrit ? `<span class="ace-qol-dmg-crit-label">${c.normalTotal !== undefined ? `MAX ${c.normalTotal}` : "CRIT"}</span> + ` : "";

      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      // ⚠️ THE ROLL, NOT ONE TARGET'S SHARE OF IT. This row sits above every
      // target and used to print `c.final`, which is the FIRST target's number
      // after their resistances — so a resisted hit read "5 + 5 = 5 necrotic".
      // `c.raw` is the total the dice actually made, which is true for
      // everybody; who resisted what belongs in their own box underneath.
      const rolled = c.raw ?? c.final;
      const typeTotal = `<span class="ace-qol-dmg-equals">=</span> <span class="ace-qol-dmg-type-total" style="color:${color}"><span class="ace-qol-dmg-type-num">${rolled}</span> ${c.type}</span>`;

      // ── Rider source caption (v0.7.15) ──
      // Identify rows that came from a rider/bonus (Searing Smite, Divine
      // Smite, Hex, Hunter's Mark, Radiant Soul, etc.) and add a small label
      // beneath the row so the GM can see WHERE the damage came from. The
      // weapon base row stays uncaptioned by design — its source is implicit.
      // Caption sits on its own line, in the same color as the damage type
      // (not dimmed), one size smaller than the main row.
      const isWeaponBase = c.name === baseName;
      const sourceCaption = (!isWeaponBase && c.name && c.name !== "Bonus")
        ? `<div class="ace-qol-dmg-source-caption" style="color:${color};">${c.name}</div>`
        : "";

      // Inline-flow layout: dice → mods → "= total type" all on one wrapping row
      // (was a 2-column flex with the total floating right, which forced dice
      // into a vertical stack on narrow chat-card widths).
      return `<div class="ace-qol-dmg-component ace-qol-dmg-row">`
        + `${critDisplay}${dieDisplay}${modDisplay}${typeTotal}`
        + `${sourceCaption}`
        + `</div>`;    }).join("");
  }

  static async postDamageCard(item, actor, damageResults, critRule, consumedRiders = null, refundLink = null, activityId = null) {
    if (!damageResults.length) return;

    // ── Shared formula display (from first target's raw roll — same roll for all) ──
    const firstResult = damageResults[0];
    const formulaRows = DamageCardRenderer.buildComponentRowsHtml(
      firstResult.components, { baseName: item?.name });

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
      // ⚠️ WHAT CHANGED THE NUMBER, so the row can say so instead of quietly
      // printing a total that does not match its own breakdown.
      reactionApplied: dr.reactionApplied ?? null,
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
          // WHICH activity produced this damage — the button path re-rolls from
          // the card, and without this it would fall back to "first damaging
          // activity" and can pick a sibling on a multi-activity item.
          activityId: activityId ?? null,
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
  /**
   * Fire the 3D-dice animation for a set of pre-rolled damage components on
   * THIS client, broadcasting to the whole table via DSN sync. Reconstructs
   * Roll objects from the serialized component terms stored on the button
   * card. Used both when the pre-rolled damage card is posted and, for
   * player-rolls-own-damage, when the CASTER shows their own dice before
   * handing the card off to the GM.
   */
  static showPreRolledDice(preRolled) {
    if (!game.dice3d || !Array.isArray(preRolled)) return;
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
          let formula = (formulaParts.join(" ") || c.formula || "").trim();
          // A zero-value mod term is skipped above, which can leave a DANGLING
          // operator — "1d4 +" — and that crashes Roll's parser with "end of
          // input found" (Johnny 2026-07-13, Polearm Master butt-end with a 0
          // mod). Strip any leading "+ * /" and any trailing "+ - * /" so the
          // dice still show cleanly. (Leading "-" is a real negation — kept.)
          formula = formula.replace(/^[\s+*/]+/, "").replace(/[\s+\-*/]+$/, "").trim();
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

          // safeShowForRoll handles every DSN failure mode and is non-async,
          // so it can never hang the pipeline.
          safeShowForRoll(roll, "pre-rolled component");
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | showPreRolledDice failed (non-blocking):`, err);
    }
  }

  static async postPreRolledDamageCard(message, flags, opts = {}) {
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

    // ── Re-apply the CURRENT Pact of the Blade type to the pre-roll ──
    // The damage is pre-rolled at ATTACK time, which bakes in whatever pact type
    // was current THEN (type + resistance). But the per-attack chooser runs later,
    // at ROLL DAMAGE time, on the roller's own client — so without this the card
    // would show the PREVIOUS pick (the one-step lag, 2026-07-12). By now the
    // chooser + socket have set the flag, so re-type the base-weapon components to
    // match and recompute each target's resistance for the new type. The dice are
    // untouched — only the damage TYPE and its resistance-adjusted total change.
    let _pactPreferred = null;
    try {
      const { hasPactOfTheBlade, getPactBladeType } = await import("./warlock-damage-chooser.mjs");
      if (actor && hasPactOfTheBlade(actor)) {
        const p = getPactBladeType(actor);
        if (p && p !== "weapon") _pactPreferred = p;
      }
    } catch (_) { /* non-fatal — leave the pre-rolled type as-is */ }

    // Reconstruct damageResults from serialized data
    const damageResults = preRolled.map(pr => {
      const scene = game.scenes.get(pr.sceneId) ?? canvas.scene;
      const tokenDoc = scene?.tokens?.get(pr.tokenDocId);
      const targetActor = tokenDoc?.actor ?? game.actors.get(pr.actorId);

      // Re-type the base-weapon components + recompute resistance for THIS target.
      if (_pactPreferred) {
        try {
          const _dmgMods = targetActor?.system ? DamageCalculator.getTargetDamageModifiers(targetActor) : {};
          let _retyped = false;
          for (const comp of (pr.components ?? [])) {
            if (comp.name !== itemName || comp.type === _pactPreferred) continue;
            comp._pactBladeFrom = comp.type;
            comp.type = _pactPreferred;
            const [re] = DamageCalculator.applyDamageModifiers([comp], _dmgMods);
            if (re) { comp.raw = re.raw; comp.final = re.final; comp.modifier = re.modifier; comp.reason = re.reason; }
            _retyped = true;
          }
          if (_retyped) {
            pr.totalRaw   = (pr.components ?? []).reduce((s, c) => s + (c.raw ?? c.total ?? 0), 0);
            pr.totalFinal = (pr.components ?? []).reduce((s, c) => s + (c.final ?? c.raw ?? c.total ?? 0), 0);
          }
        } catch (err) { console.warn(`${MODULE_ID} | pre-rolled pact re-type failed (non-fatal):`, err); }
      }

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
        // ⚠️🔴 CARRY THE ATTACK OUTCOME. This object is handed to the
        // post-roll reaction pass as the "hit", and Uncanny Dodge refuses
        // anything it cannot confirm was an attack that landed. Both pre-roll
        // sites store `hitResult` in the payload; this rebuild dropped it, so
        // the reaction engine saw a hit with no outcome and declined EVERY
        // time, silently. Firaxis critted Jeth for 18 on 2026-08-26 and Jeth
        // was never asked. The field was three lines away the whole time.
        hitResult: pr.hitResult,
        // Same reason: the secondary-roll riders distinguish a true natural 20
        // from a crit inside an expanded range, and they read it from here.
        naturalRoll: pr.naturalRoll ?? null,
        components,
        totalRaw: pr.totalRaw,
        totalFinal: pr.totalFinal,
      };
    });

    // Build a minimal item stand-in for the card header
    const fakeItem = { name: itemName, img: itemImg, uuid: flags.itemUuid };

    // ── Fire Dice So Nice animations FIRST, then post the card ──
    // Skipped when the CASTER already rolled these dice on their own client
    // (player-rolls-own-damage): their DSN sync already broadcast the tumble to
    // the whole table, so re-firing here on the GM would double the animation.
    if (!opts.skipDice) {
      DamageCardRenderer.showPreRolledDice(preRolled);
      // Let the tumble actually LAND before the card reveals the total — otherwise
      // the card pops in mid-roll (Johnny 2026-07-13: "the damage card comes up
      // before the roll even stops"). Fixed, hang-immune delay; instant no-op when
      // DSN is off. Skipped on the player-rolls-own path (opts.skipDice) since the
      // caster already tumbled + settled these dice on their own client.
      await awaitDiceSettle();
    }

    // ── ⚠️🔴 UNCANNY DODGE, NOW THAT THE DICE ARE ON THE TABLE ────────
    //
    // This used to run while the ATTACK card was being built, before Roll
    // Damage was pressed — offering "halve 14 to 7" for dice nobody had seen
    // thrown. Johnny, 2026-08-26: "The dice didn't even roll yet... It's going
    // to have to be AFTER the guy rolls the damage. That's where the hook has
    // to go."
    //
    // Here the tumble has landed and the number is visible, so the rogue is
    // deciding about damage everyone can see — the way it happens at a table.
    //
    // ⚠️ AND THE HALVING IS RECORDED, NOT SMUGGLED IN. The card used to show
    // the original component breakdown against the halved total, so it
    // contradicted itself: "7 +5 STR +1 =" and then "6 slashing". Seven plus
    // five plus one is thirteen. Each target now carries what it was and what it
    // became, and the card says which reaction did it.
    try {
      const reactionEng = game.aceQol?.reactionEngine;
      if (!reactionEng?.checkPreDamageReactions) {
        // ⚠️ NOT SILENT. This exact guard was false for months because the
        // engine was never published on the API, and because it said nothing
        // the missing feature looked identical to a feature choosing not to
        // fire. tools/api-published-check.py now fails the build on that
        // cause; this says so out loud if it ever happens again.
        console.warn(`${MODULE_ID} | no post-roll reactions this card: the reaction `
          + `engine is ${reactionEng ? "published but has no checkPreDamageReactions" : "not on game.aceQol"}. `
          + `Uncanny Dodge and Absorb Elements cannot be offered.`);
      } else {
        for (const dr of damageResults) {
          // ⚠️🔴 THIS SKIP USED TO BE SILENT, AND IT COST A TEST RUN.
          // Written 20 minutes before it failed: if either lookup came back
          // empty the loop just moved on, so Jeth was offered nothing and the
          // console said nothing about why. A skip that explains itself is the
          // whole lesson of tonight, and I wrote a new one anyway.
          const tActor = dr.targetActor?.documentName === "Actor" ? dr.targetActor : null;
          // ⚠️ TRY BOTH IDS. The pre-roll stores `tokenId` (the placeable) and
          // `tokenDocId` (the document); on an unlinked token they are not
          // always the same object, and the canvas is keyed by the document id.
          const tToken = canvas?.tokens?.get?.(dr.targetToken?.document?.id)
                      ?? canvas?.tokens?.get?.(dr.targetToken?.id)
                      ?? (tActor ? tActor.getActiveTokens?.(false, false)?.[0] : null)
                      ?? null;
          if (!tActor || !tToken) {
            console.warn(`${MODULE_ID} | no post-roll reaction offered to `
              + `"${dr.target?.name ?? "a target"}": `
              + `${!tActor ? "the target actor could not be resolved" : "its token is not on this canvas"} `
              + `(actor=${dr.targetActor?.id ?? "?"}, tokenDoc=${dr.targetToken?.document?.id ?? "?"}, `
              + `token=${dr.targetToken?.id ?? "?"}). Uncanny Dodge and Absorb Elements `
              + `cannot be offered without both.`);
            continue;
          }

          const before = dr.components.reduce((sum, c) => sum + (c.total ?? c.raw ?? 0), 0);
          const res = await reactionEng.checkPreDamageReactions(
            dr.components, tActor, tToken, actor, fakeItem, dr);

          if (!res) {
            console.warn(`${MODULE_ID} | the reaction check returned nothing for `
              + `"${dr.target?.name ?? "a target"}" — taking full damage.`);
            continue;
          }
          // A plain decline is already explained by the engine, which states
          // the reason for every refusal. Nothing to add here.
          if (!res.uncannyDodged) continue;
          dr.components = res.modifiedComponents;
          const after = dr.components.reduce((sum, c) => sum + (c.total ?? c.raw ?? 0), 0);
          // What the card needs to tell the truth about the sum.
          dr.reactionApplied = { label: "Uncanny Dodge", from: before, to: after };
          dr.totalFinal = after;
          console.log(`${MODULE_ID} | Uncanny Dodge applied after the roll: `
            + `${dr.target?.name} takes ${after} instead of ${before}.`);
        }
      }
    } catch (err) {
      // ⚠️ NEVER LOSE THE CARD OVER A REACTION. The damage is real and the
      // dice are on screen; a failed prompt must not swallow the result.
      console.error(`${MODULE_ID} | the post-roll reaction pass failed — `
        + `the card posts with FULL damage:`, err);
    }

    // ── Post the damage card AFTER dice finish rolling ──
    // Carry refund state forward: damage card links back to the button card,
    // and inherits any rider refunds the GM already performed on the button card.
    const refundLink = {
      sourceMsgId: message.id,
      alreadyRefunded: message.flags?.[MODULE_ID]?.refundedRiders ?? [],
    };
    try {
      await DamageCardRenderer.postDamageCard(fakeItem, actor, damageResults, critRule, flags.consumedRiders, refundLink, flags?.activityId ?? null);
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
  static buildTargetRowHtml({ tokenDocId, actorId, sceneId, name, img, currentHP, maxHP, totalFinal, isCrit, components, reactionApplied = null }) {
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
        // ⚠️ NO INLINE COLOUR HERE. These badges used to be painted with the
        // DAMAGE TYPE's colour, which silently beat the class that styles them:
        // necrotic is #ce93d8, a light purple, and the resist chip is orange, so
        // the label came out light-purple-on-orange at about 1.2:1 contrast.
        // Johnny, 2026-08-23: "I can barely read that on that orange background."
        // The badge says what HAPPENED (immune / resist / vulnerable) and gets a
        // fixed semantic colour; the damage TYPE is already coloured on the
        // number and the word right beside it. Colouring both was the bug.
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-immune ace-qol-dmg-truth-only">IMMUNE</span>`;
        strikeStyle = `text-decoration: line-through; text-decoration-color: ${color}; opacity: 0.6;`;
        rowClasses = " ace-qol-dmg-truth-row";
        if (!flavorTrigger.immune) flavorTrigger.immune = c.type;
      } else if (c.modifier === "resistant") {
        // Truth-only badge — players see the halved number but no "RESIST" label
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-resist ace-qol-dmg-truth-only">½ RESIST</span>`;
        if (!flavorTrigger.resistant) flavorTrigger.resistant = c.type;
      } else if (c.modifier === "vulnerable") {
        // Truth-only badge — players see the doubled number but no "VULN" label
        modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-vuln ace-qol-dmg-truth-only">×2 VULN</span>`;
        if (!flavorTrigger.vulnerable) flavorTrigger.vulnerable = c.type;
      }

      // Show the raw→final transition only for GM (it leaks the modifier);
      // players see only the final number, no strikethrough hint.
      const rawFinalSpan = (c.raw !== c.final && c.modifier !== "normal")
        ? `<span class="ace-qol-dmg-truth-only ace-qol-dmg-raw-was">${c.raw}</span> `
        : "";
      const dmgDisplay = `${rawFinalSpan}<strong class="ace-qol-dmg-final" style="color:${color}">${c.final}</strong>`;
      const clickable = c.final > 0 ? `data-action="aceQolApplyType" data-damage-type="${c.type}" data-damage-amount="${c.final}" data-comp-index="${idx}" title="Click to apply ${c.final} ${c.type} damage"` : "";
      const clickClass = c.final > 0 ? " ace-qol-dmg-type-clickable" : "";
      // ⚠️ WRAPPED ROWS, NEVER A SQUEEZED COLUMN. This was one flex row with no
      // wrap, so when the RESIST chip refused to shrink the only thing left that
      // could give was the text — and Foundry's chat CSS chops mid-word. Johnny
      // watched "necrotic" become "nec / roti / c" and a struck-through 10
      // become a 1 stacked on a 0 (2026-08-23). Vertical space in the chat log
      // is free; nothing here is ever allowed to be chopped to fit a width.
      // The chip now gets its OWN row, by his instruction, not by accident.
      return `
        <div class="ace-qol-dmg-type-line${clickClass}${rowClasses}" ${clickable} style="${strikeStyle}">
          <div class="ace-qol-dmg-type-main">
            ${dmgDisplay} <span class="ace-qol-dmg-type-name" style="color:${color}">${c.type}</span>
          </div>
          ${modBadge ? `<div class="ace-qol-dmg-mod-row">${modBadge}</div>` : ""}
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
          <!-- ⚠️ ORDER IS JOHNNY'S, 2026-08-14, AND IT IS THE RIGHT ONE.
               Multipliers and the resulting damage share the top line — they are
               one thought ("how much is this going to be?"). The HP readout sits
               UNDERNEATH on its own line, because it is the consequence and it
               is the longest item. Previously HP shared the top line and got
               pushed off the right edge of the chat log, so the GM could read
               "HP: 163 →" and not the number that actually mattered. -->
          <div class="ace-qol-dmg-ovr-line">
            <button class="ace-qol-dmg-ovr-x" data-action="aceQolDmgRemove" data-token-doc-id="${tDocId}">×</button>
            <button class="ace-qol-dmg-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="0.25">¼</button>
            <button class="ace-qol-dmg-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="0.5">½</button>
            <button class="ace-qol-dmg-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="1">1</button>
            <button class="ace-qol-dmg-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${tDocId}" data-multiplier="2">2</button>
            <span class="ace-qol-dmg-row-dmg">${totalFinal}<span class="ace-qol-dmg-unit">DMG</span></span>
            ${isDead ? '<span class="ace-qol-dmg-skull">☠</span>' : ''}
          </div>
          ${reactionApplied ? `
          <div class="ace-qol-dmg-reaction-line">
            <i class="fas fa-person-running"></i>
            <span><strong>${reactionApplied.label}</strong> — ${reactionApplied.from} halved to ${reactionApplied.to}</span>
          </div>` : ""}
          <div class="ace-qol-dmg-hp-line">
            <span class="ace-qol-dmg-row-hp">HP: <span class="ace-qol-hp-cur">${currentHP}</span> → <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span><span class="ace-qol-hp-max">/${maxHP}</span></span>
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
