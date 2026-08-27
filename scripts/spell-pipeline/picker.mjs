// ─── ACE: QOL — Unified Spell Picker ──────────────────────────────────────────
// One picker class. Four UI variants. All inline-styled (bulletproof against
// DialogV2 CSS stripping). 56×56 portraits, ACE dark wrapper, brand colors.
//
// Variants:
//   distribute       — +/- counters per portrait, total = N (Magic Missile)
//   single           — click one portrait (Hold Person, Disintegrate)
//   single-adjacent  — single, filtered to ≤ 5 feet (Cure Wounds touch)
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
import { aceDistanceFt } from "../geometry-utils.mjs";
import { Situation } from "../situation.mjs";

// ─── Creature snapshot access (2026-07-28) ───────────────────────────────────
// Facts about a creature come from the ONE reader, never from actor.system —
// the audit found every pipeline reaching into raw data and getting shapes
// wrong. Cached briefly; expired fast because state changes mid-fight.
const _aceCreatureCache = new Map();
function _aceCreature(actor, token = null) {
  if (!actor) return {};
  const key = actor.uuid ?? actor.id;
  const hit = _aceCreatureCache.get(key);
  if (hit) return hit;
  let c = {};
  try { c = Situation.readCreature(actor, token) ?? {}; } catch (_) { c = {}; }
  _aceCreatureCache.set(key, c);
  setTimeout(() => _aceCreatureCache.delete(key), 3000);
  return c;
}


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
    const charLevel = _aceCreature(actor)?.level
      ?? 1;
    const N = entry.countResolver?.(castLevel, charLevel) ?? 1;

    // Pre-fill from game.user.targets
    const preTargets = UnifiedSpellPicker._matchPreTargets(candidates);

    switch (pickerType) {
      case "distribute":
        return UnifiedSpellPicker._showDistributePicker({
          ...opts, candidates, preTargets, N, casterToken,
        });
      case "single":
        return UnifiedSpellPicker._showSinglePicker({
          ...opts, candidates, preTargets, N: 1, casterToken,
        });
      case "single-adjacent":
        // Filter to adjacent candidates only (≤ 5 feet)
        return UnifiedSpellPicker._showSinglePicker({
          ...opts,
          candidates: candidates.filter(c => c.distFt <= 5 || c.isSelf),
          preTargets: preTargets.filter(c => c.distFt <= 5 || c.isSelf),
          N: 1,
          casterToken,
        });
      case "multi":
        return UnifiedSpellPicker._showMultiPicker({
          ...opts, candidates, preTargets, N, casterToken,
        });
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

      // LINE OF SIGHT — exclude a target the caster can't SEE (a wall or closed door
      // between them). A creature behind two doors is in straight-line range but not a
      // valid spell target. Same sight-collision test as the counterspell fix.
      if (!isSelf) {
        try {
          const blocked = CONFIG.Canvas?.polygonBackends?.sight?.testCollision?.(
            casterToken.center, tok.center, { type: "sight", mode: "any" }
          );
          if (blocked) continue;
        } catch (_) { /* test unavailable → don't false-exclude */ }
      }

      if (excludeDead) {
        const hp = _aceCreature(actor)?.hp?.value ?? 0;
        if (hp <= 0) continue;
      }

      if (creatureFilter) {
        const type = String(_aceCreature(actor)?.type ?? "").toLowerCase();
        if (type !== creatureFilter.toLowerCase()) continue;
      }

      // Nearest-edge, size-aware, 3D distance in feet (canonical — geometry-utils).
      const distFt = Math.round(aceDistanceFt(casterToken, tok));
      const inRange = isSelf ? true : distFt <= range;

      out.push({
        tokenId: tok.id,
        actorId: actor.id,
        actor,
        token: tok,
        name: tok.name ?? actor.name,
        img: tok.document?.texture?.src ?? actor.img,
        ac: _aceCreature(actor)?.ac ?? null,
        hp: _aceCreature(actor)?.hp?.value ?? 0,
        maxHP: _aceCreature(actor)?.hp?.max ?? _aceCreature(actor)?.hp?.value ?? 0,
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
                <span style="color: ${rangeColor(c.distFt, c.inRange)}">${c.distFt} feet${c.inRange ? "" : " (out of range)"}</span>
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
  // SINGLE PICKER — click one target, confirm. Returns { target: candidate }
  // ═══════════════════════════════════════════════════════════════════════════

  static async _showSinglePicker(opts) {
    const { entry, item, candidates, preTargets, castLevel } = opts;
    return new Promise((resolve) => {
      // Pre-fill: if one Q-target is in candidates, pre-select it
      const initialSelected = preTargets.length === 1 ? preTargets[0].tokenId : null;
      let selectedId = initialSelected;

      const STYLES = UnifiedSpellPicker._sharedStyles();
      const buildRowHtml = (c) => {
        const isSelected = c.tokenId === selectedId;
        const rowStyle = `${c.inRange ? STYLES.ROW : STYLES.ROW_OOR}${isSelected ? "border-color:#c9a76b;background:#2f2515;" : ""}`;
        const badge = c.isNPC ? `<span style="${STYLES.BADGE_NPC}">NPC</span>` : `<span style="${STYLES.BADGE_PC}">PC</span>`;
        return `
          <div class="ace-pipe-row" data-token-id="${c.tokenId}" style="${rowStyle};cursor:pointer;">
            <img width="56" height="56" src="${c.img}" alt="${c.name}" style="${STYLES.PORTRAIT}" />
            <div style="${STYLES.INFO}">
              <div style="${STYLES.NAME}">${c.name} ${badge}</div>
              <div style="${STYLES.META}">
                <span>AC ${c.ac ?? "?"}</span>
                <span>HP ${c.hp}/${c.maxHP}</span>
                <span style="color: ${UnifiedSpellPicker._rangeColor(c.distFt, c.inRange, entry.range)}">${c.distFt} feet${c.inRange ? "" : " (out of range)"}</span>
              </div>
            </div>
            <div style="flex-shrink:0;">${isSelected ? `<i class="fas fa-circle-check" style="color:#7ec97e;font-size:22px;"></i>` : `<i class="far fa-circle" style="color:#6b5230;font-size:22px;"></i>`}</div>
          </div>
        `;
      };

      const content = `
        <div style="${STYLES.CONTAINER}">
          ${UnifiedSpellPicker._headerHtml(item, castLevel, entry, candidates.length, "Pick ONE target.")}
          <div style="max-height:380px;overflow-y:auto;padding-right:4px;">
            ${candidates.map(buildRowHtml).join("")}
          </div>
        </div>
      `;

      const dialog = new foundry.applications.api.DialogV2({
        window: { title: `${item.name} — Pick Target`, icon: "fas fa-crosshairs" },
        position: { width: 560, height: "auto" },
        content,
        buttons: [
          {
            action: "confirm",
            label: "Cast",
            icon: "fas fa-check",
            default: true,
            callback: () => {
              if (!selectedId) { resolve(null); return; }
              const c = candidates.find(cc => cc.tokenId === selectedId);
              if (!c) { resolve(null); return; }
              resolve({ target: c, targets: [c] });
            },
          },
          { action: "cancel", label: "Cancel", icon: "fas fa-times", callback: () => resolve(null) },
        ],
        rejectClose: false,
        close: () => resolve(null),
      });

      dialog.render({ force: true });

      setTimeout(() => {
        const root = dialog.element ?? document;
        const confirmBtn = root.querySelector?.('button[data-action="confirm"]');
        if (confirmBtn) confirmBtn.disabled = !selectedId;
        root.querySelectorAll?.(".ace-pipe-row").forEach(row => {
          row.addEventListener("click", () => {
            selectedId = row.dataset.tokenId;
            // Repaint rows (light update — could re-render but simpler to mark)
            root.querySelectorAll(".ace-pipe-row").forEach(r => {
              const isThis = r.dataset.tokenId === selectedId;
              r.style.borderColor = isThis ? "#c9a76b" : "#3a2e20";
              r.style.background = isThis ? "#2f2515" : "#1f1812";
              const icon = r.querySelector("i.fas, i.far");
              if (icon) {
                icon.className = isThis ? "fas fa-circle-check" : "far fa-circle";
                icon.style.color = isThis ? "#7ec97e" : "#6b5230";
              }
            });
            if (confirmBtn) confirmBtn.disabled = false;
          });
        });
      }, 50);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI PICKER — delegates to the legacy SpellTargetPicker which has a
  // proven portrait-grid layout + good CSS. The pipeline owns dispatch +
  // effect application; the picker UI itself is the legacy one.
  // Returns { targets: [{actor, token, name, img, ...}] }
  // ═══════════════════════════════════════════════════════════════════════════

  static async _showMultiPicker(opts) {
    const { entry, item, actor, N } = opts;
    try {
      const { SpellTargetPicker } = await import("../spell-target-picker.mjs");
      const pickedActors = await SpellTargetPicker.pick({
        spellItem: item,
        casterActor: actor,
        maxTargets: N,
        rangeFt: entry.range ?? null,
        allowSelf: entry.picker?.allowSelf !== false,
      });
      if (!pickedActors || pickedActors.length === 0) return null;

      // Transform Actor[] back into the candidate-shape the pipeline expects.
      // Find each actor's token + carry name/img through.
      const targets = pickedActors.map(targetActor => {
        const token = targetActor.getActiveTokens?.()?.[0]
                   ?? canvas.tokens?.placeables.find(t => t.actor?.id === targetActor.id)
                   ?? null;
        return {
          actor: targetActor,
          token,
          tokenId: token?.id,
          name: token?.name ?? targetActor.name,
          img: targetActor.img ?? token?.document?.texture?.src,
        };
      });
      return { targets };
    } catch (err) {
      console.error(`${MODULE_ID} | UnifiedSpellPicker._showMultiPicker: legacy SpellTargetPicker call failed:`, err);
      return null;
    }
  }

  // Old in-house multi-picker (replaced by legacy delegation above) kept here
  // unused for reference. Future shapes that need different selection logic
  // (e.g., chained spells with distance-from-primary constraint) can revive
  // this pattern instead of reinventing.
  static async _showMultiPickerLegacyInhouse(opts) {
    const { entry, item, candidates, preTargets, N, castLevel } = opts;
    return new Promise((resolve) => {
      const selected = new Set(preTargets.slice(0, N).map(p => p.tokenId));
      const rangeFt = entry.range ?? 0;

      // ── Tile-grid styles (inline so DialogV2 can't strip them) ──
      const GRID_STYLE = "display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;padding:6px;max-height:480px;overflow-y:auto;";
      const TILE_BASE = "position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 8px 8px;background:#1f1812;border:2px solid #3a2e20;border-radius:6px;cursor:pointer;transition:transform 0.08s ease,border-color 0.08s ease,background 0.08s ease;";
      const TILE_INVALID = "opacity:0.55;";
      const TILE_SELECTED = "border-color:#c9a76b;background:#2f2515;box-shadow:0 0 8px rgba(201,167,107,0.35);";
      const PORTRAIT = "width:96px;height:96px;border-radius:6px;border:2px solid #6b5230;object-fit:cover;display:block;";
      const NAME = "font-size:13px;font-weight:600;color:#e8d49a;text-align:center;line-height:1.2;word-break:break-word;max-width:130px;";
      const DISP_FRIENDLY = "display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;background:#28425a;color:#c4daf4;letter-spacing:0.5px;";
      const DISP_HOSTILE = "display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;background:#5a2828;color:#f4c4c4;letter-spacing:0.5px;";
      const DISP_NEUTRAL = "display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;background:#3a3a3a;color:#ccc;letter-spacing:0.5px;";
      const DIST_IN = "font-size:11px;color:#7ec97e;font-weight:600;";
      const DIST_OUT = "font-size:11px;color:#d44;font-weight:600;";
      const DIST_NEAR = "font-size:11px;color:#e8a14b;font-weight:600;";
      const DIST_SELF = "font-size:11px;color:#c9a76b;font-weight:700;letter-spacing:0.5px;";
      const SELF_BADGE = "position:absolute;top:4px;right:4px;background:rgba(201,167,107,0.85);color:#1a1410;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:0.5px;";
      const CHECK_BADGE = "position:absolute;top:4px;left:4px;font-size:18px;color:#7ec97e;text-shadow:0 0 4px rgba(0,0,0,0.6);";

      const dispLabel = (c) => {
        const disp = c.token?.document?.disposition ?? c.actor?.prototypeToken?.disposition ?? 0;
        if (disp === 1) return { text: "FRIENDLY", style: DISP_FRIENDLY };
        if (disp === -1) return { text: "HOSTILE", style: DISP_HOSTILE };
        return { text: "NEUTRAL", style: DISP_NEUTRAL };
      };

      const distChip = (c) => {
        if (c.isSelf) return { text: "SELF", style: DIST_SELF };
        if (!c.inRange) return { text: `${c.distFt} feet (OOR)`, style: DIST_OUT };
        if (c.distFt > rangeFt * 0.66) return { text: `${c.distFt} feet`, style: DIST_NEAR };
        return { text: `${c.distFt} feet`, style: DIST_IN };
      };

      const buildTileHtml = (c) => {
        const isSelected = selected.has(c.tokenId);
        const tileStyle = `${TILE_BASE}${c.inRange ? "" : TILE_INVALID}${isSelected ? TILE_SELECTED : ""}`;
        const disp = dispLabel(c);
        const dist = distChip(c);
        const selfBadge = c.isSelf ? `<div style="${SELF_BADGE}">SELF</div>` : "";
        const checkBadge = isSelected ? `<div style="${CHECK_BADGE}"><i class="fas fa-circle-check"></i></div>` : "";
        return `
          <div class="ace-pipe-tile" data-token-id="${c.tokenId}" style="${tileStyle}">
            ${selfBadge}
            ${checkBadge}
            <img src="${c.img}" alt="${c.name}" style="${PORTRAIT}" />
            <div style="${NAME}">${c.name}</div>
            <div style="${disp.style}">${disp.text}</div>
            <div style="${dist.style}">${dist.text}</div>
          </div>
        `;
      };

      const content = `
        <div style="color:#f0e4c0;background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);padding:12px;border-radius:6px;font-family:'Signika','Helvetica Neue',sans-serif;">
          ${UnifiedSpellPicker._headerHtml(item, castLevel, entry, candidates.length, `Pick up to ${N} target${N === 1 ? "" : "s"} — click a portrait to toggle.`)}
          <div style="background:#2a1f0a;border:1px solid #6b5230;border-radius:4px;padding:6px 12px;margin-bottom:8px;text-align:center;font-size:15px;color:#e8d49a;">
            <span id="ace-pipe-tally-used" style="font-weight:700;color:#fff;font-size:18px;">${selected.size}</span>
            <span style="margin:0 6px;color:#6b5230;">/</span>
            <span style="color:#c9a76b;font-weight:600;">${N}</span>
            <span style="margin-left:6px;font-size:13px;color:#b0a070;">targets selected</span>
          </div>
          <div style="${GRID_STYLE}">
            ${candidates.map(buildTileHtml).join("")}
          </div>
          <div style="margin-top:6px;font-size:11px;color:#8a7a5a;text-align:center;font-style:italic;">
            Out-of-range targets shown dim — GM may allow at table discretion.
          </div>
        </div>
      `;

      const dialog = new foundry.applications.api.DialogV2({
        window: { title: `Cast ${item.name} — Pick Targets`, icon: "fas fa-bullseye" },
        position: { width: 640, height: "auto" },
        content,
        buttons: [
          {
            action: "confirm",
            label: `Cast ${item.name}`,
            icon: "fas fa-sparkles",
            default: true,
            callback: () => {
              if (selected.size === 0) { resolve(null); return; }
              const picked = candidates.filter(c => selected.has(c.tokenId));
              resolve({ targets: picked });
            },
          },
          { action: "cancel", label: "Cancel", icon: "fas fa-times", callback: () => resolve(null) },
        ],
        rejectClose: false,
        close: () => resolve(null),
      });

      dialog.render({ force: true });

      setTimeout(() => {
        const root = dialog.element ?? document;
        const tallyEl = root.querySelector?.("#ace-pipe-tally-used");
        const confirmBtn = root.querySelector?.('button[data-action="confirm"]');
        const refresh = () => {
          if (tallyEl) tallyEl.textContent = String(selected.size);
          if (confirmBtn) confirmBtn.disabled = selected.size === 0;
        };
        refresh();
        root.querySelectorAll?.(".ace-pipe-tile").forEach(tile => {
          tile.addEventListener("click", () => {
            const id = tile.dataset.tokenId;
            if (selected.has(id)) {
              selected.delete(id);
            } else {
              if (selected.size >= N) {
                // Drop oldest to make room (matches legacy picker UX)
                const first = selected.values().next().value;
                selected.delete(first);
                const firstTile = root.querySelector(`.ace-pipe-tile[data-token-id="${first}"]`);
                if (firstTile) {
                  firstTile.style.borderColor = "#3a2e20";
                  firstTile.style.background = "#1f1812";
                  firstTile.style.boxShadow = "none";
                  firstTile.querySelector('[style*="position:absolute;top:4px;left:4px"]')?.remove();
                }
              }
              selected.add(id);
            }
            const isThis = selected.has(id);
            tile.style.borderColor = isThis ? "#c9a76b" : "#3a2e20";
            tile.style.background = isThis ? "#2f2515" : "#1f1812";
            tile.style.boxShadow = isThis ? "0 0 8px rgba(201,167,107,0.35)" : "none";
            // Add/remove the check badge in top-left
            const existingCheck = tile.querySelector('[style*="position:absolute;top:4px;left:4px"]');
            if (isThis && !existingCheck) {
              const badge = document.createElement("div");
              badge.style.cssText = "position:absolute;top:4px;left:4px;font-size:18px;color:#7ec97e;text-shadow:0 0 4px rgba(0,0,0,0.6);";
              badge.innerHTML = '<i class="fas fa-circle-check"></i>';
              tile.appendChild(badge);
            } else if (!isThis && existingCheck) {
              existingCheck.remove();
            }
            refresh();
          });
        });
      }, 50);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED HTML / STYLE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  static _sharedStyles() {
    return {
      ROW: "display:flex;align-items:center;gap:10px;padding:8px;margin-bottom:6px;background:#1f1812;border:1px solid #3a2e20;border-radius:4px;transition:border-color 0.1s ease,background 0.1s ease;",
      ROW_OOR: "display:flex;align-items:center;gap:10px;padding:8px;margin-bottom:6px;background:#1f1812;border:1px solid #3a2e20;border-radius:4px;opacity:0.55;",
      PORTRAIT: "width:56px;height:56px;border-radius:4px;border:1px solid #6b5230;object-fit:cover;flex-shrink:0;display:block;",
      INFO: "flex:1;min-width:0;color:#f0e4c0;",
      NAME: "font-size:15px;font-weight:600;color:#e8d49a;display:flex;align-items:center;gap:6px;",
      META: "display:flex;gap:10px;font-size:13px;color:#c0b288;margin-top:3px;",
      BADGE_NPC: "font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700;background:#5a2828;color:#f4c4c4;",
      BADGE_PC: "font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700;background:#28425a;color:#c4daf4;",
      CONTAINER: "color:#f0e4c0;background:linear-gradient(180deg,#1a1410 0%,#0f0a08 100%);padding:12px;border-radius:6px;font-family:'Signika','Helvetica Neue',sans-serif;",
    };
  }

  static _rangeColor(distFt, inRange, rangeFt) {
    if (!inRange) return "#d44";
    if (distFt > (rangeFt ?? 0) * 0.66) return "#e8a14b";
    return "#7ec97e";
  }

  static _headerHtml(item, castLevel, entry, candidateCount, subtitleSuffix = "") {
    const rangeStr = entry.range === 0 ? "Self" : entry.range >= 999 ? "Sight" : `${entry.range} feet`;
    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #4a3a28;">
        <i class="fas ${entry.shape === "save-single" ? "fa-dice" : entry.shape === "touch" ? "fa-hand-holding-heart" : "fa-bullseye"}" style="color:#c9a76b;font-size:28px;"></i>
        <div>
          <div style="font-size:18px;font-weight:600;color:#e8d49a;">${item.name}${castLevel ? ` <span style="font-size:13px;color:#c0b288;">(L${castLevel})</span>` : ""}</div>
          <div style="font-size:13px;color:#c0b288;margin-top:2px;">Range ${rangeStr} · ${candidateCount} eligible target${candidateCount === 1 ? "" : "s"}. ${subtitleSuffix}</div>
        </div>
      </div>
    `;
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
