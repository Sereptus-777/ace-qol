// ─── ACE: QOL — Faerie Fire Visual FX Engine ──────────────────────────────────
// Gives any token whose actor carries the ACE "Faerie Fire" active effect a
// persistent, gently-pulsing SILHOUETTE GLOW (it follows the token's artwork
// edge, NOT its square frame), plus a faint dim light.
//
// HOW THE GLOW IS DRAWN (v0.7.96): with Foundry's OWN built-in
// `OutlineOverlayFilter` (`foundry.canvas.rendering.filters.OutlineOverlayFilter`,
// with a V12 global fallback) applied to the token mesh. This filter is part of
// Foundry core — it is ALWAYS available and needs NO third-party module. It
// follows the token silhouette and animates (`wave`), and we drive its colour
// ourselves through a true blue→green→violet cycle.
//
//   ⚠ HISTORY: earlier versions reached for `PIXI.filters.GlowFilter`, which is
//   ONLY registered when Token Magic FX is installed AND enabled. With TMFX off
//   (and ACE's own conflict warning recommends disabling it!) that filter didn't
//   exist, construction failed, and the glow fell back to an ugly square rect.
//   The See-Invisibility glow worked fine without TMFX because it never used
//   that filter. Foundry's native OutlineOverlayFilter is the correct,
//   dependency-free tool, so this engine now uses it. NO TMFX anywhere.
//
// If the native filter is somehow unavailable, it degrades to a drawn
// rounded-rect border so the spell still reads.
//
// D&D 5e "Faerie Fire" rule (PHB 2014 p.239 / 2024 PHB): each object/creature in
// the 20-ft cube is outlined in blue, green, or violet light; affected creatures
// shed dim light in a 10-ft radius and can't benefit from being invisible.
//
// This file is the VISUAL layer only. The mechanical effect is applied by
// condition-library.mjs (key: "faerie_fire").
//
// ── Architecture ──
//   • refreshToken          → (re)apply or remove the outline filter + colour
//                             ticker, PER-CLIENT (every client draws its own —
//                             the filter is a local render object, no doc write).
//   • createActiveEffect /
//     deleteActiveEffect    → refresh the token visual on every client, and the
//                             activeGM writes the dim-LIGHT document update.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";

// ─── Identity constants ─────────────────────────────────────────────────────
const FAERIE_FIRE_CONTAINER_ID = "ace-qol-faerie-fire-outline"; // rect-fallback container
const FAERIE_FIRE_KEY          = "faerie_fire";   // flags["ace-qol"].conditionKey
const FAERIE_FIRE_NAME         = "Faerie Fire";   // effect.name fallback match
const PRIOR_LIGHT_FLAG         = "faerieFirePriorLight";

// ─── The three faerie-fire colors: blue → green → violet ────────────────────
const FF_COLORS = [
  0x22c55e, // green
  0x3b82f6, // blue
  0x8b5cf6, // violet
];
const FF_CYCLE_SECONDS = 3.0; // full blue→green→violet cycle

// ─── Dim-light config (RAW: 10-ft dim radius; faint cool blue-violet) ───────
const FF_LIGHT_CONFIG = {
  dim:       10,
  bright:    0,
  color:     "#8b5cf6",
  alpha:     0.12,
  animation: { type: "pulse", speed: 2, intensity: 2 },
};

export class FaerieFireFX {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  static init() {
    Hooks.on("refreshToken", (token) => FaerieFireFX._onRefreshToken(token));
    Hooks.on("createActiveEffect", (effect) => FaerieFireFX._onEffectChange(effect, true));
    Hooks.on("deleteActiveEffect", (effect) => FaerieFireFX._onEffectChange(effect, false));

