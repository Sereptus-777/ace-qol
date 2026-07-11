// ─── ACE: QOL — Merge Card Display ────────────────────────────────────────────
// Optional combined chat card that shows attack + damage + saves + effects
// all in one message instead of separate cards.
//
// When enabled (enableMergeCard setting), the attack pipeline suppresses its
// normal attack card and stores the result. When damage is calculated, this
// module builds a single merged card containing both sections.
//
// All existing button handlers (APPLY ALL, UNDO ALL, per-target overrides,
// per-type click) still work — the merge card reuses DamageEngine's wiring.
//
// Integration points:
//   - AttackPipeline._postAttackResults() → suppressed, result stored
//   - DamageEngine._postDamageCard() → replaced with merge card
//   - DamageEngine._postDamageButton() → replaced with merge card (PC path)
//   - renderChatMessage hook → wires buttons (reuses DamageEngine's handler)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { DamageConstants } from "./damage-engine.mjs";

export class MergeCard {

  // ═══════════════════════════════════════════════════════════════════════════
  //  State — Stores attack results between attack and damage phases
  // ═══════════════════════════════════════════════════════════════════════════

  /** @type {object|null} Cached attack data from _postAttackResults */
  static _pendingAttack = null;

  /**
   * Check if merge card mode is currently active.
   * @returns {boolean}
   */
  static get isEnabled() {
    try {
      return QolSettings.get("enableMergeCard");
    } catch {
      return false;
    }
  }

  /**
   * Store attack results for the upcoming damage phase.
   * Called by AttackPipeline._postAttackResults when merge mode is on.
   *
   * @param {object} attackData - { item, actor, results, roll, opts }
   */
  static storeAttackResult(attackData) {
    MergeCard._pendingAttack = attackData;
    console.log(`${MODULE_ID} | MergeCard: stored attack result for ${attackData.item?.name} (${attackData.results?.length} targets)`);
  }

