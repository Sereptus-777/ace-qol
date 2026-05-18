// ─── ACE: QOL — Lootable Tile ─────────────────────────────────────────────────
// Makes ace-qol dead-art tiles AND tagged "container" tiles clickable for
// loot. Opens a per-tile loot dialog with the source's items + currency.
// GM-assigns items to players via player buttons. Combat-locked by default;
// GM can unlock individual tiles or all.
//
// Lootable tile types:
//   - Dead-body tile  → flags["ace-qol"].isDeadToken     (created on NPC death)
//   - Container tile  → flags["ace-suite"].containerTile (chest/coffer/etc.,
//                       set manually OR auto-detected from filename)
//
// Interaction model (Phase 3c):
//   1. Single LEFT-CLICK on a lootable tile → loot dialog (reliable;
//      mousedown+mouseup with drag-resistance, fires once per click)
//   2. Hover for 1s over a lootable tile → small treasure-chest icon
//      appears at the tile center → click icon to open (discoverability)
//   3. Right-click double-click stays as a legacy fallback
//
// The shared "ace-suite" flag namespace lets ACE Forge read the same
// containerTile flag for placement guidance UX.
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "./ace-qol.mjs";
import { QolSettings } from "./settings.mjs";

// ─── Container detection (cross-module shared flag namespace) ──────────────
// Both ACE QOL and ACE Forge read these flags. ACE QOL uses them for the
// loot dialog; ACE Forge uses them for placement-guidance highlighting.
const CONTAINER_FLAG_NS    = "ace-suite";       // shared across the suite
const CONTAINER_FLAG_NAME  = "containerTile";   // boolean: explicit mark
const CONTAINER_LOOT_NAME  = "containerLoot";   // { items: [], currency: {} }

// Filename keywords that auto-mark a tile as a container. Case-insensitive
// substring match against the tile's texture path. Users can override with
// the explicit flag (true/false) — see isContainerTile() below.
const CONTAINER_KEYWORDS = [
  "chest", "coffer", "crate", "barrel", "coffin",
  "sarcophagus", "box", "urn", "mimic-idle", "treasure",
];

/**
 * Is this tile a "container" — i.e. should the loot dialog open on click?
 * Tri-state:
 *   - explicit flag === true     → yes
 *   - explicit flag === false    → no (overrides filename match)
 *   - explicit flag === undefined → fall back to filename keyword match
 *
 * Exported so ACE Forge can read the same flag for placement guidance.
 *
 * @param {TileDocument} tileDoc
 * @returns {boolean}
 */
export function isContainerTile(tileDoc) {
  if (!tileDoc) return false;
  const explicit = tileDoc.flags?.[CONTAINER_FLAG_NS]?.[CONTAINER_FLAG_NAME];
  if (typeof explicit === "boolean") return explicit;
  const path = (tileDoc.texture?.src ?? "").toLowerCase();
  return CONTAINER_KEYWORDS.some(kw => path.includes(kw));
}

/**
 * Read the container loot stored on a tile. Returns a normalized shape
 * with items[] and currency{} even if the flag is unset.
 *
 * @param {TileDocument} tileDoc
 * @returns {{items: Array, currency: object}}
 */
export function getContainerLoot(tileDoc) {
  const stored = tileDoc?.flags?.[CONTAINER_FLAG_NS]?.[CONTAINER_LOOT_NAME];
  return {
    items:    stored?.items    ?? [],
    currency: stored?.currency ?? { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
  };
}

// ─── Tile right-click patch — installed via top-level hooks ─────────────────
// CRITICAL: this MUST run from top-level module code, not from inside the
// LootableTile constructor. The constructor is called from ace-qol.mjs's
// `Hooks.once("ready", ...)` block, which means `Hooks.once("ready", ...)`
// registered INSIDE the constructor never fires (ready already passed).
//
// By registering setup/canvasReady/ready hooks at module-import time, we
// guarantee at least one fires after CONFIG.Tile.objectClass is available.
// `setup` is the earliest — fires once init has completed and CONFIG is
// fully populated. canvasReady fires when each scene's canvas finishes
// drawing (catches late module class swaps). ready fires last (final
// belt-and-suspenders).
//
// Plus a per-tile `drawTile` fallback: if some other module replaces
// CONFIG.Tile.objectClass AFTER our setup-time patch (e.g. with a custom
// subclass), the prototype patch is on the OLD class. drawTile verifies
// each instance's constructor.prototype carries our sentinel and re-patches
// if not.

// Module-level handle to the LootableTile instance so the patched method
// can call _openLootDialog. Set by the constructor when the singleton is
// created in ace-qol.mjs's ready hook.
let _lootableTileInstance = null;

function _aceQolPatchTileClickRight(reason) {
  const TileClass = CONFIG?.Tile?.objectClass;
  if (!TileClass) {
    console.warn(`${MODULE_ID} | Tile right-click patch (${reason}): Tile class not available yet — will retry.`);
    return false;
  }
  if (TileClass.prototype.__aceQolRightClickPatched) return true;  // already done
  const proto = TileClass.prototype;
  const original = proto._onClickRight;
  proto._onClickRight = function(event) {
    try {
      const tileDoc = this.document ?? this;
      const flags = tileDoc?.flags?.[MODULE_ID] ?? {};
      const isDead = flags.isDeadToken === true;
      const isContainer = !isDead && isContainerTile(tileDoc);
      if (isDead || isContainer) {
        try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
        if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
        return;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Tile right-click patch handler failed:`, err);
    }
    // Fall through to Foundry's default right-click for non-lootable tiles
    return original?.call(this, event);
  };
  TileClass.prototype.__aceQolRightClickPatched = true;
  console.log(`${MODULE_ID} | Tile.prototype._onClickRight patched (${reason}).`);
  return true;
}

// Register patch installers at TOP LEVEL — runs at module import time
// (during init phase), guaranteeing these hooks register before they fire.
Hooks.once("setup",       () => _aceQolPatchTileClickRight("setup"));
Hooks.once("canvasReady", () => _aceQolPatchTileClickRight("canvasReady"));
Hooks.once("ready",       () => _aceQolPatchTileClickRight("ready"));

// Per-tile defense: if any module replaces CONFIG.Tile.objectClass AFTER
// our setup-time patch, the prototype patch is on the OLD class and useless.
// drawTile fires for every tile rendered on canvas — check the instance's
// actual constructor.prototype and patch THAT one if it lacks our sentinel.
Hooks.on("drawTile", (tile) => {
  try {
    const ctorProto = tile?.constructor?.prototype;
    if (!ctorProto || ctorProto.__aceQolRightClickPatched) return;
    const original = ctorProto._onClickRight;
    ctorProto._onClickRight = function(event) {
      try {
        const tileDoc = this.document ?? this;
        const flags = tileDoc?.flags?.[MODULE_ID] ?? {};
        const isDead = flags.isDeadToken === true;
        const isContainer = !isDead && isContainerTile(tileDoc);
        if (isDead || isContainer) {
          try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
          if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
          return;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | Tile right-click patch handler failed:`, err);
      }
      return original?.call(this, event);
    };
    ctorProto.__aceQolRightClickPatched = true;
    console.log(`${MODULE_ID} | drawTile: late-patched ${tile.constructor.name}.prototype._onClickRight.`);
  } catch (_) {}
});

