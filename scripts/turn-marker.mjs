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

const DEFAULT_MARKER_CURRENT = "modules/JB2A_DnD5e/Library/Generic/Magic_Signs/Runes/EvocationRuneLoop_01_Regular_Red_400x400.webm";
const DEFAULT_MARKER_NEXT    = "modules/JB2A_DnD5e/Library/Generic/Magic_Signs/Runes/AbjurationRuneLoop_01_Regular_Blue_400x400.webm";
const DEFAULT_SOUND          = "sounds/notify.wav";

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
          this._currentMarker.rotation += 0.008 * speed;
          const tok = combat?.combatant?.token?.object;
          if (tok && !tok.destroyed) {
            this._currentMarker.position.set(tok.center.x, tok.center.y);
          }
        }
        if (this._nextMarker && !this._nextMarker.destroyed) {
          this._nextMarker.rotation += 0.008 * speed;
          const next = combat ? this._getNextCombatant(combat) : null;
          const tok = next?.token?.object;
          if (tok && !tok.destroyed) {
            this._nextMarker.position.set(tok.center.x, tok.center.y);
          }
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

    let texture;
    try {
      texture = await foundry.canvas.loadTexture?.(imagePath)
             ?? await PIXI.Assets.load(imagePath);
    } catch (err) {
      console.warn(`${MODULE_ID} | Turn marker image load failed (${imagePath}):`, err);
      return;
    }
    if (!texture) return;

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

    const scale = QolSettings.get("turnMarkerScale") ?? 1.15;
    const size  = Math.max(token.w, token.h) * scale;
    sprite.width  = size;
    sprite.height = size;

    sprite.position.set(token.center.x, token.center.y);
    sprite.alpha = isNext
      ? (QolSettings.get("turnMarkerNextAlpha") ?? 0.7)
      : (QolSettings.get("turnMarkerAlpha")     ?? 0.85);

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
