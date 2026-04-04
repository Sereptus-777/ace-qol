// ─── ACE: QOL — Bloodied & Death Indicator Engine ─────────────────────────────
// Shows visual indicators when tokens drop to half HP (bloodied) or 0 HP (dead).
// Supports multiple visual styles: red border ring, overlay icon, or tint.
// Announces bloodied threshold crossing in chat and/or scrolling text.
//
// D&D 5e "Bloodied" rule (common house rule / 4e carryover):
//   A creature at half HP or below is considered "bloodied."
//   This is a visual cue only — no mechanical effect in 5e RAW.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// ─── Bloodied overlay drawing name (for cleanup) ────────────────────────────
const BLOODIED_DRAWING_ID = "ace-qol-bloodied-overlay";
const DEAD_EFFECT_ID      = "dead";

export class BloodiedEngine {

  constructor() {
    /** Track which tokens we've already announced as bloodied to avoid spam */
    this._announcedBloodied = new Set();
    this._registerHooks();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook Registration
  // ═══════════════════════════════════════════════════════════════════════════

  _registerHooks() {
    // ── Linked tokens: watch actor HP changes ──
    Hooks.on("updateActor", (actor, changes, options, userId) => {
      this._onActorUpdate(actor, changes, options, userId);
    });

    // ── Unlinked tokens: watch token delta HP changes ──
    Hooks.on("updateToken", (tokenDoc, changes, options, userId) => {
      this._onTokenUpdate(tokenDoc, changes, options, userId);
    });

    // ── Visual overlay: refresh on every token draw/refresh ──
    Hooks.on("refreshToken", (token) => {
      this._onRefreshToken(token);
    });

    // ── Clean up announcements when combat ends ──
    Hooks.on("deleteCombat", () => {
      this._announcedBloodied.clear();
    });

    console.log(`${MODULE_ID} | Bloodied engine hooks registered`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HP Change Detection — Linked Actors
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle HP changes on linked actors (PCs and linked NPCs).
   * Only the GM processes bloodied state to avoid duplicate announcements.
   */
  _onActorUpdate(actor, changes, options, userId) {
    if (!game.user.isGM) return;

    try {
      if (!QolSettings.get("enableBloodied")) return;
    } catch { return; }

    // Check if HP actually changed
    const newHP = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (newHP === undefined) return;

    const maxHP = actor.system?.attributes?.hp?.max ?? 0;
    if (maxHP <= 0) return;

    this._processBloodiedState(actor, newHP, maxHP, actor.id);

    // ── Death marker ──
    try {
      if (QolSettings.get("enableDeadMarker") && newHP <= 0) {
        this._applyDeadMarker(actor);
      } else if (newHP > 0) {
        this._removeDeadMarker(actor);
      }
    } catch { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HP Change Detection — Unlinked Tokens (Token Delta)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle HP changes on unlinked tokens (most NPCs/monsters).
   * Unlinked tokens store HP in tokenDocument.delta.system.attributes.hp.
   */
  _onTokenUpdate(tokenDoc, changes, options, userId) {
    if (!game.user.isGM) return;

    try {
      if (!QolSettings.get("enableBloodied")) return;
    } catch { return; }

    // Check for HP change in the token delta
    const newHP = foundry.utils.getProperty(changes, "delta.system.attributes.hp.value")
               ?? foundry.utils.getProperty(changes, "actorData.system.attributes.hp.value");
    if (newHP === undefined) return;

    const actor = tokenDoc.actor;
    if (!actor) return;

    const maxHP = actor.system?.attributes?.hp?.max ?? 0;
    if (maxHP <= 0) return;

    // Use token document ID as the tracking key (unlinked tokens are unique)
    const trackingId = tokenDoc.id;
    this._processBloodiedState(actor, newHP, maxHP, trackingId, tokenDoc);

    // ── Death marker ──
    try {
      if (QolSettings.get("enableDeadMarker") && newHP <= 0) {
        this._applyDeadMarker(actor, tokenDoc);
      } else if (newHP > 0) {
        this._removeDeadMarker(actor, tokenDoc);
      }
    } catch { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bloodied State Processing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate whether a creature just became bloodied or recovered,
   * and announce the transition.
   *
   * @param {Actor} actor       - The actor whose HP changed
   * @param {number} currentHP  - New HP value
   * @param {number} maxHP      - Maximum HP
   * @param {string} trackingId - Unique ID for announcement dedup
   * @param {TokenDocument} [tokenDoc] - Token document (for unlinked tokens)
   */
  _processBloodiedState(actor, currentHP, maxHP, trackingId, tokenDoc = null) {
    let threshold = 0.5;
    try { threshold = QolSettings.get("bloodiedThreshold"); } catch { /* default 0.5 */ }

    const bloodiedHP = Math.floor(maxHP * threshold);
    const isBloodied = currentHP <= bloodiedHP && currentHP > 0;
    const wasAnnounced = this._announcedBloodied.has(trackingId);

    if (isBloodied && !wasAnnounced) {
      // ── Just became bloodied ──
      this._announcedBloodied.add(trackingId);

      try {
        if (QolSettings.get("announceBloodied")) {
          this._announceBloodied(actor, tokenDoc, true);
        }
      } catch { /* no announcement */ }

      // Show scrolling text on the token
      this._showBloodiedScrollingText(actor, tokenDoc);

    } else if (!isBloodied && wasAnnounced) {
      // ── Recovered from bloodied ──
      this._announcedBloodied.delete(trackingId);
    } else if (currentHP <= 0) {
      // ── Dead — remove from bloodied tracking ──
      this._announcedBloodied.delete(trackingId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Visual Overlay — Token Refresh
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called on every token refresh. Adds or removes the bloodied visual
   * indicator based on current HP.
   *
   * @param {Token} token - The placeable Token object (not TokenDocument)
   */
  _onRefreshToken(token) {
    try {
      if (!QolSettings.get("enableBloodied")) return;
    } catch { return; }

    const actor = token.actor;
    if (!actor) return;

    // ── Visibility check: should this user see bloodied indicators? ──
    try {
      const visibility = QolSettings.get("bloodiedVisibleTo");
      if (visibility === "gm" && !game.user.isGM) {
        this._removeBloodiedOverlay(token);
        return;
      }
    } catch { /* default: show to all */ }

    const hp = actor.system?.attributes?.hp?.value ?? 0;
    const maxHP = actor.system?.attributes?.hp?.max ?? 0;
    if (maxHP <= 0) {
      this._removeBloodiedOverlay(token);
      return;
    }

    let threshold = 0.5;
    try { threshold = QolSettings.get("bloodiedThreshold"); } catch { /* default */ }

    const bloodiedHP = Math.floor(maxHP * threshold);
    const isBloodied = hp <= bloodiedHP && hp > 0;

    if (isBloodied) {
      this._addBloodiedOverlay(token);
    } else {
      this._removeBloodiedOverlay(token);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Overlay Rendering
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add the bloodied visual indicator to a token.
   * Style is controlled by the bloodiedIndicatorStyle setting:
   *   - "border"  — Red border ring (default)
   *   - "overlay" — Blood splatter overlay icon
   *   - "tint"    — Red tint on the token image
   *
   * @param {Token} token
   */
  _addBloodiedOverlay(token) {
    let style = "border";
    try { style = QolSettings.get("bloodiedIndicatorStyle"); } catch { /* default */ }

    // ── Get or create the overlay graphics container ──
    if (!token._aceBloodiedGraphics) {
      token._aceBloodiedGraphics = new PIXI.Container();
      token._aceBloodiedGraphics.name = BLOODIED_DRAWING_ID;
      token.addChild(token._aceBloodiedGraphics);
    }

    const container = token._aceBloodiedGraphics;
    container.removeChildren();
    container.visible = true;

    const gs = canvas.grid.size;
    const w = (token.document?.width ?? 1) * gs;
    const h = (token.document?.height ?? 1) * gs;

    switch (style) {
      case "border":
        this._drawBloodiedBorder(container, w, h);
        break;
      case "overlay":
        this._drawBloodiedOverlayIcon(container, w, h);
        break;
      case "tint":
        this._applyBloodiedTint(token);
        break;
    }
  }

  /**
   * Remove the bloodied visual indicator from a token.
   * @param {Token} token
   */
  _removeBloodiedOverlay(token) {
    if (token._aceBloodiedGraphics) {
      token._aceBloodiedGraphics.removeChildren();
      token._aceBloodiedGraphics.visible = false;
    }

    // Remove tint if applied
    if (token._aceBloodiedTint) {
      try {
        if (token.mesh) token.mesh.tint = 0xFFFFFF;
      } catch { /* mesh not available */ }
      token._aceBloodiedTint = false;
    }
  }

  /**
   * Draw a glowing red border ring around the token.
   * This is the default and most visible indicator style.
   */
  _drawBloodiedBorder(container, w, h) {
    const g = new PIXI.Graphics();
    const lineWidth = 3;
    const padding = 2;

    // Outer glow (semi-transparent, wider)
    g.lineStyle(lineWidth + 4, 0xFF0000, 0.25);
    g.drawRoundedRect(-padding - 2, -padding - 2, w + (padding + 2) * 2, h + (padding + 2) * 2, 6);

    // Main red border
    g.lineStyle(lineWidth, 0xFF2222, 0.8);
    g.drawRoundedRect(-padding, -padding, w + padding * 2, h + padding * 2, 4);

    // Inner highlight (brighter, thinner)
    g.lineStyle(1, 0xFF6666, 0.5);
    g.drawRoundedRect(0, 0, w, h, 3);

    container.addChild(g);

    // Pulse animation — subtle alpha oscillation
    const ticker = PIXI.Ticker.shared;
    let elapsed = 0;
    const pulseHandler = (dt) => {
      elapsed += dt;
      // Sine wave between 0.5 and 1.0 alpha over ~2 seconds
      g.alpha = 0.6 + 0.4 * Math.sin(elapsed * 0.03);
    };
    ticker.add(pulseHandler);

    // Store reference for cleanup
    container._pulseHandler = pulseHandler;
    container._pulseTicker = ticker;
  }

  /**
   * Draw a blood splatter overlay icon on the token.
   * Uses a simple red cross/drop indicator.
   */
  _drawBloodiedOverlayIcon(container, w, h) {
    const g = new PIXI.Graphics();
    const iconSize = Math.min(w, h) * 0.3;
    const cx = w - iconSize - 2;
    const cy = 2;

    // Red circle background
    g.beginFill(0xFF0000, 0.7);
    g.drawCircle(cx + iconSize / 2, cy + iconSize / 2, iconSize / 2);
    g.endFill();

    // White cross inside
    const crossSize = iconSize * 0.25;
    const crossCx = cx + iconSize / 2;
    const crossCy = cy + iconSize / 2;
    g.beginFill(0xFFFFFF, 0.9);
    g.drawRect(crossCx - crossSize, crossCy - crossSize / 3, crossSize * 2, crossSize * 0.66);
    g.drawRect(crossCx - crossSize / 3, crossCy - crossSize, crossSize * 0.66, crossSize * 2);
    g.endFill();

    container.addChild(g);
  }

  /**
   * Apply a red tint to the token's mesh/sprite.
   * This is the most subtle indicator — tints the token image red.
   */
  _applyBloodiedTint(token) {
    try {
      if (token.mesh) {
        token.mesh.tint = 0xFF8888; // Soft red tint
        token._aceBloodiedTint = true;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply bloodied tint:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Announcement
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a chat message announcing that a creature has become bloodied.
   *
   * @param {Actor} actor
   * @param {TokenDocument|null} tokenDoc
   * @param {boolean} isBloodied - true = became bloodied, false = recovered
   */
  async _announceBloodied(actor, tokenDoc, isBloodied) {
    const name = tokenDoc?.name ?? actor.prototypeToken?.name ?? actor.name;
    const img = tokenDoc?.texture?.src ?? actor.prototypeToken?.texture?.src ?? actor.img ?? "icons/svg/blood.svg";

    const content = `
      <div class="ace-qol-bloodied-announce" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-left:3px solid #cc2222;background:rgba(204,34,34,0.08);border-radius:4px;">
        <img src="${img}" alt="${name}" style="width:36px;height:36px;border-radius:50%;border:2px solid #cc2222;object-fit:cover;" />
        <div style="flex:1;">
          <strong style="color:#cc2222;">${name}</strong>
          <span style="opacity:0.9;"> is <b style="color:#cc2222;">BLOODIED</b>!</span>
          <div style="font-size:0.8em;opacity:0.7;">Half hit points or below</div>
        </div>
        <i class="fas fa-tint" style="color:#cc2222;font-size:1.4em;opacity:0.6;"></i>
      </div>
    `;

    // ── Determine whisper targets based on visibility setting ──
    let whisper = [];
    try {
      const visibility = QolSettings.get("bloodiedVisibleTo");
      if (visibility === "gm") {
        whisper = game.users.filter(u => u.isGM).map(u => u.id);
      }
    } catch { /* public by default */ }

    await ChatMessage.create({
      content,
      speaker: { alias: "ACE QOL" },
      whisper,
      flags: {
        [MODULE_ID]: {
          type: "bloodiedAnnounce",
          actorId: actor.id,
          tokenDocId: tokenDoc?.id,
        },
      },
    });
  }

  /**
   * Show scrolling "BLOODIED" text on the token.
   */
  _showBloodiedScrollingText(actor, tokenDoc) {
    try {
      // Find the token on canvas
      let token = null;
      if (tokenDoc) {
        token = tokenDoc.object;
      } else {
        token = actor.getActiveTokens?.()?.[0];
      }

      if (!token || !canvas.interface?.createScrollingText) return;

      canvas.interface.createScrollingText(token.center, "BLOODIED", {
        anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
        direction: CONST.TEXT_ANCHOR_POINTS.TOP,
        fill: "#FF2222",
        fontSize: 32,
        stroke: 0x000000,
        strokeThickness: 4,
        duration: 2500,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Bloodied scrolling text failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dead Marker
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply the "dead" status effect when a creature drops to 0 HP.
   * Uses the system's built-in "dead" status effect.
   *
   * @param {Actor} actor
   * @param {TokenDocument|null} tokenDoc
   */
  async _applyDeadMarker(actor, tokenDoc = null) {
    try {
      // For unlinked tokens, apply via token document
      const token = tokenDoc?.object ?? actor.getActiveTokens?.()?.[0];
      if (!token) return;

      // Check if already has dead status
      if (actor.statuses?.has(DEAD_EFFECT_ID)) return;

      // Apply the dead status effect — use the system's built-in effect
      const deadEffect = CONFIG.statusEffects?.find(e => e.id === DEAD_EFFECT_ID);
      if (deadEffect) {
        await token.toggleEffect(deadEffect, { active: true, overlay: true });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to apply dead marker:`, err);
    }
  }

  /**
   * Remove the "dead" status effect when a creature recovers from 0 HP.
   */
  async _removeDeadMarker(actor, tokenDoc = null) {
    try {
      const token = tokenDoc?.object ?? actor.getActiveTokens?.()?.[0];
      if (!token) return;

      if (!actor.statuses?.has(DEAD_EFFECT_ID)) return;

      const deadEffect = CONFIG.statusEffects?.find(e => e.id === DEAD_EFFECT_ID);
      if (deadEffect) {
        await token.toggleEffect(deadEffect, { active: false });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to remove dead marker:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Destroy all bloodied overlays and stop animations.
   * Called when the engine is disabled or the module unloads.
   */
  destroy() {
    this._announcedBloodied.clear();

    // Clean up all token overlays
    if (canvas.tokens?.placeables) {
      for (const token of canvas.tokens.placeables) {
        this._removeBloodiedOverlay(token);
        if (token._aceBloodiedGraphics) {
          // Stop pulse animation
          const container = token._aceBloodiedGraphics;
          if (container._pulseHandler && container._pulseTicker) {
            container._pulseTicker.remove(container._pulseHandler);
          }
          token.removeChild(token._aceBloodiedGraphics);
          token._aceBloodiedGraphics.destroy({ children: true });
          token._aceBloodiedGraphics = null;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  API Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register public API on game.aceQol.
   */
  registerAPI() {
    if (!game.aceQol) return;
    game.aceQol.bloodiedEngine = this;
    console.log(`${MODULE_ID} | Bloodied engine API registered (game.aceQol.bloodiedEngine)`);
  }
}