export class LootableTile {

  constructor() {
    _lootableTileInstance = this;
    this._registerHooks();
  }

  _registerHooks() {
    // Tile right-click patch is installed via top-level Hooks.once("setup"/
    // "canvasReady"/"ready") registered above, NOT from this constructor.
    // (Constructor runs inside ace-qol.mjs's ready hook, by which point any
    //  Hooks.once("ready") registered here would already have missed.)

    // DOM listener — mouse-move tracking for the hover-icon UX
    this._wireDomListener();

    // Tile HUD buttons (GM-only, when on tile layer)
    Hooks.on("renderTileHUD", (hud, html) => this._addTileHudButton(hud, html));

    // Auto-unlock all dead tiles when combat ends
    Hooks.on("deleteCombat", () => this._unlockAllDeadTiles());

    // GM drops an Item onto a container tile → append to that tile's loot
    Hooks.on("dropCanvasData", (canvas, data) => this._onCanvasDrop(canvas, data));

    console.log(`${MODULE_ID} | Lootable tile online (instance bound; right-click patched via top-level hooks)`);
  }

  /** Re-installs the prototype patch on demand. Kept on the instance for
   *  external tools (debug console, hot-reload scripts) — the canonical
   *  install path is the top-level hooks at the head of this file. */
  _patchTileClickRight() {
    return _aceQolPatchTileClickRight("instance.reinstall");
  }

