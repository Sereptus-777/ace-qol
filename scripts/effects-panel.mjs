// ─── ACE: QOL — Effects Panel ────────────────────────────────────────────────
// Floating side panel that lists the controlled token's combat effects.
//
// Strict filter shows only:
//   - Conditions (effect.statuses.size > 0 — stunned, prone, blinded, etc.)
//   - Time-limited effects (duration.rounds/.turns/.seconds > 0)
//   - Spell-sourced effects (origin trace shows a spell)
//
// Passive effects (worn items, class features, racial traits) are hidden by
// default and revealed via an expandable "passive effects" toggle.
//
// Class auras (Paladin Aura of Protection, Aura of Courage, etc.) are
// detected from class levels (no Active Effect needed) and listed separately.
//
// Slides with the sidebar so it doesn't overlap chat/sidebar UI.
//
//   Header click  → collapse / expand the entire panel
//   Left-click    → toggle inline description tooltip
//   Right-click   → confirmation → disable (default) or delete (per setting)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

const PANEL_ID = "ace-qol-effects-panel";

// ─── Class aura definitions (level-gated, computed from actor classes) ──────
// Each entry: { className, levelMin, name, icon, description: (actor) => string,
//               radius: (level) => number, subclass: optional subclass id }
const CLASS_AURAS = [
  {
    className: "paladin", levelMin: 6,
    name: "Aura of Protection",
    icon: "icons/equipment/shield/heater-crystal-blue.webp",
    radius: (lvl) => lvl >= 18 ? 30 : 10,
    description: (actor, lvl) => {
      const cha = actor.system?.abilities?.cha?.mod ?? 0;
      const r = lvl >= 18 ? 30 : 10;
      return `All friendly creatures within ${r}ft (including you) gain a +${cha} bonus to saving throws.`;
    },
  },
  {
    className: "paladin", levelMin: 10,
    name: "Aura of Courage",
    icon: "icons/magic/light/explosion-star-glow-yellow.webp",
    radius: (lvl) => lvl >= 18 ? 30 : 10,
    description: (_, lvl) => {
      const r = lvl >= 18 ? 30 : 10;
      return `You and friendly creatures within ${r}ft can't be frightened while you are conscious.`;
    },
  },
  {
    className: "paladin", levelMin: 7, subclass: "devotion",
    name: "Aura of Devotion",
    icon: "icons/magic/holy/angel-wings-gray.webp",
    radius: (lvl) => lvl >= 18 ? 30 : 10,
    description: (_, lvl) => `You and friendly creatures within ${lvl >= 18 ? 30 : 10}ft can't be charmed.`,
  },
  {
    className: "paladin", levelMin: 7, subclass: "ancients",
    name: "Aura of Warding",
    icon: "icons/magic/nature/leaf-glow-green.webp",
    radius: (lvl) => lvl >= 18 ? 30 : 10,
    description: (_, lvl) => `You and friendly creatures within ${lvl >= 18 ? 30 : 10}ft have resistance to damage from spells.`,
  },
  {
    className: "paladin", levelMin: 7, subclass: "vengeance",
    name: "Aura of Hate",
    icon: "icons/magic/death/skull-horned-goat-black.webp",
    radius: (lvl) => lvl >= 18 ? 30 : 10,
    description: (actor, lvl) => {
      const cha = actor.system?.abilities?.cha?.mod ?? 0;
      return `You and any fiends/undead within ${lvl >= 18 ? 30 : 10}ft gain a +${cha} bonus to melee weapon damage rolls.`;
    },
  },
];

export class EffectsPanel {

  constructor() {
    this._currentActor = null;
    this._panelEl = null;
    this._collapsed = true;        // default: collapsed (per user request)
    this._showPassives = false;    // passives section default hidden
    this._userMoved = false;       // true once user drags — disables auto-position
    this._sidebarObserver = null;
    this._registerHooks();
  }

