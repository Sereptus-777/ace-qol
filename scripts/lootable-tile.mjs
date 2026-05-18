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

  // ─── Description-cleaning helpers ────────────────────────────────────────
  // Foundry V13 + dnd5e 5.x descriptions are rich text with HTML tags AND
  // enricher syntax baked in. When we display item descriptions in plain
  // text (loot dialog, hover tooltips, anywhere we don't want full HTML),
  // we have to strip BOTH layers — otherwise raw artifacts like
  // `[[/attack extended]]` or `@UUID[Compendium.dnd5e...]{Sword}` leak
  // into the UI looking like garbage.
  //
  // Static so any future feature that displays item text can reuse them
  // without having to re-derive the regex set.

  /**
   * Strip HTML tags, decode common entities, and remove dnd5e/Foundry
   * enricher syntax from an item-description string. Returns a clean
   * single-line plain-text fragment (whitespace collapsed).
   *
   * Handles:
   *   • HTML tags                                  <p>, <em>, <strong>, …
   *   • Common HTML entities                       &nbsp; &amp; &lt; &gt; &quot;
   *   • dnd5e enricher commands                    [[/attack ...]], [[/damage ...]],
   *                                                [[/save ...]], [[/check ...]],
   *                                                [[/heal ...]], [[/h ...]],
   *                                                [[/r ...]], [[/roll ...]],
   *                                                [[/ability ...]], etc.
   *   • Inline-roll formulas                       [[<formula>]]
   *   • Foundry referential enrichers              @UUID[ref]{Label}     → "Label"
   *                                                @Compendium[ref]{Label} → "Label"
   *                                                @Item[ref]{Label}     → "Label"
   *                                                @Actor[ref]{Label}    → "Label"
   *                                                @Scene[ref]{Label}    → "Label"
   *                                                @Folder[ref]{Label}   → "Label"
   *                                                @JournalEntry[ref]{Label} → "Label"
   *   • Same enrichers without a label             @Check[ability=str], @Damage[2d6]
   *                                                (whole tag removed)
   *
   * @param {string} s   Raw description value
   * @returns {string}   Cleaned single-line plain text (empty string if input was empty)
   */
  static cleanItemDescription(s) {
    if (!s) return "";
    let out = String(s);

    // 1. Strip enricher commands first — they're the most likely source of
    //    bracketed garbage. `[[/cmd args]]` covers attack/damage/save/check/
    //    heal/h/r/roll/ability/concentration/condition and any future
    //    slash-prefixed enricher.
    out = out.replace(/\[\[\/[^\]]+\]\]/g, "");

    // 2. Strip inline-roll formulas `[[1d6+2]]`, `[[@scaling.cantrip]]`, etc.
    //    Anything else still wrapped in [[ ]] at this point is a roll
    //    formula — Foundry uses these heavily in spells/feats.
    out = out.replace(/\[\[[^\]]+\]\]/g, "");

    // 3. Replace document-referential enrichers with their label when one
    //    exists (e.g. @UUID[...]{Sword of Wounding} → "Sword of Wounding").
    //    Without the label we have no human-readable fallback, so drop
    //    the whole thing.
    out = out.replace(/@(?:UUID|Compendium|Item|Actor|Scene|Folder|JournalEntry|Macro|RollTable)\[[^\]]+\]\{([^}]+)\}/g, "$1");
    out = out.replace(/@(?:UUID|Compendium|Item|Actor|Scene|Folder|JournalEntry|Macro|RollTable)\[[^\]]+\]/g, "");

    // 4. Strip remaining `@Foo[args]` enrichers (e.g. @Check, @Damage,
    //    @Save) that don't carry a label. Conservative — only matches
    //    the @Word[ … ] shape.
    out = out.replace(/@\w+\[[^\]]+\]/g, "");

    // 5. HTML tags
    out = out.replace(/<[^>]+>/g, " ");

    // 6. Common HTML entities
    out = out
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&#x?[0-9a-f]+;/gi, "");  // any remaining numeric/hex entity

    // 7. Collapse whitespace
    out = out.replace(/\s+/g, " ").trim();

    // 8. Trim leading punctuation left behind by stripped enrichers
    //    ("., a shield is made..." → "a shield is made...")
    out = out.replace(/^[.,;:\s]+/, "");

    return out;
  }

  /** Truncate a cleaned description to `n` chars, appending an ellipsis
   *  if a cut was made. Used by the loot dialog to keep entries from
   *  ballooning vertically. */
  static truncateDescription(s, n = 220) {
    if (!s) return "";
    if (s.length <= n) return s;
    return s.slice(0, n - 1).trimEnd() + "…";
  }

  /**
   * Build a dialog-ready row from a STORED item entry (snapshot or
   * container path — both store plain data, not live Item documents).
   *
   * Respects the unidentified layer in the same way `_buildLootItemRow`
   * does for live items: when an entry is marked unidentified AND has an
   * obscured name / description stored on it, show those instead of the
   * real values. Players see the obscured layer; the GM can flip the
   * Reveal toggle on snapshot items (handled in _wireDialog).
   *
   * Schema we expect on a stored magical entry:
   *   {
   *     name, img, uuid, type, rarity,
   *     description,                    ← real flavor (HTML or plain)
   *     identified: false,
   *     unidentified: {
   *       name:        "obscured name",
   *       description: "obscured flavor (HTML or plain)"
   *     }
   *   }
   */
  static _buildStoredItemRow(it, opts = {}) {
    const isIdentified = it.identified !== false;
    const realName  = it.name ?? "";
    const obscName  = it.unidentified?.name ?? "";
    const realDesc  = it.description ?? "";
    const obscDesc  = it.unidentified?.description ?? "";
    const displayName = isIdentified ? realName : (obscName || realName);
    const rawDesc     = isIdentified ? realDesc : (obscDesc || "");
    return {
      ...it,
      name:        displayName,
      realName,
      description: LootableTile.truncateDescription(LootableTile.cleanItemDescription(rawDesc), 220),
      identified:  isIdentified,
      revealable:  opts.revealable === true,
    };
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

    // Find a lootable tile at the drop position — container OR dead-body.
    // Container drops append to containerLoot.items. Dead-body drops append
    // to the lootSnapshot (so players + the dialog both see the new item
    // immediately) and to the live actor if one exists.
    const tileDoc = this._findLootableTileDocAtWorldPos(data.x, data.y);
    if (!tileDoc) return;

    const isDead = tileDoc.flags?.[MODULE_ID]?.isDeadToken === true;

    try {
      const item = await fromUuid(data.uuid);
      if (!item) return;

      if (isDead) {
        // ── Dead-body tile: append to snapshot, and to live actor if linked ──
        const tileFlags = tileDoc.flags?.[MODULE_ID] ?? {};
        const liveActor = tileFlags.originalActorId
          ? game.actors.get(tileFlags.originalActorId)
          : null;

        const itemData = item.toObject();
        let createdOnActor = null;
        if (liveActor) {
          try {
            const [created] = await liveActor.createEmbeddedDocuments("Item", [itemData]);
            createdOnActor = created ?? null;
          } catch (err) {
            console.warn(`${MODULE_ID} | Drop on dead tile: createEmbeddedDocuments failed:`, err);
          }
        }

        // Append to snapshot too — snapshot is the canonical store for
        // unlinked-NPC corpses, and players read from it regardless.
        const snap = tileDoc.flags?.[MODULE_ID]?.lootSnapshot;
        const items = Array.isArray(snap?.items) ? [...snap.items] : [];
        items.push({
          id:          createdOnActor?.id ?? foundry.utils.randomID(),
          name:        item.name,
          img:         item.img,
          uuid:        createdOnActor?.uuid ?? item.uuid,
          type:        item.type,
          rarity:      item.system?.rarity ?? "common",
          description: item.system?.description?.value ?? "",
          identified:  item.system?.identified !== false,
          data:        itemData,
        });
        await tileDoc.update({ [`flags.${MODULE_ID}.lootSnapshot.items`]: items });

        ui.notifications.info(`ACE QOL: Added "${item.name}" to ${tileFlags.originalName ?? "the body"}.`);

        // Sync chat card if there's a lootCard for this corpse
        if (tileFlags.originalActorId && game.aceQol?.lootEngine?.syncCardForActor) {
          try {
            await game.aceQol.lootEngine.syncCardForActor(tileFlags.originalActorId, {
              addItem: {
                name:   item.name,
                img:    item.img,
                uuid:   createdOnActor?.uuid ?? item.uuid,
                type:   item.type,
                rarity: item.system?.rarity ?? "common",
              },
            });
          } catch (err) {
            console.warn(`${MODULE_ID} | Chat-card sync after canvas drop failed (non-fatal):`, err);
          }
        }
        return false;  // cancel default drop handling
      }

      // ── Container tile (original path) ──
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
      console.warn(`${MODULE_ID} | Tile drop failed:`, err);
    }
  }

  /**
   * Find a lootable tile-document (dead-body OR container) at the given
   * world position. Companion of _findContainerTileAtWorldPos which
   * matched only containers — this broader version powers the canvas-drop
   * handler so you can drop items onto either kind of loot tile.
   */
  _findLootableTileDocAtWorldPos(worldX, worldY) {
    if (!canvas?.scene) return null;
    const tiles = [...canvas.scene.tiles.contents].reverse();
    for (const tileDoc of tiles) {
      const isDead = tileDoc.flags?.[MODULE_ID]?.isDeadToken === true;
      const isCont = !isDead && isContainerTile(tileDoc);
      if (!isDead && !isCont) continue;
      const w = (Number(tileDoc.width)  > 0) ? Number(tileDoc.width)  : 100;
      const h = (Number(tileDoc.height) > 0) ? Number(tileDoc.height) : 100;
      if (worldX >= tileDoc.x && worldX < tileDoc.x + w
       && worldY >= tileDoc.y && worldY < tileDoc.y + h) {
        return tileDoc;
      }
    }
    return null;
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
        width: 40px; height: 40px;
        display: flex; align-items: center; justify-content: center;
        background: rgba(212, 175, 55, 0.95);
        border: 2px solid #d4af37;
        border-radius: 50%;
        color: #1a1a1e;
        font-size: 20px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.55);
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

      // Decide which source has the "real" loot:
      //
      //   Background — for UNLINKED token NPCs (most monsters), loot is
      //   generated on the synthetic token-actor by loot-engine.mjs BEFORE
      //   the death pipeline runs. The death pipeline then snapshots that
      //   token-actor's items+currency into tile.flags.lootSnapshot. After
      //   the token dies the synthetic actor is destroyed; the world-
      //   sidebar prototype (game.actors.get) never had the loot.
      //
      //   So: prefer the snapshot when it has any items OR currency.
      //   Fall back to the world actor only when the snapshot is empty
      //   AND the world actor (linked NPC, or pre-built loot on the
      //   prototype) does have lootable items.
      const snapshotHasItems = (snapshot?.items?.length ?? 0) > 0;
      const snapshotHasGold = (() => {
        const c = snapshot?.currency ?? {};
        return ((c.pp ?? 0) + (c.gp ?? 0) + (c.ep ?? 0) + (c.sp ?? 0) + (c.cp ?? 0)) > 0;
      })();
      const useSnapshot = !!snapshot && (snapshotHasItems || snapshotHasGold);

      if (useSnapshot) {
        source = "snapshot";
        items = (snapshot.items ?? []).map(it => LootableTile._buildStoredItemRow(it, { revealable: !!actor && it.identified === false }));
        currency = snapshot.currency ?? {};
      } else if (actor) {
        source = "actor";
        items = actor.items.contents
          .filter(i => this._isLootableItem(i))
          .map(i => this._buildLootItemRow(i));
        currency = actor.system?.currency ?? {};
      } else {
        ui.notifications.warn(`ACE QOL: Loot data not available for "${flags.originalName}".`);
        return;
      }
      displayName = flags.originalName ?? actor?.name ?? "Unknown";
    } else {
      source = "container";
      const loot = getContainerLoot(tileDoc);
      items = (loot.items ?? []).map(it => LootableTile._buildStoredItemRow(it, { revealable: false }));
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
    // GM can distribute from a live actor, a container, OR a snapshot
    // (snapshot items now carry full toObject() data so they can be
    // recreated on the recipient — see death-pipeline._buildLootSnapshot).
    const canDistribute = game.user.isGM && (source === "actor" || source === "container" || source === "snapshot");
    const btnDisabled = (isLocked || !canDistribute) ? "disabled" : "";

    // Item identifier in the DOM:
    //   - actor   → item.id (used with actor.items.get to fetch + delete)
    //   - snapshot → item.uuid (display only; no transfer)
    //   - container → item.uuid (used with fromUuid + flag-array filter)
    // DOM key for each item — uniquely identifies the row inside its source.
    //   actor    → item.id   (lookup via actor.items.get(key))
    //   snapshot → item.id   (lookup by indexOf inside snapshot.items[])
    //              fallback to uuid if id missing (legacy snapshots)
    //   container → prefer uuid (linked items), fall back to id for
    //               name-only / placeholder entries (the screenshot-to-tile
    //               spawn path assigns randomID() id but null uuid for
    //               homebrew items it can't resolve to a compendium doc).
    //               Without this fallback the delete handler bails on
    //               empty keys and the trash icon silently no-ops.
    const keyFor = (item) => {
      if (source === "actor") return item.id ?? "";
      if (source === "snapshot") return item.id ?? item.uuid ?? "";
      return item.uuid ?? item.id ?? "";
    };

    const itemRowsHtml = items.length ? items.map((item) => {
      const key = keyFor(item);
      // Recipient buttons — class-driven fills (no inline player-color border).
      // pc-online = gold fill, pc-offline = grayer-gold, npc = subtle purple.
      // All show black text on the player name for legibility.
      const recipientBtns = canDistribute ? recipients.map(r => {
        let cls = "ace-qol-loot-give-btn";
        if (r.type === "pc") cls += r.online ? " ace-give-pc-online" : " ace-give-pc-offline";
        else cls += " ace-give-npc";
        const title = r.type === "pc"
          ? (r.online ? "Player Character (online)" : "Player Character (offline)")
          : "Friendly NPC on scene";
        return `<button class="${cls}" data-item-key="${key}" data-actor-id="${r.actorId}" ${btnDisabled} title="${title}">${foundry.utils.escapeHTML(r.name)}</button>`;
      }).join("") : "";

      // Per-item header row: image + name + (GM-only) reveal toggle for unidentified items
      const revealBtn = (game.user.isGM && item.revealable)
        ? `<button class="ace-qol-loot-reveal-btn" data-item-key="${key}" title="Reveal real name + description to players (Identify spell, GM grant)"><i class="fas fa-lock"></i></button>`
        : "";
      // GM-only per-item Delete button — confirms before removing
      const deleteBtn = game.user.isGM
        ? `<button class="ace-qol-loot-delete-btn" data-item-key="${key}" data-item-name="${foundry.utils.escapeHTML(item.name)}" title="Delete this item from the loot (asks for confirmation)"><i class="fas fa-trash"></i></button>`
        : "";
      // Visual distinction for unidentified items is GM-ONLY. Players see
      // EVERY item — magical or mundane — with identical styling so they
      // can't tell at a glance which is which. They have to read the
      // descriptions and use Identify (or wait for the GM Reveal) to
      // figure out what's actually magical.
      const isUnid = item.identified === false;
      const showUnidStyling = game.user.isGM && isUnid;
      const unidentClass = showUnidStyling ? " ace-loot-unidentified" : "";
      // Real-name label — only the GM sees this, sits above the obscured
      // name so the GM knows the truth at a glance. Hidden from players
      // entirely.
      const realNameLabel = (game.user.isGM && isUnid && item.realName && item.realName !== item.name)
        ? `<div class="ace-qol-tile-loot-realname" title="True identity (GM only)">${foundry.utils.escapeHTML(item.realName)}</div>`
        : "";

      return `
        <div class="ace-qol-tile-loot-item${unidentClass}" data-item-key="${key}">
          <div class="ace-qol-tile-loot-item-head">
            <img src="${item.img}" class="ace-qol-tile-loot-img" />
            <div class="ace-qol-tile-loot-item-titles">
              ${realNameLabel}
              <div class="ace-qol-tile-loot-name">${foundry.utils.escapeHTML(item.name)}</div>
              ${item.description ? `<div class="ace-qol-tile-loot-desc">${foundry.utils.escapeHTML(item.description)}</div>` : ""}
            </div>
            <div class="ace-qol-tile-loot-item-actions">
              ${revealBtn}
              ${deleteBtn}
            </div>
          </div>
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

    // GM-only "Repost Loot Card" button — recreates the ACE Loot chat card
    // for this tile if the original card was lost / accidentally deleted.
    // Hidden if there's nothing worth posting (no items + no currency).
    const repostBtn = (game.user.isGM && (items.length > 0 || totalCoins > 0))
      ? `<button class="ace-qol-loot-repost-btn" data-action="lootRepostCard" title="Post a fresh ACE Loot chat card from this tile's contents — use if the original card was deleted"><i class="fas fa-comment-alt"></i> Repost Card</button>`
      : "";

    const content = `
      <div class="ace-qol-tile-loot-dialog">
        <div class="ace-qol-tile-loot-header">
          <strong>${foundry.utils.escapeHTML(displayName)}</strong>
          <span class="ace-qol-tile-loot-type">${foundry.utils.escapeHTML(subtitle)}</span>
          ${repostBtn}
        </div>
        ${lockBanner}
        ${goldHtml}
        <div class="ace-qol-tile-loot-items">${itemRowsHtml}</div>
      </div>
    `;

    // Capture the resolved source data so the dialog wiring can build a
    // postable chat card payload without re-resolving from scratch.
    const repostPayload = {
      displayName,
      actorId:   flags?.originalActorId ?? actor?.id ?? null,
      actorImg:  actor?.img ?? actor?.prototypeToken?.texture?.src ?? "icons/svg/skull.svg",
      items,
      currency,
    };

    const dlg = await foundry.applications.api.DialogV2.wait({
      window: { title: `Loot — ${displayName}` },
      classes: ["ace-qol-tile-loot-dialog-window"],
      content,
      buttons: [{ action: "close", label: "Close", icon: "fa-solid fa-xmark", default: true }],
      rejectClose: false,
      position: { width: 560 },
      render: (event, dialog) =>
        this._wireDialog(event, dialog, { tile, actor, recipients, source, repostPayload }),
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
    const { tile, actor, recipients, source, repostPayload } = ctx ?? {};

    // ── Repost Loot Card button (GM only) ──
    const repostBtn = root.querySelector(".ace-qol-loot-repost-btn");
    if (repostBtn && game.user.isGM && repostPayload) {
      repostBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Repost Loot Card" },
          content: `<p style="font-size:15px;line-height:1.5;">Post a fresh <strong>ACE Loot</strong> chat card for <strong>${foundry.utils.escapeHTML(repostPayload.displayName)}</strong> using this tile's current contents? Useful if the original card was deleted.</p>`,
          modal:   true,
          yes:     { default: true, label: "Repost", icon: "fa-solid fa-comment-alt" },
          no:      { label: "Cancel" },
          rejectClose: false,
        }).catch(() => false);
        if (!confirmed) return;
        try {
          if (game.aceQol?.lootEngine?.postCardFromTile) {
            await game.aceQol.lootEngine.postCardFromTile(repostPayload);
          } else {
            ui.notifications.warn("ACE QOL: LootEngine.postCardFromTile not available.");
          }
        } catch (err) {
          console.error(`${MODULE_ID} | Repost loot card failed:`, err);
          ui.notifications.error("ACE QOL: Failed to repost loot card — see console.");
        }
      });
    }

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
          } else if (source === "snapshot") {
            // Snapshot path — the actor is gone (unlinked NPC token was
            // destroyed when the dead-art tile was created). Find the item
            // by id in tile.flags.lootSnapshot.items, recreate it on the
            // recipient from the stored toObject() data, and prune the
            // snapshot entry so the dialog updates on next open.
            const tileDoc = tile.document ?? tile;
            const snap = tileDoc.flags?.[MODULE_ID]?.lootSnapshot;
            const entry = (snap?.items ?? []).find(it => (it.id ?? it.uuid) === key);
            if (!entry) {
              ui.notifications.warn(`ACE QOL: Item not found in snapshot.`);
              return;
            }
            // Prefer the stored toObject() data; fall back to fetching by
            // uuid if (somehow) data wasn't captured. Legacy snapshots
            // pre-v0.7.2 will hit the fallback and likely fail — that's
            // OK, those are dead corpses from before the fix.
            let itemData = entry.data ?? null;
            if (!itemData && entry.uuid) {
              try {
                const liveItem = await fromUuid(entry.uuid);
                if (liveItem) itemData = liveItem.toObject();
              } catch (_) {}
            }
            if (!itemData) {
              ui.notifications.warn(`ACE QOL: Snapshot has no item data for "${entry.name}". Pre-v0.7.2 corpse?`);
              return;
            }
            await targetActor.createEmbeddedDocuments("Item", [itemData]);
            await this._syncSnapshotItemRemoved(tile, key);
            ui.notifications.info(`ACE QOL: Gave ${entry.name} to ${targetActor.name}.`);
            btn.closest(".ace-qol-tile-loot-item")?.remove();
            await ChatMessage.create({
              content: `<em><strong>${foundry.utils.escapeHTML(targetActor.name)}</strong> received <strong>${foundry.utils.escapeHTML(entry.name)}</strong> from the body.</em>`,
            });
          }
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
        // Gold goes to PCs on scene only (not to NPC recipients).
        // Online/offline status doesn't matter for gold — offline PCs still
        // get their share since the gold belongs to the character, not the
        // player's session presence.
        const pcRecipients = (recipients ?? []).filter(r => r.type === "pc");
        if (!pcRecipients.length) {
          ui.notifications.warn("ACE QOL: No PCs on this scene to split gold to.");
          return;
        }
        if (source === "container") {
          await this._splitContainerGold(tile, pcRecipients);
        } else if (source === "actor" && actor) {
          await this._splitGold(actor, pcRecipients);
          await this._syncSnapshotCurrencyZeroed(tile);
        } else if (source === "snapshot") {
          await this._splitSnapshotGold(tile, pcRecipients);
        }
        splitBtn.disabled = true;
        splitBtn.textContent = "Split Done";
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

    // ── Reveal-item button (GM only) — flips identified:false → true on a single item ──
    root.querySelectorAll(".ace-qol-loot-reveal-btn").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!game.user.isGM) return;
        const key = btn.dataset.itemKey;
        if (!key) return;
        try {
          let item = null;
          if (source === "actor" && actor) {
            item = actor.items.get(key);
          } else {
            // Container / snapshot — item key is a UUID
            item = await fromUuid(key);
          }
          if (!item) {
            ui.notifications.warn("ACE QOL: Couldn't locate item to reveal.");
            return;
          }
          await item.update({ "system.identified": true });
          ui.notifications.info(`ACE QOL: Revealed "${item.name}" to all players.`);
          await ChatMessage.create({
            content: `<em>The party identifies the item: <strong>${foundry.utils.escapeHTML(item.name)}</strong>.</em>`,
          });
          // Re-open dialog so the line item refreshes with real name + description
          await dialog.close();
          this._openLootDialog(tile);
        } catch (err) {
          console.error(`${MODULE_ID} | Reveal-item failed:`, err);
          ui.notifications.error("ACE QOL: Failed to reveal item — see console.");
        }
      });
    });

    // ── Delete-item button (GM only) — confirms before removing ──
    root.querySelectorAll(".ace-qol-loot-delete-btn").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!game.user.isGM) return;
        const key = btn.dataset.itemKey;
        const itemName = btn.dataset.itemName ?? "this item";
        if (!key) return;

        // Confirm dialog — default "Yes" so Enter confirms.
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Delete Item" },
          content: `<p style="font-size:15px;line-height:1.5;">Delete <strong>${itemName}</strong> from this loot? This cannot be undone.</p>`,
          modal:   true,
          yes:     { default: true, label: "Delete", icon: "fa-solid fa-trash" },
          no:      { label: "Cancel" },
          rejectClose: false,
        }).catch(() => false);
        if (!confirmed) return;

        try {
          const tileDoc = tile.document ?? tile;
          const originalActorId = tileDoc?.flags?.[MODULE_ID]?.originalActorId;
          let removed = null;       // { name, uuid } for chat sync

          if (source === "actor" && actor) {
            const item = actor.items.get(key);
            if (!item) return;
            removed = { name: item.name, uuid: item.uuid };
            await item.delete();
            await this._syncSnapshotItemRemoved(tile, key);
          } else if (source === "snapshot") {
            const snap = tileDoc?.flags?.[MODULE_ID]?.lootSnapshot;
            const entry = (snap?.items ?? []).find(it => (it.id ?? it.uuid) === key);
            if (!entry) return;
            removed = { name: entry.name, uuid: entry.uuid };
            await this._syncSnapshotItemRemoved(tile, key);
          } else if (source === "container") {
            const loot = getContainerLoot(tileDoc);
            const entry = loot.items.find(it => (it.uuid ?? it.id) === key);
            if (!entry) return;
            removed = { name: entry.name, uuid: entry.uuid };
            await this._removeContainerItem(tile, key);
          }

          if (removed) {
            ui.notifications.info(`ACE QOL: Removed "${removed.name}" from the loot.`);
            btn.closest(".ace-qol-tile-loot-item")?.remove();
            // Sync the chat card if one exists for this corpse
            if (originalActorId && game.aceQol?.lootEngine?.syncCardForActor) {
              try {
                await game.aceQol.lootEngine.syncCardForActor(originalActorId, {
                  removeByUuid: removed.uuid || undefined,
                  removeByName: removed.uuid ? undefined : removed.name,
                });
              } catch (err) {
                console.warn(`${MODULE_ID} | Chat-card sync after delete failed (non-fatal):`, err);
              }
            }
          }
        } catch (err) {
          console.error(`${MODULE_ID} | Delete-item failed:`, err);
          ui.notifications.error("ACE QOL: Failed to delete item — see console.");
        }
      });
    });

    // ── Inspect-item (GM only) — click image or name to open the item sheet ──
    // Routes by source:
    //   actor    → actor.items.get(key).sheet.render(true)
    //   container → fromUuid(key) — if uuid (real item), open its sheet
    //               If placeholder (no uuid), warn — nothing to inspect
    //   snapshot → fromUuid(uuid) if still valid (linked actor),
    //              OR rehydrate a temporary Item from snapshot.data
    //              (synthetic-actor items still inspectable after the
    //               original token is gone, because we stored toObject() data)
    if (game.user.isGM) {
      const inspectClick = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const itemEl = ev.currentTarget.closest(".ace-qol-tile-loot-item");
        if (!itemEl) return;
        const key = itemEl.dataset.itemKey;
        if (!key) {
          ui.notifications.warn("ACE QOL: This item has no source document to inspect (homebrew placeholder).");
          return;
        }
        let item = null;
        try {
          if (source === "actor" && actor) {
            item = actor.items.get(key) ?? null;
            if (!item && key.includes(".")) item = await fromUuid(key);
          } else if (source === "snapshot") {
            // Try the (possibly dead) UUID first; fall back to rehydrating
            // a temporary Item from the snapshot's stored toObject() data.
            const tileDoc = tile.document ?? tile;
            const entry = (tileDoc?.flags?.[MODULE_ID]?.lootSnapshot?.items ?? [])
                            .find(it => (it.id ?? it.uuid) === key);
            if (entry?.uuid) {
              try { item = await fromUuid(entry.uuid); } catch (_) {}
            }
            if (!item && entry?.data) {
              try { item = new CONFIG.Item.documentClass(entry.data, { temporary: true }); } catch (_) {}
            }
          } else {
            // container — key is uuid or id
            if (key.includes(".")) {
              try { item = await fromUuid(key); } catch (_) {}
            }
          }
        } catch (err) {
          console.warn(`${MODULE_ID} | Inspect lookup failed:`, err);
        }
        if (item?.sheet) {
          item.sheet.render(true);
        } else {
          ui.notifications.warn("ACE QOL: Couldn't open item sheet — original document not found (homebrew or deleted).");
        }
      };
      root.querySelectorAll(".ace-qol-tile-loot-img, .ace-qol-tile-loot-name").forEach(el => {
        el.style.cursor = "pointer";
        el.title = "Click to view item details";
        el.addEventListener("click", inspectClick);
      });
    }

    // ── Drag-and-drop ADD into the dialog body (GM only) ──
    // GM drags an Item (from sidebar, compendium, or another sheet) onto the
    // open loot dialog. Item is appended to the source (actor / snapshot /
    // container) and the chat card is synced if one exists.
    if (game.user.isGM) {
      const dropTarget = root.querySelector(".ace-qol-tile-loot-dialog") ?? root;
      if (dropTarget) {
        dropTarget.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try { ev.dataTransfer.dropEffect = "copy"; } catch (_) {}
          dropTarget.classList.add("ace-qol-tile-loot-drag-over");
        });
        dropTarget.addEventListener("dragleave", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          dropTarget.classList.remove("ace-qol-tile-loot-drag-over");
        });
        dropTarget.addEventListener("drop", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          dropTarget.classList.remove("ace-qol-tile-loot-drag-over");
          try {
            const raw = ev.dataTransfer?.getData("text/plain");
            if (!raw) return;
            let data; try { data = JSON.parse(raw); } catch { return; }
            if (data?.type !== "Item" || !data?.uuid) return;
            await this._handleDialogItemDrop(tile, data.uuid, source, actor, dialog);
          } catch (err) {
            console.error(`${MODULE_ID} | Dialog drop failed:`, err);
            ui.notifications.error("ACE QOL: Failed to add item — see console.");
          }
        });
      }
    }
  }

  /**
   * Append an item to the current loot source. Routes by source kind:
   *   - actor    → createEmbeddedDocuments on the live actor
   *   - snapshot → push to tile.flags.lootSnapshot.items with toObject() data
   *   - container → push to tile.flags["ace-suite"].containerLoot.items
   * Syncs the chat card if one exists for this corpse, then reopens the
   * dialog so the new entry appears.
   *
   * @param {Tile|TileDocument} tile
   * @param {string} itemUuid    UUID of the dragged item
   * @param {"actor"|"snapshot"|"container"} source
   * @param {Actor|null} actor   Live actor reference (only for source==="actor")
   * @param {DialogV2} dialog
   */
  async _handleDialogItemDrop(tile, itemUuid, source, actor, dialog) {
    const sourceItem = await fromUuid(itemUuid);
    if (!sourceItem) {
      ui.notifications.warn(`ACE QOL: Couldn't load dropped item.`);
      return;
    }
    const tileDoc = tile.document ?? tile;
    const originalActorId = tileDoc?.flags?.[MODULE_ID]?.originalActorId;
    const itemData = sourceItem.toObject();

    if (source === "actor" && actor) {
      const [created] = await actor.createEmbeddedDocuments("Item", [itemData]);
      if (created) {
        // Mirror to snapshot for players reading the tile
        try {
          const snap = tileDoc?.flags?.[MODULE_ID]?.lootSnapshot;
          const items = Array.isArray(snap?.items) ? [...snap.items] : [];
          items.push({
            id:          created.id,
            name:        created.name,
            img:         created.img,
            uuid:        created.uuid,
            type:        created.type,
            rarity:      created.system?.rarity ?? "common",
            description: created.system?.description?.value ?? "",
            identified:  created.system?.identified !== false,
            data:        created.toObject(),
          });
          await tileDoc.update({ [`flags.${MODULE_ID}.lootSnapshot.items`]: items });
        } catch (_) {}
      }
    } else if (source === "snapshot") {
      const snap = tileDoc?.flags?.[MODULE_ID]?.lootSnapshot;
      const items = Array.isArray(snap?.items) ? [...snap.items] : [];
      items.push({
        id:          foundry.utils.randomID(),
        name:        sourceItem.name,
        img:         sourceItem.img,
        uuid:        sourceItem.uuid,
        type:        sourceItem.type,
        rarity:      sourceItem.system?.rarity ?? "common",
        description: sourceItem.system?.description?.value ?? "",
        identified:  sourceItem.system?.identified !== false,
        data:        itemData,
      });
      await tileDoc.update({ [`flags.${MODULE_ID}.lootSnapshot.items`]: items });
    } else if (source === "container") {
      const loot = getContainerLoot(tileDoc);
      const updatedItems = [...loot.items, {
        id:     sourceItem.id ?? foundry.utils.randomID(),
        name:   sourceItem.name,
        img:    sourceItem.img,
        uuid:   sourceItem.uuid,
        type:   sourceItem.type,
        rarity: sourceItem.system?.rarity ?? "common",
      }];
      await tileDoc.update({
        [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.items`]: updatedItems,
      });
    }

    ui.notifications.info(`ACE QOL: Added "${sourceItem.name}" to the loot.`);

    // Chat card sync (corpse only — containers don't have ACE Loot cards)
    if ((source === "actor" || source === "snapshot") && originalActorId && game.aceQol?.lootEngine?.syncCardForActor) {
      try {
        await game.aceQol.lootEngine.syncCardForActor(originalActorId, {
          addItem: {
            name:   sourceItem.name,
            img:    sourceItem.img,
            uuid:   sourceItem.uuid,
            type:   sourceItem.type,
            rarity: sourceItem.system?.rarity ?? "common",
          },
        });
      } catch (err) {
        console.warn(`${MODULE_ID} | Chat-card sync after add failed (non-fatal):`, err);
      }
    }

    // Reopen dialog so the new item renders
    await dialog.close();
    this._openLootDialog(tile);
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
   * Build an enriched row payload for the loot dialog from a live actor
   * item. Handles dnd5e's built-in identification model:
   *   - system.identified === false  → show unidentified.name + unidentified.description
   *   - system.identified !== false  → show real name + real description
   *
   * Description HTML is stripped to plain text, enricher tags are filtered
   * out (so `[[/attack ...]]` and `@UUID[...]{Name}` etc. don't leak into
   * the UI as raw artifacts), and the result is truncated to keep the
   * dialog readable. The GM-side dialog gets a "Reveal" toggle when the
   * item is currently unidentified (revealable: true).
   */
  _buildLootItemRow(item) {
    const sys = item.system ?? {};
    const isIdentified = sys.identified !== false;

    // What name + description to display in the dialog
    const realName = item.name ?? "";
    const unidentName = sys.unidentified?.name ?? "";
    const displayName = isIdentified ? realName : (unidentName || realName);

    const realDesc = LootableTile.cleanItemDescription(sys.description?.value ?? "");
    const unidentDesc = LootableTile.cleanItemDescription(sys.unidentified?.description ?? "");
    const rawDesc = isIdentified ? realDesc : (unidentDesc || ""); // mundane shows real; magical-unid shows unident
    const description = LootableTile.truncateDescription(rawDesc, 220);

    // The Reveal button only matters when item is currently unidentified
    // AND we have a real actor reference (so the click handler can resolve
    // it via fromUuid). Snapshot / container items can't be revealed
    // because there's no live item document to update.
    const revealable = !isIdentified && !!item.uuid;

    return {
      id:          item.id,
      uuid:        item.uuid,
      name:        displayName,
      realName,
      img:         item.img,
      description,
      identified:  isIdentified,
      revealable,
    };
  }

  /**
   * Build the list of loot recipients.
   *
   * v2 (May 2026): SCENE ONLY — drop the world-actor-sidebar source. The
   * old behavior pulled every PC ever rolled in the campaign, even ones
   * not at the table that night. Now we only show tokens actually on the
   * current scene.
   *
   * Included:
   *   - PCs (hasPlayerOwner) currently on the scene, alive
   *   - Friendly/neutral NPCs on the scene, alive, not flagged as a
   *     dead-token tile representation
   * Excluded:
   *   - Hostile or secret-disposition tokens
   *   - Dead bodies / 0-HP actors
   *   - The actor being looted (excludeActorId)
   *
   * Each PC is tagged `online: true|false` based on whether a non-GM
   * owner is currently connected. Used by the dialog CSS to dim
   * offline-PC buttons so the GM can see at a glance who's actually at
   * the table.
   */
  _getLootRecipients(excludeActorId) {
    if (!canvas.scene) return [];
    const recipients = [];
    const seen = new Set();

    for (const token of canvas.tokens?.placeables ?? []) {
      if (!token.actor) continue;
      if (seen.has(token.actor.id)) continue;
      if (token.actor.id === excludeActorId) continue;
      const disp = token.document?.disposition ?? 0;
      if (disp < 0) continue;                               // hostile / secret — skip
      const hp = token.actor.system?.attributes?.hp?.value;
      if (hp !== undefined && hp <= 0) continue;            // skip dead
      if (token.document.flags?.[MODULE_ID]?.isDeadToken) continue;

      // Classify recipient:
      //   - actor.type === "character" + hasPlayerOwner → REAL PC (shows as PC button)
      //   - actor.type === "npc"      + hasPlayerOwner → companion / summon / familiar
      //                                                   (Steel Defender, Spectral
      //                                                    Dire Wolf, Find Familiar
      //                                                    creature, etc.) — EXCLUDE
      //                                                    from loot list entirely.
      //                                                    Their owning PC gets the
      //                                                    share; the pet shouldn't
      //                                                    be a separate recipient.
      //   - actor.type === "npc"      + !hasPlayerOwner → friendly scene NPC (Kasimir-
      //                                                   type) → show as NPC button
      const actor = token.actor;
      const isCharacter = actor.type === "character";
      const isPlayerOwned = !!actor.hasPlayerOwner;
      const isCompanion = isPlayerOwned && !isCharacter;   // player-owned NPC = companion/summon
      if (isCompanion) continue;                            // skip — they never get loot

      const isPC = isCharacter && isPlayerOwned;
      let online = false;
      if (isPC) {
        for (const u of game.users) {
          if (u.isGM) continue;
          if (!u.active) continue;
          try {
            if (actor.testUserPermission(u, "OWNER")) { online = true; break; }
          } catch (_) {}
        }
      }

      seen.add(actor.id);
      recipients.push({
        type:    isPC ? "pc" : "npc",
        actorId: actor.id,
        name:    token.name ?? actor.name,
        online,
      });
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

  /**
   * Split gold from a snapshot (unlinked-token NPC death) among PC recipients.
   * Reads currency from tile.flags.lootSnapshot.currency, adds the share to
   * each PC actor, and zeroes the snapshot currency to prevent re-claiming.
   * Same arithmetic as _splitGold — only the source/sink differ.
   */
  async _splitSnapshotGold(tile, recipients) {
    if (!recipients?.length) {
      ui.notifications.warn("No eligible recipients to split gold to.");
      return;
    }
    const tileDoc = tile?.document ?? tile;
    const snap = tileDoc?.flags?.[MODULE_ID]?.lootSnapshot;
    const cur = snap?.currency ?? {};
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
        console.warn(`${MODULE_ID} | Snapshot gold split to ${targetActor.name} failed:`, err);
      }
    }

    // Zero the snapshot currency so the dialog shows no more gold next open
    try {
      await tileDoc.update({
        [`flags.${MODULE_ID}.lootSnapshot.currency`]: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | Snapshot currency zero failed:`, err);
    }

    const sourceName = tileDoc?.flags?.[MODULE_ID]?.originalName ?? "the body";
    await ChatMessage.create({
      content: `<em>Split <strong>${sharePerGp}gp ${sharePerSp}sp ${sharePerCpFinal}cp</strong> per recipient from ${foundry.utils.escapeHTML(sourceName)} (${recipients.length} recipient${recipients.length === 1 ? "" : "s"}: ${recipients.map(r => foundry.utils.escapeHTML(r.name)).join(", ")}).</em>`,
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

  /** Remove an item from a container tile's loot flag. Matches by uuid OR
   *  id — placeholder entries (e.g. name-only items from the screenshot-
   *  to-tile spawn path) have null uuid and need to be matched by id. */
  async _removeContainerItem(tile, key) {
    try {
      const tileDoc = tile?.document ?? tile;
      const loot = getContainerLoot(tileDoc);
      const updatedItems = loot.items.filter(i => i.uuid !== key && i.id !== key);
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
