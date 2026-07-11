// ─── ACE: QOL — Spell Target Picker (v0.7.15) ────────────────────────────────
// DialogV2-based popup that lets the caster pick targets for a multi-target
// buff/debuff spell (Bless, Bane, Slow, Faerie Fire, Beacon of Hope, etc.).
//
// What it shows:
//   - Portrait grid of every token on the current scene
//   - Distance-from-caster in feet (color-coded vs spell range)
//   - Self always selectable (Bless allows caster to bless themselves)
//   - Out-of-range tokens dimmed but still selectable (GM houserule)
//   - Multi-select with a per-spell target cap
//   - Already-targeted tokens (game.user.targets) come pre-selected
//
// Pattern mirrors HealTargetPicker but stripped of heal-specific logic.
// Returns Promise<Actor[]> — selected actors, [] if cancelled.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { aceDistanceFt } from "./geometry-utils.mjs";

export class SpellTargetPicker {

  /**
   * Public entry point. Shows the picker and resolves to an array of selected
   * Actor objects. Returns [] if cancelled.
   *
   * @param {object} opts
   * @param {Item}   opts.spellItem    — the spell item being cast
   * @param {Actor}  opts.casterActor  — actor casting the spell
   * @param {number} opts.maxTargets   — max selectable (e.g., 3 for Bless)
   * @param {number} [opts.rangeFt]    — range in feet (defaults to spell.system.range)
   * @param {boolean}[opts.allowSelf]  — caster can be a target (default true)
   * @returns {Promise<Actor[]>}
   */
  static async pick({ spellItem, casterActor, maxTargets, rangeFt, allowSelf = true }) {
    if (!spellItem || !casterActor) return [];

    // Resolve range from spell item if not explicitly passed
    const resolvedRange = Number.isFinite(rangeFt)
      ? rangeFt
      : SpellTargetPicker._resolveRangeFt(spellItem);

    // Find caster's token for range computation
    const casterToken = casterActor.getActiveTokens?.()?.[0]
                     ?? canvas.tokens?.placeables.find(t => t.actor?.id === casterActor.id)
                     ?? null;

    if (!casterToken) {
      ui.notifications?.warn(
        `${spellItem.name}: caster has no token on this scene — defaulting to caster only.`
      );
      return [casterActor];
    }

    // Build the candidate list
    const _tb0 = performance.now();
    const candidates = SpellTargetPicker._buildCandidates(casterToken, casterActor, resolvedRange, allowSelf);
    console.log(`ace-qol | [picker-timing] _buildCandidates → ${candidates.length} candidates in ${Math.round(performance.now() - _tb0)}ms`);
    if (!candidates.length) {
      ui.notifications?.warn(`${spellItem.name}: no valid targets on this scene.`);
      return [];
    }

    // Pre-select tokens already in game.user.targets (caster convenience)
    const preSelected = new Set();
    for (const t of game.user.targets ?? []) {
      if (candidates.find(c => c.tokenId === t.id)) preSelected.add(t.id);
    }
    // If nothing is explicitly pre-targeted and self-targeting is allowed,
    // pre-select self — BUT only for MULTI-target buffs (Bless, Aid, Slow).
    // For a SINGLE-target buff (maxTargets === 1: Greater Invisibility, Death
    // Ward, Stoneskin, Foresight, Mind Blank, Freedom of Movement, Protection
    // from Evil/Good, Barkskin) auto-selecting self silently biases the spell
    // onto the caster: if the GM means to buff an adjacent ally and doesn't
    // notice the pre-pick, the caster gets the buff instead. Single-target
    // buffs now start with NOTHING selected, forcing one explicit pick — the
    // caster only ever gets the effect if the GM clicks their own portrait.
    // (v0.7.90 — Greater Invisibility "caster gets it too" report.)
    if (preSelected.size === 0 && allowSelf && (Number(maxTargets) || 1) > 1) {
      const selfRow = candidates.find(c => c.isSelf);
      if (selfRow) preSelected.add(selfRow.tokenId);
    }

    console.log(`ace-qol | [picker-timing] candidates ready — opening dialog (gap from here to the picker appearing = render time)`);
    return await SpellTargetPicker._showDialog({
      spellItem,
      candidates,
      preSelected,
      maxTargets: Math.max(1, Number(maxTargets) || 1),
      rangeFt: resolvedRange,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Range Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Read a spell's range and convert to feet. Returns Infinity for unlimited.
   */
  static _resolveRangeFt(spellItem) {
    const range = spellItem.system?.range ?? {};
    const v = Number(range.value);
    const u = String(range.units ?? "").toLowerCase();
    if (!Number.isFinite(v) || v <= 0) {
      // Touch / self / special — treat as 5ft default
      if (u === "touch") return 5;
      if (u === "self") return 0;
      return 30; // sensible fallback
    }
    if (u === "ft" || u === "feet" || u === "") return v;
    if (u === "mi" || u === "mile" || u === "miles") return v * 5280;
    if (u === "m" || u === "meter" || u === "meters") return v * 3.28084;
    return v;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Candidate Building
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Walk every token on canvas. Compute distance from caster, validity.
   * Returns sorted by distance ascending (caster first, then nearest).
   */
  static _buildCandidates(casterToken, casterActor, rangeFt, allowSelf) {
    const tokens = canvas.tokens?.placeables ?? [];
    const out = [];

    for (const tok of tokens) {
      if (!tok.actor) continue;
      const isSelf = tok.id === casterToken.id || tok.actor.id === casterActor.id;
      if (isSelf && !allowSelf) continue;

      // Distance FIRST (cheap geometry) — needed for range anyway, AND it lets us
      // skip the expensive line-of-sight raycast for anything out of range.
      let distFt = 0;
      if (!isSelf) distFt = SpellTargetPicker._measureDistance(casterToken, tok);
      const inRange = !Number.isFinite(rangeFt) || distFt <= rangeFt + 0.01;

      // LINE OF SIGHT — a creature you can't SEE (wall / closed door between you and
      // it) is not a valid target. Only test IN-RANGE creatures: an out-of-range token
      // can't be picked regardless, so we never pay for a raycast to it — and every ray
      // stays SHORT (caster → a nearby in-range token) instead of firing clear across a
      // wall-dense map like the Amber Temple to tokens hundreds of feet away, which was
      // turning the picker build into a ~20-second stall. Self is always visible.
      if (!isSelf && inRange && SpellTargetPicker._losBlocked(casterToken, tok)) continue;
      const disposition = tok.document?.disposition ?? 0;
      const isPlayerOwned = !!tok.actor.hasPlayerOwner;
      const hp = tok.actor.system?.attributes?.hp ?? {};
      const isDead = (hp.value ?? 1) <= 0 || tok.actor.statuses?.has?.("dead");

      out.push({
        tokenId: tok.id,
        token: tok,
        actor: tok.actor,
        name: tok.name ?? tok.actor.name,
        img: tok.actor.img ?? tok.document?.texture?.src ?? "icons/svg/mystery-man.svg",
        isSelf,
        distFt,
        inRange,
        disposition,
        isPlayerOwned,
        isDead,
      });
    }

    out.sort((a, b) => {
      if (a.isSelf && !b.isSelf) return -1;
      if (b.isSelf && !a.isSelf) return 1;
      return a.distFt - b.distFt;
    });

    return out;
  }

  // Nearest-edge, size-aware, 3D distance in feet (canonical — geometry-utils).
  static _measureDistance(t1, t2) {
    return aceDistanceFt(t1, t2);
  }

  // Is the caster→target line blocked by a sight-blocking wall or closed door?
  // A creature behind two doors in another room is in straight-line range but NOT
  // visible, so it must not appear as a spell target.
  static _losBlocked(fromToken, toToken) {
    try {
      // Foundry already computes per-token visibility for the current client every
      // frame (vision range, walls, light, fog). On the caster's OWN client that IS
      // "can the caster see this token" — for free. Using it instead of a per-token
      // sight raycast is the difference between instant and a multi-second stall on a
      // wall-dense map: a single testCollision through the Amber Temple's wall set was
      // taking ~1s+ EACH. `visible` is true on the GM (omniscient) and on scenes with
      // no token vision, so neither is wrongly over-filtered.
      if (toToken?.visible === false) return true;
      // Only when visibility is genuinely indeterminate (rare) fall back to one cheap
      // sight ray — and callers only ask about in-range tokens now, so it stays short.
      if (toToken?.visible == null) {
        return !!CONFIG.Canvas?.polygonBackends?.sight?.testCollision?.(
          fromToken.center, toToken.center, { type: "sight", mode: "any" }
        );
      }
      return false;
    } catch (_) {
      return false;   // test unavailable → don't false-exclude
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dialog Render
  // ═══════════════════════════════════════════════════════════════════════════

  static async _showDialog({ spellItem, candidates, preSelected, maxTargets, rangeFt }) {
    const rangeLabel = !Number.isFinite(rangeFt) ? "any range"
                     : rangeFt === 0 ? "self only"
                     : rangeFt === 5 ? "5 ft (touch)"
                     : `${rangeFt} ft`;

    const headerHtml = `
      <div class="ace-qol-spell-pickr-header">
        <img class="ace-qol-spell-pickr-icon" src="${spellItem.img}" alt="" onerror="this.style.display='none'">
        <div class="ace-qol-spell-pickr-titles">
          <div class="ace-qol-spell-pickr-name">${foundry.utils.escapeHTML(spellItem.name)}</div>
          <div class="ace-qol-spell-pickr-meta">
            <span class="ace-qol-spell-pickr-tag">${rangeLabel}</span>
            <span class="ace-qol-spell-pickr-tag">up to ${maxTargets} target${maxTargets === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>
    `;

    const rowsHtml = candidates.map(c =>
      SpellTargetPicker._renderTokenRow(c, preSelected.has(c.tokenId))
    ).join("");

    const content = `
      <div class="ace-qol-spell-pickr">
        ${headerHtml}
        <div class="ace-qol-spell-pickr-instructions">
          Select up to <strong>${maxTargets}</strong> target${maxTargets === 1 ? "" : "s"}.
          Click a portrait to toggle. Out-of-range targets are dimmed but still selectable.
        </div>
        <div class="ace-qol-spell-pickr-grid" data-max-count="${maxTargets}">
          ${rowsHtml}
        </div>
        <div class="ace-qol-spell-pickr-footer">
          <span class="ace-qol-spell-pickr-count" data-selected="${preSelected.size}">
            <strong class="ace-qol-spell-pickr-count-num">${preSelected.size}</strong> / ${maxTargets} selected
          </span>
        </div>
      </div>
    `;

    return await new Promise((resolve) => {
      const dlg = new foundry.applications.api.DialogV2({
        window: { title: `Cast ${spellItem.name} — Pick Targets` },
        content,
        rejectClose: false,
        position: { width: 600 },
        buttons: [
          {
            action: "confirm",
            label: `Cast ${spellItem.name}`,
            icon: "fa-solid fa-sparkles",
            default: true,
            callback: (_event, _button, dialog) => {
              const root = dialog?.element ?? document;
              const actors = SpellTargetPicker._readSelection(root, candidates);
              resolve(actors);
            },
          },
          {
            action: "cancel",
            label: "Cancel",
            icon: "fa-solid fa-xmark",
            callback: () => resolve([]),
          },
        ],
      });
      // v0.7.21: await the render Promise so the DOM is guaranteed mounted
      // before we wire click handlers. The previous setTimeout(50ms) raced
      // against DialogV2's render time on COLD CACHE (first cast after F5
      // reload) — DOM wasn't ready, _wireGrid found nothing, click handlers
      // never attached, out-of-range tokens were silently selectable. The
      // "first cast fails / second cast works" bug Johnny hit with Haste.
      // (Audit-mandated 2026-06-09.)
      dlg.render({ force: true }).then(() => {
        SpellTargetPicker._wireGrid(dlg.element ?? document, maxTargets);
      }).catch(err => {
        console.warn(`${MODULE_ID} | SpellTargetPicker dialog render threw:`, err);
        // Fallback — try a delayed wire even on render error so the user
        // isn't left with an unwired picker.
        setTimeout(() => SpellTargetPicker._wireGrid(dlg.element ?? document, maxTargets), 200);
      });
    });
  }

  static _renderTokenRow(c, preSelected) {
    const distLabel = c.isSelf ? "self" : `${Math.round(c.distFt)} ft`;
    const distClass = c.isSelf ? "self" : (c.inRange ? "in-range" : "out-of-range");
    const validClass = c.inRange && !c.isDead ? "valid" : "invalid";
    const selectedClass = preSelected ? "selected" : "";
    const ownerClass = c.isPlayerOwned ? "pc" : "npc";
    const deadBadge = c.isDead ? `<div class="ace-qol-spell-pickr-tok-dead">DEAD</div>` : "";
    const dispLabel = c.disposition === 1 ? "FRIENDLY"
                    : c.disposition === -1 ? "HOSTILE"
                    : c.disposition === 0 ? "NEUTRAL"
                    : "";
    const dispClass = c.disposition === 1 ? "friendly"
                    : c.disposition === -1 ? "hostile"
                    : "neutral";

    return `
      <div class="ace-qol-spell-pickr-tok ${validClass} ${selectedClass} ${ownerClass}"
           data-token-id="${c.tokenId}"
           data-actor-id="${c.actor.id}"
           title="${foundry.utils.escapeHTML(c.name)} — ${distLabel}">
        <div class="ace-qol-spell-pickr-tok-img-wrap">
          <img src="${c.img}" alt="" class="ace-qol-spell-pickr-tok-img" onerror="this.style.display='none'">
          ${c.isSelf ? `<div class="ace-qol-spell-pickr-tok-self-badge">SELF</div>` : ""}
          ${deadBadge}
        </div>
        <div class="ace-qol-spell-pickr-tok-name">${foundry.utils.escapeHTML(c.name)}</div>
        ${dispLabel ? `<div class="ace-qol-spell-pickr-tok-disp ${dispClass}">${dispLabel}</div>` : ""}
        <div class="ace-qol-spell-pickr-tok-dist ${distClass}">${distLabel}</div>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Selection Logic
  // ═══════════════════════════════════════════════════════════════════════════

  static _wireGrid(root, maxTargets) {
    const grid = root.querySelector?.(".ace-qol-spell-pickr-grid");
    const counter = root.querySelector?.(".ace-qol-spell-pickr-count");
    if (!grid) return;

    grid.querySelectorAll(".ace-qol-spell-pickr-tok").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        // ── v0.7.21: Hard-enforce range + dead state ──
        // Previously the .invalid class greyed the token visually but the
        // click handler ignored it — user could still click + cast Haste on
        // a target 60ft away when the spell's range is 30ft. Now blocked.
        // (Bug found in testing 2026-06-09.)
        if (el.classList.contains("invalid")) {
          // Brief flash to make it clear the click was rejected
          el.classList.add("ace-qol-pickr-reject-flash");
          setTimeout(() => el.classList.remove("ace-qol-pickr-reject-flash"), 350);
          // Surface a one-time toast on the first rejection so the user
          // understands why nothing happened.
          if (!grid.dataset.rejectToastShown) {
            grid.dataset.rejectToastShown = "1";
            const reason = el.querySelector(".ace-qol-spell-pickr-tok-dist.out-of-range")
              ? "out of spell range"
              : el.querySelector(".ace-qol-spell-pickr-tok-dead")
                ? "dead"
                : "invalid";
            ui.notifications?.warn(`Cannot target ${el.title?.split(" — ")[0] ?? "this token"} — ${reason}.`);
          }
          return;
        }

        const isSelected = el.classList.contains("selected");
        if (!isSelected) {
          // Enforce max — drop oldest selection if exceeding
          const allSelected = grid.querySelectorAll(".ace-qol-spell-pickr-tok.selected");
          if (allSelected.length >= maxTargets) {
            allSelected[0]?.classList.remove("selected");
          }
          el.classList.add("selected");
        } else {
          el.classList.remove("selected");
        }

        // Update counter
        const newCount = grid.querySelectorAll(".ace-qol-spell-pickr-tok.selected").length;
        if (counter) {
          const numEl = counter.querySelector(".ace-qol-spell-pickr-count-num");
          if (numEl) numEl.textContent = String(newCount);
          counter.dataset.selected = String(newCount);
        }
      });
    });
  }

  static _readSelection(root, candidates) {
    const selectedIds = [...root.querySelectorAll(".ace-qol-spell-pickr-tok.selected")]
      .map(el => el.dataset.tokenId);
    const out = [];
    for (const id of selectedIds) {
      const c = candidates.find(x => x.tokenId === id);
      if (c?.actor) out.push(c.actor);
    }
    return out;
  }
}
