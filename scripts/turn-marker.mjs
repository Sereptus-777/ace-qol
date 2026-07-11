// ─── ACE: QOL — Turn Marker ──────────────────────────────────────────────────
// Replaces combatbooster's turn marker functionality:
//   - Rotating PIXI sprite under the active combatant's token
//   - Greyscale "next turn" marker on the next combatant
//   - Centered "Your Turn!" notification + sound for connected players
//   - Optional auto-pan camera to current combatant
//
// Sprite is placed beneath tokens in the canvas.tokens container, follows
// token movement automatically via the requestAnimationFrame loop.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";
import { showCenterToast } from "./attack-prompt.mjs";

const DEFAULT_MARKER_CURRENT = "modules/JB2A_DnD5e/Library/Generic/On_Token/Buff/Ontoken_Buff001_001_OrangeYellow_400x400.webm";
const DEFAULT_MARKER_NEXT    = "modules/JB2A_DnD5e/Library/Generic/On_Token/Buff/Ontoken_Buff001_001_BluePurple_400x400.webm";
const DEFAULT_SOUND          = "sounds/notify.wav";

// Foundry-core asset that ships with EVERY install — used as the failsafe
// when the configured marker image can't load (e.g. the GM hasn't installed
// JB2A). The marker sprite is spun by the animation loop, so this static core
// icon still renders as an animated spinning turn marker. Guarantees every
// table sees a marker on their turn out of the box, dependency-free. v0.7.24.
const CORE_FALLBACK_MARKER   = "icons/svg/aura.svg";

export class TurnMarker {

  constructor() {
    this._currentMarker = null;
    this._nextMarker    = null;
    this._animationFrame = null;
    this._lastNotifiedCombatantId = null;
    this._registerHooks();
    this._startAnimation();
  }

