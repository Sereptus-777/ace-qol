// ─── ACE: QOL — Magic Missile Picker (v0.7.17) ────────────────────────────────
// DialogV2-based popup that lets the caster distribute Magic Missile darts
// across multiple targets.
//
// What it shows:
//   - Header: spell name, slot level cast at, dart total
//   - Live tally: "X / N darts assigned"
//   - Portrait grid: every viable target on the current scene
//     (all NPC tokens + non-self PC tokens; skips dead targets)
//   - Per-target widget: − / current count / + buttons
//   - Distance-from-caster in feet (color-coded vs spell range 120ft)
//   - Out-of-range tokens dimmed but still selectable (GM houserule allows
//     it; player accepts the cost)
//   - Confirm button greyed until total === dart pool
//
// Pre-population logic:
//   - If the caster already has tokens in game.user.targets, darts are
//     distributed evenly across them (M // N each + remainder to first
//     targets). Player can adjust before confirming.
//   - Otherwise, the picker opens with all zeros.
//
// Returns Promise<Map<Actor, number>|null>:
//   - Map<targetActor, dartCount> on confirm
//   - null on cancel
//
// Pattern mirrors SpellTargetPicker but with quantity widgets per row.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

export class MagicMissilePicker {

  /**
   * Public entry point. Shows the picker and resolves to the dart
   * distribution map, or null if cancelled.
   *
   * @param {object} opts
   * @param {Item}   opts.spellItem   — the Magic Missile spell item
   * @param {Actor}  opts.casterActor — actor casting
   * @param {number} opts.dartCount   — total darts available (3 at L1, +1/level)
   * @param {number} [opts.rangeFt=120] — spell range in feet
   * @returns {Promise<Map<Actor, number>|null>}
   */
  static async pick({ spellItem, casterActor, dartCount, rangeFt = 120 }) {
    if (!spellItem || !casterActor || !Number.isFinite(dartCount) || dartCount < 1) {
      return null;
    }

    // Find caster's token on the active scene for range computation
    const casterToken = casterActor.getActiveTokens?.()?.[0]
                     ?? canvas.tokens?.placeables.find(t => t.actor?.id === casterActor.id)
                     ?? null;

    if (!casterToken) {
      ui.notifications?.warn(
        `${spellItem.name}: caster has no token on this scene — Magic Missile cancelled.`
      );
      return null;
    }

    // Build candidate target list
    const candidates = MagicMissilePicker._buildCandidates(casterToken, casterActor, rangeFt);
    if (!candidates.length) {
      ui.notifications?.warn(`${spellItem.name}: no valid targets on this scene.`);
      return null;
    }

    // Pre-distribute darts across already-targeted tokens (caster convenience)
    const initialAssignment = new Map(); // tokenId -> dartCount
    const preTargets = [...(game.user.targets ?? [])].filter(t =>
      candidates.some(c => c.tokenId === t.id)
    );
    if (preTargets.length > 0) {
      // Even split, remainder to first targets
      const perTarget = Math.floor(dartCount / preTargets.length);
      let remainder = dartCount % preTargets.length;
      for (const t of preTargets) {
        initialAssignment.set(t.id, perTarget + (remainder > 0 ? 1 : 0));
        if (remainder > 0) remainder--;
      }
    }

    return await MagicMissilePicker._showDialog({
      spellItem,
      casterActor,
      candidates,
      dartCount,
      rangeFt,
      initialAssignment,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CANDIDATE BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the list of valid targets on the current scene.
   * Includes: all NPC tokens + non-self PC tokens with HP > 0.
   * Excludes: caster, dead tokens, secret tokens (GM-only display).
   */
  static _buildCandidates(casterToken, casterActor, rangeFt) {
    const placeables = canvas.tokens?.placeables ?? [];
    const out = [];

    for (const tok of placeables) {
      const actor = tok.actor;
      if (!actor) continue;
      if (actor.id === casterActor.id) continue; // can't target self with Magic Missile
      if (tok.document?.hidden && !game.user.isGM) continue;

      const hp = actor.system?.attributes?.hp?.value ?? 0;
      if (hp <= 0) continue; // dead

      // Distance in feet (Chebyshev via PIXI distance)
      const distPx = Math.hypot(
        (tok.center?.x ?? tok.x) - (casterToken.center?.x ?? casterToken.x),
        (tok.center?.y ?? tok.y) - (casterToken.center?.y ?? casterToken.y),
      );
      const gridSize = canvas.scene?.grid?.size ?? canvas.grid?.size ?? 100;
      const gridDistance = canvas.scene?.grid?.distance ?? 5;
      const distFt = Math.round((distPx / gridSize) * gridDistance);

      out.push({
        tokenId: tok.id,
        actorId: actor.id,
        actor,
        token: tok,
        name: tok.name ?? actor.name,
        img: tok.document?.texture?.src ?? actor.img,
        ac: actor.system?.attributes?.ac?.value ?? null,
        hp,
        maxHP: actor.system?.attributes?.hp?.max ?? hp,
        distFt,
        inRange: distFt <= rangeFt,
        isNPC: actor.type === "npc",
      });
    }

    // Sort: in-range NPCs first, then in-range PCs, then OOR
    out.sort((a, b) => {
      if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
      if (a.isNPC !== b.isNPC) return a.isNPC ? -1 : 1;
      return a.distFt - b.distFt;
    });

    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DIALOG
  // ═══════════════════════════════════════════════════════════════════════════

  static async _showDialog({ spellItem, casterActor, candidates, dartCount, rangeFt, initialAssignment }) {
    return new Promise((resolve) => {
      const assignment = new Map(initialAssignment); // tokenId -> dartCount
      const initialTotal = [...assignment.values()].reduce((s, n) => s + n, 0);

      const rangeColor = (distFt, inRange) => {
        if (!inRange) return "#d44";
        if (distFt > rangeFt * 0.66) return "#e8a14b";
        return "#7ec97e";
      };

      // v0.7.17c (2026-06-07): inline styles on every layout/size attribute
      // so the picker renders correctly even if DialogV2 scopes/strips our
      // <style> block. Portraits forced to 56x56 via HTML width/height +
      // inline CSS — bulletproof regardless of stylesheet status.
      const ROW_STYLE = "display:flex;align-items:center;gap:10px;padding:8px;margin-bottom:6px;background:#1f1812;border:1px solid #3a2e20;border-radius:4px;";
      const ROW_OOR_STYLE = ROW_STYLE + "opacity:0.55;";
      const PORTRAIT_STYLE = "width:56px;height:56px;border-radius:4px;border:1px solid #6b5230;object-fit:cover;flex-shrink:0;display:block;";
      const INFO_STYLE = "flex:1;min-width:0;color:#f0e4c0;";
      const NAME_STYLE = "font-size:15px;font-weight:600;color:#e8d49a;display:flex;align-items:center;gap:6px;";
      const META_STYLE = "display:flex;gap:10px;font-size:13px;color:#c0b288;margin-top:3px;";
      const COUNTER_STYLE = "display:flex;align-items:center;gap:6px;flex-shrink:0;";
      const BTN_STYLE = "width:28px;height:28px;border-radius:4px;border:1px solid #6b5230;background:#2a1f0a;color:#e8d49a;font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;";
      const COUNT_STYLE = "min-width:28px;text-align:center;font-size:16px;font-weight:700;color:#fff;";
      const BADGE_NPC = "font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700;background:#5a2828;color:#f4c4c4;";
      const BADGE_PC  = "font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700;background:#28425a;color:#c4daf4;";

      const buildRowHtml = (c) => {
        const current = assignment.get(c.tokenId) ?? 0;
        const rowStyle = c.inRange ? ROW_STYLE : ROW_OOR_STYLE;
        const npcBadge = c.isNPC
          ? `<span style="${BADGE_NPC}">NPC</span>`
          : `<span style="${BADGE_PC}">PC</span>`;
        return `
          <div class="ace-mm-row" data-token-id="${c.tokenId}" style="${rowStyle}">
            <img class="ace-mm-portrait" width="56" height="56" src="${c.img}" alt="${c.name}" style="${PORTRAIT_STYLE}" />
            <div style="${INFO_STYLE}">
              <div style="${NAME_STYLE}">${c.name} ${npcBadge}</div>
              <div style="${META_STYLE}">
                <span>AC ${c.ac ?? "?"}</span>
                <span>HP ${c.hp}/${c.maxHP}</span>
                <span style="color: ${rangeColor(c.distFt, c.inRange)}">${c.distFt} ft${c.inRange ? "" : " (out of range)"}</span>
              </div>
            </div>
            <div style="${COUNTER_STYLE}">
              <button type="button" data-action="dec" data-token-id="${c.tokenId}" aria-label="Remove dart" style="${BTN_STYLE}">−</button>
              <span data-count-for="${c.tokenId}" style="${COUNT_STYLE}">${current}</span>
              <button type="button" data-action="inc" data-token-id="${c.tokenId}" aria-label="Add dart" style="${BTN_STYLE}">+</button>
            </div>
          </div>
        `;
      };

      const content = `
        <div style="color:#f0e4c0;background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);padding:12px;border-radius:6px;font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #4a3a28;">
            <i class="fas fa-burst" style="color:#c9a76b;font-size:28px;"></i>
            <div>
              <div style="font-size:18px;font-weight:600;color:#e8d49a;">${spellItem.name}</div>
              <div style="font-size:14px;color:#c0b288;margin-top:2px;">Distribute darts across targets. Each dart deals 1d4+1 force damage.</div>
            </div>
          </div>
          <div style="background:#2a1f0a;border:1px solid #6b5230;border-radius:4px;padding:8px 12px;margin-bottom:10px;text-align:center;font-size:18px;color:#e8d49a;">
            <span id="ace-mm-tally-used" style="font-weight:700;color:#fff;font-size:22px;">${initialTotal}</span>
            <span style="margin:0 6px;color:#6b5230;">/</span>
            <span style="color:#c9a76b;font-weight:600;">${dartCount}</span>
            <span style="display:block;font-size:13px;color:#b0a070;margin-top:2px;">darts assigned</span>
          </div>
          <div style="max-height:360px;overflow-y:auto;padding-right:4px;">
            ${candidates.map(buildRowHtml).join("")}
          </div>
          <div style="margin-top:8px;font-size:12px;color:#8a7a5a;text-align:center;font-style:italic;">
            <i class="fas fa-info-circle" style="margin-right:4px;"></i>
            Out-of-range targets shown dim — GM may allow at table discretion.
          </div>
        </div>
      `;

      const dialog = new foundry.applications.api.DialogV2({
        window: { title: `${spellItem.name} — Dart Distribution`, icon: "fas fa-burst" },
        position: { width: 560, height: "auto" },
        content,
        buttons: [
          {
            action: "confirm",
            label: "Launch Darts",
            icon: "fas fa-check",
            default: true,
            callback: () => {
              const map = new Map();
              for (const [tokenId, n] of assignment.entries()) {
                if (n <= 0) continue;
                const c = candidates.find(cc => cc.tokenId === tokenId);
                if (c?.actor) map.set(c.actor, n);
              }
              resolve(map);
            },
          },
          {
            action: "cancel",
            label: "Cancel",
            icon: "fas fa-times",
            callback: () => resolve(null),
          },
        ],
        rejectClose: false,
        close: () => resolve(null),
      });

      dialog.render({ force: true });

      // Wire up +/- buttons once the DOM is in place. Mirrors the
      // SpellTargetPicker pattern — setTimeout sidesteps having to
      // override the application's internal _onRender lifecycle.
      setTimeout(() => {
        MagicMissilePicker._wireCounters(
          dialog.element ?? document, assignment, dartCount
        );
      }, 50);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUTTON WIRING
  // ═══════════════════════════════════════════════════════════════════════════

  static _wireCounters(root, assignment, dartCount) {
    try {
      const tallyEl = root.querySelector?.("#ace-mm-tally-used");
      const confirmBtn = root.querySelector?.('button[data-action="confirm"]');

      const refreshConfirm = () => {
        const total = [...assignment.values()].reduce((s, n) => s + n, 0);
        if (tallyEl) tallyEl.textContent = String(total);
        if (confirmBtn) {
          const ok = total === dartCount;
          confirmBtn.disabled = !ok;
          confirmBtn.classList.toggle("ace-mm-confirm-ready", ok);
        }
      };
      refreshConfirm();

      root.querySelectorAll?.('button[data-action="inc"], button[data-action="dec"]').forEach(btn => {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const tokenId = btn.dataset.tokenId;
          const action = btn.dataset.action;
          const current = assignment.get(tokenId) ?? 0;
          const total = [...assignment.values()].reduce((s, n) => s + n, 0);

          let next = current;
          if (action === "inc") {
            if (total >= dartCount) return; // can't exceed pool
            next = current + 1;
          } else {
            next = Math.max(0, current - 1);
          }
          if (next === current) return;

          if (next === 0) assignment.delete(tokenId);
          else assignment.set(tokenId, next);

          const countEl = root.querySelector(`[data-count-for="${tokenId}"]`);
          if (countEl) countEl.textContent = String(next);
          refreshConfirm();
        });
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | MagicMissilePicker wire-counters failed (non-fatal):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STYLES (scoped inline so picker is self-contained)
  // ═══════════════════════════════════════════════════════════════════════════

  static _styleBlock() {
    return `
      <style>
        .ace-mm-picker {
          color: #f0e4c0;
          background: linear-gradient(180deg, #1a1410 0%, #0f0a08 100%);
          padding: 12px;
          border-radius: 6px;
          font-family: "Signika", "Helvetica Neue", sans-serif;
        }
        .ace-mm-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #4a3a28; }
        .ace-mm-icon { color: #c9a76b; font-size: 28px; }
        .ace-mm-title { font-size: 18px; font-weight: 600; color: #e8d49a; }
        .ace-mm-sub { font-size: 14px; color: #c0b288; margin-top: 2px; }
        .ace-mm-tally {
          background: #2a1f0a;
          border: 1px solid #6b5230;
          border-radius: 4px;
          padding: 8px 12px;
          margin-bottom: 10px;
          text-align: center;
          font-size: 18px;
          color: #e8d49a;
        }
        #ace-mm-tally-used { font-weight: 700; color: #fff; font-size: 22px; }
        .ace-mm-tally-sep { margin: 0 6px; color: #6b5230; }
        .ace-mm-tally-total { color: #c9a76b; font-weight: 600; }
        .ace-mm-tally-label { display: block; font-size: 13px; color: #b0a070; margin-top: 2px; }
        .ace-mm-rows {
          max-height: 360px;
          overflow-y: auto;
          padding-right: 4px;
        }
        .ace-mm-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px;
          margin-bottom: 6px;
          background: #1f1812;
          border: 1px solid #3a2e20;
          border-radius: 4px;
          transition: border-color 0.15s;
        }
        .ace-mm-row:hover { border-color: #6b5230; }
        .ace-mm-row-oor { opacity: 0.55; }
        .ace-mm-portrait {
          width: 44px;
          height: 44px;
          border-radius: 4px;
          border: 1px solid #6b5230;
          object-fit: cover;
          flex-shrink: 0;
        }
        .ace-mm-info { flex: 1; min-width: 0; }
        .ace-mm-name { font-size: 15px; font-weight: 600; color: #e8d49a; display: flex; align-items: center; gap: 6px; }
        .ace-mm-meta { display: flex; gap: 10px; font-size: 13px; color: #c0b288; margin-top: 3px; }
        .ace-mm-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 700; }
        .ace-mm-badge-npc { background: #5a2828; color: #f4c4c4; }
        .ace-mm-badge-pc { background: #28425a; color: #c4daf4; }
        .ace-mm-counter { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
        .ace-mm-btn {
          width: 28px;
          height: 28px;
          border-radius: 4px;
          border: 1px solid #6b5230;
          background: #2a1f0a;
          color: #e8d49a;
          font-size: 18px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          line-height: 1;
        }
        .ace-mm-btn:hover { background: #3a2c14; border-color: #c9a76b; }
        .ace-mm-btn:active { transform: scale(0.95); }
        .ace-mm-count { min-width: 28px; text-align: center; font-size: 16px; font-weight: 700; color: #fff; }
        .ace-mm-hint {
          margin-top: 8px;
          font-size: 12px;
          color: #8a7a5a;
          text-align: center;
          font-style: italic;
        }
        .ace-mm-hint i { margin-right: 4px; }
        .ace-mm-confirm-ready { box-shadow: 0 0 8px #c9a76b; }
      </style>
    `;
  }
}