  /**
   * Handle item drops onto the canvas. If the drop target is a container
   * tile, append the dropped item to that tile's loot flag and cancel the
   * default drop handling (Foundry would otherwise reject the drop with an
   * error or create an unwanted token/tile).
   *
   * Returns false to cancel default drop handling.
   *
   * @param {Canvas} _canvas
   * @param {object} data — { type, uuid, x, y, ... }
   */
  async _onCanvasDrop(_canvas, data) {
    if (!game.user.isGM) return;
    if (data?.type !== "Item" || !data?.uuid) return;
    if (typeof data.x !== "number" || typeof data.y !== "number") return;

    // Find a CONTAINER tile at the drop position (dead-body tiles use the
    // actor as source of truth — drops there would be confusing).
    const tileDoc = this._findContainerTileAtWorldPos(data.x, data.y);
    if (!tileDoc) return;

    try {
      const item = await fromUuid(data.uuid);
      if (!item) return;

      const entry = {
        id:     item.id ?? null,
        name:   item.name,
        img:    item.img,
        uuid:   item.uuid,
        type:   item.type,
        rarity: item.system?.rarity ?? "common",
      };

      const loot = getContainerLoot(tileDoc);
      const updatedItems = [...loot.items, entry];

      // If the tile wasn't explicitly marked yet (filename auto-match only),
      // promote to explicit mark — GM is treating it as a container, so make
      // it official to prevent surprises if filename changes.
      const explicit = tileDoc.flags?.[CONTAINER_FLAG_NS]?.[CONTAINER_FLAG_NAME];
      const updates = {
        [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.items`]: updatedItems,
      };
      if (explicit !== true) {
        updates[`flags.${CONTAINER_FLAG_NS}.${CONTAINER_FLAG_NAME}`] = true;
      }
      // Preserve existing currency if any
      if (!loot.currency || typeof loot.currency !== "object") {
        updates[`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.currency`] =
          { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
      }

      await tileDoc.update(updates);
      ui.notifications.info(`ACE QOL: Added ${item.name} to container.`);
      return false;  // cancel default drop handling
    } catch (err) {
      console.warn(`${MODULE_ID} | Container drop failed:`, err);
    }
  }

  /** Find a container tile at the given world position. Used by the
   *  dropCanvasData hook to route Item drops to the right container. */
  _findContainerTileAtWorldPos(worldX, worldY) {
    if (!canvas?.scene) return null;
    const tiles = [...canvas.scene.tiles.contents].reverse();
    for (const tileDoc of tiles) {
      // Only containers — dead-body tiles aren't drop targets
      if (tileDoc.flags?.[MODULE_ID]?.isDeadToken === true) continue;
      if (!isContainerTile(tileDoc)) continue;
      // v0.4.22.11: `??` was substituting for null/undefined only — a
      // tile with width:0 (corrupt or freshly-created) propagated 0
      // through, making the hit-test box have zero area. Use explicit
      // positive-number check.
      const w = (Number(tileDoc.width)  > 0) ? Number(tileDoc.width)  : 100;
      const h = (Number(tileDoc.height) > 0) ? Number(tileDoc.height) : 100;
      if (worldX >= tileDoc.x && worldX < tileDoc.x + w
       && worldY >= tileDoc.y && worldY < tileDoc.y + h) {
        return tileDoc;
      }
    }
    return null;
  }

  // ── DOM-level listeners (Phase 3d — right-click + hover icon) ──────────
  // Two paths to the loot dialog:
  //   1. Single RIGHT-CLICK on a lootable tile (primary — GM and players).
  //      Right-click feels less ambiguous than left-click on the canvas:
  //      left-click is "select / token control"; right-click on the canvas
  //      is already used for context menus elsewhere, so it's a natural
  //      "interact with this thing under the cursor" gesture. Detected via
  //      contextmenu event with drag-resistance: only fires when the click
  //      ended within 500ms of mousedown AND cursor moved less than 5px.
  //   2. Hover for N seconds → treasure-chest icon appears at tile center
  //      ONLY IF the tile has loot to take. Click the icon to open the
  //      dialog. Delay configurable via lootHoverIconDelayMs (0 = disabled).
  _wireDomListener() {
    if (this._domWired) return;
    this._domWired = true;

    // ── Right-click (mousedown→mouseup pair, button=2) with drag-resistance ──
    // We previously tried the `contextmenu` event, but Foundry's PIXI canvas
    // calls preventDefault on it inside its own handlers — by the time our
    // document listener fires, the event has been consumed. The
    // mousedown/mouseup pair on the document fires reliably regardless of
    // PIXI's internal handling.
    //
    // We ALSO swallow contextmenu over a lootable tile so Foundry doesn't
    // pop its default right-click menu on top of our dialog.
    document.addEventListener("mousedown", (ev) => {
      if (ev.button !== 2) return;
      this._rightDownAt = {
        screenX: ev.clientX,
        screenY: ev.clientY,
        time:    Date.now(),
      };
    }, true);  // capture phase — beat Foundry to it

    document.addEventListener("mouseup", (ev) => {
      if (ev.button !== 2) return;
      const start = this._rightDownAt;
      this._rightDownAt = null;
      if (!start) return;
      const dt   = Date.now() - start.time;
      const dist = Math.hypot(ev.clientX - start.screenX, ev.clientY - start.screenY);
      if (dt > 500 || dist > 5) return;
      this._handleSingleRightClick(ev);
    }, true);  // capture phase

    // Suppress browser/Foundry context menu when right-clicking over a
    // lootable tile so our dialog isn't covered by a stray menu.
    document.addEventListener("contextmenu", (ev) => {
      const worldPos = this._eventToWorldPos(ev);
      if (!worldPos) return;
      if (this._findLootableTileAt(worldPos)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }, true);

    // ── Hover-icon system ──
    document.addEventListener("mousemove", (ev) => this._onHoverMove(ev));

    let delayMs = "?";
    try { delayMs = game.settings.get(MODULE_ID, "lootHoverIconDelayMs"); }
    catch (_) {}
    console.log(`${MODULE_ID} | Lootable tile DOM listeners wired — right-click ready; hover-icon delay=${delayMs}ms${delayMs === 0 ? " (DISABLED — set lootHoverIconDelayMs > 0 to enable)" : ""}`);
  }

  /**
   * Process a confirmed single right-click. Opens the loot dialog if the
   * click landed on a lootable tile (dead-body OR container).
   *
   * Click-priority order:
   *   1. Active layer is TilesLayer → defer (GM is editing tiles)
   *   2. Lootable tile at click pos → open loot dialog (highest priority,
   *      wins over overlapping tokens — looting is the dominant intent
   *      when a body/chest is at the click point)
   *   3. Otherwise → no-op (let Foundry handle its own right-click menus)
   */
  _handleSingleRightClick(event) {
    const debug = this._isDebugEnabled();
    const worldPos = this._eventToWorldPos(event);
    if (!worldPos) {
      if (debug) console.debug(`${MODULE_ID} | LootClick: no worldPos (off-canvas) — skip`);
      return;
    }

    // On the Tiles layer, single-click is "select tile" — don't steal it
    const layerName = canvas.activeLayer?.constructor?.name ?? canvas.activeLayer?.name;
    if (layerName === "TilesLayer") {
      if (debug) console.debug(`${MODULE_ID} | LootClick: active layer is TilesLayer — defer`);
      return;
    }

    // Lootable tile wins over overlapping tokens — clicking a visible body
    // or chest is the user's clear intent regardless of who's standing on it.
    const tile = this._findLootableTileAt(worldPos);
    if (!tile) {
      if (debug) {
        const hasToken = this._tokenAtPos(worldPos);
        console.debug(`${MODULE_ID} | LootClick: no lootable tile at (${worldPos.x.toFixed(0)},${worldPos.y.toFixed(0)})${hasToken ? " (token at pos)" : ""}`);
      }
      return;
    }

    const tileDoc = tile.document ?? tile;
    const isDead = tileDoc.flags?.[MODULE_ID]?.isDeadToken === true;
    if (debug) console.debug(`${MODULE_ID} | LootClick: opening loot dialog for ${isDead ? "dead-body" : "container"} tile ${tileDoc.id}`);

    try { event.stopPropagation(); event.preventDefault(); } catch (_) {}
    this._openLootDialog(tile);
  }

  /**
   * Read the lootClickDebug setting if registered. Returns false if the
   * setting doesn't exist — keeps legacy behavior silent.
   */
  _isDebugEnabled() {
    try { return !!game.settings.get(MODULE_ID, "lootClickDebug"); }
    catch (_) { return false; }
  }

  // Convert a DOM mouse event into Foundry world coordinates, or null if
  // the click was outside the canvas viewport.
  _eventToWorldPos(ev) {
    const canvasEl = document.getElementById("board") ?? canvas?.app?.view;
    if (!canvasEl) return null;
    const rect = canvasEl.getBoundingClientRect();
    if (ev.clientX < rect.left || ev.clientX > rect.right
     || ev.clientY < rect.top  || ev.clientY > rect.bottom) return null;
    const screenPos = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    try {
      return canvas.stage.toLocal({ x: screenPos.x, y: screenPos.y });
    } catch (_) {
      return null;
    }
  }

  // Is there a placeable token at this world position? Used to defer to the
  // token's own dblclick handler (which opens the character sheet) when a PC
  // or NPC is standing on top of a dead tile.
  _tokenAtPos(worldPos) {
    if (!worldPos) return false;
    const gridSize = canvas.grid?.size ?? 100;
    for (const t of canvas.tokens?.placeables ?? []) {
      const td = t.document;
      if (!td) continue;
      // v0.4.22.11: same 0-vs-?? bug as the dead-tile hit test
      const wCells = (Number(td.width)  > 0) ? Number(td.width)  : 1;
      const hCells = (Number(td.height) > 0) ? Number(td.height) : 1;
      const tw = wCells * gridSize;
      const th = hCells * gridSize;
      if (worldPos.x >= td.x && worldPos.x < td.x + tw
       && worldPos.y >= td.y && worldPos.y < td.y + th) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find a lootable tile at the given world position. Returns the FIRST
   * matching tile in reverse render order (topmost wins).
   *
   * A tile is lootable if it's a dead-body tile OR a container tile (per
   * isContainerTile() — explicit flag wins, else filename keyword match).
   *
   * @param {{x: number, y: number}} worldPos
   * @returns {Tile|TileDocument|null}
   */
  _findLootableTileAt(worldPos) {
    if (!canvas?.scene || !worldPos) return null;
    const tiles = [...canvas.scene.tiles.contents].reverse();
    for (const tileDoc of tiles) {
      const isDead = tileDoc.flags?.[MODULE_ID]?.isDeadToken === true;
      const isContainer = !isDead && isContainerTile(tileDoc);
      if (!isDead && !isContainer) continue;
      // v0.4.22.11: 0-width tile would never match. Fix below allows
      // recovery — clicking still works on dimensionally-broken tiles.
      const w = (Number(tileDoc.width)  > 0) ? Number(tileDoc.width)  : 100;
      const h = (Number(tileDoc.height) > 0) ? Number(tileDoc.height) : 100;
      if (worldPos.x >= tileDoc.x
       && worldPos.x < tileDoc.x + w
       && worldPos.y >= tileDoc.y
       && worldPos.y < tileDoc.y + h) {
        return tileDoc.object ?? canvas.tiles?.get?.(tileDoc.id) ?? tileDoc;
      }
    }
    return null;
  }

  // Legacy alias — some older code paths still call _findDeadTileAt. Keep
  // it working but prefer the broader lookup (it's strictly a superset).
  _findDeadTileAt(worldPos) {
    return this._findLootableTileAt(worldPos);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Hover-icon system — small treasure-chest icon appears over a lootable
     tile after 1s of hover, providing a discoverable click target for new
     players who don't know the canvas itself is clickable.
     ══════════════════════════════════════════════════════════════════════ */

  _onHoverMove(ev) {
    // Setting === 0 disables the hover icon entirely (still keeps right-click).
    let delayMs = 200;
    try { delayMs = game.settings.get(MODULE_ID, "lootHoverIconDelayMs") ?? 200; }
    catch (_) { /* setting not registered yet — fall back to default */ }
    if (delayMs <= 0) {
      this._cancelHoverIcon();
      return;
    }

    const worldPos = this._eventToWorldPos(ev);
    if (!worldPos) {
      this._cancelHoverIcon();
      return;
    }
    const tile = this._findLootableTileAt(worldPos);
    if (!tile) {
      this._cancelHoverIcon();
      return;
    }
    // One-time diagnostic so we can prove the listener fires + the tile is
    // detected. Logged exactly once per session per tile-id so it doesn't
    // spam. If you never see this line in console, _wireDomListener never
    // ran. If you see it but no icon appears, the problem is downstream
    // (_tileHasLoot returned false, or _showHoverIcon couldn't render).
    if (!this._hoverFirstDetectLogged) this._hoverFirstDetectLogged = new Set();
    const tid = tile.id ?? tile.document?.id;
    if (tid && !this._hoverFirstDetectLogged.has(tid)) {
      this._hoverFirstDetectLogged.add(tid);
      console.log(`${MODULE_ID} | hover-icon: lootable tile detected under cursor (${tid}, delay=${delayMs}ms)`);
    }
    // Don't tease the user with a treasure-chest icon on empty corpses /
    // empty containers — only show the icon if there's actually something
    // to take. Right-click still works either way for diagnostic purposes.
    if (!this._tileHasLoot(tile)) {
      this._cancelHoverIcon();
      return;
    }
    // If we're already showing the icon for this tile, leave it alone
    if (this._hoverIconTileId === (tile.id ?? tile.document?.id)) return;
    // Clear any pending or visible icon for a different tile
    this._cancelHoverIcon();
    // Schedule icon reveal after the configured delay
    const tileId = tile.id ?? tile.document?.id;
    this._hoverPending = setTimeout(() => {
      this._showHoverIcon(tile);
      this._hoverIconTileId = tileId;
    }, delayMs);
  }

  /**
   * Does this tile have any loot worth surfacing the hover icon for?
   * Returns true when:
   *   • Dead-body tile: linked actor has at least 1 lootable item, OR
   *     any positive currency, OR a snapshot with items/currency
   *   • Container tile: containerLoot flag has at least 1 item OR positive currency
   * Returns false for empty bodies / empty chests / unknown sources.
   */
  _tileHasLoot(tile) {
    try {
      const tileDoc = tile?.document ?? tile;
      if (!tileDoc) return false;
      const flags = tileDoc.flags?.[MODULE_ID] ?? {};
      const isDead = flags.isDeadToken === true;
      const isContainer = !isDead && isContainerTile(tileDoc);
      if (!isDead && !isContainer) return false;

      const currencyHasValue = (c) =>
        ((c?.pp ?? 0) + (c?.gp ?? 0) + (c?.ep ?? 0) + (c?.sp ?? 0) + (c?.cp ?? 0)) > 0;

      if (isDead) {
        // Prefer the live actor; fall back to the lootSnapshot if the actor
        // was deleted (Curse of Strahd module purge, GM cleanup, etc.).
        const actor = flags.originalActorId ? game.actors.get(flags.originalActorId) : null;
        if (actor) {
          const items = actor.items?.contents?.filter(i => this._isLootableItem(i)) ?? [];
          if (items.length > 0) return true;
          if (currencyHasValue(actor.system?.currency)) return true;
          return false;
        }
        const snapshot = flags.lootSnapshot ?? null;
        if (snapshot) {
          if ((snapshot.items?.length ?? 0) > 0) return true;
          if (currencyHasValue(snapshot.currency)) return true;
        }
        return false;
      }

      // Container tile
      const loot = getContainerLoot(tileDoc);
      if ((loot.items?.length ?? 0) > 0) return true;
      if (currencyHasValue(loot.currency)) return true;
      return false;
    } catch (_) {
      // Fail safe — if loot detection blows up, show the icon so the user
      // can still try clicking. Better to over-show than to hide a valid
      // body behind a bug.
      return true;
    }
  }

  _cancelHoverIcon() {
    if (this._hoverPending) {
      clearTimeout(this._hoverPending);
      this._hoverPending = null;
    }
    if (this._hoverIconEl) {
      try { this._hoverIconEl.remove(); } catch (_) {}
      this._hoverIconEl = null;
    }
    this._hoverIconTileId = null;
  }

  _showHoverIcon(tile) {
    try {
      const tileDoc = tile.document ?? tile;
      if (!tileDoc) return;
      // v0.4.22.11: same 0-width fallback fix
      const w = (Number(tileDoc.width)  > 0) ? Number(tileDoc.width)  : 100;
      const h = (Number(tileDoc.height) > 0) ? Number(tileDoc.height) : 100;
      const cx = tileDoc.x + w / 2;
      const cy = tileDoc.y + h / 2;
      // Convert world → screen via canvas.stage
      const screen = canvas.stage.toGlobal({ x: cx, y: cy });
      const canvasEl = document.getElementById("board") ?? canvas?.app?.view;
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const left = rect.left + screen.x;
      const top  = rect.top  + screen.y;

      const icon = document.createElement("div");
      icon.className = "ace-qol-loot-hover-icon";
      // fa-sack-dollar is Font Awesome 6 Free (Foundry V13 bundles Free).
      // Previously used fa-treasure-chest, which is Pro-only — the icon
      // div rendered as a blank circle on Free installations.
      icon.innerHTML = `<i class="fas fa-sack-dollar" aria-hidden="true"></i>`;
      icon.style.cssText = `
        position: fixed;
        left: ${left}px;
        top: ${top}px;
        transform: translate(-50%, -50%);
        width: 76px; height: 76px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(212, 175, 55, 0.95);
        border: 3px solid #d4af37;
        border-radius: 50%;
        color: #1a1a1e;
        font-size: 40px;
        cursor: pointer;
        box-shadow: 0 3px 14px rgba(0,0,0,0.65);
        z-index: 10000;
        pointer-events: auto;
        animation: ace-qol-loot-pulse 1.4s ease-in-out infinite;
      `;
      icon.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._cancelHoverIcon();
        this._openLootDialog(tile);
      });
      // Don't let the icon's own pointer events trigger our hover-out cleanup
      icon.addEventListener("mousemove", (ev) => ev.stopPropagation());
      document.body.appendChild(icon);
      this._hoverIconEl = icon;
    } catch (err) {
      console.warn(`${MODULE_ID} | hover-icon show failed:`, err);
    }
  }

  // ── GM tile-HUD buttons (when GM has tile layer active) ──
  // Up to three buttons can appear (any subset based on tile type):
  //   1. Loot — opens the loot dialog (dead-body or container)
  //   2. Edit Loot — set name/currency, remove items (container only)
  //   3. Mark/Unmark Container — toggle the explicit container flag
  _addTileHudButton(hud, html) {
    if (!game.user.isGM) return;
    const tile = hud.object;
    const tileDoc = tile?.document;
    if (!tileDoc) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const col = root.querySelector(".col.left, .col-left, .left") ?? root;

    const aceQolFlags = tileDoc.flags?.[MODULE_ID] ?? {};
    const isDead = aceQolFlags.isDeadToken === true;
    const isContainer = !isDead && isContainerTile(tileDoc);
    const explicitMark = tileDoc.flags?.[CONTAINER_FLAG_NS]?.[CONTAINER_FLAG_NAME];

    const makeBtn = (icon, title, bg, onClick) => {
      const btn = document.createElement("div");
      btn.className = "control-icon ace-qol-loot-tile-btn";
      btn.innerHTML = `<i class="fas ${icon}"></i>`;
      btn.title = title;
      btn.style.cssText = `background:${bg};border:1px solid #d4af37;cursor:pointer;`;
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick(ev);
      });
      col.appendChild(btn);
    };

    // ── Loot button (any lootable tile) ──
    if (isDead || isContainer) {
      makeBtn(
        "fa-treasure-chest",
        isDead ? "Loot this body" : "Open container",
        "rgba(212,175,55,0.2)",
        () => this._openLootDialog(tile),
      );
    }

    // ── Edit Loot (container only — set currency, remove items, rename) ──
    if (isContainer) {
      makeBtn(
        "fa-pen-to-square",
        "Edit container loot (currency, items, name)",
        "rgba(80,160,212,0.2)",
        () => this._openEditLootDialog(tile),
      );
    }

    // ── Mark / Unmark Container — only for non-dead tiles ──
    if (!isDead) {
      const isExplicitlyMarked = explicitMark === true;
      const autoMatch = isContainer && explicitMark === undefined;

      if (isExplicitlyMarked) {
        makeBtn(
          "fa-times-circle",
          "Unmark as container",
          "rgba(180,80,80,0.2)",
          async () => {
            await tileDoc.update({
              [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_FLAG_NAME}`]: false,
            });
            ui.notifications.info("ACE QOL: Tile unmarked as container.");
          },
        );
      } else if (autoMatch) {
        // Auto-detected by filename — let GM force-disable
        makeBtn(
          "fa-times-circle",
          "Disable container detection (filename auto-match)",
          "rgba(180,140,80,0.2)",
          async () => {
            await tileDoc.update({
              [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_FLAG_NAME}`]: false,
            });
            ui.notifications.info("ACE QOL: Container detection disabled for this tile.");
          },
        );
      } else {
        makeBtn(
          "fa-box-open",
          "Mark as container",
          "rgba(80,160,212,0.2)",
          async () => {
            await tileDoc.update({
              [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_FLAG_NAME}`]: true,
            });
            ui.notifications.info("ACE QOL: Tile marked as container. Drop Items onto it to add loot.");
          },
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dialog
  // ═══════════════════════════════════════════════════════════════════════════

  async _openLootDialog(tile) {
    const tileDoc = tile.document ?? tile;
    const flags = tileDoc?.flags?.[MODULE_ID] ?? {};
    const isDead      = flags.isDeadToken === true;
    const isContainer = !isDead && isContainerTile(tileDoc);
    if (!isDead && !isContainer) return;

    // Resolve loot data based on tile kind:
    //   - dead-body → live actor (preferred) or snapshot (player fallback)
    //   - container → flags["ace-suite"].containerLoot on the tile itself
    // The `source` string drives the dialog's transfer/split behavior.
    let items, currency, source, actor = null, displayName;

    if (isDead) {
      actor = game.actors.get(flags.originalActorId);
      const snapshot = flags.lootSnapshot ?? null;
      if (actor) {
        source = "actor";
        items = actor.items.contents
          .filter(i => this._isLootableItem(i))
          .map(i => ({ id: i.id, name: i.name, img: i.img, uuid: i.uuid }));
        currency = actor.system?.currency ?? {};
      } else if (snapshot) {
        source = "snapshot";
        items = snapshot.items ?? [];
        currency = snapshot.currency ?? {};
      } else {
        ui.notifications.warn(`ACE QOL: Loot data not available for "${flags.originalName}".`);
        return;
      }
      displayName = flags.originalName ?? actor?.name ?? "Unknown";
    } else {
      source = "container";
      const loot = getContainerLoot(tileDoc);
      items = loot.items;
      currency = loot.currency;
      displayName = tileDoc.flags?.[CONTAINER_FLAG_NS]?.containerName
                  ?? this._extractContainerName(tileDoc);
    }

    // Combat-lock only applies to dead-body tiles (corpses are typically
    // looted post-combat; static chests don't share that semantic).
    const isLocked = isDead && !!flags.combatLocked && !!game.combat?.started;

    const totalCoins = (currency.pp ?? 0) + (currency.gp ?? 0) + (currency.ep ?? 0)
                     + (currency.sp ?? 0) + (currency.cp ?? 0);

    // Loot recipients = all PCs + any friendly/neutral NPC tokens on the scene.
    // Containers don't have a "self" actor to exclude.
    const recipients = this._getLootRecipients(isDead ? flags.originalActorId : null);

    // GM can distribute from a live actor OR a container; snapshots are
    // read-only because the source actor is gone.
    const canDistribute = game.user.isGM && (source === "actor" || source === "container");
    const btnDisabled = (isLocked || !canDistribute) ? "disabled" : "";

    // Item identifier in the DOM:
    //   - actor   → item.id (used with actor.items.get to fetch + delete)
    //   - snapshot → item.uuid (display only; no transfer)
    //   - container → item.uuid (used with fromUuid + flag-array filter)
    const keyFor = (item) => source === "actor" ? (item.id ?? "") : (item.uuid ?? "");

    const itemRowsHtml = items.length ? items.map((item, idx) => {
      const key = keyFor(item);
      const recipientBtns = canDistribute ? recipients.map(r => {
        const colorStyle = r.color ? `border-color:${r.color}` : "";
        const typeBadge = r.type === "pc" ? "👤" : "🤝";
        return `<button class="ace-qol-loot-give-btn" data-item-key="${key}" data-actor-id="${r.actorId}" style="${colorStyle}" ${btnDisabled} title="${r.type === "pc" ? "Player Character" : "Friendly/Neutral NPC"}">${typeBadge} ${foundry.utils.escapeHTML(r.name)}</button>`;
      }).join("") : "";
      return `
        <div class="ace-qol-tile-loot-item" data-item-key="${key}">
          <img src="${item.img}" class="ace-qol-tile-loot-img" />
          <span class="ace-qol-tile-loot-name">${foundry.utils.escapeHTML(item.name)}</span>
          ${canDistribute ? `<div class="ace-qol-tile-loot-give-row">${recipientBtns}</div>` : ""}
        </div>
      `;
    }).join("") : `<div class="ace-qol-tile-loot-empty">No items remaining.</div>`;

    const goldHtml = totalCoins > 0 ? `
      <div class="ace-qol-tile-loot-gold">
        💰 <strong>${currency.pp ? `${currency.pp}pp ` : ""}${currency.gp ? `${currency.gp}gp ` : ""}${currency.ep ? `${currency.ep}ep ` : ""}${currency.sp ? `${currency.sp}sp ` : ""}${currency.cp ? `${currency.cp}cp` : ""}</strong>
        ${canDistribute ? `<button class="ace-qol-loot-split-gold-btn" ${btnDisabled}>Split Evenly</button>` : ""}
      </div>
    ` : "";

    const lockBanner = isLocked ? `
      <div class="ace-qol-tile-loot-locked">
        🔒 Locked during combat.
        ${game.user.isGM ? `<button class="ace-qol-loot-unlock-btn">Unlock this body</button>` : ""}
      </div>
    ` : "";

    // Subtitle: creature type for dead bodies, "Container" for chests
    const subtitle = isDead
      ? (flags.creatureType ?? "")
      : "Container";

    const content = `
      <div class="ace-qol-tile-loot-dialog">
        <div class="ace-qol-tile-loot-header">
          <strong>${foundry.utils.escapeHTML(displayName)}</strong>
          <span class="ace-qol-tile-loot-type">${foundry.utils.escapeHTML(subtitle)}</span>
        </div>
        ${lockBanner}
        ${goldHtml}
        <div class="ace-qol-tile-loot-items">${itemRowsHtml}</div>
      </div>
    `;

    const dlg = await foundry.applications.api.DialogV2.wait({
      window: { title: `Loot — ${displayName}` },
      classes: ["ace-qol-tile-loot-dialog-window"],
      content,
      buttons: [{ action: "close", label: "Close", icon: "fa-solid fa-xmark", default: true }],
      rejectClose: false,
      position: { width: 460 },
      render: (event, dialog) =>
        this._wireDialog(event, dialog, { tile, actor, recipients, source }),
    });
  }

  _wireDialog(event, dialog, ctx) {
    const root = dialog?.element ?? event?.currentTarget ?? document;
    if (!root?.querySelectorAll) return;

    // Backward-compat: older callers passed positional args (event, dialog,
    // tile, actor, recipients). Detect that shape and synthesize the ctx.
    if (ctx && typeof ctx === "object" && !("source" in ctx) && arguments.length > 3) {
      ctx = { tile: arguments[2], actor: arguments[3], recipients: arguments[4], source: "actor" };
    }
    const { tile, actor, recipients, source } = ctx ?? {};

    // ── Give-to-recipient buttons ──
    root.querySelectorAll(".ace-qol-loot-give-btn").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        if (!game.user.isGM) {
          ui.notifications.warn("Only the GM can assign loot.");
          return;
        }
        const key = btn.dataset.itemKey;
        const actorId = btn.dataset.actorId;
        const targetActor = game.actors.get(actorId);
        if (!key || !targetActor) return;

        try {
          if (source === "container") {
            // Container path — load by UUID, copy onto target, remove from
            // the tile's containerLoot flag.
            const sourceItem = await fromUuid(key);
            if (!sourceItem) {
              ui.notifications.warn(`ACE QOL: Couldn't load item from ${key}.`);
              return;
            }
            const itemData = sourceItem.toObject();
            await targetActor.createEmbeddedDocuments("Item", [itemData]);
            await this._removeContainerItem(tile, key);
            ui.notifications.info(`ACE QOL: Gave ${sourceItem.name} to ${targetActor.name}.`);
            btn.closest(".ace-qol-tile-loot-item")?.remove();
            await ChatMessage.create({
              content: `<em><strong>${foundry.utils.escapeHTML(targetActor.name)}</strong> received <strong>${foundry.utils.escapeHTML(sourceItem.name)}</strong> from the chest.</em>`,
            });
          } else if (source === "actor" && actor) {
            // Live-actor path — original transfer logic
            const item = actor.items.get(key);
            if (!item) return;
            const itemData = item.toObject();
            await targetActor.createEmbeddedDocuments("Item", [itemData]);
            await item.delete();
            ui.notifications.info(`ACE QOL: Gave ${item.name} to ${targetActor.name}.`);
            btn.closest(".ace-qol-tile-loot-item")?.remove();
            await ChatMessage.create({
              content: `<em><strong>${foundry.utils.escapeHTML(targetActor.name)}</strong> received <strong>${foundry.utils.escapeHTML(item.name)}</strong> from ${foundry.utils.escapeHTML(actor.name)}'s body.</em>`,
            });
            // Keep tile snapshot in sync so players see the updated loot list
            await this._syncSnapshotItemRemoved(tile, key);
          }
          // source === "snapshot": read-only, give-buttons aren't shown
        } catch (err) {
          console.error(`${MODULE_ID} | Loot transfer failed:`, err);
          ui.notifications.error(`Failed to transfer item.`);
        }
      });
    });

    // ── Split gold button (GM only) ──
    const splitBtn = root.querySelector(".ace-qol-loot-split-gold-btn");
    if (splitBtn) {
      splitBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        if (!game.user.isGM) return;
        if (source === "container") {
          await this._splitContainerGold(tile, recipients);
          splitBtn.disabled = true;
          splitBtn.textContent = "Split Done";
        } else if (source === "actor" && actor) {
          await this._splitGold(actor, recipients);
          splitBtn.disabled = true;
          splitBtn.textContent = "Split Done";
          await this._syncSnapshotCurrencyZeroed(tile);
        }
      });
    }

    // ── Unlock button (GM only) ──
    const unlockBtn = root.querySelector(".ace-qol-loot-unlock-btn");
    if (unlockBtn) {
      unlockBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        await tile.document.update({ [`flags.${MODULE_ID}.combatLocked`]: false });
        ui.notifications.info(`ACE QOL: Unlocked. Re-open to claim.`);
        // Re-render dialog with unlocked state
        await dialog.close();
        this._openLootDialog(tile);
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Decide whether an item on a dead NPC should appear in the loot dialog.
   * Rejects: class/racial features, spells, monster natural attacks (Bite,
   * Claws, etc.), improvised weapons, unequippable abilities.
   * Accepts: actual gear, weapons, consumables, treasure, etc.
   */
  _isLootableItem(item) {
    if (!item) return false;
    const type = item.type;

    // ── 1. Reject non-inventory item types entirely ──
    const REJECT_TYPES = new Set([
      "feat", "spell", "class", "subclass", "background", "race",
      "species", "facility", "feature", "trait", "spelllist",
    ]);
    if (REJECT_TYPES.has(type)) return false;

    // ── 2. Only allow recognized inventory types ──
    const ALLOW_TYPES = new Set([
      "weapon", "equipment", "consumable", "tool", "loot",
      "container", "treasure", "backpack",
    ]);
    if (!ALLOW_TYPES.has(type)) return false;

    // ── 3. Filter out monster natural / improvised weapons ──
    if (type === "weapon") {
      const sys = item.system ?? {};
      const weaponType = sys.weaponType ?? sys.type?.value ?? "";
      const NATURAL_TYPES = new Set(["natural", "improv", "improvised", "siege"]);
      if (NATURAL_TYPES.has(weaponType)) return false;

      // Name backstop matches DDB Importer's authoritative natural-weapon list.
      // Tight on purpose — primary filter is weaponType==="natural" above.
      // This catches the few cases where system metadata is wrong/missing.
      const NATURAL_NAME_RE = /^(bite|claws?|cat'?s\s+claws|fangs|gore|sting|talons?|trunk|fanged\s+bite|vampiric\s+bite|form\s+of\s+the\s+beast|natural\s+attack)\b/i;
      if (NATURAL_NAME_RE.test(item.name?.trim() ?? "")) return false;
    }

    // ── 4. Reject items flagged as inactive features ──
    // Some monster items are "weapons" but actually class features
    if (item.system?.equipped === undefined && item.system?.identifier) {
      // Probably a feature dressed as a weapon — skip
      // (real weapons have an `equipped` boolean)
    }

    return true;
  }

  /**
   * Build the list of loot recipients:
   *  - All PCs (any actor with hasPlayerOwner)
   *  - Any alive non-hostile tokens on the current scene (disposition ≥ 0)
   *  Excluded: the dead body itself, hostile tokens, dead/incapacitated actors
   */
  _getLootRecipients(excludeActorId) {
    const seen = new Set();
    const recipients = [];

    // 1. All PCs (characters with player ownership)
    for (const a of game.actors.contents) {
      if (a.type !== "character") continue;
      if (!a.hasPlayerOwner) continue;
      if (a.id === excludeActorId) continue;
      const hp = a.system?.attributes?.hp?.value;
      if (hp !== undefined && hp <= 0) continue; // skip dead PCs
      // Match a user for color coding
      const user = game.users.find(u => !u.isGM && a.testUserPermission(u, "OWNER"));
      seen.add(a.id);
      recipients.push({
        type:    "pc",
        actorId: a.id,
        name:    a.name,
        color:   user?.color ?? null,
      });
    }

    // 2. Friendly/neutral NPCs on the current scene (disposition ≥ 0)
    if (canvas.scene) {
      for (const token of canvas.tokens?.placeables ?? []) {
        if (!token.actor || seen.has(token.actor.id)) continue;
        if (token.actor.id === excludeActorId) continue;
        const disp = token.document?.disposition ?? 0;
        if (disp === -1) continue;              // hostile — skip
        const hp = token.actor.system?.attributes?.hp?.value;
        if (hp !== undefined && hp <= 0) continue; // skip dead
        if (token.document.flags?.[MODULE_ID]?.isDeadToken) continue;
        // Include
        seen.add(token.actor.id);
        recipients.push({
          type:    token.actor.hasPlayerOwner ? "pc" : "npc",
          actorId: token.actor.id,
          name:    token.name ?? token.actor.name,
          color:   null,
        });
      }
    }

    return recipients;
  }

  async _splitGold(actor, recipients) {
    if (!recipients?.length) {
      ui.notifications.warn("No eligible recipients to split gold to.");
      return;
    }
    const cur = actor.system?.currency ?? {};
    const totalCp = (cur.pp ?? 0) * 1000 + (cur.gp ?? 0) * 100 + (cur.ep ?? 0) * 50
                  + (cur.sp ?? 0) * 10 + (cur.cp ?? 0);
    if (totalCp <= 0) {
      ui.notifications.info("No gold to split.");
      return;
    }
    const sharePerCp = Math.floor(totalCp / recipients.length);
    const sharePerGp = Math.floor(sharePerCp / 100);
    const remainderCp = sharePerCp - sharePerGp * 100;
    const sharePerSp = Math.floor(remainderCp / 10);
    const sharePerCpFinal = remainderCp - sharePerSp * 10;

    for (const r of recipients) {
      const targetActor = game.actors.get(r.actorId);
      if (!targetActor) continue;
      const tc = targetActor.system?.currency ?? {};
      try {
        await targetActor.update({
          "system.currency.gp": (tc.gp ?? 0) + sharePerGp,
          "system.currency.sp": (tc.sp ?? 0) + sharePerSp,
          "system.currency.cp": (tc.cp ?? 0) + sharePerCpFinal,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Gold split to ${targetActor.name} failed:`, err);
      }
    }

    // Zero out actor's currency
    try {
      await actor.update({
        "system.currency.pp": 0,
        "system.currency.gp": 0,
        "system.currency.ep": 0,
        "system.currency.sp": 0,
        "system.currency.cp": 0,
      });
    } catch (_) {}

    await ChatMessage.create({
      content: `<em>Split <strong>${sharePerGp}gp ${sharePerSp}sp ${sharePerCpFinal}cp</strong> per recipient from ${foundry.utils.escapeHTML(actor.name)}'s body (${recipients.length} recipient${recipients.length === 1 ? "" : "s"}: ${recipients.map(r => foundry.utils.escapeHTML(r.name)).join(", ")}).</em>`,
    });
  }

  // ── Snapshot maintenance — keep tile.flags.lootSnapshot in sync with the
  //    live actor as the GM transfers items / splits gold from the dialog.
  //    Players read from the snapshot since they typically lack actor permission.
  async _syncSnapshotItemRemoved(tile, itemId) {
    try {
      const tileDoc = tile?.document ?? tile;
      const snap = tileDoc?.flags?.[MODULE_ID]?.lootSnapshot;
      if (!snap?.items) return;
      const updatedItems = snap.items.filter(s => s.id !== itemId);
      if (updatedItems.length === snap.items.length) return;  // nothing changed
      await tileDoc.update({ [`flags.${MODULE_ID}.lootSnapshot.items`]: updatedItems });
    } catch (err) {
      console.warn(`${MODULE_ID} | Snapshot item sync failed (non-blocking):`, err);
    }
  }

  async _syncSnapshotCurrencyZeroed(tile) {
    try {
      const tileDoc = tile?.document ?? tile;
      if (!tileDoc?.flags?.[MODULE_ID]?.lootSnapshot) return;
      await tileDoc.update({
        [`flags.${MODULE_ID}.lootSnapshot.currency`]: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Snapshot currency sync failed (non-blocking):`, err);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     Container-tile helpers (Phase 3c)
     ══════════════════════════════════════════════════════════════════════ */

  /** Derive a display name from a tile's texture filename. "chest_wooden_01.png"
   *  → "Chest Wooden 01". Falls back to "Container" if no path. */
  _extractContainerName(tileDoc) {
    const path = tileDoc?.texture?.src ?? "";
    if (!path) return "Container";
    const base = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Container";
    return base.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  /** Remove an item (by UUID) from a container tile's loot flag. */
  async _removeContainerItem(tile, uuid) {
    try {
      const tileDoc = tile?.document ?? tile;
      const loot = getContainerLoot(tileDoc);
      const updatedItems = loot.items.filter(i => i.uuid !== uuid);
      if (updatedItems.length === loot.items.length) return;
      await tileDoc.update({
        [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.items`]: updatedItems,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | _removeContainerItem failed:`, err);
    }
  }

  /** Split a container tile's gold among recipients and zero out the flag. */
  async _splitContainerGold(tile, recipients) {
    if (!recipients?.length) {
      ui.notifications.warn("ACE QOL: No eligible recipients to split gold to.");
      return;
    }
    const tileDoc = tile?.document ?? tile;
    const loot = getContainerLoot(tileDoc);
    const c = loot.currency ?? {};
    const totalCp = (c.pp ?? 0) * 1000 + (c.gp ?? 0) * 100 + (c.ep ?? 0) * 50
                  + (c.sp ?? 0) * 10  + (c.cp ?? 0);
    if (totalCp <= 0) {
      ui.notifications.info("ACE QOL: No gold to split.");
      return;
    }
    const sharePerCp = Math.floor(totalCp / recipients.length);
    const sharePerGp = Math.floor(sharePerCp / 100);
    const remCp1     = sharePerCp - sharePerGp * 100;
    const sharePerSp = Math.floor(remCp1 / 10);
    const sharePerCpFinal = remCp1 - sharePerSp * 10;

    for (const r of recipients) {
      const targetActor = game.actors.get(r.actorId);
      if (!targetActor) continue;
      const tc = targetActor.system?.currency ?? {};
      try {
        await targetActor.update({
          "system.currency.gp": (tc.gp ?? 0) + sharePerGp,
          "system.currency.sp": (tc.sp ?? 0) + sharePerSp,
          "system.currency.cp": (tc.cp ?? 0) + sharePerCpFinal,
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Container gold split to ${targetActor.name} failed:`, err);
      }
    }

    // Zero the container's currency flag
    try {
      await tileDoc.update({
        [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.currency`]:
          { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
      });
    } catch (_) {}

    const containerName = this._extractContainerName(tileDoc);
    await ChatMessage.create({
      content: `<em>Split <strong>${sharePerGp}gp ${sharePerSp}sp ${sharePerCpFinal}cp</strong> per recipient from ${foundry.utils.escapeHTML(containerName)} (${recipients.length} recipient${recipients.length === 1 ? "" : "s"}: ${recipients.map(r => foundry.utils.escapeHTML(r.name)).join(", ")}).</em>`,
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     GM "Edit Loot" dialog — set name, currency, remove items in bulk.
     Items are normally added via drag-and-drop onto the tile; this dialog
     covers everything that drag-drop can't.
     ══════════════════════════════════════════════════════════════════════ */

  async _openEditLootDialog(tile) {
    if (!game.user.isGM) return;
    const tileDoc = tile?.document ?? tile;
    if (!tileDoc) return;

    const initialName = tileDoc.flags?.[CONTAINER_FLAG_NS]?.containerName
                     ?? this._extractContainerName(tileDoc);
    const loot = getContainerLoot(tileDoc);
    const c = loot.currency;

    // Track removed item uuids — applied at save time against the LIVE
    // tile flags, so items dragged onto the tile mid-edit are preserved.
    const removedUuids = new Set();

    const escapeHTML = (s) => foundry.utils.escapeHTML(String(s ?? ""));
    const itemsHtml = loot.items.length
      ? loot.items.map((item) => `
          <div class="ace-qol-edit-loot-item" data-item-uuid="${escapeHTML(item.uuid)}">
            <img src="${escapeHTML(item.img ?? "")}" class="ace-qol-edit-loot-img" />
            <span class="ace-qol-edit-loot-name">${escapeHTML(item.name)}</span>
            <button type="button" class="ace-qol-edit-loot-remove" data-action="removeItem" data-uuid="${escapeHTML(item.uuid)}" title="Remove this item">✕</button>
          </div>`).join("")
      : `<div class="ace-qol-edit-loot-empty"><em>No items yet. Drag items from the sidebar onto the tile to add them.</em></div>`;

    const content = `
      <div class="ace-qol-edit-loot-dialog">
        <div class="form-group ace-qol-edit-loot-namerow">
          <label>Container Name</label>
          <input type="text" name="containerName" value="${escapeHTML(initialName)}" />
        </div>
        <fieldset class="ace-qol-edit-loot-currency">
          <legend>Currency</legend>
          <label>PP <input type="number" name="pp" value="${c.pp ?? 0}" min="0" /></label>
          <label>GP <input type="number" name="gp" value="${c.gp ?? 0}" min="0" /></label>
          <label>EP <input type="number" name="ep" value="${c.ep ?? 0}" min="0" /></label>
          <label>SP <input type="number" name="sp" value="${c.sp ?? 0}" min="0" /></label>
          <label>CP <input type="number" name="cp" value="${c.cp ?? 0}" min="0" /></label>
        </fieldset>
        <fieldset class="ace-qol-edit-loot-itemsbox">
          <legend>Items</legend>
          <div class="ace-qol-edit-loot-itemlist">${itemsHtml}</div>
          <div class="ace-qol-edit-loot-hint">
            Drag Items from the sidebar onto the tile to add new entries.
            Click ✕ to mark for removal — applied on Save.
          </div>
        </fieldset>
      </div>
    `;

    return foundry.applications.api.DialogV2.wait({
      window: { title: `Edit Loot — ${initialName}` },
      classes: ["ace-qol-edit-loot-dialog-window"],
      content,
      buttons: [
        {
          action: "save",
          label:  "Save Changes",
          icon:   "fa-solid fa-floppy-disk",
          default: true,
          callback: async (event, button, dialog) => {
            const root = dialog?.element ?? document;
            const nameInput = root.querySelector('input[name="containerName"]');
            const newName = (nameInput?.value ?? "").trim() || initialName;

            const readNum = (name) => {
              const el = root.querySelector(`input[name="${name}"]`);
              const v = parseInt(el?.value);
              return Number.isFinite(v) && v >= 0 ? v : 0;
            };
            const newCurrency = {
              pp: readNum("pp"),
              gp: readNum("gp"),
              ep: readNum("ep"),
              sp: readNum("sp"),
              cp: readNum("cp"),
            };

            // Re-read CURRENT items at save time so anything dragged in
            // during the edit session is preserved.
            const liveItems = tileDoc.flags?.[CONTAINER_FLAG_NS]?.[CONTAINER_LOOT_NAME]?.items ?? [];
            const newItems = liveItems.filter(i => !removedUuids.has(i.uuid));

            try {
              await tileDoc.update({
                [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_FLAG_NAME}`]: true,
                [`flags.${CONTAINER_FLAG_NS}.containerName`]: newName,
                [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.currency`]: newCurrency,
                [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.items`]: newItems,
              });
              ui.notifications.info(`ACE QOL: Saved loot for ${newName}.`);
            } catch (err) {
              console.error(`${MODULE_ID} | Edit-loot save failed:`, err);
              ui.notifications.error("ACE QOL: Failed to save container loot.");
            }
          },
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" },
      ],
      rejectClose: false,
      position: { width: 480 },
      render: (event, dialog) => {
        const root = dialog?.element ?? event?.currentTarget ?? document;
        if (!root?.querySelectorAll) return;
        // Wire the per-item ✕ buttons. Marking is visual only — actual
        // mutation happens on Save (so Cancel really cancels).
        root.querySelectorAll('[data-action="removeItem"]').forEach(btn => {
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            const uuid = btn.dataset.uuid;
            if (!uuid) return;
            removedUuids.add(uuid);
            const row = btn.closest(".ace-qol-edit-loot-item");
            if (row) {
              row.style.opacity = "0.4";
              row.style.textDecoration = "line-through";
            }
            btn.disabled = true;
            btn.textContent = "—";
          });
        });
      },
    });
  }

  async _unlockAllDeadTiles() {
    if (!game.user.isGM) return;
    if (!canvas.scene) return;
    const lockedTiles = canvas.scene.tiles.contents.filter(t =>
      t.flags?.[MODULE_ID]?.isDeadToken && t.flags?.[MODULE_ID]?.combatLocked);
    if (!lockedTiles.length) return;
    const updates = lockedTiles.map(t => ({
      _id: t.id,
      [`flags.${MODULE_ID}.combatLocked`]: false,
    }));
    try {
      await canvas.scene.updateEmbeddedDocuments("Tile", updates);
      console.log(`${MODULE_ID} | Combat ended — auto-unlocked ${lockedTiles.length} loot tile${lockedTiles.length === 1 ? "" : "s"}`);
    } catch (err) {
      console.warn(`${MODULE_ID} | Combat-end auto-unlock failed:`, err);
    }
  }
}