    const FilterClass = FaerieFireFX._getFilterClass();
    console.log(`${MODULE_ID} | Faerie Fire FX ready — glow engine: ${FilterClass ? "Foundry OutlineOverlayFilter (silhouette, no TMFX)" : "rounded-rect fallback"}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Effect detection
  // ═══════════════════════════════════════════════════════════════════════════

  static _isFaerieFireEffect(effect) {
    if (!effect) return false;
    try {
      if (effect.flags?.[MODULE_ID]?.conditionKey === FAERIE_FIRE_KEY) return true;
      if (effect.name === FAERIE_FIRE_NAME) return true;
    } catch (_) { /* defensive */ }
    return false;
  }

  static _actorHasFaerieFire(actor) {
    if (!actor?.effects) return false;
    try {
      for (const effect of actor.effects) {
        if (!effect || effect.disabled) continue;
        if (FaerieFireFX._isFaerieFireEffect(effect)) return true;
      }
    } catch (_) { /* defensive */ }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Hook handlers
  // ═══════════════════════════════════════════════════════════════════════════

  static _onRefreshToken(token) {
    try {
      const actor = token?.actor;
      const hasFF = !!(actor && FaerieFireFX._actorHasFaerieFire(actor));
      if (hasFF) FaerieFireFX._applyOutlineGlow(token);
      else       FaerieFireFX._removeOutlineGlow(token);
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._onRefreshToken failed (non-fatal):`, err);
    }
  }

  static _onEffectChange(effect, added) {
    try {
      if (!FaerieFireFX._isFaerieFireEffect(effect)) return;
      const actor = effect?.parent;
      if (!(actor instanceof Actor)) return;

      let tokens = [];
      try { tokens = actor.getActiveTokens?.() ?? []; } catch (_) { tokens = []; }

      // Per-client visual refresh (the outline filter is a local render object).
      for (const token of tokens) FaerieFireFX._onRefreshToken(token);

      // activeGM owns the dim-light document write.
      if (game.users?.activeGM === game.user) {
        for (const token of tokens) {
          const tokenDoc = token?.document;
          if (!tokenDoc) continue;
          if (added) {
            FaerieFireFX._applyDimLight(tokenDoc);
          } else if (!FaerieFireFX._actorHasFaerieFire(actor)) {
            FaerieFireFX._restoreDimLight(tokenDoc);
          }
        }
      }
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._onEffectChange failed (non-fatal):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Silhouette glow (PRIMARY — Foundry OutlineOverlayFilter, per-client, NO TMFX)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Resolve Foundry's native OutlineOverlayFilter class (V13 namespaced, V12 global). */
  static _getFilterClass() {
    return foundry?.canvas?.rendering?.filters?.OutlineOverlayFilter
        ?? globalThis.OutlineOverlayFilter
        ?? null;
  }

  /** 0xRRGGBB → normalized [r,g,b,a] (OutlineOverlayFilter colour format). */
  static _colorToRGBA(c, a = 1) {
    return [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255, a];
  }

  /** Build the native outline filter, or null if the class isn't available. */
  static _makeOutlineFilter() {
    try {
      const FilterClass = FaerieFireFX._getFilterClass();
      if (!FilterClass) return null;
      // PROVEN construction — verified live in Johnny's game 2026-06-26.
      // ⚠ CRITICAL: pass ONLY `outlineColor` (+ knockout) to create(); set
      // `thickness` as a PROPERTY afterward. Passing thickness as a
      // constructor/uniform option clobbers OutlineOverlayFilter's [x,y] array
      // uniform with a scalar → apply() throws "Cannot create property '0' on
      // number" on EVERY render frame → black canvas. (That was the v0.7.96 crash.)
      let f = null;
      try {
        f = (typeof FilterClass.create === "function")
          ? FilterClass.create({ outlineColor: FaerieFireFX._colorToRGBA(FF_COLORS[0]), knockout: false })
          : new FilterClass();
      } catch (_) { f = null; }
      if (!f) return null;
      try { f.thickness = 2; }     catch (_) { /* property absent on this build */ }
      try { f.knockout  = false; } catch (_) { /* keep the token ART visible inside the glow */ }
      try { f.wave      = true; }  catch (_) { /* gentle animated edge */ }
      return f;
    } catch (e) {
      console.debug(`${MODULE_ID} | FaerieFireFX: OutlineOverlayFilter unavailable:`, e);
      return null;
    }
  }

  /** Live-set the outline colour (covers setter + raw-uniform builds). */
  static _setFilterColor(filter, color) {
    if (!filter) return;
    const rgba = FaerieFireFX._colorToRGBA(color);
    try { filter.outlineColor = rgba; } catch (_) { /* not a setter on this build */ }
    try { if (filter.uniforms) filter.uniforms.outlineColor = rgba; } catch (_) { /* no uniforms */ }
  }

  /**
   * Apply (or re-attach) the outline filter to the token mesh + run the colour
   * ticker. Idempotent: Foundry rebuilds token.mesh.filters on a full redraw, so
   * we re-append our existing filter instead of recreating it.
   * @param {Token} token
   */
  static _applyOutlineGlow(token) {
    try {
      const mesh = token?.mesh;
      if (!mesh) return; // mid-draw — the next refresh catches it
      if (token._aceFFFilter) {
        // Re-attach if a full redraw dropped it; keep the colour ticker running.
        const filters = mesh.filters ?? [];
        if (!filters.includes(token._aceFFFilter)) mesh.filters = [...filters, token._aceFFFilter];
        FaerieFireFX._ensureColorTicker(token);
        return;
      }
      const filter = FaerieFireFX._makeOutlineFilter();
      if (!filter) { FaerieFireFX._addRectFallback(token); return; }
      token._aceFFFilter = filter;
      mesh.filters = [...(mesh.filters ?? []), filter]; // APPEND — preserve other filters
      FaerieFireFX._ensureColorTicker(token);
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._applyOutlineGlow failed (non-fatal):`, err);
    }
  }

  /** Remove the outline filter + stop the colour ticker (and any rect fallback). */
  static _removeOutlineGlow(token) {
    try {
      FaerieFireFX._stopColorTicker(token);
      if (token?._aceFFFilter) {
        const mesh = token.mesh;
        if (mesh?.filters?.length) {
          mesh.filters = mesh.filters.filter(f => f !== token._aceFFFilter);
        }
        token._aceFFFilter = null;
      }
      FaerieFireFX._removeRectFallback(token);
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._removeOutlineGlow failed (non-fatal):`, err);
    }
  }

  /**
   * Per-client colour ticker — cycles the outline through blue→green→violet.
   * @param {Token} token
   */
  static _ensureColorTicker(token) {
    if (!token || token._aceFFColorHandler) return; // already running
    const ticker = PIXI.Ticker.shared;
    let elapsed = 0;
    const handler = (dt) => {
      try {
        elapsed += dt;
        if (token._aceFFFilter) {
          FaerieFireFX._setFilterColor(token._aceFFFilter, FaerieFireFX._cycleColor(elapsed / 60));
        }
      } catch (_) {
        try { ticker.remove(handler); } catch (_e) { /* ignore */ }
      }
    };
    ticker.add(handler);
    token._aceFFColorTicker  = ticker;
    token._aceFFColorHandler = handler;
  }

  /** Stop a token's colour ticker. */
  static _stopColorTicker(token) {
    try {
      if (token?._aceFFColorHandler && token?._aceFFColorTicker) {
        token._aceFFColorTicker.remove(token._aceFFColorHandler);
      }
    } catch (_) { /* ignore */ }
    if (token) { token._aceFFColorHandler = null; token._aceFFColorTicker = null; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rounded-rect FALLBACK (only if the native filter is unavailable)
  // ═══════════════════════════════════════════════════════════════════════════

  static _addRectFallback(token) {
    try {
      if (!token._aceFaerieFireGraphics) {
        token._aceFaerieFireGraphics = new PIXI.Container();
        token._aceFaerieFireGraphics.name = FAERIE_FIRE_CONTAINER_ID;
        token.addChild(token._aceFaerieFireGraphics);
      }
      const container = token._aceFaerieFireGraphics;
      if (container._pulseHandler && container._pulseTicker) {
        container._pulseTicker.remove(container._pulseHandler);
        container._pulseHandler = null;
        container._pulseTicker   = null;
      }
      container.removeChildren();
      container.visible = true;

      const gs = canvas.grid.size;
      const w  = (token.document?.width ?? 1) * gs;
      const h  = (token.document?.height ?? 1) * gs;
      FaerieFireFX._drawFaerieFireBorder(container, w, h);
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._addRectFallback failed (non-fatal):`, err);
    }
  }

  static _removeRectFallback(token) {
    try {
      if (!token?._aceFaerieFireGraphics) return;
      const container = token._aceFaerieFireGraphics;
      if (container._pulseHandler && container._pulseTicker) {
        container._pulseTicker.remove(container._pulseHandler);
        container._pulseHandler = null;
        container._pulseTicker   = null;
      }
      container.removeChildren();
      container.visible = false;
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._removeRectFallback failed (non-fatal):`, err);
    }
  }

  static _drawFaerieFireBorder(container, w, h) {
    const g = new PIXI.Graphics();
    container.addChild(g);
    const redraw = (color) => {
      g.clear();
      g.lineStyle(7, color, 0.22);
      g.drawRoundedRect(-4, -4, w + 8, h + 8, 6);
      g.lineStyle(3, color, 0.85);
      g.drawRoundedRect(-2, -2, w + 4, h + 4, 4);
      const hi = FaerieFireFX._lerpColor(color, 0xffffff, 0.5);
      g.lineStyle(1, hi, 0.6);
      g.drawRoundedRect(0, 0, w, h, 3);
    };
    redraw(FF_COLORS[0]);
    const ticker = PIXI.Ticker.shared;
    let elapsed = 0;
    const pulseHandler = (dt) => {
      try {
        elapsed += dt;
        redraw(FaerieFireFX._cycleColor(elapsed / 60));
        g.alpha = 0.85 + 0.15 * Math.sin(elapsed * 0.03);
      } catch (_) {
        try { ticker.remove(pulseHandler); } catch (_e) { /* ignore */ }
      }
    };
    ticker.add(pulseHandler);
    container._pulseHandler = pulseHandler;
    container._pulseTicker  = ticker;
  }

  // ─── Colour helpers ─────────────────────────────────────────────────────────

  static _lerpColor(c1, c2, t) {
    const r1 = (c1 >> 16) & 0xff, g1 = (c1 >> 8) & 0xff, b1 = c1 & 0xff;
    const r2 = (c2 >> 16) & 0xff, g2 = (c2 >> 8) & 0xff, b2 = c2 & 0xff;
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return (r << 16) | (g << 8) | b;
  }

  static _cycleColor(seconds) {
    const n = FF_COLORS.length;
    const phase = ((seconds % FF_CYCLE_SECONDS) / FF_CYCLE_SECONDS) * n;
    const i = Math.floor(phase) % n;
    const next = (i + 1) % n;
    const t = phase - Math.floor(phase);
    return FaerieFireFX._lerpColor(FF_COLORS[i], FF_COLORS[next], t);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dim light (activeGM-gated DOCUMENT write)
  // ═══════════════════════════════════════════════════════════════════════════

  static async _applyDimLight(tokenDoc) {
    try {
      const alreadySaved = tokenDoc.getFlag(MODULE_ID, PRIOR_LIGHT_FLAG) !== undefined;
      if (!alreadySaved) {
        const priorLight = tokenDoc.light?.toObject?.() ?? null;
        await tokenDoc.setFlag(MODULE_ID, PRIOR_LIGHT_FLAG, priorLight);
      }
      await tokenDoc.update({ light: foundry.utils.deepClone(FF_LIGHT_CONFIG) });
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._applyDimLight failed (non-fatal):`, err);
    }
  }

  static async _restoreDimLight(tokenDoc) {
    try {
      const priorLight = tokenDoc.getFlag(MODULE_ID, PRIOR_LIGHT_FLAG);
      if (priorLight === undefined) return;
      const restore = priorLight ?? { dim: 0, bright: 0, color: null, alpha: 0.5 };
      await tokenDoc.update({ light: restore });
      await tokenDoc.unsetFlag(MODULE_ID, PRIOR_LIGHT_FLAG);
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX._restoreDimLight failed (non-fatal):`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  static destroy() {
    try {
      if (!canvas?.tokens?.placeables) return;
      for (const token of canvas.tokens.placeables) {
        FaerieFireFX._removeOutlineGlow(token);
        if (token._aceFaerieFireGraphics) {
          try { token.removeChild(token._aceFaerieFireGraphics); } catch (_) { /* ignore */ }
          try { token._aceFaerieFireGraphics.destroy({ children: true }); } catch (_) { /* ignore */ }
          token._aceFaerieFireGraphics = null;
        }
      }
    } catch (err) {
      console.debug(`${MODULE_ID} | FaerieFireFX.destroy failed (non-fatal):`, err);
    }
  }
}
