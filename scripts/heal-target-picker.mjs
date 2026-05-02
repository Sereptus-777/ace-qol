// ─── ACE: QOL — Heal Target Picker ───────────────────────────────────────────
// DialogV2-based popup that lets the GM (or player) pick valid heal targets.
//
// What it shows:
//   - Portrait grid of every token on the current scene
//   - HP bar (current/max) + temp HP badge
//   - Distance-from-caster in feet (color-coded green/yellow/red vs range)
//   - Self button (caster always selectable for self-eligible heals)
//   - Out-of-range tokens are dimmed but selectable (GM may want to heal
//     someone barely out of range — RAW says no, but houserules vary)
//   - Hostile tokens are dimmed when affects.type is "ally"
//   - Multi-select with N-target cap (greys out additional clicks)
//   - Already-targeted tokens (game.user.targets) come pre-selected
//
// Why DialogV2: matches V13 conventions, integrates with Foundry's UI stack,
// no jQuery dependency, supports promises cleanly.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

const SELF_KEY = "__SELF__";

export class HealTargetPicker {

  /**
   * Public entry point. Shows the picker and resolves to an array of selected
   * Token (canvas) objects. Returns [] if canceled.
   *
   * @param {Activity} activity — the HealActivity being used
   * @param {object} classification — output of HealPipeline._classify
   * @returns {Promise<Token[]>}
   */
  static async pick(activity, classification) {
    const item   = activity.item;
    const actor  = activity.actor;
    const casterToken = actor?.getActiveTokens()?.[0]
                    ?? canvas.tokens?.placeables.find(t => t.actor?.id === actor?.id);

    // Build the candidate list (every placeable token on canvas)
    const candidates = HealTargetPicker._buildCandidates(actor, casterToken, classification);
    if (!candidates.length) {
      ui.notifications.warn(`${item.name}: no valid healing targets on this scene.`);
      return [];
    }

    // Pre-select tokens already in game.user.targets (GM convenience)
    const preSelected = new Set();
    for (const t of game.user.targets) {
      if (candidates.find(c => c.tokenId === t.id)) preSelected.add(t.id);
    }
    // For self-eligible heals, pre-select self if no other selection
    if (preSelected.size === 0 && casterToken && classification.shape !== "multi") {
      const selfRow = candidates.find(c => c.isSelf);
      if (selfRow) preSelected.add(selfRow.tokenId);
    }

    return await HealTargetPicker._showDialog({
      item, classification, candidates, preSelected, casterToken,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Candidate Building
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Walk every token on canvas and decide if it's a valid heal target.
   * Each row records range, validity, and a reason if invalid.
   */
  static _buildCandidates(casterActor, casterToken, classification) {
    const tokens = canvas.tokens?.placeables ?? [];
    const out = [];
    for (const tok of tokens) {
      if (!tok.actor) continue;

      const isSelf = casterToken && tok.id === casterToken.id;

      // Distance in feet (0 for self). Foundry's measureDistances handles
      // grid-aware distance with diagonal rules from the scene config.
      let distFt = 0;
      if (!isSelf && casterToken) {
        try {
          distFt = HealTargetPicker._measureDistance(casterToken, tok);
        } catch (_) {
          distFt = HealTargetPicker._fallbackDistance(casterToken, tok);
        }
      }

      // Validity checks
      const validity = HealTargetPicker._checkValidity(tok, casterActor, classification, distFt);

      // HP info
      const hp  = tok.actor.system?.attributes?.hp ?? {};
      const cur = hp.value ?? 0;
      const max = hp.max   ?? 0;
      const tmp = hp.temp  ?? 0;

      out.push({
        tokenId:    tok.id,
        token:      tok,
        name:       tok.document?.name ?? tok.actor.name,
        img:        tok.document?.texture?.src ?? tok.actor.img,
        actorType:  tok.actor.type,
        disposition: tok.document?.disposition ?? 0,
        currentHp:  cur,
        maxHp:      max,
        tempHp:     tmp,
        distFt,
        valid:      validity.valid,
        reason:     validity.reason,
        isSelf,
        isPlayerOwned: tok.actor.hasPlayerOwner,
      });
    }
    // Sort: self first, then valid by distance, then invalid
    out.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      if (a.valid !== b.valid)   return a.valid  ? -1 : 1;
      return a.distFt - b.distFt;
    });
    return out;
  }

  static _measureDistance(t1, t2) {
    // V13: canvas.grid.measurePath
    if (typeof canvas.grid?.measurePath === "function") {
      const p = canvas.grid.measurePath([
        { x: t1.center.x, y: t1.center.y },
        { x: t2.center.x, y: t2.center.y },
      ]);
      return p?.distance ?? 0;
    }
    // V12: canvas.grid.measureDistances
    if (typeof canvas.grid?.measureDistances === "function") {
      const segs = [{ ray: new (foundry?.canvas?.geometry?.Ray ?? Ray)(t1.center, t2.center) }];
      const dists = canvas.grid.measureDistances(segs, { gridSpaces: true });
      return dists?.[0] ?? 0;
    }
    return HealTargetPicker._fallbackDistance(t1, t2);
  }

  static _fallbackDistance(t1, t2) {
    const dx = t1.center.x - t2.center.x;
    const dy = t1.center.y - t2.center.y;
    const px = Math.hypot(dx, dy);
    const grid = canvas.grid?.size ?? 100;
    const sceneDist = canvas.scene?.grid?.distance ?? 5;
    return (px / grid) * sceneDist;
  }

  /**
   * Valid-target check based on the heal's affects.type and the target's
   * disposition / actor type. Returns { valid, reason }.
   *
   * Rules (RAW):
   *   - "self":     only the caster
   *   - "ally":     friendly creatures (positive disposition or PC)
   *   - "creature": any creature (most common — PC friendly heals)
   *   - "enemy":    rare — drain/transfer effects
   *   - undead/construct exclusion handled by description, not enforced here
   */
  static _checkValidity(token, casterActor, classification, distFt) {
    const affects = classification.affectsType;
    const isSelf  = token.actor?.id === casterActor?.id;
    const disp    = token.document?.disposition;
    const casterDisp = casterActor?.token?.disposition
                    ?? casterActor?.prototypeToken?.disposition
                    ?? 1; // PCs are friendly by default

    // Range check (Infinity passes)
    if (Number.isFinite(classification.rangeFt) && distFt > classification.rangeFt + 0.01) {
      return { valid: false, reason: `${Math.round(distFt)}ft > ${classification.rangeFt}ft range` };
    }

    if (affects === "self" && !isSelf) return { valid: false, reason: "self-only heal" };

    if (affects === "ally") {
      // Allied: same disposition or PC
      if (token.actor.hasPlayerOwner || casterActor?.hasPlayerOwner) {
        // Both PC-side OK, NPC hostiles not OK
        if (disp === -1 && !casterActor?.hasPlayerOwner === false) return { valid: false, reason: "hostile" };
      } else if (disp !== casterDisp && !isSelf) {
        return { valid: false, reason: "not allied" };
      }
    }

    if (affects === "enemy" && (token.actor.hasPlayerOwner || disp === casterDisp)) {
      return { valid: false, reason: "ally — needs hostile target" };
    }

    return { valid: true, reason: "" };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dialog Render
  // ═══════════════════════════════════════════════════════════════════════════

  static async _showDialog({ item, classification, candidates, preSelected }) {
    const maxCount = classification.count;
    const maxCountDisplay = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : 1;
    const rangeDisplay = !Number.isFinite(classification.rangeFt)
      ? "any range"
      : classification.rangeFt === 0 ? "self only"
      : classification.rangeFt === 5 ? "5 ft (touch)"
      : `${classification.rangeFt} ft`;

    const tempHPBadge = classification.isTempHP
      ? `<span class="ace-qol-heal-pickr-tag ace-qol-heal-pickr-tag-temp">TEMP HP</span>`
      : "";

    const headerHtml = `
      <div class="ace-qol-heal-pickr-header">
        <img class="ace-qol-heal-pickr-icon" src="${item.img}" alt="" onerror="this.style.display='none'">
        <div class="ace-qol-heal-pickr-titles">
          <div class="ace-qol-heal-pickr-name">${foundry.utils.escapeHTML(item.name)}</div>
          <div class="ace-qol-heal-pickr-meta">
            <span class="ace-qol-heal-pickr-tag">${rangeDisplay}</span>
            <span class="ace-qol-heal-pickr-tag">up to ${maxCountDisplay} target${maxCountDisplay === 1 ? "" : "s"}</span>
            ${tempHPBadge}
          </div>
        </div>
      </div>
    `;

    const rowsHtml = candidates.map(c => HealTargetPicker._renderTokenRow(c, preSelected.has(c.tokenId))).join("");

    const content = `
      <div class="ace-qol-heal-pickr">
        ${headerHtml}
        <div class="ace-qol-heal-pickr-instructions">
          Select up to <strong>${maxCountDisplay}</strong> target${maxCountDisplay === 1 ? "" : "s"}.
          Click a portrait to toggle. Out-of-range targets are dimmed.
        </div>
        <div class="ace-qol-heal-pickr-grid" data-max-count="${maxCountDisplay}">
          ${rowsHtml}
        </div>
        <div class="ace-qol-heal-pickr-footer">
          <span class="ace-qol-heal-pickr-count" data-selected="${preSelected.size}">
            <strong class="ace-qol-heal-pickr-count-num">${preSelected.size}</strong> / ${maxCountDisplay} selected
          </span>
          <label class="ace-qol-heal-pickr-consume" title="Whether to spend the spell slot / charge / linked use when the heal fires. Off = free cast (testing or houserule).">
            <input type="checkbox" class="ace-qol-heal-pickr-consume-cb" checked>
            <span>Consume resource</span>
          </label>
        </div>
      </div>
    `;

    return await new Promise((resolve) => {
      const dlg = new foundry.applications.api.DialogV2({
        window: { title: `Heal Target — ${item.name}` },
        content,
        rejectClose: false,
        position: { width: 580 },
        buttons: [
          {
            action:  "confirm",
            label:   "Heal Selected",
            icon:    "fa-solid fa-staff-snake",
            default: true,
            callback: (_event, _button, dialog) => {
              const root = dialog?.element ?? document;
              const selected = HealTargetPicker._readSelection(root, candidates);
              const consumeCb = root.querySelector?.(".ace-qol-heal-pickr-consume-cb");
              const consume   = consumeCb ? !!consumeCb.checked : true;
              resolve({ tokens: selected, consume });
            },
          },
          {
            action:  "cancel",
            label:   "Cancel",
            icon:    "fa-solid fa-xmark",
            callback: () => resolve({ tokens: [], consume: false }),
          },
        ],
      });
      dlg.render({ force: true });

      // Wire portrait clicks once the dialog is in the DOM
      setTimeout(() => HealTargetPicker._wireGrid(dlg.element ?? document, classification), 50);
    });
  }

  static _renderTokenRow(c, preSelected) {
    const hpPct = c.maxHp > 0 ? Math.max(0, Math.min(100, (c.currentHp / c.maxHp) * 100)) : 0;
    const distLabel = c.isSelf ? "self" : `${Math.round(c.distFt)} ft`;
    const distClass = c.isSelf ? "self" : (c.valid ? "in-range" : "out-of-range");
    const validClass = c.valid ? "valid" : "invalid";
    const selectedClass = preSelected ? "selected" : "";
    const ownerClass = c.isPlayerOwned ? "pc" : "npc";
    const tempBadge = c.tempHp > 0 ? `<span class="ace-qol-heal-pickr-tok-temp">+${c.tempHp}</span>` : "";

    return `
      <div class="ace-qol-heal-pickr-tok ${validClass} ${selectedClass} ${ownerClass}"
           data-token-id="${c.tokenId}" data-valid="${c.valid}"
           title="${foundry.utils.escapeHTML(c.reason || c.name)}">
        <div class="ace-qol-heal-pickr-tok-img-wrap">
          <img src="${c.img}" alt="" class="ace-qol-heal-pickr-tok-img" onerror="this.style.display='none'">
          ${c.isSelf ? `<div class="ace-qol-heal-pickr-tok-self-badge">SELF</div>` : ""}
        </div>
        <div class="ace-qol-heal-pickr-tok-name">${foundry.utils.escapeHTML(c.name)}</div>
        <div class="ace-qol-heal-pickr-tok-hp">
          <div class="ace-qol-heal-pickr-tok-hp-bar">
            <div class="ace-qol-heal-pickr-tok-hp-fill" style="width:${hpPct}%"></div>
          </div>
          <div class="ace-qol-heal-pickr-tok-hp-text">${c.currentHp} / ${c.maxHp}${tempBadge}</div>
        </div>
        <div class="ace-qol-heal-pickr-tok-dist ${distClass}">${distLabel}</div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Selection Logic
  // ═══════════════════════════════════════════════════════════════════════════

  static _wireGrid(root, classification) {
    const grid    = root.querySelector?.(".ace-qol-heal-pickr-grid");
    const counter = root.querySelector?.(".ace-qol-heal-pickr-count");
    if (!grid) return;
    const maxCount = parseInt(grid.dataset.maxCount) || 1;

    grid.querySelectorAll(".ace-qol-heal-pickr-tok").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const isSelected = el.classList.contains("selected");
        if (!isSelected) {
          // Enforce max count — if we'd exceed it, deselect oldest
          const allSelected = grid.querySelectorAll(".ace-qol-heal-pickr-tok.selected");
          if (allSelected.length >= maxCount) {
            // Multi-select: remove the OLDEST selected (first in DOM order); single-select: remove the only one.
            allSelected[0]?.classList.remove("selected");
          }
          el.classList.add("selected");
        } else {
          el.classList.remove("selected");
        }
        // Update counter
        const newCount = grid.querySelectorAll(".ace-qol-heal-pickr-tok.selected").length;
        if (counter) {
          const numEl = counter.querySelector(".ace-qol-heal-pickr-count-num");
          if (numEl) numEl.textContent = String(newCount);
          counter.dataset.selected = String(newCount);
        }
      });
    });
  }

  static _readSelection(root, candidates) {
    const selectedIds = [...root.querySelectorAll(".ace-qol-heal-pickr-tok.selected")]
      .map(el => el.dataset.tokenId);
    const out = [];
    for (const id of selectedIds) {
      const c = candidates.find(x => x.tokenId === id);
      if (c?.token) out.push(c.token);
    }
    return out;
  }
}