  _registerHooks() {
    Hooks.on("combatStart",  (combat) => this._updateMarker(combat));
    Hooks.on("combatTurn",   (combat) => this._updateMarker(combat));
    Hooks.on("combatRound",  (combat) => this._updateMarker(combat));
    Hooks.on("deleteCombat", ()       => this._removeMarker());

    // Re-place after canvas reload (scene change, refresh, etc.)
    Hooks.on("canvasReady", () => {
      if (game.combat?.started) this._updateMarker(game.combat);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Animation loop — rotation + position follow
  // ═══════════════════════════════════════════════════════════════════════════

  _startAnimation() {
    const tick = () => {
      try {
        const speed = QolSettings.get("turnMarkerSpeed") ?? 0.5;
        const combat = game.combat;

        if (this._currentMarker && !this._currentMarker.destroyed) {
          const m = this._currentMarker;
          // Re-assert the intended size — a webm texture that finished decoding
          // after placement can shift the displayed size; this self-corrects it
          // within a frame (only fires when it has actually drifted).
          if (m._aceTargetSize && Math.abs(m.width - m._aceTargetSize) > 0.5) {
            m.width = m._aceTargetSize; m.height = m._aceTargetSize;
          }
          m.rotation += 0.008 * speed;
          // Breathing pulse — the active marker brightens + dims so the eye is
          // drawn to whose turn it is (0.7×→1.0× of its base opacity, ~1s cycle).
          const base = m._aceBaseAlpha ?? 1.0;
          m.alpha = base * (0.7 + 0.3 * (0.5 + 0.5 * Math.sin(performance.now() / 480)));
          const tok = combat?.combatant?.token?.object;
          if (tok && !tok.destroyed) m.position.set(tok.center.x, tok.center.y);
        }
        if (this._nextMarker && !this._nextMarker.destroyed) {
          const m = this._nextMarker;
          if (m._aceTargetSize && Math.abs(m.width - m._aceTargetSize) > 0.5) {
            m.width = m._aceTargetSize; m.height = m._aceTargetSize;
          }
          m.rotation += 0.008 * speed;
          const next = combat ? this._getNextCombatant(combat) : null;
          const tok = next?.token?.object;
          if (tok && !tok.destroyed) m.position.set(tok.center.x, tok.center.y);
        }
      } catch (_) { /* swallow tick errors */ }
      this._animationFrame = requestAnimationFrame(tick);
    };
    this._animationFrame = requestAnimationFrame(tick);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Marker placement
  // ═══════════════════════════════════════════════════════════════════════════

  async _updateMarker(combat) {
    if (!QolSettings.get("enableTurnMarker")) { this._removeMarker(); return; }
    if (!combat?.started)                     { this._removeMarker(); return; }

    const activeCombatant = combat.combatant;
    const activeToken     = activeCombatant?.token?.object;
    if (!activeToken) { this._removeMarker(); return; }

    await this._placeMarker(activeToken, "current");

    if (QolSettings.get("enableNextTurnMarker")) {
      const next = this._getNextCombatant(combat);
      const nextToken = next?.token?.object;
      if (nextToken && nextToken.id !== activeToken.id) {
        await this._placeMarker(nextToken, "next");
      } else {
        this._removeMarker("next");
      }
    } else {
      this._removeMarker("next");
    }

    this._notifyIfMyTurn(activeCombatant);

    if (QolSettings.get("enableTurnMarkerAutoPan")) {
      try {
        canvas.animatePan({ x: activeToken.center.x, y: activeToken.center.y, duration: 400 });
      } catch (_) { /* pan permission */ }
    }
  }

  async _placeMarker(token, type = "current") {
    const isNext = type === "next";
    const propName = isNext ? "_nextMarker" : "_currentMarker";

    // Tear down old sprite of this type
    if (this[propName]) {
      try { this[propName].destroy(); } catch (_) {}
      this[propName] = null;
    }

    const imagePath = isNext
      ? (QolSettings.get("turnMarkerImageNext") || DEFAULT_MARKER_NEXT)
      : (QolSettings.get("turnMarkerImage")     || DEFAULT_MARKER_CURRENT);

    const _load = async (p) => (await foundry.canvas.loadTexture?.(p)) ?? (await PIXI.Assets.load(p));
    let texture;
    try {
      texture = await _load(imagePath);
    } catch (err) {
      // Configured/default image failed (most often: JB2A not installed).
      // Fall back to the core asset so a marker still appears.
      console.warn(`${MODULE_ID} | Turn marker image load failed (${imagePath}) — falling back to core ${CORE_FALLBACK_MARKER}:`, err?.message ?? err);
      try { texture = await _load(CORE_FALLBACK_MARKER); }
      catch (err2) { console.warn(`${MODULE_ID} | Core fallback marker also failed to load:`, err2?.message ?? err2); return; }
    }
    if (!texture) {
      try { texture = await _load(CORE_FALLBACK_MARKER); } catch (_) { return; }
      if (!texture) return;
    }

    // Force video textures to loop (webm markers from JB2A etc.)
    try {
      const videoEl = texture.baseTexture?.resource?.source;
      if (videoEl instanceof HTMLVideoElement) {
        videoEl.loop = true;
        videoEl.muted = true;
        videoEl.play?.().catch(() => {});
      }
    } catch (_) { /* not a video texture */ }

    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);

    // Size off the STABLE footprint — the token document's grid width × the grid
    // pixel size — NOT the live token.w getter, which can read transiently small
    // while a token is still constructing/animating. That transient produced a
    // one-off 0.86× scale that then STUCK, because the active combatant's marker
    // only re-places on turn change (so it never self-corrected). The intended
    // size is stamped on the sprite so the animation loop can re-assert it if a
    // late-decoding webm texture shifts the displayed size after placement.
    // v0.7.24 fix (confirmed: stale timing placement).
    const scale     = QolSettings.get("turnMarkerScale") ?? 1.15;
    const gridSize  = canvas.dimensions?.size ?? canvas.grid?.size ?? 100;
    const footprint = Math.max(token.document?.width ?? 1, token.document?.height ?? 1) * gridSize;
    const size      = footprint * scale;
    sprite.width  = size;
    sprite.height = size;
    sprite._aceTargetSize = size;

    sprite.position.set(token.center.x, token.center.y);
    // Store the BASE opacity — the tick loop pulses the CURRENT marker around
    // it so "whose turn is it" is unmissable (Johnny 2026-07-10: "not bright
    // enough, can't see them"). Next-marker stays steady (it's a preview).
    sprite._aceBaseAlpha = isNext
      ? (QolSettings.get("turnMarkerNextAlpha") ?? 0.85)
      : (QolSettings.get("turnMarkerAlpha")     ?? 1.0);
    sprite.alpha = sprite._aceBaseAlpha;

    // Insert beneath tokens — addChildAt(0) puts the sprite first in z-order
    try {
      canvas.tokens.addChildAt(sprite, 0);
    } catch (_) {
      try { canvas.tokens.addChild(sprite); } catch (_) { return; }
    }
    this[propName] = sprite;
  }

  _removeMarker(type = "all") {
    if (type === "current" || type === "all") {
      if (this._currentMarker) {
        try { this._currentMarker.destroy(); } catch (_) {}
        this._currentMarker = null;
      }
    }
    if (type === "next" || type === "all") {
      if (this._nextMarker) {
        try { this._nextMarker.destroy(); } catch (_) {}
        this._nextMarker = null;
      }
    }
  }

  _getNextCombatant(combat) {
    const turns = combat.turns;
    if (!turns?.length) return null;
    let next = (combat.turn ?? 0) + 1;
    if (next >= turns.length) next = 0;
    // Skip defeated combatants
    let safety = turns.length;
    while (safety-- > 0 && turns[next]?.defeated) {
      next = (next + 1) % turns.length;
    }
    return turns[next];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player notification + sound
  // ═══════════════════════════════════════════════════════════════════════════

  _notifyIfMyTurn(combatant) {
    // Diagnostic (2026-07-11): logs on EVERY client which combatant is being
    // notified and where the combat pointer is — so "does the sound fire on
    // turn BEGIN or END, and for whom" is answerable in one glance next combat.
    try {
      const c = game.combat;
      console.debug(`${MODULE_ID} | [turn-sound] notify → combatant "${combatant?.name}" | combat.turn=${c?.turn} round=${c?.round} current="${c?.combatant?.name}" | isGM=${game.user.isGM}`);
    } catch (_) {}

    if (!combatant || combatant.id === this._lastNotifiedCombatantId) return;
    this._lastNotifiedCombatantId = combatant.id;

    const actor = combatant.actor;
    if (!actor) return;

    if (game.user.isGM) return; // GM doesn't need a "your turn" notification
    if (!actor.testUserPermission(game.user, "OWNER")) return;

    if (QolSettings.get("enableYourTurnNotification")) {
      showCenterToast(`Your Turn — ${actor.name}!`, 2800);
    }

    if (QolSettings.get("enableYourTurnSound")) {
      const soundPath = QolSettings.get("yourTurnSound") || DEFAULT_SOUND;
      try {
        foundry.audio?.AudioHelper?.play?.({ src: soundPath, volume: 0.6, autoplay: true }, false)
          ?? AudioHelper.play({ src: soundPath, volume: 0.6, autoplay: true }, false);
      } catch (err) {
        console.warn(`${MODULE_ID} | Your-turn sound failed:`, err);
      }
    }
  }
}
