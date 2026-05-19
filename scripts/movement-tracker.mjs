// ─── ACE: QOL — Movement Tracker ─────────────────────────────────────────────
// Visualizes movement distance as colored grid squares while dragging a token.
//
//   🟢 Green  — within base walk speed
//   🟡 Yellow — within Dash (2× walk)
//   🔴 Red    — beyond Dash (impossible without other resources)
//
// Hooks into Token's drag handlers to draw a PIXI overlay along the path from
// the token's starting position to the cursor. Updates live as the cursor moves.
//
// Reads `actor.system.attributes.movement.walk` for the speed source.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

const COLOR_WALK = 0x00ff44;
const COLOR_DASH = 0xffd000;
const COLOR_OVER = 0xff3030;

export class MovementTracker {

  constructor() {
    this._tracking = null; // { token, startCenter, walkSpeed, dashSpeed, graphics, label }
    this._patched = false;
    this._registerHooks();
  }

  _registerHooks() {
    // Hook into the canvas-ready event so Token class is guaranteed available
    Hooks.once("ready", () => this._patchTokenDrag());
  }

  _patchTokenDrag() {
    if (this._patched) return;
    this._patched = true;

    const TokenClass = CONFIG.Token?.objectClass;
    if (!TokenClass?.prototype) {
      console.warn(`${MODULE_ID} | Movement tracker: Token class not found`);
      return;
    }

    const tracker = this;

    // ── Drag start ──
    const origStart = TokenClass.prototype._onDragLeftStart;
    if (origStart) {
      TokenClass.prototype._onDragLeftStart = function(event) {
        const result = origStart.call(this, event);
        try { tracker._onDragStart(this, event); } catch (err) {
          console.warn(`${MODULE_ID} | Movement tracker drag-start failed:`, err);
        }
        return result;
      };
    }

    // ── Drag move ──
    const origMove = TokenClass.prototype._onDragLeftMove;
    if (origMove) {
      TokenClass.prototype._onDragLeftMove = function(event) {
        const result = origMove.call(this, event);
        try { tracker._onDragMove(this, event); } catch (err) { /* silent */ }
        return result;
      };
    }

    // ── Drag drop / cancel — clear ──
    const origDrop = TokenClass.prototype._onDragLeftDrop;
    if (origDrop) {
      TokenClass.prototype._onDragLeftDrop = function(event) {
        try { tracker._onDragEnd(); } catch (_) {}
        return origDrop.call(this, event);
      };
    }
    const origCancel = TokenClass.prototype._onDragLeftCancel;
    if (origCancel) {
      TokenClass.prototype._onDragLeftCancel = function(event) {
        try { tracker._onDragEnd(); } catch (_) {}
        return origCancel.call(this, event);
      };
    }

    console.debug(`${MODULE_ID} | Movement tracker patched Token drag handlers`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Drag lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  _onDragStart(token, event) {
    if (!QolSettings.get("enableMovementTracker")) return;
    if (QolSettings.get("movementTrackerOnlyInCombat") && !game.combat?.started) return;
    if (!token?.actor) return;

    // Read movement speed (in scene units — typically feet)
    const walk = Number(token.actor.system?.attributes?.movement?.walk) || 30;
    const dash = walk * 2;

    // Create overlay graphics
    const graphics = new PIXI.Graphics();
    const label = new PIXI.Text("", {
      fontSize: 18,
      fontFamily: "Signika, sans-serif",
      fill: 0xffffff,
      stroke: 0x000000,
      strokeThickness: 4,
      fontWeight: "bold",
    });
    label.anchor.set(0, 0.5);

    try {
      canvas.tokens.addChild(graphics);
      canvas.tokens.addChild(label);
    } catch (_) {
      try {
        canvas.interface.addChild(graphics);
        canvas.interface.addChild(label);
      } catch (e) { return; }
    }

    this._tracking = {
      token,
      startCenter: { x: token.center.x, y: token.center.y },
      walkSpeed: walk,
      dashSpeed: dash,
      graphics,
      label,
    };
  }

  _onDragMove(token, event) {
    const t = this._tracking;
    if (!t || t.token !== token) return;

    // Get current cursor position in world coords
    let cursor;
    try {
      cursor = event.data?.getLocalPosition?.(canvas.stage)
            ?? event.interactionData?.destination
            ?? canvas.app.renderer.events.pointer;
    } catch (_) { return; }
    if (!cursor) return;

    // Build the colored path
    this._renderPath(cursor);
  }

  _onDragEnd() {
    if (!this._tracking) return;
    try { this._tracking.graphics?.destroy(); } catch (_) {}
    try { this._tracking.label?.destroy(); } catch (_) {}
    this._tracking = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Rendering
  // ═══════════════════════════════════════════════════════════════════════════

  _renderPath(cursorWorld) {
    const t = this._tracking;
    const grid = canvas.grid;
    if (!grid) return;

    t.graphics.clear();

    // Convert positions to grid offsets
    const startOff = grid.getOffset(t.startCenter);
    const endOff   = grid.getOffset(cursorWorld);

    // Bresenham line on grid coords gives the squares the path crosses
    const path = this._bresenham(startOff, endOff);

    const alpha = QolSettings.get("movementTrackerAlpha") ?? 0.35;
    let totalDistance = 0;

    for (let i = 0; i < path.length; i++) {
      const cell = path[i];
      const center = grid.getCenterPoint(cell);

      // Cumulative distance from start to this cell (in scene units / feet)
      const dist = grid.measureDistance(t.startCenter, center);
      totalDistance = dist;

      let color;
      if (dist <= t.walkSpeed)      color = COLOR_WALK;
      else if (dist <= t.dashSpeed) color = COLOR_DASH;
      else                          color = COLOR_OVER;

      // Skip the very first cell (it's where the token started — no tint)
      if (i === 0) continue;

      const topLeft = grid.getTopLeftPoint(cell);
      const size = grid.size;
      t.graphics.beginFill(color, alpha);
      t.graphics.drawRect(topLeft.x, topLeft.y, size, size);
      t.graphics.endFill();

      // Outline
      t.graphics.lineStyle(2, color, Math.min(1, alpha + 0.4));
      t.graphics.drawRect(topLeft.x, topLeft.y, size, size);
      t.graphics.lineStyle(0);
    }

    // Live distance label at cursor
    const distRounded = Math.round(totalDistance);
    const status = totalDistance <= t.walkSpeed ? "WALK"
                 : totalDistance <= t.dashSpeed ? "DASH"
                                                : "OVER";
    t.label.text = `${distRounded}ft  ·  ${status}  ·  ${t.walkSpeed}/${t.dashSpeed}`;
    t.label.position.set(cursorWorld.x + 24, cursorWorld.y);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bresenham-style line algorithm on grid coordinates.
   * Returns the list of grid cells the line crosses, including endpoints.
   * Works for square grids; hex grids fall back to a simpler diagonal path.
   */
  _bresenham(start, end) {
    const cells = [];
    let x0 = start.j, y0 = start.i;
    const x1 = end.j,  y1 = end.i;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let safety = 200;
    while (safety-- > 0) {
      cells.push({ i: y0, j: x0 });
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 <  dx) { err += dx; y0 += sy; }
    }
    return cells;
  }
}
