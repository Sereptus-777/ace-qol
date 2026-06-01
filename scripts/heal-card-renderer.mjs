// ─── ACE: QOL — Heal Card Renderer ───────────────────────────────────────────
// HTML chat card for heal activity results. Mirrors the attack card aesthetic:
//   - Item icon + name header with HEAL tag
//   - Big roll formula chip (dice + bonus breakdown)
//   - One row per target with portrait, current → projected HP bar, Apply button
//
// Apply button calls `_applyHeal` which:
//   - Updates actor's HP (regular or temp depending on classification)
//   - Caps at max HP (RAW: heal can't exceed max; temp HP doesn't stack)
//   - Marks the row "applied" so it can't be double-applied
//   - Posts a small confirm message
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class HealCardRenderer {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Build Card HTML
  // ═══════════════════════════════════════════════════════════════════════════

  static buildCard({ item, actor, roll, targetData, classification }) {
    const headerHtml = HealCardRenderer._buildHeader(item, classification);
    const formulaHtml = HealCardRenderer._buildFormula(roll, classification);
    const targetsHtml = HealCardRenderer._buildTargets(targetData, classification);
    const applyAllHtml = (targetData?.length ?? 0) > 1
      ? `<div class="ace-qol-heal-card-applyall-row">
           <button class="ace-qol-heal-card-applyall" data-action="applyAll">
             <i class="fas fa-staff-snake"></i> Apply to All
           </button>
         </div>`
      : "";

    return `
      <div class="ace-qol-heal-card" data-actor-uuid="${actor.uuid}">
        ${headerHtml}
        ${formulaHtml}
        <div class="ace-qol-heal-card-targets">
          ${targetsHtml}
        </div>
        ${applyAllHtml}
      </div>
    `;
  }

  static _buildHeader(item, classification) {
    const tag = classification.isTempHP ? "TEMP HP" : "HEAL";
    const tagClass = classification.isTempHP ? "ace-qol-heal-card-tag-temp" : "ace-qol-heal-card-tag-hp";
    return `
      <div class="ace-qol-heal-card-header">
        <img class="ace-qol-heal-card-icon" src="${item.img}" alt="" onerror="this.style.display='none'">
        <div class="ace-qol-heal-card-titles">
          <span class="ace-qol-heal-card-title">${foundry.utils.escapeHTML(item.name)}</span>
          <span class="ace-qol-heal-card-tag ${tagClass}">${tag}</span>
        </div>
      </div>
    `;
  }

  /**
   * Render the dice + bonus breakdown chip using the same PNG dice graphics
   * the attack card uses. We pull from `Assets/Dice Dice/Dice Images/Green/`
   * for healing (green = heal), or `Blue` for temp HP.
   *
   * Path format: modules/ace-qol/Assets/Dice%20Dice/Dice%20Images/{color}/d{N}/{N}-{result}_nobg.png
   * Supported: d4, d6, d8, d10, d12, d20, d100. Anything else falls back to FA.
   */
  static _buildFormula(roll, classification) {
    const total = roll.total ?? 0;
    const formula = roll.formula ?? "";
    const color = classification.isTempHP ? "Blue" : "Green";

    // Pull the rolled dice for visual display
    const diceParts = [];
    for (const term of (roll.terms ?? [])) {
      if (term.faces && Array.isArray(term.results)) {
        for (const r of term.results) {
          diceParts.push(HealCardRenderer._renderDieGraphic(term.faces, r.result, color));
        }
      }
    }
    const diceHtml = diceParts.join(" ");

    // Compute the flat bonus (total minus all dice rolls)
    let diceTotal = 0;
    for (const term of (roll.terms ?? [])) {
      if (term.faces && Array.isArray(term.results)) {
        for (const r of term.results) diceTotal += (r.result ?? 0);
      }
    }
    const flatBonus = total - diceTotal;
    const bonusHtml = flatBonus !== 0
      ? `<span class="ace-qol-heal-card-bonus">${flatBonus >= 0 ? "+" : ""}${flatBonus}</span>`
      : "";

    return `
      <div class="ace-qol-heal-card-formula" title="${foundry.utils.escapeHTML(formula)}">
        ${diceHtml}
        ${bonusHtml}
        <span class="ace-qol-heal-card-equals">=</span>
        <span class="ace-qol-heal-card-total">${total}</span>
        <span class="ace-qol-heal-card-total-label">${classification.isTempHP ? "temp HP" : "healing"}</span>
      </div>
    `;
  }

  /**
   * Render a single die graphic with its result. Uses ace-qol's shipped PNG
   * dice (Green for healing, Blue for temp HP) when the face count is
   * supported (4, 6, 8, 10, 12, 20, 100). Falls back to FontAwesome for
   * exotic faces (d3, d2, etc.).
   */
  static _renderDieGraphic(faces, result, color) {
    const SUPPORTED = new Set([4, 6, 8, 10, 12, 20, 100]);
    if (SUPPORTED.has(faces)) {
      const path = `modules/ace-qol/Assets/Dice%20Dice/Dice%20Images/${color}/d${faces}/${faces}-${result}_nobg.png`;
      return `<span class="ace-qol-heal-card-die" data-faces="${faces}">
        <img class="ace-qol-heal-card-die-img" src="${path}" alt="d${faces}=${result}"
             onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
        <i class="fas fa-dice-d${faces} ace-qol-heal-card-die-fallback" style="display:none"></i>
      </span>`;
    }
    // Unsupported face count — fall back to FA + numeric overlay
    return `<span class="ace-qol-heal-card-die" data-faces="${faces}">
      <i class="fas fa-dice-d${faces}"></i>
      <span class="ace-qol-heal-card-die-result">${result}</span>
    </span>`;
  }

  static _buildTargets(targetData, classification) {
    if (!targetData?.length) {
      return `<div class="ace-qol-heal-card-empty">No targets selected.</div>`;
    }
    return targetData.map((t, i) => HealCardRenderer._buildTargetRow(t, i, classification)).join("");
  }

  static _buildTargetRow(t, idx, classification) {
    const before = classification.isTempHP ? t.currentTempHp : t.currentHp;
    const after  = classification.isTempHP ? t.projectedHp   : t.projectedHp;
    const max    = classification.isTempHP ? Math.max(t.maxHp, t.projectedHp) : t.maxHp;
    const beforePct = max > 0 ? Math.max(0, Math.min(100, (before / max) * 100)) : 0;
    const afterPct  = max > 0 ? Math.max(0, Math.min(100, (after  / max) * 100)) : 0;

    const appliedClass = t.applied ? "applied" : "";
    const appliedBtn = t.applied
      ? `<button class="ace-qol-heal-card-applied" disabled><i class="fas fa-check"></i> Applied</button>`
      : `<button class="ace-qol-heal-card-apply" data-target-idx="${idx}"><i class="fas fa-staff-snake"></i> Apply</button>`;

    return `
      <div class="ace-qol-heal-card-target ${appliedClass}" data-target-idx="${idx}" data-token-id="${t.tokenId}">
        <img class="ace-qol-heal-card-target-img" src="${t.img}" alt="" onerror="this.style.display='none'">
        <div class="ace-qol-heal-card-target-info">
          <div class="ace-qol-heal-card-target-name">${foundry.utils.escapeHTML(t.name)}</div>
          <div class="ace-qol-heal-card-target-hpline">
            <span class="ace-qol-heal-card-target-hp-before">${before}</span>
            <i class="fas fa-arrow-right ace-qol-heal-card-target-arrow"></i>
            <span class="ace-qol-heal-card-target-hp-after">${after}</span>
            <span class="ace-qol-heal-card-target-hp-max">/ ${max}</span>
            ${classification.isTempHP ? `<span class="ace-qol-heal-card-target-temptag">TEMP</span>` : ""}
          </div>
          <div class="ace-qol-heal-card-target-bar">
            <div class="ace-qol-heal-card-target-bar-before" style="width:${beforePct}%"></div>
            <div class="ace-qol-heal-card-target-bar-gain" style="left:${beforePct}%; width:${Math.max(0, afterPct - beforePct)}%"></div>
          </div>
        </div>
        <div class="ace-qol-heal-card-target-action">${appliedBtn}</div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Button Wiring (called from renderChatMessage hook)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync the DOM card's applied-state visuals with the current flags.targets.
   * Runs on every render of a heal card (called from the renderChatMessage
   * hook). For each target that has `applied: true`, replace its Apply
   * button with a disabled "Applied" version and add the .applied row class.
   *
   * This is the safety net against Foundry's render pipeline reverting our
   * direct DOM mutations: even if the message re-renders mid-apply with the
   * original "Apply" button HTML, this call immediately re-flips it to the
   * "Applied" state from the persisted flags. No race, no flicker.
   */
  static syncAppliedState(el, flags) {
    if (!el?.querySelectorAll) return;
    const targets = flags?.targets ?? [];
    targets.forEach((t, idx) => {
      if (!t?.applied) return;
      const row = el.querySelector(`.ace-qol-heal-card-target[data-target-idx="${idx}"]`);
      if (!row) return;
      row.classList.add("applied");
      const btn = row.querySelector(".ace-qol-heal-card-apply");
      if (btn) {
        const newBtn = document.createElement("button");
        newBtn.className = "ace-qol-heal-card-applied";
        newBtn.disabled = true;
        newBtn.innerHTML = `<i class="fas fa-check"></i> Applied`;
        btn.replaceWith(newBtn);
      }
    });

    // If ALL targets are applied, also flip the Apply All button to "All Applied"
    const allBtn = el.querySelector(".ace-qol-heal-card-applyall");
    if (allBtn && targets.length > 0 && targets.every(t => t?.applied)) {
      allBtn.disabled = true;
      allBtn.classList.add("applied");
      allBtn.innerHTML = `<i class="fas fa-check"></i> All Applied`;
    }
  }

  static wireButtons(el, message, flags) {
    if (!el?.querySelectorAll) return;

    // Per-target Apply + Apply All — GM-only.
    // Discovered during the Gemini-audit chat-card sweep: when a non-GM
    // clicked Apply, the local DOM flipped to "Applied" but the underlying
    // actor.update() and message.update() both failed silently on permission.
    // Result: player saw a confident green check, GM saw the heal NEVER
    // applied, and players asked "why isn't my Cure Wounds working?"
    // Gate the click handlers GM-only so the visual state never lies.
    // (Future enhancement: socket-route a heal-apply request through GM —
    // would let casters apply their own heals — punch-list item.)
    if (game.user.isGM) {
      el.querySelectorAll(".ace-qol-heal-card-apply").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const idx = parseInt(btn.dataset.targetIdx);
          if (!Number.isFinite(idx)) return;
          await HealCardRenderer._onApplyClick(message, idx, btn);
        });
      });

      const allBtn = el.querySelector(".ace-qol-heal-card-applyall");
      if (allBtn) {
        allBtn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          await HealCardRenderer._onApplyAll(message, el, allBtn);
        });
      }
    }
  }

  /**
   * Per-target apply. Order of operations is critical to avoid the
   * re-render race: we mutate the DOM BEFORE awaiting message.update so
   * the visual state lands first. The renderChatMessage hook's syncAppliedState
   * call then preserves it on any subsequent re-renders.
   */
  static async _onApplyClick(message, idx, btnEl) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags || flags.type !== "healCard") return;
    const targets = flags.targets ?? [];
    const t = targets[idx];
    if (!t) return;
    if (t.applied) return; // double-click guard

    // Resolve the actor
    const tokenDoc = canvas.scene?.tokens.get(t.tokenDocId)
                  ?? game.scenes.get(t.sceneId)?.tokens.get(t.tokenDocId);
    const actor = tokenDoc?.actor ?? game.actors.get(t.actorId);
    if (!actor) {
      ui.notifications.warn("Heal apply: actor not found (token may have been deleted).");
      return;
    }

    // PRE-EMPTIVE DOM update — flip the button to "Applied" immediately, before
    // any await resolves. This prevents the user from seeing a green
    // clickable Apply button after they've already clicked it.
    HealCardRenderer._flipRowToApplied(message, idx, t, { newValue: t.projectedHp });

    // Apply HP change (await — may take a moment for actor.update)
    const result = await HealCardRenderer._applyHealToActor(actor, t.healAmount, t.isTempHP);

    // Mark applied in the message flags (so reloads / re-renders preserve state)
    targets[idx] = { ...t, applied: true };
    try {
      await message.update({ [`flags.${MODULE_ID}.targets`]: targets });
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to mark heal as applied (non-blocking):`, err);
    }

    // Re-flip with the actual capped HP value (in case heal hit max and
    // the projected value differs). The DOM may have been re-rendered
    // during message.update; this catches that and updates HP-after text.
    HealCardRenderer._flipRowToApplied(message, idx, t, result);

    // No follow-up chat message — the main heal card itself is the record:
    // the target row shows current → new HP and the Apply button has been
    // replaced with "Applied". A separate confirmation note was redundant
    // clutter (and looked like a vanilla dnd5e card to the user).
  }

  /**
   * Apply to all targets at once. Loops the per-target apply (skipping any
   * already applied), with a tiny delay between each so the chat notes and
   * DOM updates land in order rather than racing.
   */
  static async _onApplyAll(message, cardEl, allBtnEl) {
    const flags = message.flags?.[MODULE_ID];
    if (!flags || flags.type !== "healCard") return;
    const targets = flags.targets ?? [];
    if (allBtnEl) {
      allBtnEl.disabled = true;
      allBtnEl.classList.add("applied");
    }

    for (let idx = 0; idx < targets.length; idx++) {
      if (targets[idx].applied) continue;
      const btn = cardEl.querySelector(`.ace-qol-heal-card-apply[data-target-idx="${idx}"]`);
      await HealCardRenderer._onApplyClick(message, idx, btn);
      // tiny pause so the chat notes don't all pile up at once
      await new Promise(r => setTimeout(r, 60));
    }

    // Flip the All button to "Applied" once everything is done
    if (allBtnEl) {
      allBtnEl.innerHTML = `<i class="fas fa-check"></i> All Applied`;
    }
  }

  /**
   * Rewrite the target row's button + visual state to "applied" without a
   * full re-render. Uses querySelectorAll so popped-out chat windows or
   * duplicated DOM trees all get updated.
   */
  static _flipRowToApplied(message, idx, target, result) {
    // Match every card instance for this message (sidebar + any popouts)
    const cards = document.querySelectorAll(`[data-message-id="${message.id}"] .ace-qol-heal-card`);
    cards.forEach(card => {
      const row = card.querySelector(`.ace-qol-heal-card-target[data-target-idx="${idx}"]`);
      if (!row) return;

      row.classList.add("applied");

      // Replace Apply button with Applied (idempotent — if already Applied, skip)
      const applyBtn = row.querySelector(".ace-qol-heal-card-apply");
      if (applyBtn) {
        const newBtn = document.createElement("button");
        newBtn.className = "ace-qol-heal-card-applied";
        newBtn.disabled = true;
        newBtn.innerHTML = `<i class="fas fa-check"></i> Applied`;
        applyBtn.replaceWith(newBtn);
      }

      // Update HP-after text with the actual capped value (heal might hit max)
      const afterEl = row.querySelector(".ace-qol-heal-card-target-hp-after");
      if (afterEl && Number.isFinite(result?.newValue)) {
        afterEl.textContent = String(result.newValue);
      }
    });
  }

  /**
   * Mutate the target actor's HP. Regular heal adds to .hp.value (capped
   * at .hp.max). Temp HP replaces .hp.temp if greater (RAW behavior — temp
   * HP doesn't stack).
   *
   * @returns {{ before: number, newValue: number, capped: boolean }}
   */
  static async _applyHealToActor(actor, amount, isTempHP) {
    const hp  = actor.system?.attributes?.hp ?? {};
    const cur = hp.value ?? 0;
    const max = hp.max   ?? 0;
    const tmp = hp.temp  ?? 0;

    if (isTempHP) {
      // RAW: temp HP from the same source doesn't stack — take the higher
      const newTemp = Math.max(tmp, amount);
      await actor.update({ "system.attributes.hp.temp": newTemp });
      return { before: tmp, newValue: newTemp, capped: false };
    }

    // Regular heal — add and cap at max
    const projected = cur + amount;
    const capped    = projected > max;
    const newHp     = Math.min(projected, max);
    await actor.update({ "system.attributes.hp.value": newHp });
    return { before: cur, newValue: newHp, capped };
  }
}
