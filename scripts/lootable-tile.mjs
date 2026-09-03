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
import { aceEdgeGapFt } from "./geometry-utils.mjs";
import { lootFraming, readCreatureType } from "./loot-framing.mjs";
import { canHarvest } from "./sustenance.mjs";
import { aceDescriptionTextSync, acePrimeDescriptions, aceDescriptionHtml } from "./description-reader.mjs";

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
  console.debug(`${MODULE_ID} | Tile.prototype._onClickRight patched (${reason}).`);
  return true;
}

// Register patch installers at TOP LEVEL — runs at module import time
// (during init phase), guaranteeing these hooks register before they fire.
Hooks.once("setup",       () => _aceQolPatchTileClickRight("setup"));
Hooks.once("canvasReady", () => _aceQolPatchTileClickRight("canvasReady"));
Hooks.once("ready",       () => _aceQolPatchTileClickRight("ready"));

// ─── Token click patching for the new dead-token pipeline ────────────────
//
// Since v0.7.14 the death pipeline keeps the token in place and swaps its
// texture instead of creating a separate corpse tile. The loot dialog
// historically opened from clicking the tile — now it opens from clicking
// the dead TOKEN. Click rules:
//
//   - LEFT CLICK on a dead token:
//       Player → open loot dialog (selection is blocked because the player
//                no longer has OWNER permission anyway; we intercept the
//                click so it doesn't fall through to nothing).
//       GM     → normal Foundry behavior (select / drag / etc.)
//
//   - RIGHT CLICK on a dead token:
//       Player → open loot dialog (mirrors the player left-click; either
//                button opens loot)
//       GM     → open loot dialog (per user's spec: "as long as the DM can
//                right-click and still bring up the loot pile, everything
//                will be solved perfectly")
//
//   - DOUBLE LEFT CLICK on a dead token:
//       Player → blocked (would normally open the actor sheet)
//       GM     → normal behavior
//
// We monkey-patch Token.prototype the same way the existing tile patch
// works, with both setup-time + per-token defense (drawToken hook for
// late-replacement module compatibility).

