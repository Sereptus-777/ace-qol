// ─── ACE: QOL — Unified Spell Picker ──────────────────────────────────────────
// One picker class. Four UI variants. All inline-styled (bulletproof against
// DialogV2 CSS stripping). 56×56 portraits, ACE dark wrapper, brand colors.
//
// Variants:
//   distribute       — +/- counters per portrait, total = N (Magic Missile)
//   single           — click one portrait (Hold Person, Disintegrate)
//   single-adjacent  — single, filtered to ≤ 5 ft (Cure Wounds touch)
//   multi            — click up to N portraits (Bless, Faerie Fire)
//
// Phase 1 ships DISTRIBUTE fully implemented (Magic Missile proof of concept).
// Single / multi / single-adjacent are stubs that throw — Phase 2 will fill in
// as Bless / Hold Person / Cure Wounds enter the registry.
//
// Returns: Promise<{ targets?: Actor[], distribution?: Map<Actor, number> } | null>
// null = user cancelled (caller must refund the deferred slot)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";

export class UnifiedSpellPicker {

  /**
   * @param {object} opts
   * @param {object} opts.entry         - registry entry
   * @param {Item}   opts.item          - spell item
   * @param {Actor}  opts.actor         - caster
   * @param {number} opts.castLevel
   * @param {number} opts.spellMod
   * @param {"single"|"single-adjacent"|"multi"|"distribute"} opts.pickerType
   * @returns {Promise<{targets?: Actor[], distribution?: Map<Actor, number>}|null>}
   */
  static async pick(opts) {
    const { entry, item, actor, castLevel, pickerType } = opts;
    if (!entry || !item || !actor) return null;

    const casterToken = actor.getActiveTokens?.()?.[0]
      ?? canvas.tokens?.placeables.find(t => t.actor?.id === actor.id);
    if (!casterToken) {
      ui.notifications?.warn(`${item.name}: caster has no token on this scene.`);
      return null;
    }

    // Build candidates (range + LOS + creature-type filtered)
    const candidates = UnifiedSpellPicker._buildCandidates({
      casterToken,
      casterActor: actor,
      range: entry.range ?? 0,
      filter: entry.picker ?? {},
    });

    if (!candidates.length) {
      ui.notifications?.warn(`${item.name}: no valid targets in range.`);
      return null;
    }

    // Compute N for shapes that need it
    const N = entry.countResolver?.(castLevel, actor.system?.details?.level ?? 1) ?? 1;

    // Pre-fill from game.user.targets
    const preTargets = UnifiedSpellPicker._matchPreTargets(candidates);

    switch (pickerType) {
      case "distribute":
        return UnifiedSpellPicker._showDistributePicker({
          ...opts, candidates, preTargets, N, casterToken,
        });
      case "single":
        return UnifiedSpellPicker._stub("single", item.name);
      case "single-adjacent":
        return UnifiedSpellPicker._stub("single-adjacent", item.name);
      case "multi":
        return UnifiedSpellPicker._stub("multi", item.name);
      default:
        console.warn(`${MODULE_ID} | UnifiedSpellPicker: unknown pickerType "${pickerType}"`);
        return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CANDIDATE BUILDER
  // ═══════════════════════════════════════════════════════════════════════════

  static _buildCandidates({ casterToken, casterActor, range, filter }) {
    const placeables = canvas.tokens?.placeables ?? [];
    const allowSelf       = filter.allowSelf === true;
    const excludeDead     = filter.excludeDead !== false; // default true
    const creatureFilter  = filter.creatureTypeFilter ?? null;

    const out = [];
    for (const tok of placeables) {
      const actor = tok.actor;
      if (!actor) continue;
      const isSelf = actor.id === casterActor.id;
      if (isSelf && !allowSelf) continue;
      if (tok.document?.hidden && !game.user.isGM) continue;

      if (excludeDead) {
        const hp = actor.system?.attributes?.hp?.value ?? 0;
        if (hp <= 0) continue;
      }

      if (creatureFilter) {
        const type = String(actor.system?.details?.type?.value ?? "").toLowerCase();
        if (type !== creatureFilter.toLowerCase()) continue;
      }

      // Distance in feet (PIXI hypotenuse)
      const distPx = Math.hypot(
        (tok.center?.x ?? tok.x) - (casterToken.center?.x ?? casterToken.x),
        (tok.center?.y ?? tok.y) - (casterToken.center?.y ?? casterToken.y),
      );
      const gridSize = canvas.scene?.grid?.size ?? canvas.grid?.size ?? 100;
      const gridDistance = canvas.scene?.grid?.distance ?? 5;
      const distFt = Math.round((distPx / gridSize) * gridDistance);
      const inRange = isSelf ? true : distFt <= range;

      out.push({
        tokenId: tok.id,
        actorId: actor.id,
        actor,
        token: tok,
        name: tok.name ?? actor.name,
        img: tok.document?.texture?.src ?? actor.img,
        ac: actor.system?.attributes?.ac?.value ?? null,
        hp: actor.system?.attributes?.hp?.value ?? 0,
        maxHP: actor.system?.attributes?.hp?.max ?? actor.system?.attributes?.hp?.value ?? 0,
        distFt,
        inRange,
        isSelf,
        isNPC: actor.type === "npc",
      });
    }

    // Sort: in-range NPCs first, then in-range PCs, then OOR by distance
    out.sort((a, b) => {
      if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
      if (a.isNPC !== b.isNPC) return a.isNPC ? -1 : 1;
      return a.distFt - b.distFt;
    });

    return out;
  }

  static _matchPreTargets(candidates) {
    const targeted = new Set([...(game.user.targets ?? [])].map(t => t.id));
    return candidates.filter(c => targeted.has(c.tokenId));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISTRIBUTE PICKER — +/- counters per portrait, total = N
  // ═══════════════════════════════════════════════════════════════════════════

  static async _showDistributePicker({ entry, item, candidates, preTargets, N, castLevel }) {
    return new Promise((resolve) => {
      // Pre-distribute units across pre-targeted tokens (even split + remainder)
      const assignment = new Map(); // tokenId -> unitCount
      if (preTargets.length > 0) {
        const per = Math.floor(N / preTargets.length);
        let rem = N % preTargets.length;
        for (const t of preTargets) {
          assignment.set(t.tokenId, per + (rem > 0 ? 1 : 0));
          if (rem > 0) rem--;
        }
      }
      const initialTotal = [...assignment.values()].reduce((s, n) => s + n, 0);

      const rangeFt = entry.range ?? 0;
      const unitName  = UnifiedSpellPicker._unitNoun(entry); // "dart" for Magic Missile, "ray" for Scorching Ray, etc.
      const unitLabel = `${unitName}${N === 1 ? "" : "s"}`;
      const perUnitText = entry.unit
        ? `${entry.unit.formula} ${entry.unit.type}`
        : "per unit";

      const rangeColor = (distFt, inRange) => {
        if (!inRange) return "#d44";
        if (distFt > rangeFt * 0.66) return "#e8a14b";
        return "#7ec97e";
      };

      // ── Inline styles (bulletproof) ──
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
        const badge = c.isNPC ? `<span style="${BADGE_NPC}">NPC</span>` : `<span style="${BADGE_PC}">PC</span>`;
        return `
          <div class="ace-pipe-row" data-token-id="${c.tokenId}" style="${rowStyle}">
            <img class="ace-pipe-portrait" width="56" height="56" src="${c.img}" alt="${c.name}" style="${PORTRAIT_STYLE}" />
            <div style="${INFO_STYLE}">
              <div style="${NAME_STYLE}">${c.name} ${badge}</div>
              <div style="${META_STYLE}">
                <span>AC ${c.ac ?? "?"}</span>
                <span>HP ${c.hp}/${c.maxHP}</span>
                <span style="color: ${rangeColor(c.distFt, c.inRange)}">${c.distFt} ft${c.inRange ? "" : " (out of range)"}</span>
              </div>
            </div>
            <div style="${COUNTER_STYLE}">
              <button type="button" data-action="dec" data-token-id="${c.tokenId}" aria-label="Remove ${unitName}" style="${BTN_STYLE}">−</button>
              <span data-count-for="${c.tokenId}" style="${COUNT_STYLE}">${current}</span>
              <button type="button" data-action="inc" data-token-id="${c.tokenId}" aria-label="Add ${unitName}" style="${BTN_STYLE}">+</button>
            </div>
          </div>
        `;
      };

      const subtitleText = entry.flavorOnConfirm
        ? `${entry.flavorOnConfirm} (${perUnitText} per ${unitName})`
        : `Distribute ${unitLabel} across targets. Each ${unitName} deals ${perUnitText}.`;

      const content = `
        <div style="color:#f0e4c0;background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);padding:12px;border-radius:6px;font-family:'Signika','Helvetica Neue',sans-serif;">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #4a3a28;">
            <i class="fas fa-burst" style="color:#c9a76b;font-size:28px;"></i>
            <div>
              <div style="font-size:18px;font-weight:600;color:#e8d49a;">${item.name}${castLevel ? ` <span style="font-size:13px;color:#c0b288;">(L${castLevel})</span>` : ""}</div>
              <div style="font-size:14px;color:#c0b288;margin-top:2px;">${subtitleText}</div>
            </div>
          </div>
          <div style="background:#2a1f0a;border:1px solid #6b5230;border-radius:4px;padding:8px 12px;margin-bottom:10px;text-align:center;font-size:18px;color:#e8d49a;">
            <span id="ace-pipe-tally-used" style="font-weight:700;color:#fff;font-size:22px;">${initialTotal}</span>
            <span style="margin:0 6px;color:#6b5230;">/</span>
            <span style="color:#c9a76b;font-weight:600;">${N}</span>
            <span style="display:block;font-size:13px;color:#b0a070;margin-top:2px;">${unitLabel} assigned</span>
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
        window: { title: `${item.name} — Distribute ${unitLabel}`, icon: "fas fa-burst" },
        position: { width: 560, height: "auto" },
        content,
        buttons: [
          {
            action: "confirm",
            label: `Launch ${unitLabel}`,
            icon: "fas fa-check",
            default: true,
            callback: () => {
              const map = new Map();
              for (const [tokenId, n] of assignment.entries()) {
                if (n <= 0) continue;
                const c = candidates.find(cc => cc.tokenId === tokenId);
                if (c?.actor) map.set(c.actor, n);
              }
              if (map.size === 0) { resolve(null); return; }
              resolve({ distribution: map });
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

      // Wire +/- buttons once DOM is in place
      setTimeout(() => {
        UnifiedSpellPicker._wireDistributeCounters(dialog.element ?? document, assignment, N);
      }, 50);
    });
  }

  static _wireDistributeCounters(root, assignment, N) {
    try {
      const tallyEl = root.querySelector?.("#ace-pipe-tally-used");
      const confirmBtn = root.querySelector?.('button[data-action="confirm"]');

      const refreshConfirm = () => {
        const total = [...assignment.values()].reduce((s, n) => s + n, 0);
        if (tallyEl) tallyEl.textContent = String(total);
        if (confirmBtn) {
          const ok = total === N;
          confirmBtn.disabled = !ok;
          confirmBtn.classList.toggle("ace-pipe-confirm-ready", ok);
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
            if (total >= N) return; // can't exceed pool
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
      console.warn(`${MODULE_ID} | UnifiedSpellPicker wire-counters failed (non-fatal):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STUBS — Phase 2 variants
  // ═══════════════════════════════════════════════════════════════════════════

  static _stub(variant, spellName) {
    console.warn(`${MODULE_ID} | UnifiedSpellPicker.${variant} not yet implemented — falling through (${spellName})`);
    return null; // null = pipeline falls through to dnd5e default
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Derive a noun for what's being distributed based on the spell name.
   * Magic Missile → "dart". Scorching Ray → "ray". Default → "unit".
   */
  static _unitNoun(entry) {
    // Future: read from entry.unitNoun if explicitly set
    if (entry.unitNoun) return entry.unitNoun;
    // Defensive default
    return "dart";
  }
}