  /**
   * Consume and return the stored attack data, clearing the cache.
   * @returns {object|null}
   */
  static consumeAttackResult() {
    const data = MergeCard._pendingAttack;
    MergeCard._pendingAttack = null;
    return data;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build Merged Attack + Damage Card (NPC path — immediate damage)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a combined attack + damage card for NPC attacks (immediate roll).
   * This replaces both the attack card and the damage card with one message.
   *
   * @param {object} attackData - Stored attack phase data
   * @param {Item5e} item - The weapon/spell item
   * @param {Actor5e} actor - The attacking actor
   * @param {object[]} damageResults - Per-target damage results from DamageEngine
   * @param {string} critRule - Active crit rule setting
   * @returns {string} HTML content for the merged card
   */
  static buildMergeCard(attackData, item, actor, damageResults, critRule) {
    const isDetailed = MergeCard._getStyle() === "detailed";
    const showAtkFormula = MergeCard._showAttackFormula();
    const showDmgFormula = MergeCard._showDamageFormula();

    // ── Header ──
    const headerHtml = MergeCard._buildHeader(item, actor, attackData);

    // ── Attack roll section ──
    const attackHtml = MergeCard._buildAttackSection(attackData, showAtkFormula);

    // ── Damage formula section (shared roll display) ──
    const damageFormulaHtml = showDmgFormula
      ? MergeCard._buildDamageFormulaSection(damageResults, item)
      : "";

    // ── Per-target results (combined hit/miss + damage) ──
    const targetsHtml = MergeCard._buildTargetSection(attackData, damageResults);

    // ── Control buttons ──
    const hasCleave = actor ? DamageConstants.actorHasCleave(actor, item) : false;
    const controlsHtml = MergeCard._buildControls(hasCleave);

    const critRuleLabel = { doubleDice: "Double Dice", maxPlusRoll: "Max + Roll", maxAll: "Max All" }[critRule] ?? critRule;
    const anyCrit = damageResults.some(dr => dr.isCrit);

    return `
      <div class="ace-qol-merge-card ace-qol-damage-card">
        ${headerHtml}
        ${attackHtml}
        ${damageFormulaHtml}
        <div class="ace-qol-merge-targets ace-qol-dmg-targets">
          ${targetsHtml}
        </div>
        <div class="ace-qol-dmg-gm-controls">
          ${controlsHtml}
        </div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build Merged Attack + Damage Button Card (PC path — deferred roll)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a combined attack + "ROLL DAMAGE" button card for PC attacks.
   * Shows the attack roll results with a damage button below.
   *
   * @param {object} attackData - Stored attack phase data
   * @param {Item5e} item - The weapon/spell item
   * @param {Actor5e} actor - The attacking actor
   * @param {boolean} anyCrit - Whether any target was critically hit
   * @param {string} targetNames - Comma-separated target names
   * @returns {string} HTML content for the merged card
   */
  static buildMergeDamageButton(attackData, item, actor, anyCrit, targetNames) {
    const showAtkFormula = MergeCard._showAttackFormula();

    // ── Header ──
    const headerHtml = MergeCard._buildHeader(item, actor, attackData);

    // ── Attack roll section ──
    const attackHtml = MergeCard._buildAttackSection(attackData, showAtkFormula);

    // ── Target hit/miss results (no damage yet) ──
    const targetRows = (attackData?.results ?? []).map(r => {
      const hitClass = r.hitResult === "critical" ? "ace-qol-merge-hit ace-qol-merge-crit"
                     : r.hitResult === "hit" ? "ace-qol-merge-hit"
                     : r.hitResult === "fumble" ? "ace-qol-merge-miss ace-qol-merge-fumble"
                     : "ace-qol-merge-miss";

      const hitLabel = r.hitResult === "critical" ? "CRIT!"
                     : r.hitResult === "hit" ? "HIT"
                     : r.hitResult === "fumble" ? "FUMBLE"
                     : "MISS";

      // ── Mirror Image redirect caption ──
      // When an attack was absorbed by a Mirror Image duplicate, the target row
      // shows MISS — but without context the attacker sees "21 vs AC 13 = MISS"
      // and is confused why. Inject a small caption explaining the redirect.
      let mirrorCaption = "";
      if (r.mirrorImageRedirect) {
        const mi = r.mirrorImageRedirect;
        // i18n: see languages/en.json — key:redirectHitDestroyed / redirectHitDodged
        const key = mi.hitDuplicate
          ? "ACE_QOL.mirrorImage.redirectHitDestroyed"
          : "ACE_QOL.mirrorImage.redirectHitDodged";
        const outcome = game.i18n?.format?.(key, { ac: mi.duplicateAC })
                     ?? (mi.hitDuplicate
                         ? `Hit Mirror Image duplicate (AC ${mi.duplicateAC}) — duplicate destroyed`
                         : `Hit Mirror Image duplicate (AC ${mi.duplicateAC}) — duplicate dodged`);
        mirrorCaption = `<div class="ace-qol-merge-tgt-caption ace-qol-merge-mirror-caption">→ ${outcome}</div>`;
      }

      return `
        <div class="ace-qol-merge-target-row ${hitClass}">
          <img src="${r.img || "icons/svg/mystery-man.svg"}" class="ace-qol-merge-tgt-img" />
          <span class="ace-qol-merge-tgt-name">${r.name ?? "Unknown"}</span>
          <span class="ace-qol-merge-tgt-ac">AC ${r.ac}</span>
          <span class="ace-qol-merge-tgt-result">${hitLabel}</span>
        </div>
        ${mirrorCaption}
      `;
    }).join("");

    // ── Roll Damage button ──
    const btnHtml = `
      <div class="ace-qol-merge-dmg-btn-section">
        <button class="ace-qol-btn ace-qol-btn-roll-dmg" data-action="aceQolRollDamage">
          <i class="fas fa-burst"></i>
          ROLL DAMAGE${anyCrit ? ' <span class="ace-qol-dmg-btn-crit">CRIT!</span>' : ""}
        </button>
        <span class="ace-qol-dmg-btn-targets">${targetNames}</span>
      </div>
    `;

    return `
      <div class="ace-qol-merge-card">
        ${headerHtml}
        ${attackHtml}
        <div class="ace-qol-merge-hitmiss-targets">
          ${targetRows}
        </div>
        ${btnHtml}
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Section Builders
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the card header with item icon, name, and attacker.
   */
  static _buildHeader(item, actor, attackData) {
    const rollMode = attackData?.results?.[0]?.finalRollMode;
    const rollModeLabel = rollMode === "advantage"
      ? '<span class="ace-qol-roll-mode ace-qol-adv">ADV</span>'
      : rollMode === "disadvantage"
      ? '<span class="ace-qol-roll-mode ace-qol-disadv">DISADV</span>'
      : "";

    return `
      <div class="ace-qol-merge-header">
        <img src="${item.img || "icons/svg/sword.svg"}" class="ace-qol-merge-item-img" />
        <div class="ace-qol-merge-header-text">
          <strong class="ace-qol-merge-item-name">${item.name}</strong>
          <span class="ace-qol-merge-attacker">${actor?.name ?? ""}</span>
        </div>
        ${rollModeLabel}
      </div>
    `;
  }

  /**
   * Build the attack roll display section (d20 + formula + total).
   */
  static _buildAttackSection(attackData, showFormula) {
    if (!attackData?.results?.length) return "";

    const r0 = attackData.results[0];
    const d20 = r0.d20Result;
    const total = r0.attackTotal;

    // ── D20 image ──
    const bd20Path = `modules/ace-qol/Assets/Dice%20Dice/BD20/BD20-${d20}_nobg.png`;
    const d20Html = `
      <span class="ace-qol-mod-die">
        <img class="ace-qol-atk-d20-img" src="${bd20Path}" alt="d20"
             onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
        <i class="fas fa-dice-d20 ace-qol-atk-d20-fallback" style="display:none"></i>
        <span class="ace-qol-atk-d20-result">${d20}</span>
      </span>
    `;

    // ── Formula breakdown (if enabled) ──
    let formulaHtml = d20Html;
    if (showFormula && attackData.formulaParts) {
      // Use pre-built formula parts from the attack pipeline
      formulaHtml = attackData.formulaParts;
    }

    // ── Hit result class for big number ──
    const anyHit = attackData.results.some(r => r.hitResult === "hit" || r.hitResult === "critical");
    const anyCrit = attackData.results.some(r => r.hitResult === "critical");
    const resultClass = anyCrit ? "ace-qol-result-crit"
                      : anyHit ? "ace-qol-result-hit"
                      : "ace-qol-result-miss";

    return `
      <div class="ace-qol-merge-attack">
        <div class="ace-qol-atk-roll">
          <span class="ace-qol-atk-formula">${formulaHtml}</span>
          <span class="ace-qol-atk-total ${resultClass}">${total}</span>
        </div>
      </div>
    `;
  }

  /**
   * Build the damage formula display (dice + type totals).
   * Reuses the same layout as the standalone damage card.
   */
  static _buildDamageFormulaSection(damageResults, item = null) {
    if (!damageResults?.length) return "";

    const first = damageResults[0];
    const itemName = item?.name ?? null;
    const formulaRows = (first.components ?? []).map(c => {
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
      const critDisplay = c.isCrit
        ? `<span class="ace-qol-dmg-crit-label">${c.normalTotal !== undefined ? `MAX ${c.normalTotal}` : "CRIT"}</span> + `
        : "";

      const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
      const typeTotal = `<span class="ace-qol-dmg-equals">=</span> <span class="ace-qol-dmg-type-total" style="color:${color}"><span class="ace-qol-dmg-type-num">${c.final}</span> ${c.type}</span>`;

      // ── Rider source caption (v0.7.15) — same as postDamageCard path ──
      // Riders / bonuses (Searing Smite, Divine Smite, Hex, etc.) get a
      // small label beneath the row. The weapon base row stays uncaptioned.
      const isWeaponBase = itemName && c.name === itemName;
      const sourceCaption = (!isWeaponBase && c.name && c.name !== "Bonus")
        ? `<div class="ace-qol-dmg-source-caption" style="color:${color};">${c.name}</div>`
        : "";

      // Inline-flow layout: dice → mods → "= total type" all on one wrapping row
      return `<div class="ace-qol-dmg-component ace-qol-dmg-row">`
        + `${critDisplay}${dieDisplay}${modDisplay}${typeTotal}`
        + `${sourceCaption}`
        + `</div>`;
    }).join("");

    return `
      <div class="ace-qol-merge-damage-formula ace-qol-dmg-roll-section">
        <div class="ace-qol-dmg-components">${formulaRows}</div>
      </div>
    `;
  }

  /**
   * Build the per-target section with combined hit/miss + damage info.
   * For targets that were hit, shows per-type damage breakdown + overrides.
   * For targets that missed, shows just the MISS badge.
   */
  static _buildTargetSection(attackData, damageResults) {
    const attackResults = attackData?.results ?? [];

    // Build a map of tokenDocId → damageResult for quick lookup
    const dmgMap = new Map();
    for (const dr of (damageResults ?? [])) {
      const key = dr.targetToken?.document?.id ?? dr.targetToken?.id;
      if (key) dmgMap.set(key, dr);
    }

    return attackResults.map(atkResult => {
      const tokenDocId = atkResult.targetToken?.document?.id ?? atkResult.targetToken?.id ?? "unknown";
      const isHit = atkResult.hitResult === "hit" || atkResult.hitResult === "critical";
      const isCrit = atkResult.hitResult === "critical";
      const isFumble = atkResult.hitResult === "fumble";

      // Hit/miss badge
      const hitClass = isCrit ? "ace-qol-crit"
                     : isHit ? "ace-qol-hit"
                     : isFumble ? "ace-qol-fumble"
                     : "ace-qol-miss";
      const hitLabel = isCrit ? "CRIT!"
                     : isHit ? "HIT"
                     : isFumble ? "FUMBLE"
                     : "MISS";

      // ── Miss / Fumble row (no damage) ──
      if (!isHit) {
        // Mirror Image redirect explanation — same caption as the early hit-card path
        let mirrorCaption = "";
        if (atkResult.mirrorImageRedirect) {
          const mi = atkResult.mirrorImageRedirect;
          // i18n: see languages/en.json — key:redirectHitDestroyed / redirectHitDodged
          const key = mi.hitDuplicate
            ? "ACE_QOL.mirrorImage.redirectHitDestroyed"
            : "ACE_QOL.mirrorImage.redirectHitDodged";
          const outcome = game.i18n?.format?.(key, { ac: mi.duplicateAC })
                       ?? (mi.hitDuplicate
                           ? `Hit Mirror Image duplicate (AC ${mi.duplicateAC}) — duplicate destroyed`
                           : `Hit Mirror Image duplicate (AC ${mi.duplicateAC}) — duplicate dodged`);
          mirrorCaption = `<div class="ace-qol-merge-tgt-caption ace-qol-merge-mirror-caption">→ ${outcome}</div>`;
        }
        return `
          <div class="ace-qol-merge-combined-row ace-qol-merge-row-miss">
            <div class="ace-qol-merge-row-header">
              <img src="${atkResult.img || "icons/svg/mystery-man.svg"}" class="ace-qol-dmg-tgt-img" />
              <span class="ace-qol-dmg-tgt-name">${atkResult.name ?? "Unknown"}</span>
              <span class="ace-qol-atk-ac">AC ${atkResult.ac}</span>
              <span class="ace-qol-atk-result ${hitClass}">${hitLabel}</span>
            </div>
            ${mirrorCaption}
          </div>
        `;
      }

      // ── Hit row — show damage using DamageEngine's target row builder ──
      const dr = dmgMap.get(tokenDocId);
      if (!dr) {
        // Damage not calculated yet (shouldn't happen for NPC merge cards)
        return `
          <div class="ace-qol-merge-combined-row">
            <div class="ace-qol-merge-row-header">
              <img src="${atkResult.img || "icons/svg/mystery-man.svg"}" class="ace-qol-dmg-tgt-img" />
              <span class="ace-qol-dmg-tgt-name">${atkResult.name ?? "Unknown"}</span>
              <span class="ace-qol-atk-ac">AC ${atkResult.ac}</span>
              <span class="ace-qol-atk-result ${hitClass}">${hitLabel}</span>
            </div>
          </div>
        `;
      }

      // Build the full damage target row (per-type breakdown, overrides, HP)
      // We reuse DamageEngine's _buildTargetRowHtml format inline
      const portrait = dr.target?.img || "icons/svg/mystery-man.svg";
      const currentHP = dr.target?.currentHP ?? 0;
      const maxHP = dr.target?.maxHP ?? 0;
      const totalFinal = dr.totalFinal ?? 0;
      const newHP = Math.max(0, currentHP - totalFinal);
      const isDead = newHP <= 0;

      // Per-component type breakdown lines
      const compLines = (dr.components ?? []).map((c, idx) => {
        const color = DamageConstants.DAMAGE_COLORS[c.type] ?? "#ccc";
        let modBadge = "";
        let strikeStyle = "";
        if (c.modifier === "immune") {
          modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-immune" style="background:${color}; color:#000">IMMUNE</span>`;
          strikeStyle = `text-decoration: line-through; text-decoration-color: ${color}; opacity: 0.6;`;
        } else if (c.modifier === "resistant") {
          modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-resist" style="border-color:${color}; color:${color}">&#189; RESIST</span>`;
        } else if (c.modifier === "vulnerable") {
          modBadge = `<span class="ace-qol-dmg-mod ace-qol-dmg-vuln">&times;2 VULN</span>`;
        }
        const dmgDisplay = (c.raw !== c.final && c.modifier !== "normal")
          ? `<span style="color:#666; text-decoration:line-through; font-size:0.75rem">${c.raw}</span> <strong style="color:${color}">${c.final}</strong>`
          : `<strong style="color:${color}">${c.final}</strong>`;
        const clickable = c.final > 0
          ? `data-action="aceQolApplyType" data-damage-type="${c.type}" data-damage-amount="${c.final}" data-comp-index="${idx}" title="Click to apply ${c.final} ${c.type} damage"`
          : "";
        const clickClass = c.final > 0 ? " ace-qol-dmg-type-clickable" : "";
        return `
          <div class="ace-qol-dmg-type-line${clickClass}" ${clickable} style="${strikeStyle}">
            ${dmgDisplay} <span style="color:${color}; font-weight:600">${c.type}</span> ${modBadge}
          </div>
        `;
      }).join("");

      const _a = (mult) => (mult === 1) ? " ace-qol-dmg-ovr-active" : "";

      return `
        <div class="ace-qol-dmg-target-row ace-qol-merge-combined-row" data-token-doc-id="${tokenDocId}" data-actor-id="${dr.targetActor?.id ?? ""}" data-scene-id="${canvas.scene?.id ?? ""}">
          <div class="ace-qol-merge-row-header">
            <img src="${portrait}" class="ace-qol-dmg-tgt-img" />
            <span class="ace-qol-dmg-tgt-name">${atkResult.name ?? "Unknown"}</span>
            <span class="ace-qol-atk-ac">AC ${atkResult.ac}</span>
            <span class="ace-qol-atk-result ${hitClass}">${hitLabel}</span>
            ${isCrit ? '<span class="ace-qol-dmg-crit-badge">CRIT</span>' : ""}
          </div>
          ${compLines ? `<div class="ace-qol-dmg-type-breakdown">${compLines}</div>` : ""}
          <div class="ace-qol-dmg-gm-controls">
            <div class="ace-qol-dmg-hp-line">
              <span class="ace-qol-dmg-row-dmg">${totalFinal}</span>
              ${isDead ? '<span class="ace-qol-dmg-skull">&#9760;</span>' : ''}
              <span class="ace-qol-dmg-row-hp">HP: <span class="ace-qol-hp-cur">${currentHP}</span> &rarr; <span class="ace-qol-hp-new${isDead ? ' ace-qol-hp-dead' : ''}">${newHP}</span><span class="ace-qol-hp-max">/${maxHP}</span></span>
            </div>
            <div class="ace-qol-dmg-ovr-line">
              <button class="ace-qol-dmg-ovr-x" data-action="aceQolDmgRemove" data-token-doc-id="${tokenDocId}">&times;</button>
              <button class="ace-qol-dmg-ovr${_a(0.25)}" data-action="aceQolDmgOverride" data-token-doc-id="${tokenDocId}" data-multiplier="0.25">&frac14;</button>
              <button class="ace-qol-dmg-ovr${_a(0.5)}" data-action="aceQolDmgOverride" data-token-doc-id="${tokenDocId}" data-multiplier="0.5">&frac12;</button>
              <button class="ace-qol-dmg-ovr${_a(1)}" data-action="aceQolDmgOverride" data-token-doc-id="${tokenDocId}" data-multiplier="1">1</button>
              <button class="ace-qol-dmg-ovr${_a(2)}" data-action="aceQolDmgOverride" data-token-doc-id="${tokenDocId}" data-multiplier="2">2</button>
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  /**
   * Build the control buttons section (CLEAVE, APPLY ALL, UNDO ALL).
   */
  static _buildControls(hasCleave) {
    return `
      <div class="ace-qol-dmg-actions">
        ${hasCleave ? `<button class="ace-qol-btn ace-qol-btn-cleave" data-action="aceQolCleave">
          <i class="fas fa-khanda"></i> CLEAVE
        </button>` : ""}
        <button class="ace-qol-btn ace-qol-btn-apply" data-action="aceQolApplyDamage">
          <i class="fas fa-heart-crack"></i> APPLY ALL
        </button>
        <button class="ace-qol-btn ace-qol-btn-undo" data-action="aceQolUndoDamage" disabled>
          <i class="fas fa-undo"></i> UNDO ALL
        </button>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post Merged Card to Chat
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post the merged NPC damage card (attack + damage in one).
   * Called from DamageEngine._onAttackComplete when merge mode is on.
   *
   * @param {object} attackData - Stored attack phase data
   * @param {Item5e} item - The weapon/spell item
   * @param {Actor5e} actor - The attacking actor
   * @param {object[]} damageResults - Per-target damage results
   * @param {string} critRule - Active crit rule
   */
  static async postMergedDamageCard(attackData, item, actor, damageResults, critRule) {
    const cardHtml = MergeCard.buildMergeCard(attackData, item, actor, damageResults, critRule);
    const firstResult = damageResults[0];
    const rawComponents = firstResult?.components?.map(c => ({
      name: c.name, type: c.type, raw: c.raw, formula: c.formula,
    })) ?? [];

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "damageResult",
          mergeCard: true,
          itemUuid: item.uuid,
          actorId: actor.id,
          rawComponents,
          totalRaw: firstResult?.totalRaw ?? 0,
          damageResults: damageResults.map(dr => ({
            targetId: dr.targetActor?.id,
            tokenId: dr.targetToken?.id,
            tokenDocId: dr.targetToken?.document?.id ?? dr.targetToken?.id,
            sceneId: canvas.scene?.id,
            isLinked: dr.targetActor?.prototypeToken?.actorLink ?? dr.targetToken?.document?.actorLink ?? false,
            totalFinal: dr.totalFinal,
            currentHP: dr.target?.currentHP,
            maxHP: dr.target?.maxHP,
            name: dr.target?.name,
            img: dr.target?.img,
            components: dr.components?.map(c => ({
              name: c.name, type: c.type, raw: c.raw, final: c.final, modifier: c.modifier,
            })),
          })),
          // Store attack data in flags for reference
          attackData: {
            d20Result: attackData?.results?.[0]?.d20Result,
            attackTotal: attackData?.results?.[0]?.attackTotal,
            hitResults: attackData?.results?.map(r => ({
              name: r.name, hitResult: r.hitResult, ac: r.ac,
            })),
          },
        }
      }
    });
  }

  /**
   * Post the merged PC card (attack + ROLL DAMAGE button in one).
   * Called from DamageEngine._onAttackComplete (PC path) when merge mode is on.
   *
   * @param {object} attackData - Stored attack phase data
   * @param {Item5e} item - The weapon/spell item
   * @param {Actor5e} actor - The attacking actor
   * @param {object[]} hits - Hit results from attack pipeline
   * @param {object[]} preRolled - Pre-rolled damage data
   * @param {string} critRule - Active crit rule
   * @param {object|null} parsedDescription - Pre-parsed item description
   */
  static async postMergedDamageButton(attackData, item, actor, hits, preRolled, critRule, parsedDescription, consumedRiders = []) {
    const anyCrit = hits.some(h => h.hitResult === "critical");
    const targetNames = hits.map(h => h.name ?? h.target?.name ?? "target").join(", ");

    const cardHtml = MergeCard.buildMergeDamageButton(attackData, item, actor, anyCrit, targetNames);

    await ChatMessage.create({
      content: cardHtml,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          type: "damageButton",
          mergeCard: true,
          itemId: item.id,
          itemUuid: item.uuid,
          itemName: item.name,
          itemImg: item.img || "icons/svg/sword.svg",
          actorId: actor.id,
          // Player who owns the attacking creature rolls its own damage (companions,
          // summons, wild-shapes); GM applies. Computed GM-side (2026-07-11).
          attackerOwnerUserIds: game.users.filter(u => !u.isGM && actor.testUserPermission?.(u, "OWNER")).map(u => u.id),
          critRule,
          preRolled,
          parsedDescription,
          consumedRiders: consumedRiders?.length ? consumedRiders : undefined,
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Settings Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  static _getStyle() {
    try { return QolSettings.get("mergeCardStyle"); }
    catch (err) { console.warn("ace-qol | MergeCard._getStyle setting read failed:", err); return "detailed"; }
  }

  static _showAttackFormula() {
    try { return QolSettings.get("showAttackFormula"); }
    catch (err) { console.warn("ace-qol | MergeCard._showAttackFormula setting read failed:", err); return true; }
  }

  static _showDamageFormula() {
    try { return QolSettings.get("showDamageFormula"); }
    catch (err) { console.warn("ace-qol | MergeCard._showDamageFormula setting read failed:", err); return true; }
  }
}