  _registerHooks() {
    Hooks.on("controlToken", (token, controlled) => this._onControlToken(token, controlled));
    Hooks.on("deleteToken",  (tokenDoc) => {
      if (this._currentActor && tokenDoc.actor?.id === this._currentActor.id) this._hide();
    });

    const refreshIfMine = (effect) => {
      const actor = effect?.parent;
      if (actor && this._currentActor && actor.id === this._currentActor.id) this._render();
    };
    Hooks.on("createActiveEffect", refreshIfMine);
    Hooks.on("updateActiveEffect", refreshIfMine);
    Hooks.on("deleteActiveEffect", refreshIfMine);

    // Foundry hook fallback (fires after collapse animation completes)
    Hooks.on("collapseSidebar", () => {
      if (this._panelEl && !this._userMoved) this._applyPosition();
    });

    // canvasReady fires on initial login + every scene change. Check for
    // already-controlled tokens (controlToken hook doesn't fire for those).
    Hooks.on("canvasReady", () => {
      setTimeout(() => {
        const controlled = canvas.tokens?.controlled ?? [];
        if (controlled.length > 0) this._onControlToken(controlled[0], true);
      }, 200); // Brief delay to let assigned-character selection settle
    });

    // MutationObserver on #sidebar-content for INSTANT reposition during the
    // collapse animation — same approach ace-engine uses for smooth tracking.
    Hooks.once("ready", () => this._bindSidebarObserver());

    // v0.4.22.13: debounced resize handler. Without the 120ms gate,
    // a fluid window-drag fired `_applyPosition` dozens of times per
    // second, recomputing layout each tick. Single trailing-edge
    // call is enough — users don't perceive the difference.
    let _resizeTimer = null;
    window.addEventListener("resize", () => {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        if (this._panelEl && !this._userMoved) this._applyPosition();
      }, 120);
    });
  }

  _bindSidebarObserver() {
    if (this._sidebarObserver) return;
    // Watch the `#sidebar` element itself — in V13 it carries the
    // `collapsed` class toggle, in V12 it grows/shrinks even if no class
    // toggles. Combined with collapseSidebar hook fallback, this fires in
    // BOTH directions (expand AND collapse), regardless of Foundry version.
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) {
      setTimeout(() => this._bindSidebarObserver(), 500);
      return;
    }

    const reposition = () => {
      if (this._panelEl && !this._userMoved) this._applyPosition();
    };

    // MutationObserver on `#sidebar` — V13 toggles `collapsed` here on
    // every state change. Also observe `#sidebar-content` for V12 compat.
    this._sidebarObserver = new MutationObserver(reposition);
    this._sidebarObserver.observe(sidebar, {
      attributes: true,
      attributeFilter: ["class"],
    });
    const contentEl = document.getElementById("sidebar-content");
    if (contentEl) {
      this._sidebarObserver.observe(contentEl, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    // Foundry's collapseSidebar hook fires in V12 + V13 in both directions.
    // Guaranteed to catch state changes even if the class observer misses.
    this._sidebarHookBound = Hooks.on("collapseSidebar", reposition);
  }

  _onControlToken(token, controlled) {
    if (!QolSettings.get("enableEffectsPanel")) { this._hide(); return; }
    if (!controlled) {
      if (canvas.tokens?.controlled?.length === 0) this._hide();
      else {
        const next = canvas.tokens.controlled[canvas.tokens.controlled.length - 1];
        if (next.actor && this._canShowFor(next.actor)) this._show(next.actor);
        else this._hide();
      }
      return;
    }
    if (!token.actor || !this._canShowFor(token.actor)) { this._hide(); return; }
    this._show(token.actor);
  }

  _canShowFor(actor) {
    const mode = QolSettings.get("effectsPanelFor") ?? "default";
    if (game.user.isGM) return mode !== "owned";
    return actor.testUserPermission(game.user, "OWNER");
  }

  _show(actor) {
    this._currentActor = actor;
    this._render();
  }

  _hide() {
    this._currentActor = null;
    if (this._panelEl) {
      this._panelEl.remove();
      this._panelEl = null;
    }
  }

  /** Public: reset to auto-positioned (next to sidebar). Call from console if stuck. */
  resetPosition() {
    this._userMoved = false;
    this._lastPosition = null;
    if (this._panelEl) {
      this._panelEl.style.transition = "";
      this._applyPosition();
    }
    console.log(`${MODULE_ID} | Effects panel position reset`);
  }

  _ensurePanel() {
    if (this._panelEl?.isConnected) return this._panelEl;
    const el = document.createElement("div");
    el.id = PANEL_ID;
    el.className = "ace-qol-effects-panel";
    document.body.appendChild(el);
    this._panelEl = el;
    // Restore the user's last drag position (if any), else apply default
    if (this._userMoved && this._lastPosition) {
      const { left, top } = this._lastPosition;
      el.style.left = `${left}px`;
      el.style.top  = `${top}px`;
      el.style.right = el.style.bottom = "";
    } else {
      this._applyPosition();
    }
    this._initDrag();
    return el;
  }

  _applyPosition() {
    if (!this._panelEl || this._userMoved) return;
    const pos = QolSettings.get("effectsPanelPosition") ?? "top-right";
    const cs = this._panelEl.style;
    cs.top = cs.bottom = cs.left = cs.right = "";

    // DFreds-style: read CSS variables Foundry exposes for sidebar metrics.
    // Falls back gracefully if vars don't exist or sidebar tabs aren't found.
    let rightOffset = 16;
    if (pos === "top-right" || pos === "bottom-right") {
      rightOffset = this._computeRightOffset();
    }

    switch (pos) {
      case "top-left":     cs.top = "10px";    cs.left = "16px";  break;
      case "bottom-left":  cs.bottom = "60px"; cs.left = "16px";  break;
      case "bottom-right": cs.bottom = "60px"; cs.right = `${rightOffset}px`; break;
      case "top-right":
      default:             cs.top = "10px";    cs.right = `${rightOffset}px`; break;
    }
  }

  _computeRightOffset() {
    const PADDING = 48;   // bumped from 24 → user reported icons still half-covered
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return PADDING + 60;

    const root = getComputedStyle(document.documentElement);

    // V13 path — sidebar carries `collapsed` class, widths in two CSS vars.
    // The sidebar element's reported width INCLUDES its tabs region in V13,
    // so use the var directly without separately adding tabs.
    const wExp = parseInt(root.getPropertyValue("--sidebar-width-expanded"));
    const wCol = parseInt(root.getPropertyValue("--sidebar-width-collapsed"));
    if (Number.isFinite(wExp) && Number.isFinite(wCol)) {
      const isCollapsed = sidebar.classList.contains("collapsed");
      return (isCollapsed ? wCol : wExp) + PADDING;
    }

    // V12 path — `#sidebar-content.expanded` toggles, tabs separate from content
    const contentEl  = document.getElementById("sidebar-content");
    const isExpanded = !!contentEl?.classList.contains("expanded");
    const tabsEl = sidebar.querySelector("nav.tabs")
                ?? document.getElementById("sidebar-tabs");
    const tabsW = tabsEl ? tabsEl.getBoundingClientRect().width : 58;
    const sw    = parseInt(root.getPropertyValue("--sidebar-width")) || 300;
    const sg    = parseInt(root.getPropertyValue("--sidebar-scroll-gutter")) || 12;
    return tabsW + (isExpanded ? sw + sg : 0) + PADDING;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Drag — grab anywhere non-interactive to move the panel
  // ═══════════════════════════════════════════════════════════════════════════

  _initDrag() {
    if (this._dragBound) return;
    this._dragBound = true;

    // Skip drag start on these — they need their own click/contextmenu/scroll
    const INTERACTIVE = "button, a, input, textarea, select, [contenteditable]";
    const PANEL_INTERACTIVE = ".ace-qol-effect-row, .ace-qol-effects-passive-toggle, .ace-qol-effects-panel-header, .ace-qol-effect-tooltip";

    const DRAG_THRESHOLD = 5;
    let dragging = false;
    let armed    = false;
    let startX, startY, origLeft, origTop;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (!this._panelEl?.contains(e.target)) return;
      if (e.target.closest(INTERACTIVE)) return;
      if (e.target.closest(PANEL_INTERACTIVE)) return;
      armed = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this._panelEl.getBoundingClientRect();
      origLeft = rect.left;
      origTop  = rect.top;
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!armed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        dragging = true;
        this._userMoved = true;
        const cs = this._panelEl.style;
        cs.transition = "none"; // kill the CSS transition that causes "magnetic" lag
        cs.right = cs.bottom = "";
        cs.left = `${origLeft}px`;
        cs.top  = `${origTop}px`;
      }
      if (dragging) {
        const newLeft = origLeft + dx;
        const newTop  = origTop  + dy;
        this._panelEl.style.left = `${newLeft}px`;
        this._panelEl.style.top  = `${newTop}px`;
        this._lastPosition = { left: newLeft, top: newTop };
      }
    };

    const onMouseUp = () => {
      if (dragging && this._panelEl) this._panelEl.style.transition = ""; // restore for slide
      armed = false;
      dragging = false;
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup",   onMouseUp);
  }

  // Also wire drag on the HEADER specifically so user can drag from the title
  // bar (header is interactive — clicks toggle collapse — but drags via threshold)
  _initHeaderDrag(headerEl) {
    if (!headerEl) return;
    const DRAG_THRESHOLD = 5;
    let armed = false;
    let dragging = false;
    let startX, startY, origLeft, origTop;

    headerEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      armed = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = this._panelEl.getBoundingClientRect();
      origLeft = rect.left;
      origTop  = rect.top;
    });

    document.addEventListener("mousemove", (e) => {
      if (!armed) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        dragging = true;
        this._userMoved = true;
        this._headerDidDrag = true;
        const cs = this._panelEl.style;
        cs.transition = "none";
        cs.right = cs.bottom = "";
        cs.left = `${origLeft}px`;
        cs.top  = `${origTop}px`;
      }
      if (dragging) {
        const newLeft = origLeft + dx;
        const newTop  = origTop  + dy;
        this._panelEl.style.left = `${newLeft}px`;
        this._panelEl.style.top  = `${newTop}px`;
        this._lastPosition = { left: newLeft, top: newTop };
      }
    });

    document.addEventListener("mouseup", () => {
      if (dragging && this._panelEl) this._panelEl.style.transition = "";
      armed = false;
      // Reset on next tick so the header click handler can check this flag
      setTimeout(() => { dragging = false; this._headerDidDrag = false; }, 50);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Effect collection (strict filter — combat-relevant only)
  // ═══════════════════════════════════════════════════════════════════════════

  _collectActive(actor) {
    const out = [];
    for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
      if (effect.disabled) continue;
      if (this._isPassive(effect)) continue;
      out.push(effect);
    }
    return out;
  }

  _collectPassive(actor) {
    const out = [];
    for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
      if (effect.disabled) continue;
      if (!this._isPassive(effect)) continue;
      out.push(effect);
    }
    return out;
  }

  /**
   * Strict-filter heuristic: NOT passive if:
   *   - Has any status (5e condition like stunned/prone)
   *   - Has a non-zero duration
   *   - Sourced from a spell
   * Otherwise it's passive (worn item, class feature, racial trait, etc.)
   */
  _isPassive(effect) {
    // Conditions always count as active
    if (effect.statuses && effect.statuses.size > 0) return false;
    // Time-limited effects always count as active
    const dur = effect.duration ?? {};
    if (dur.rounds || dur.turns || dur.seconds) return false;
    // Spell-sourced effects count as active
    const origin = effect.origin ?? "";
    if (origin) {
      try {
        const item = fromUuidSync?.(origin);
        if (item?.type === "spell") return false;
      } catch (_) { /* ignore */ }
      if (/\.spell\./i.test(origin) || /Item\..+\.Item\./i.test(origin)) {
        // origin string format check as fallback
      }
    }
    // Anything else is treated as a passive (item enchantments, class features, etc.)
    return true;
  }

  _collectAuras(actor) {
    if (!QolSettings.get("effectsPanelShowAuras")) return [];
    const out = [];
    const classes = actor.system?.classes ?? actor.classes ?? {};
    const subclassIds = new Set();
    for (const c of Object.values(classes)) {
      const sub = c?.subclass?.system?.identifier ?? c?.subclass?.identifier ?? c?.subclass;
      if (sub) subclassIds.add(String(sub).toLowerCase());
    }

    for (const aura of CLASS_AURAS) {
      const cls = classes[aura.className];
      const lvl = cls?.levels ?? cls?.system?.levels ?? 0;
      if (lvl < aura.levelMin) continue;
      if (aura.subclass && !subclassIds.has(aura.subclass)) continue;
      out.push({
        id: `aura-${aura.className}-${aura.name.toLowerCase().replace(/\s+/g, "-")}`,
        name: aura.name,
        icon: aura.icon,
        description: aura.description(actor, lvl),
        radius: aura.radius?.(lvl),
        isAura: true,
      });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════════════════════════════════════

  _render() {
    if (!this._currentActor) { this._hide(); return; }

    const active   = this._collectActive(this._currentActor);
    const auras    = this._collectAuras(this._currentActor);
    const passives = this._collectPassive(this._currentActor);

    if (!active.length && !auras.length && !passives.length) {
      // Nothing to show — hide panel entirely
      if (this._panelEl) { this._panelEl.remove(); this._panelEl = null; }
      return;
    }

    // Auto-expand if there are active conditions (stunned, charmed, prone, etc.)
    // — user shouldn't have to click the chevron to see them. Stay collapsed
    // only when the actor has nothing time-critical going on.
    if (active.length > 0) this._collapsed = false;

    const el = this._ensurePanel();
    const counts = `${active.length}A · ${auras.length}U · ${passives.length}P`;
    const collapsedClass = this._collapsed ? " ace-qol-effects-panel-collapsed" : "";

    el.className = `ace-qol-effects-panel${collapsedClass}`;
    el.innerHTML = `
      <div class="ace-qol-effects-panel-header" data-action="togglePanel">
        <i class="fas ace-qol-effects-panel-chevron ${this._collapsed ? "fa-chevron-down" : "fa-chevron-up"}"></i>
        <div class="ace-qol-effects-panel-titles">
          <span class="ace-qol-effects-panel-title">EFFECTS</span>
          <span class="ace-qol-effects-panel-actor">${foundry.utils.escapeHTML(this._currentActor.name ?? "")}</span>
        </div>
        <span class="ace-qol-effects-panel-counts" title="Active · aUras · Passive">${counts}</span>
      </div>
      <div class="ace-qol-effects-panel-body">
        ${active.length ? `
          <div class="ace-qol-effects-section">
            <div class="ace-qol-effects-section-label">Active</div>
            ${active.map(e => this._renderEffectRow(e)).join("")}
          </div>
        ` : ""}
        ${auras.length ? `
          <div class="ace-qol-effects-section">
            <div class="ace-qol-effects-section-label">Auras</div>
            ${auras.map(a => this._renderAuraRow(a)).join("")}
          </div>
        ` : ""}
        ${passives.length ? `
          <div class="ace-qol-effects-passive-toggle ${this._showPassives ? "expanded" : ""}" data-action="togglePassives">
            <i class="fas ${this._showPassives ? "fa-chevron-down" : "fa-chevron-right"}"></i>
            ${passives.length} passive effect${passives.length === 1 ? "" : "s"}
          </div>
          <div class="ace-qol-effects-section ace-qol-effects-passives" ${this._showPassives ? "" : "hidden"}>
            ${passives.map(e => this._renderEffectRow(e)).join("")}
          </div>
        ` : ""}
      </div>
    `;

    this._wireHeader(el);
    this._wirePassiveToggle(el);
    this._wireRows(el, [...active, ...passives]);
    this._wireAuraRows(el, auras);
  }

  _renderEffectRow(effect) {
    const icon = effect.img ?? effect.icon ?? "icons/svg/aura.svg";
    const name = effect.name ?? effect.label ?? "Effect";
    const remaining = this._formatRemaining(effect);
    const id = effect.id;
    return `
      <div class="ace-qol-effect-row" data-effect-id="${id}" title="${foundry.utils.escapeHTML(name)}">
        <img src="${icon}" class="ace-qol-effect-icon" alt="" />
        <div class="ace-qol-effect-info">
          <span class="ace-qol-effect-name">${foundry.utils.escapeHTML(name)}</span>
          ${remaining ? `<span class="ace-qol-effect-duration">${remaining}</span>` : ""}
        </div>
      </div>
      <div class="ace-qol-effect-tooltip" data-effect-id="${id}" hidden></div>
    `;
  }

  _renderAuraRow(aura) {
    const radiusBadge = aura.radius ? `<span class="ace-qol-effect-duration">${aura.radius}ft</span>` : "";
    return `
      <div class="ace-qol-effect-row ace-qol-aura-row" data-aura-id="${aura.id}" title="${foundry.utils.escapeHTML(aura.name)}">
        <img src="${aura.icon}" class="ace-qol-effect-icon" alt="" />
        <div class="ace-qol-effect-info">
          <span class="ace-qol-effect-name">${foundry.utils.escapeHTML(aura.name)}</span>
          ${radiusBadge}
        </div>
      </div>
      <div class="ace-qol-effect-tooltip" data-aura-id="${aura.id}" hidden>
        ${foundry.utils.escapeHTML(aura.description ?? "")}
      </div>
    `;
  }

  _formatRemaining(effect) {
    const dur = effect.duration ?? {};
    if (dur.seconds) {
      const s = dur.remaining ?? dur.seconds;
      if (s >= 60) return `${Math.ceil(s / 60)}m`;
      return `${Math.ceil(s)}s`;
    }
    if (dur.rounds) return `${dur.remaining ?? dur.rounds}r`;
    if (dur.turns)  return `${dur.remaining ?? dur.turns}t`;
    return "";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Wiring
  // ═══════════════════════════════════════════════════════════════════════════

  _wireHeader(panel) {
    const header = panel.querySelector("[data-action='togglePanel']");
    if (!header) return;

    // Header is draggable for moving the panel; threshold-based so a click
    // still toggles collapse but a drag moves the panel.
    this._initHeaderDrag(header);

    header.addEventListener("click", () => {
      // Don't toggle if the user just finished dragging via the header
      if (this._headerDidDrag) return;
      this._collapsed = !this._collapsed;
      panel.classList.toggle("ace-qol-effects-panel-collapsed", this._collapsed);
      const chev = header.querySelector(".ace-qol-effects-panel-chevron");
      if (chev) {
        chev.classList.toggle("fa-chevron-down", this._collapsed);
        chev.classList.toggle("fa-chevron-up", !this._collapsed);
      }
    });
  }

  _wirePassiveToggle(panel) {
    const toggle = panel.querySelector("[data-action='togglePassives']");
    const list = panel.querySelector(".ace-qol-effects-passives");
    if (!toggle || !list) return;
    toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._showPassives = !this._showPassives;
      list.hidden = !this._showPassives;
      toggle.classList.toggle("expanded", this._showPassives);
      const icon = toggle.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-chevron-down", this._showPassives);
        icon.classList.toggle("fa-chevron-right", !this._showPassives);
      }
    });
  }

  _wireRows(panel, effects) {
    const rows = panel.querySelectorAll(".ace-qol-effect-row[data-effect-id]");
    for (const row of rows) {
      const effectId = row.dataset.effectId;
      const effect = effects.find(e => e.id === effectId);
      if (!effect) continue;

      row.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const tooltip = panel.querySelector(`.ace-qol-effect-tooltip[data-effect-id="${effectId}"]`);
        if (!tooltip) return;
        if (!tooltip.dataset.loaded) {
          let desc = effect.description ?? "";
          try {
            const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
            if (TE?.enrichHTML && desc) {
              desc = await TE.enrichHTML(desc, { secrets: false, relativeTo: effect });
            }
          } catch (_) { /* fall back to raw */ }
          tooltip.innerHTML = desc || "<em>No description.</em>";
          tooltip.dataset.loaded = "1";
        }
        tooltip.hidden = !tooltip.hidden;
      });

      row.addEventListener("contextmenu", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const action = QolSettings.get("effectsPanelAction") ?? "disable";
        const verb = action === "delete" ? "Delete" : "Disable";
        const proceed = await this._confirm(`${verb} "${effect.name}"?`);
        if (!proceed) return;
        try {
          if (action === "delete") await effect.delete();
          else await effect.update({ disabled: true });
        } catch (err) {
          console.warn(`${MODULE_ID} | Effects panel ${action} failed:`, err);
        }
      });
    }
  }

  _wireAuraRows(panel, auras) {
    const rows = panel.querySelectorAll(".ace-qol-aura-row[data-aura-id]");
    for (const row of rows) {
      const auraId = row.dataset.auraId;
      row.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const tooltip = panel.querySelector(`.ace-qol-effect-tooltip[data-aura-id="${auraId}"]`);
        if (!tooltip) return;
        tooltip.hidden = !tooltip.hidden;
      });
    }
  }

  async _confirm(message) {
    return foundry.applications.api.DialogV2.confirm({
      window: { title: "ACE QOL — Effects Panel" },
      content: `<p style="text-align:center;font-size:14px;">${foundry.utils.escapeHTML(message)}</p>`,
      rejectClose: false,
    }).catch(() => false);
  }
}