function _aceQolPatchTokenClicks(reason) {
  const TokenClass = CONFIG?.Token?.objectClass;
  if (!TokenClass) {
    console.warn(`${MODULE_ID} | Token click patch (${reason}): Token class not available yet — will retry.`);
    return false;
  }
  if (TokenClass.prototype.__aceQolTokenClicksPatched) return true;
  const proto = TokenClass.prototype;

  const _isDead = (token) => {
    const doc = token?.document ?? token;
    return doc?.flags?.[MODULE_ID]?.isDead === true;
  };

  // ── Right-click: always open loot dialog for dead tokens (GM + player) ──
  const origRight = proto._onClickRight;
  proto._onClickRight = function(event) {
    try {
      if (_isDead(this)) {
        try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
        if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
        return;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Token right-click patch handler failed:`, err);
    }
    return origRight?.call(this, event);
  };

  // ── Left-click: player-only loot redirect; GM keeps normal behavior ──
  const origLeft = proto._onClickLeft;
  proto._onClickLeft = function(event) {
    try {
      if (_isDead(this) && !game.user.isGM) {
        try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
        if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
        return;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Token left-click patch handler failed:`, err);
    }
    return origLeft?.call(this, event);
  };

  // ── Double left-click: block sheet open on dead tokens for non-GMs ──
  // GMs still get full sheet access for HP-bump / revive workflows.
  const origLeft2 = proto._onClickLeft2;
  proto._onClickLeft2 = function(event) {
    try {
      if (_isDead(this) && !game.user.isGM) {
        try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
        if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
        return;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Token double-click patch handler failed:`, err);
    }
    return origLeft2?.call(this, event);
  };

  TokenClass.prototype.__aceQolTokenClicksPatched = true;
  console.debug(`${MODULE_ID} | Token.prototype clicks patched (${reason}).`);
  return true;
}

Hooks.once("setup",       () => _aceQolPatchTokenClicks("setup"));
Hooks.once("canvasReady", () => _aceQolPatchTokenClicks("canvasReady"));
Hooks.once("ready",       () => _aceQolPatchTokenClicks("ready"));

// Per-token defense — same pattern as drawTile, for modules that swap
// the Token class after our setup patch installs.
Hooks.on("drawToken", (token) => {
  try {
    const ctorProto = token?.constructor?.prototype;
    if (!ctorProto || ctorProto.__aceQolTokenClicksPatched) return;

    const _isDead = (tk) => {
      const doc = tk?.document ?? tk;
      return doc?.flags?.[MODULE_ID]?.isDead === true;
    };

    const origRight = ctorProto._onClickRight;
    ctorProto._onClickRight = function(event) {
      try {
        if (_isDead(this)) {
          try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
          if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
          return;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | drawToken right-click patch threw:`, err);
      }
      return origRight?.call(this, event);
    };

    const origLeft = ctorProto._onClickLeft;
    ctorProto._onClickLeft = function(event) {
      try {
        if (_isDead(this) && !game.user.isGM) {
          try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
          if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
          return;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | drawToken left-click patch threw:`, err);
      }
      return origLeft?.call(this, event);
    };

    const origLeft2 = ctorProto._onClickLeft2;
    ctorProto._onClickLeft2 = function(event) {
      try {
        if (_isDead(this) && !game.user.isGM) {
          try { event?.preventDefault?.(); event?.stopPropagation?.(); } catch (_) {}
          if (_lootableTileInstance) _lootableTileInstance._openLootDialog(this);
          return;
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | drawToken double-click patch threw:`, err);
      }
      return origLeft2?.call(this, event);
    };

    ctorProto.__aceQolTokenClicksPatched = true;
    console.debug(`${MODULE_ID} | drawToken: late-patched ${token.constructor.name} clicks.`);
  } catch (_) {}
});

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
    console.debug(`${MODULE_ID} | drawTile: late-patched ${tile.constructor.name}.prototype._onClickRight.`);
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

    console.debug(`${MODULE_ID} | Lootable tile online (instance bound; right-click patched via top-level hooks)`);
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
          // Enriched here, where the item still exists — a snapshot outlives it.
          description: await aceDescriptionHtml(item),
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
    // Track listener references so we can cleanly unwire on module disable
    // or world unload. Previous code added document listeners but never
    // removed them — accumulating duplicates on reload (audit P1-3).
    this._domHandlers = this._domHandlers ?? {};

    // ── Right-click (mousedown→mouseup pair, button=2) with drag-resistance ──
    // We previously tried the `contextmenu` event, but Foundry's PIXI canvas
    // calls preventDefault on it inside its own handlers — by the time our
    // document listener fires, the event has been consumed. The
    // mousedown/mouseup pair on the document fires reliably regardless of
    // PIXI's internal handling.
    //
    // We ALSO swallow contextmenu over a lootable tile so Foundry doesn't
    // pop its default right-click menu on top of our dialog.
    // ── UI element bail-out ──
    // Character sheets, dialogs, sidebar, BG3 HUD, etc. all sit ABOVE the
    // canvas. A right-click on a sheet whose window happens to overlay a
    // lootable token underneath was bleeding through to the loot dialog,
    // because our document-level listeners don't know whether the click
    // landed on the canvas or on a UI overlay. Bail when the event target
    // is inside a known UI surface.
    // UI surfaces that sit ABOVE the canvas. Mouse events landing on any of
    // these should NOT trigger lootable-tile behavior (right-click, hover icon).
    // V13 introduced ApplicationV2 which uses `.application` instead of `.app`,
    // and DialogV2 uses different classes too — must catch both old and new.
    const UI_BAIL = [
      ".app",                  // V1 Foundry application (sheets, dialogs)
      ".application",          // V2 Foundry application (ApplicationV2 / DialogV2)
      ".window-app",           // generic Foundry window
      ".sheet",                // actor / item / journal sheets
      ".dialog",               // legacy Dialog
      "dialog",                // native HTML dialog element (DialogV2 renders one)
      "#sidebar",              // right sidebar (chat, combat, etc.)
      "#chat",                 // chat panel
      "#chat-log",             // chat log
      "#hud",                  // canvas HUD
      "#ui-top",               // top UI bar
      "#ui-bottom",            // bottom UI bar (hotbar)
      "#ui-left",              // left UI panel
      "#ui-right",             // right UI panel
      ".notification",         // toast notifications
      "#notifications",        // notifications container
      ".tooltip",              // tooltips
      "#tooltip",              // tooltip element
      "#context-menu",         // context menus
      ".context-menu",         // context menus
      "#players",              // player list
      "#navigation",           // scene navigation
      ".bg3-hud",              // BG3 HUD module
      "#bg3-hud-container",    // BG3 HUD container
      ".combat-dock",          // theripper93's Carousel Combat Tracker container
      ".combat-dock-tooltip-wrapper",  // ...and its hover tooltips
      "[data-application-id]", // any element belonging to an Application — V13 catch-all
      "[role='dialog']",       // ARIA dialog (covers most modal popups)
    ].join(", ");
    // Made instance-level so all event handlers in this class can share it
    // (right-click, hover, drag, future additions).
    this._isOverGameCanvas = (ev) => {
      const t = ev?.target;
      if (!t) return false;
      if (typeof t.closest !== "function") return false;
      return !t.closest(UI_BAIL);
    };

    // ── Bound handler refs (so we can remove them in _unwireDomListener) ──
    this._domHandlers.mousedown = (ev) => {
      if (ev.button !== 2) return;
      if (!this._isOverGameCanvas(ev)) return;
      this._rightDownAt = {
        screenX: ev.clientX,
        screenY: ev.clientY,
        time:    Date.now(),
      };
    };
    this._domHandlers.mouseup = (ev) => {
      if (ev.button !== 2) return;
      if (!this._isOverGameCanvas(ev)) { this._rightDownAt = null; return; }
      const start = this._rightDownAt;
      this._rightDownAt = null;
      if (!start) return;
      const dt   = Date.now() - start.time;
      const dist = Math.hypot(ev.clientX - start.screenX, ev.clientY - start.screenY);
      if (dt > 500 || dist > 5) return;
      this._handleSingleRightClick(ev);
    };
    this._domHandlers.contextmenu = (ev) => {
      if (!this._isOverGameCanvas(ev)) return;
      const worldPos = this._eventToWorldPos(ev);
      if (!worldPos) return;
      if (this._findLootableTileAt(worldPos) || this._findLootableTokenAt(worldPos)) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    this._domHandlers.mousemove = (ev) => {
      if (!this._isOverGameCanvas(ev)) {
        this._cancelHoverIcon?.();
        return;
      }
      this._onHoverMove(ev);
    };

    document.addEventListener("mousedown",   this._domHandlers.mousedown,   true);
    document.addEventListener("mouseup",     this._domHandlers.mouseup,     true);
    document.addEventListener("contextmenu", this._domHandlers.contextmenu, true);
    document.addEventListener("mousemove",   this._domHandlers.mousemove);

    let delayMs = "?";
    try { delayMs = game.settings.get(MODULE_ID, "lootHoverIconDelayMs"); }
    catch (_) {}
    console.debug(`${MODULE_ID} | Lootable tile DOM listeners wired — right-click ready; hover-icon delay=${delayMs}ms${delayMs === 0 ? " (DISABLED — set lootHoverIconDelayMs > 0 to enable)" : ""}`);
  }

  /**
   * Remove the document-level mouse listeners wired by _wireDomListener.
   * Called from a Foundry `closeGame`/`disableModule` hook (or manually
   * via the API) so listeners don't accumulate across reload/disable.
   *
   * Without this, every module reload added a fresh set of four document
   * listeners while the old ones stayed bound — leading to duplicated
   * right-clicks and stuck hover-icon timers on long sessions. Audit P1-3.
   */
  _unwireDomListener() {
    if (!this._domWired || !this._domHandlers) return;
    try {
      document.removeEventListener("mousedown",   this._domHandlers.mousedown,   true);
      document.removeEventListener("mouseup",     this._domHandlers.mouseup,     true);
      document.removeEventListener("contextmenu", this._domHandlers.contextmenu, true);
      document.removeEventListener("mousemove",   this._domHandlers.mousemove);
    } catch (err) {
      console.warn(`${MODULE_ID} | _unwireDomListener: removeEventListener threw (non-fatal):`, err);
    }
    this._domHandlers = {};
    this._domWired = false;
    console.debug(`${MODULE_ID} | Lootable tile DOM listeners unwired.`);
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

    // Lootable tile OR dead token — both are valid loot targets. Tile takes
    // priority for backwards-compat with the old pipeline that placed corpse
    // tiles. The new pipeline (v0.7.14+) doesn't place tiles, so the token
    // pass is what fires for normal post-launch dead bodies.
    const target = this._findLootableTileAt(worldPos)
                ?? this._findLootableTokenAt(worldPos);
    if (!target) {
      if (debug) {
        const hasToken = this._tokenAtPos(worldPos);
        console.debug(`${MODULE_ID} | LootClick: no lootable tile or dead token at (${worldPos.x.toFixed(0)},${worldPos.y.toFixed(0)})${hasToken ? " (live token at pos)" : ""}`);
      }
      return;
    }

    const targetDoc = target.document ?? target;
    const kind = targetDoc.documentName === "Token" ? "dead-body (token)"
               : (targetDoc.flags?.[MODULE_ID]?.isDeadToken === true ? "dead-body (tile)" : "container");
    if (debug) console.debug(`${MODULE_ID} | LootClick: opening loot dialog for ${kind} ${targetDoc.id}`);

    try { event.stopPropagation(); event.preventDefault(); } catch (_) {}
    this._openLootDialog(target);
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

  /**
   * Find a lootable TOKEN at the given world position. Mirrors
   * _findLootableTileAt but walks scene tokens instead of tiles, filtering
   * to those marked dead by ace-qol's death pipeline (v0.7.14+).
   *
   * Dead tokens have flag isDeadToken (set as a compatibility mirror of
   * the new isDead flag) so the existing loot dialog code reads them
   * unchanged. Returns the Token (PIXI object) or its document.
   */
  _findLootableTokenAt(worldPos) {
    if (!canvas?.scene || !worldPos) return null;
    const tokens = [...canvas.scene.tokens.contents].reverse();
    for (const tokenDoc of tokens) {
      const isDead = tokenDoc.flags?.[MODULE_ID]?.isDead === true
                  || tokenDoc.flags?.[MODULE_ID]?.isDeadToken === true;
      if (!isDead) continue;
      const w = (Number(tokenDoc.width)  > 0) ? Number(tokenDoc.width)  * canvas.grid.size : canvas.grid.size;
      const h = (Number(tokenDoc.height) > 0) ? Number(tokenDoc.height) * canvas.grid.size : canvas.grid.size;
      if (worldPos.x >= tokenDoc.x
       && worldPos.x < tokenDoc.x + w
       && worldPos.y >= tokenDoc.y
       && worldPos.y < tokenDoc.y + h) {
        return tokenDoc.object ?? canvas.tokens?.get?.(tokenDoc.id) ?? tokenDoc;
      }
    }
    return null;
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

    // ── UI-overlap guard ──
    // The hover icon is position:fixed and floats over screen coords. If a
    // dialog, popup (attack roll, save card, etc.), sidebar, or any other
    // UI element is layered ABOVE the canvas at the cursor's position,
    // showing the icon would punch through and obscure that UI. Cursor
    // coords still resolve to a valid world position underneath, so
    // _eventToWorldPos can't detect this on its own — we have to ask the
    // DOM what's actually at the top of the layer stack right now.
    const topEl = document.elementFromPoint(ev.clientX, ev.clientY);
    const canvasEl = document.getElementById("board") ?? canvas?.app?.view ?? null;
    const overIcon = this._hoverIconEl
      && (topEl === this._hoverIconEl || this._hoverIconEl.contains(topEl));
    if (topEl && canvasEl && topEl !== canvasEl && !overIcon) {
      this._cancelHoverIcon();
      return;
    }

    const worldPos = this._eventToWorldPos(ev);
    if (!worldPos) {
      this._cancelHoverIcon();
      return;
    }
    // First-pass: tiles (dead-art tiles + containers — original behavior).
    // Second-pass: dead TOKENS (v0.7.14+ — the new in-place death pipeline
    // keeps the token, swaps its texture, and marks it lootable on flags).
    // Tile takes priority if both are present at the same spot (legacy +
    // possibility of an older dead-art tile overlaid on the new pipeline's
    // token). The dialog handles either kind via tile.document ?? tile.
    let target = this._findLootableTileAt(worldPos);
    if (!target) target = this._findLootableTokenAt(worldPos);
    if (!target) {
      this._cancelHoverIcon();
      return;
    }
    // One-time diagnostic so we can prove the listener fires + the target is
    // detected. Logged exactly once per session per target-id so it doesn't
    // spam. If you never see this line in console, _wireDomListener never
    // ran. If you see it but no icon appears, the problem is downstream
    // (_tileHasLoot returned false, or _showHoverIcon couldn't render).
    if (!this._hoverFirstDetectLogged) this._hoverFirstDetectLogged = new Set();
    const tid = target.id ?? target.document?.id;
    if (tid && !this._hoverFirstDetectLogged.has(tid)) {
      this._hoverFirstDetectLogged.add(tid);
      const kind = target.document?.documentName ?? (target.constructor?.name ?? "lootable");
      console.log(`${MODULE_ID} | hover-icon: lootable ${kind} detected under cursor (${tid}, delay=${delayMs}ms)`);
    }
    // Don't tease the user with a treasure-chest icon on empty corpses /
    // empty containers — only show the icon if there's actually something
    // to take. Right-click still works either way for diagnostic purposes.
    if (!this._tileHasLoot(target)) {
      this._cancelHoverIcon();
      return;
    }
    // If we're already showing the icon for this target, leave it alone
    if (this._hoverIconTileId === (target.id ?? target.document?.id)) return;
    // Clear any pending or visible icon for a different target
    this._cancelHoverIcon();
    // Schedule icon reveal after the configured delay
    const targetId = target.id ?? target.document?.id;
    this._hoverPending = setTimeout(() => {
      this._showHoverIcon(target);
      this._hoverIconTileId = targetId;
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
        // ⚠️🔴 TWO ANSWERS TO ONE QUESTION, AND THEY DISAGREED.
        //
        // This decided whether to show the loot icon by reading the LIVE ACTOR
        // first and only falling back to the snapshot. The dialog that opens
        // when you press that icon does the exact opposite: it prefers the
        // snapshot and falls back to the actor. Giving loot away prunes the
        // snapshot, so the dialog correctly emptied while this kept reading a
        // world actor nobody had pruned, and the icon never went away.
        //
        // Johnny, 2026-09-02: "Right now, if I push the loot icon, even though
        // it's been given all away, it still comes up."
        //
        // ⚠️ SO THERE IS ONE READER NOW AND BOTH CALL IT. Two functions that
        // answer the same question in opposite orders will always drift; this
        // is the same shape as the cast-time and entry checks disagreeing about
        // who was standing in a Moonbeam (2026-08-27).
        const loot = this._deadLootFor(tileDoc);
        return (loot.items.length > 0) || currencyHasValue(loot.currency);
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

  /**
   * Does this dead thing read as meat rather than treasure?
   *
   * ⚠️ Delegates to `sustenance.canHarvest`, which is where the beasts-only
   * rule lives. Do NOT re-implement the creature-type test here — there must be
   * exactly one place that decides what may be butchered, and it is not this
   * file. A humanoid returns false and simply shows the ordinary loot badge.
   */
  _isHarvestable(tile) {
    try {
      const doc = tile?.document ?? tile;
      if (doc?.documentName !== "Token") return false;      // tiles are never meat
      const actor = tile?.actor ?? doc?.actor ?? null;
      if (!actor) return false;
      return canHarvest(actor).ok === true;
    } catch (_) {
      return false;   // never let the badge decision throw the hover handler
    }
  }

  _showHoverIcon(tile) {
    try {
      const tileDoc = tile.document ?? tile;
      if (!tileDoc) return;

      // ⚠️ A TILE AND A TOKEN DO NOT MEASURE THEMSELVES THE SAME WAY.
      // TileDocument width/height are PIXELS. TokenDocument width/height are
      // GRID SQUARES — a medium creature is `width: 1`. This function was
      // written for tiles and later reused for dead tokens, so every corpse
      // was centred at `x + 0.5` — half a pixel from its top-left corner.
      // That is why the icon sat in the north-west corner instead of on the
      // body. Ask the PLACEABLE for its bounds, which are in world pixels for
      // both kinds, and only fall back to document maths if there is no
      // placeable to ask.
      let cx, cy, worldW, worldH;
      const bounds = (typeof tile.bounds === "object" && tile.bounds) ? tile.bounds : null;
      if (bounds && Number(bounds.width) > 0) {
        worldW = Number(bounds.width);
        worldH = Number(bounds.height);
        cx = Number(bounds.x) + worldW / 2;
        cy = Number(bounds.y) + worldH / 2;
      } else if (tile.center && Number.isFinite(tile.center.x)) {
        cx = tile.center.x;
        cy = tile.center.y;
        const gs = Number(canvas?.grid?.size) || 100;
        worldW = (Number(tileDoc.width)  || 1) * (tileDoc.documentName === "Token" ? gs : 1);
        worldH = (Number(tileDoc.height) || 1) * (tileDoc.documentName === "Token" ? gs : 1);
      } else {
        // Last resort: document maths, with the grid conversion tokens need.
        const gs = Number(canvas?.grid?.size) || 100;
        const isToken = tileDoc.documentName === "Token";
        worldW = (Number(tileDoc.width)  > 0 ? Number(tileDoc.width)  : 1) * (isToken ? gs : 1);
        worldH = (Number(tileDoc.height) > 0 ? Number(tileDoc.height) : 1) * (isToken ? gs : 1);
        cx = Number(tileDoc.x) + worldW / 2;
        cy = Number(tileDoc.y) + worldH / 2;
      }
      // Convert world → screen via canvas.stage
      const screen = canvas.stage.toGlobal({ x: cx, y: cy });
      const canvasEl = document.getElementById("board") ?? canvas?.app?.view;
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const left = rect.left + screen.x;
      const top  = rect.top  + screen.y;

      // ── Scale the badge to the body it sits on ──────────────────────────
      // Johnny, 2026-08-09: "I would just rather have the loot icon as big as
      // the corpse is. It's very visible inside the square of the corpse."
      // 70% of the token, not 100%: a badge that fills the square swallows the
      // token underneath, and the GM still needs to click the corpse itself to
      // open its sheet and put hit points back after a resurrection. The
      // remaining ring is that click target. Clamped so a rat is still hittable
      // and a dragon's badge is not absurd.
      // ⚠️🔴 ONE SQUARE, NEVER THE CREATURE. This scaled to the body it sat on,
      // so a Huge dragon wore a badge nine times the area of a goblin's and it
      // dominated that corner of the map. Johnny, 2026-09-02: "the loot icon
      // doesn't have to scale with the size of the creature. It can just stay
      // within a 5 ft by 5 ft square, in fact, smaller, 75%."
      //
      // So the size comes from the GRID, not from `worldW/worldH`. A badge on a
      // dragon and a badge on a rat are now the same size, which is what makes
      // a row of corpses readable at a glance. Still scaled by zoom, or it would
      // be a speck when he pulls the camera back.
      const zoom  = Number(canvas?.stage?.scale?.x) || 1;
      const onScreen = (Number(canvas?.grid?.size) || 100) * zoom;
      const size  = Math.max(24, Math.min(96, Math.round(onScreen * 0.75)));
      const glyph = Math.round(size * 0.5);

      // A carcass someone can butcher reads as meat, not treasure — and it is
      // the same slot, so players meet the harvest affordance where they
      // already look for the loot one.
      const harvestable = this._isHarvestable?.(tile) ?? false;

      const icon = document.createElement("div");
      icon.className = "ace-qol-loot-hover-icon";
      // fa-sack-dollar and fa-drumstick-bite are both Font Awesome 6 FREE
      // (Foundry V13 bundles Free). fa-treasure-chest is Pro-only and rendered
      // as a blank circle — do not reach for it again.
      icon.innerHTML = harvestable
        ? `<i class="fas fa-drumstick-bite" aria-hidden="true"></i>`
        : `<i class="fas fa-sack-dollar" aria-hidden="true"></i>`;
      icon.style.cssText = `
        position: fixed;
        left: ${left}px;
        top: ${top}px;
        transform: translate(-50%, -50%);
        width: ${size}px; height: ${size}px;
        --ace-glyph: ${glyph}px;
        display: flex; align-items: center; justify-content: center;
        background: ${harvestable ? "rgba(214, 122, 127, 0.95)" : "rgba(212, 175, 55, 0.95)"};
        border: 2px solid ${harvestable ? "#c05f66" : "#d4af37"};
        border-radius: 50%;
        color: #1a1a1e;
        font-size: ${glyph}px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.55);
        z-index: 60;
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

    // ── Incapacitated creatures can't loot ── (players only; GM unrestricted)
    // RAW: an incapacitated creature (paralyzed, stunned, unconscious, petrified)
    // can't take actions — and looting/searching a body IS an action. Block the
    // dialog so a held/stunned PC can't rummage a corpse or peek its contents.
    // (2026-06-24.)
    if (!game.user.isGM) {
      const st = game.user.character?.statuses;
      const blocked = ["incapacitated", "paralyzed", "stunned", "unconscious", "petrified"];
      if (st && blocked.some(s => st.has?.(s))) {
        ui.notifications?.warn("You can't loot while incapacitated.");
        return;
      }
    }

    // ── Distance gate for players (GM is unrestricted) ──
    // The player's character has to be within 10 feet (configurable via
    // setting `lootMaxDistanceFt`) of the body/container to loot it.
    // Without this, a player anywhere on the canvas can open the loot
    // dialog on any dead body — including ones on the other side of a
    // wall or 150 feet away across the battlefield.
    //
    // Rules of engagement:
    //   - GM: unrestricted (often runs cleanup post-combat from the chair)
    //   - Player: distance from their character's token to the loot target
    //   - If we can't find the player's character token (no assigned
    //     character, no token on canvas), fall back to ALLOW. Defensive —
    //     we'd rather over-allow than soft-lock players whose setup is
    //     non-standard. Better complaint to handle than silent failure.
    if (!game.user.isGM) {
      const maxFt = (() => {
        try {
          const v = Number(game.settings.get(MODULE_ID, "lootMaxDistanceFt"));
          // Setting 0 = disabled (any distance allowed). NaN / negative
          // fall back to the default. Otherwise honor exactly.
          if (!Number.isFinite(v) || v < 0) return 10;
          return v;
        } catch (_) { return 10; }
      })();
      // maxFt = 0 → distance gate disabled, skip the whole check
      if (maxFt > 0) {
      const playerToken = (() => {
        // Prefer a token the player is actually controlling
        const ctrl = canvas.tokens?.controlled?.find(t =>
          t.actor?.hasPlayerOwner && t.actor?.id === game.user.character?.id
        );
        if (ctrl) return ctrl;
        // Else find the assigned character's token on this scene
        if (game.user.character) {
          const owned = canvas.tokens?.placeables?.find(t =>
            t.actor?.id === game.user.character?.id
          );
          if (owned) return owned;
        }
        // Else any token on this scene the player owns
        return canvas.tokens?.placeables?.find(t =>
          t.actor?.hasPlayerOwner && t.actor?.testUserPermission?.(game.user, "OWNER")
        ) ?? null;
      })();
      if (playerToken) {
        try {
          const gridSize = canvas.grid?.size ?? 100;
          // Edge-to-edge gap (nearest-edge, 5e diagonal rule) via the canonical
          // helper, so loot range agrees with reach/spell measurement. The loot
          // target may be a Tile (pixel width/height) or a Token (grid-unit
          // width/height); both resolve to a pixel footprint here. 2D — looting
          // is a ground reach, so elevation is ignored.
          const isToken = tileDoc.documentName === "Token";
          const targetW = (Number(tileDoc.width)  > 0 ? Number(tileDoc.width)  : 1) * (isToken ? gridSize : 1);
          const targetH = (Number(tileDoc.height) > 0 ? Number(tileDoc.height) : 1) * (isToken ? gridSize : 1);
          const tileRect = { x: tileDoc.x ?? 0, y: tileDoc.y ?? 0, w: targetW, h: targetH };
          const pdoc = playerToken.document;
          const playerRect = {
            x: pdoc.x ?? 0, y: pdoc.y ?? 0,
            w: (pdoc.width ?? 1) * gridSize, h: (pdoc.height ?? 1) * gridSize,
          };
          const distFt = aceEdgeGapFt(playerRect, tileRect, { threeD: false });
          if (distFt > maxFt) {
            ui.notifications?.warn(`Too far to loot — ${Math.round(distFt)} feet away (max ${maxFt} feet). Move closer.`);
            return;
          }
        } catch (distErr) {
          // Defensive: if the math throws (unusual scene config, missing
          // grid, etc.) ALLOW the loot rather than soft-locking the player.
          console.warn(`${MODULE_ID} | Loot distance check threw — allowing access:`, distErr);
        }
      } else {
        console.debug(`${MODULE_ID} | No player token found for distance gate — allowing loot access (defensive).`);
      }
      } // end if (maxFt > 0)
    }

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

      // ⚠️ WHAT WAS ALREADY HANDED OUT NEVER APPEARS AGAIN. Reviving a corpse
      // clears its snapshot and killing it a second time rebuilds one from a
      // sheet that may still hold everything, which is how Johnny's shadow
      // dragon offered its entire hoard twice (2026-09-02). The claim list
      // outlives both, so this filter is the backstop behind the deletion.
      const _claimed = new Set(flags.lootClaimed ?? []);
      // ⚠️ WARM THE DESCRIPTIONS BEFORE THE ROWS ARE BUILT. `_buildLootItemRow`
      // is synchronous and enrichment is not, so without this the first open of
      // a body shows its items with the enricher text stripped instead of
      // resolved. Priming here costs nothing and the dialog is built after it.
      try { acePrimeDescriptions(actor?.items ?? []); }
      catch (err) { console.warn(`${MODULE_ID} | could not pre-read the loot descriptions:`, err); }

      if (useSnapshot) {
        source = "snapshot";
        // Snapshot revealable whenever the entry is unidentified — we can
        // flip the stored flag even when the source actor is gone (the
        // reveal handler updates the snapshot.items entry in-place).
        items = (snapshot.items ?? [])
          .filter(it => !_claimed.has(it.id ?? it.uuid))
          .map(it => LootableTile._buildStoredItemRow(it, { revealable: it.identified === false }));
        currency = snapshot.currency ?? {};
      } else if (actor) {
        source = "actor";
        items = actor.items.contents
          .filter(i => this._isLootableItem(i) && !_claimed.has(i.id))
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
      // Container revealable whenever the entry is unidentified — the
      // reveal handler updates the containerLoot.items entry in-place
      // (no live Item document needed since the data lives on the tile).
      items = (loot.items ?? []).map(it => LootableTile._buildStoredItemRow(it, { revealable: it.identified === false }));
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

    // ── How this drop should be DESCRIBED ────────────────────────────────
    // A construct is salvaged, an ooze is cut open, a beast is simply dead
    // with things lying on it. Only humanoids and their kin actually carried
    // what they're holding. Read order matters: the snapshot recorded the
    // type at the moment of death, the token flag is the same value, and the
    // world actor is the LAST resort because for an unlinked token it's a
    // different copy of the creature. (2026-08-08)
    const deadCreatureType = isDead
      ? (readCreatureType(flags.lootSnapshot)
         || String(flags.creatureType ?? "").toLowerCase()
         || readCreatureType(actor))
      : "";
    const framing = lootFraming(deadCreatureType);

    // Subtitle: creature type for dead bodies, "Container" for chests
    const subtitle = isDead
      ? (deadCreatureType ? deadCreatureType.charAt(0).toUpperCase() + deadCreatureType.slice(1) : "")
      : "Container";

    // One plain line explaining WHY this isn't pocket loot. Empty for the
    // ordinary case, so a goblin's card looks exactly as it always has.
    const framingNoteHtml = (isDead && framing.note)
      ? `<div class="ace-qol-tile-loot-framing" style="margin:6px 0 2px;padding:7px 10px;border-radius:4px;background:#191b22;border-left:3px solid #d4af37;color:#cfc4a8;font-size:14px;line-height:1.4;">${foundry.utils.escapeHTML(framing.note)}</div>`
      : "";

    // GM-only "Repost Loot Card" button — recreates the ACE Loot chat card
    // for this tile if the original card was lost / accidentally deleted.
    // Hidden if there's nothing worth posting (no items + no currency).
    const repostBtn = (game.user.isGM && (items.length > 0 || totalCoins > 0))
      ? `<button class="ace-qol-loot-repost-btn" data-action="lootRepostCard" title="Post a fresh ACE Loot chat card from this tile's contents — use if the original card was deleted"><i class="fas fa-comment-alt"></i> Repost Card</button>`
      : "";

    // GM-only "Reveal All" button — flips identified:true on every
    // unidentified item in this loot pile in one shot. Hidden when no
    // unidentified items exist (so it doesn't clutter the header for
    // a fully-mundane corpse).
    const unidCount = items.filter(it => it.identified === false).length;
    const revealAllBtn = (game.user.isGM && unidCount > 0)
      ? `<button class="ace-qol-loot-reveal-all-btn" data-action="lootRevealAll" title="Reveal ALL ${unidCount} unidentified items in this loot pile to players in one action"><i class="fas fa-eye"></i> Reveal All (${unidCount})</button>`
      : "";

    const content = `
      <div class="ace-qol-tile-loot-dialog">
        <div class="ace-qol-tile-loot-header">
          <strong>${foundry.utils.escapeHTML(displayName)}</strong>
          <span class="ace-qol-tile-loot-type">${foundry.utils.escapeHTML(subtitle)}</span>
          ${revealAllBtn}
          ${repostBtn}
        </div>
        ${framingNoteHtml}
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
      creatureType: deadCreatureType,
    };

    const dlg = await foundry.applications.api.DialogV2.wait({
      window: { title: `${framing.verb} — ${displayName}` },
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

    // ── Reveal All button (GM only) — flip every unidentified item in one action ──
    const revealAllBtn = root.querySelector(".ace-qol-loot-reveal-all-btn");
    if (revealAllBtn && game.user.isGM) {
      revealAllBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Reveal All Items" },
          content: `<p style="font-size:15px;line-height:1.5;">Reveal the real name and description of EVERY unidentified item in this loot pile to all players? This cannot be undone (re-marking individually would require editing each item's sheet).</p>`,
          modal:   true,
          yes:     { default: true, label: "Reveal All", icon: "fa-solid fa-eye" },
          no:      { label: "Cancel" },
          rejectClose: false,
        }).catch(() => false);
        if (!confirmed) return;

        try {
          const tileDoc = tile.document ?? tile;
          const revealed = [];

          if (source === "actor" && actor) {
            // Iterate actor.items, update each unidentified one
            const targets = actor.items.contents.filter(i => i.system?.identified === false);
            for (const it of targets) {
              try {
                await it.update({ "system.identified": true });
                revealed.push(it.name);
              } catch (err) {
                console.warn(`${MODULE_ID} | Reveal-all: failed on "${it.name}":`, err);
              }
            }
          } else if (source === "snapshot") {
            const snapItems = foundry.utils.deepClone(tileDoc?.flags?.[MODULE_ID]?.lootSnapshot?.items ?? []);
            for (const entry of snapItems) {
              if (entry.identified === false) {
                entry.identified = true;
                if (entry.data?.system) entry.data.system.identified = true;
                revealed.push(entry.name);
              }
            }
            if (revealed.length) {
              await tileDoc.update({ [`flags.${MODULE_ID}.lootSnapshot.items`]: snapItems });
            }
          } else if (source === "container") {
            const contItems = foundry.utils.deepClone(tileDoc?.flags?.[CONTAINER_FLAG_NS]?.[CONTAINER_LOOT_NAME]?.items ?? []);
            for (const entry of contItems) {
              if (entry.identified === false) {
                entry.identified = true;
                revealed.push(entry.name);
              }
            }
            if (revealed.length) {
              await tileDoc.update({ [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.items`]: contItems });
            }
          }

          if (!revealed.length) {
            ui.notifications.info("ACE QOL: Nothing to reveal — all items were already identified.");
            return;
          }

          ui.notifications.info(`ACE QOL: Revealed ${revealed.length} item${revealed.length === 1 ? "" : "s"} to all players.`);
          await ChatMessage.create({
            content: `<em>The party identifies <strong>${revealed.length}</strong> item${revealed.length === 1 ? "" : "s"}: ${revealed.map(n => `<strong>${foundry.utils.escapeHTML(n)}</strong>`).join(", ")}.</em>`,
          });
          await dialog.close();
          this._openLootDialog(tile);
        } catch (err) {
          console.error(`${MODULE_ID} | Reveal-all failed:`, err);
          ui.notifications.error("ACE QOL: Reveal-all failed — see console.");
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
    // Routes by source kind:
    //   actor    → live Item document.update({ "system.identified": true })
    //   snapshot → mutate tile.flags.lootSnapshot.items entry in place
    //   container → mutate tile.flags["ace-suite"].containerLoot.items entry in place
    root.querySelectorAll(".ace-qol-loot-reveal-btn").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!game.user.isGM) return;
        const key = btn.dataset.itemKey;
        if (!key) return;
        try {
          let revealedName = null;
          if (source === "actor" && actor) {
            const item = actor.items.get(key) ?? (key.includes(".") ? await fromUuid(key) : null);
            if (!item) {
              ui.notifications.warn("ACE QOL: Couldn't locate item to reveal.");
              return;
            }
            await item.update({ "system.identified": true });
            revealedName = item.name;
          } else if (source === "snapshot") {
            const tileDoc = tile.document ?? tile;
            const snapItems = foundry.utils.deepClone(tileDoc?.flags?.[MODULE_ID]?.lootSnapshot?.items ?? []);
            const entry = snapItems.find(it => (it.id ?? it.uuid) === key);
            if (!entry) {
              ui.notifications.warn("ACE QOL: Couldn't locate snapshot entry to reveal.");
              return;
            }
            revealedName = entry.name;
            entry.identified = true;
            // The full toObject() stored in entry.data still has identified:false
            // baked in — flip there too so future give-to-recipient creates an
            // identified item on the PC.
            if (entry.data?.system) entry.data.system.identified = true;
            await tileDoc.update({ [`flags.${MODULE_ID}.lootSnapshot.items`]: snapItems });
          } else if (source === "container") {
            const tileDoc = tile.document ?? tile;
            const contItems = foundry.utils.deepClone(tileDoc?.flags?.[CONTAINER_FLAG_NS]?.[CONTAINER_LOOT_NAME]?.items ?? []);
            const entry = contItems.find(it => (it.uuid ?? it.id) === key);
            if (!entry) {
              ui.notifications.warn("ACE QOL: Couldn't locate container entry to reveal.");
              return;
            }
            revealedName = entry.name;
            entry.identified = true;
            await tileDoc.update({ [`flags.${CONTAINER_FLAG_NS}.${CONTAINER_LOOT_NAME}.items`]: contItems });
          }
          if (!revealedName) return;
          ui.notifications.info(`ACE QOL: Revealed "${revealedName}" to all players.`);
          await ChatMessage.create({
            content: `<em>The party identifies the item: <strong>${foundry.utils.escapeHTML(revealedName)}</strong>.</em>`,
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
            description: await aceDescriptionHtml(created),
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
        description: await aceDescriptionHtml(sourceItem),
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
  /**
   * THE reader for "what is still on this corpse".
   *
   * ⚠️ ONE FUNCTION, BECAUSE TWO OF THEM DISAGREED FOR MONTHS. The hover icon
   * asked the world actor first; the dialog asked the snapshot first. Giving
   * loot away pruned only the snapshot, so the dialog emptied and the icon
   * stayed lit forever.
   *
   * Order, and the reasons for it:
   *   1. The SNAPSHOT wins when it exists. It is the record of what this body
   *      was carrying at the moment it died, and it is the thing that gets
   *      pruned as items are handed out. For the unlinked NPCs that make up
   *      nearly every monster it is also the only record there is.
   *   2. The world actor is the fallback, for a linked creature that died
   *      before snapshots existed.
   *   3. Anything already claimed is filtered out of both, so a revive and a
   *      second death cannot hand out the same sword twice.
   */
  _deadLootFor(tileDoc) {
    const empty = { items: [], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }, source: "none" };
    try {
      const flags = tileDoc?.flags?.[MODULE_ID] ?? {};

      // ⚠️🔴 ASH HAS NOTHING TO GIVE, AND THE FALLBACK BELOW WOULD HAVE GIVEN
      // IT EVERYTHING. Burning a body to ash clears its loot snapshot, and the
      // world-actor fallback further down reads a sheet that still owns the
      // whole hoard — so a pile of cinders would have handed out the dragon's
      // greatsword. The fire engine clears the corpse flags too; this is the
      // guard that does not depend on it having managed to.
      if (flags.isAsh) return { ...empty, source: "ash" };

      const claimed = new Set(flags.lootClaimed ?? []);
      const snap = flags.lootSnapshot ?? null;

      if (snap) {
        return {
          items: (snap.items ?? []).filter(i => !claimed.has(i.id ?? i.uuid)),
          currency: snap.currency ?? empty.currency,
          source: "snapshot",
        };
      }

      const live = flags.originalActorId ? game.actors.get(flags.originalActorId) : null;
      if (live) {
        return {
          items: (live.items?.contents ?? [])
            .filter(i => this._isLootableItem(i) && !claimed.has(i.id)),
          currency: live.system?.currency ?? empty.currency,
          source: "actor",
        };
      }

      // ⚠️ "NOTHING LEFT" AND "COULD NOT LOOK" MUST NOT READ THE SAME. A corpse
      // with neither a snapshot nor an actor is a bug upstream, not an empty body.
      if (flags.isDeadToken) {
        console.warn(`${MODULE_ID} | "${tileDoc?.name ?? "a corpse"}" has no loot snapshot `
          + `and no actor behind it, so what it was carrying cannot be determined. `
          + `Showing nothing rather than guessing.`);
      }
      return empty;
    } catch (err) {
      console.warn(`${MODULE_ID} | could not read what is on this body:`, err);
      return empty;
    }
  }

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

    // ⚠️🔴 ENRICH FIRST, THEN CLEAN. `cleanItemDescription` is a good FLOOR and a
    // poor ceiling: it deletes `[[lookup @name]]` rather than resolving it, so a
    // sword whose text names its wielder reads with a hole in it. The sync
    // reader answers from the cache the loot dialog primes below, resolves the
    // placeholders, and only falls back to stripping when it cannot. Either way
    // nothing bracketed reaches the dialog.
    const realDesc = LootableTile.cleanItemDescription(
      aceDescriptionTextSync(item) || (sys.description?.value ?? ""));
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
  /**
   * ⚠️🔴 REMOVING IT FROM THE SNAPSHOT IS NOT REMOVING IT FROM THE BODY.
   *
   * Johnny's shadow dragon, 2026-09-02: "This guy's already been looted of
   * everything, I've already given it away, yet it's still got a loot icon...
   * If I revive the dragon to one hit point and I kill it again, then I still
   * get all that loot."
   *
   * The snapshot path assumed the source actor was gone, which is true for the
   * unlinked NPCs it was written for and false for anything linked. So the item
   * was copied to the player, pruned from the snapshot, and left sitting on the
   * corpse. Reviving clears the snapshot; killing again rebuilds it from an
   * actor that still owns everything, and the whole hoard comes back.
   *
   * ⚠️ AND THE CLAIM IS RECORDED, not merely acted on. A second death must know
   * what was already taken even if the item somehow survives on the sheet.
   */
  async _syncSnapshotItemRemoved(tile, itemId) {
    const tileDoc = tile?.document ?? tile;
    try {
      const snap = tileDoc?.flags?.[MODULE_ID]?.lootSnapshot;
      if (snap?.items) {
        const updatedItems = snap.items.filter(s => s.id !== itemId);
        if (updatedItems.length !== snap.items.length) {
          await tileDoc.update({ [`flags.${MODULE_ID}.lootSnapshot.items`]: updatedItems });
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | Snapshot item sync failed (non-blocking):`, err);
    }

    // Record the claim so a later death cannot hand it out again.
    try {
      const claimed = new Set(tileDoc?.flags?.[MODULE_ID]?.lootClaimed ?? []);
      if (!claimed.has(itemId)) {
        claimed.add(itemId);
        await tileDoc.update({ [`flags.${MODULE_ID}.lootClaimed`]: [...claimed] });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | could not record that "${itemId}" was claimed, so a `
        + `revive-and-rekill could offer it again:`, err);
    }

    // Take it off the body too, when there still is one.
    try {
      const actorId = tileDoc?.flags?.[MODULE_ID]?.originalActorId;
      const live = actorId ? game.actors.get(actorId) : null;
      const onBody = live?.items?.get?.(itemId);
      if (onBody) {
        await onBody.delete();
        console.log(`${MODULE_ID} | removed "${onBody.name}" from ${live.name}'s body after it was given away.`);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | gave the item away but could not remove it from the body, `
        + `so it may be lootable again after a revive:`, err);
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
