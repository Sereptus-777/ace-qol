// ─── ACE: QOL — Death Pipeline ──────────────────────────────────────────────
// Handles NPC death visuals: converts dead NPC tokens to tile art.
// When an NPC drops to 0 HP, this engine finds matching dead-creature art,
// places a tile at the token's position, and removes the original token.
//
// 3-tier art matching:
//   1. Exact creature name  (dead-goblin-boss.png)
//   2. Creature subtype/type (dead-mongrelfolk.png, dead-humanoid.png)
//   3. Incorporeal/elemental remnants (dead-remnant-ash-pile.png)
//   Fallback: dead-generic.png — if nothing matches, skip conversion entirely.
//
// Self-contained — no imports from other ace-qol files to avoid circular deps.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG_PREFIX = `${MODULE_ID} | Death:`;

// ─── Asset base path ───────────────────────────────────────────────────────
const DEAD_ART_PATH = `modules/${MODULE_ID}/Assets/Dead`;

// ─── Incorporeal creature names ────────────────────────────────────────────
// Creatures that dissolve/vanish on death — no corpse, just ash/remnant.
const INCORPOREAL = new Set([
  "wraith", "specter", "ghost", "shadow", "banshee",
  "will-o-wisp", "poltergeist", "allip", "phantom",
]);

// ─── Elemental remnant mapping ─────────────────────────────────────────────
// Maps elemental name/subtype keywords to specific remnant art file stems.
const ELEMENTAL_REMNANTS = {
  "fire elemental":  "dead-remnant-candle-flame",
  "fire":            "dead-remnant-candle-flame",
  "magma":           "dead-remnant-candle-flame",
  "water elemental": "dead-remnant-puddle",
  "water":           "dead-remnant-puddle",
  "ice":             "dead-remnant-puddle",
  "earth elemental": "dead-remnant-rubble",
  "earth":           "dead-remnant-rubble",
  "mud":             "dead-remnant-rubble",
  "air elemental":   "dead-remnant-wind-wisp",
  "air":             "dead-remnant-wind-wisp",
  "steam":           "dead-remnant-wind-wisp",
};

// ─── Special creature-type remnants ────────────────────────────────────────
// Creature types that leave non-standard remains.
const TYPE_REMNANTS = {
  "ooze":  "dead-remnant-ooze-puddle",
  "plant": "dead-remnant-plant-wilted",
};


// ──────────────────────────────────────────────────────────────────────────────

export class DeathPipeline {

  constructor() {
    /** @type {Map<string, string>}  normalized file stem → full file path */
    this._artCache = new Map();
    /** @type {boolean} Whether the cache has been built at least once */
    this._cacheReady = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Settings Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register death-pipeline world settings.
   * Call during the "init" hook.
   */
  static registerSettings() {
    try {
      const s = (key, opts) => game.settings.register(MODULE_ID, key, opts);

      s("enableDeathPipeline", {
        name:    "Convert NPC Tokens to Dead Art on Death",
        hint:    "When an NPC reaches 0 HP, replace their token with a matching dead-art tile on the canvas.",
        scope:   "world",
        config:  false,
        type:    Boolean,
        default: true,
      });

      s("deleteTokenOnDeath", {
        name:    "Remove Token After Creating Dead Tile",
        hint:    "Delete the original token once the dead-art tile has been placed. Disable to keep both.",
        scope:   "world",
        config:  false,
        type:    Boolean,
        default: true,
      });

      console.log(`${LOG_PREFIX} Settings registered`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Settings registration failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Public API Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Expose death-pipeline methods on `game.aceQol.DeathPipeline`.
   * Call during the "ready" hook after game.aceQol is initialized.
   *
   * @param {DeathPipeline} instance - The live DeathPipeline instance.
   */
  static registerAPI(instance) {
    try {
      if (!game.aceQol) game.aceQol = {};
      game.aceQol.DeathPipeline = {
        processNPCDeath: instance.processNPCDeath.bind(instance),
        buildArtCache:   instance.buildArtCache.bind(instance),
        getAvailableArt: () => new Map(instance._artCache),
      };
      console.log(`${LOG_PREFIX} API registered on game.aceQol.DeathPipeline`);
    } catch (err) {
      console.error(`${LOG_PREFIX} API registration failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Art Cache — FilePicker scan
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Scan the Assets/Dead folder (and subfolders) via FilePicker, building an
   * in-memory map of normalized-file-stem → full-path for instant lookup.
   *
   * Safe to call multiple times — rebuilds from scratch each time.
   */
  async buildArtCache() {
    this._artCache.clear();
    this._cacheReady = false;

    try {
      const result = await FilePicker.browse("data", DEAD_ART_PATH);

      // ── Index root-level files ──
      for (const file of result.files || []) {
        this._indexFile(file);
      }

      // ── Index subfolders (beasts/, humans/, etc.) ──
      for (const dir of result.dirs || []) {
        try {
          const subResult = await FilePicker.browse("data", dir);
          for (const file of subResult.files || []) {
            this._indexFile(file);
          }
        } catch (subErr) {
          console.warn(`${LOG_PREFIX} Failed to scan subfolder "${dir}":`, subErr);
        }
      }

      this._cacheReady = true;
      console.log(`${LOG_PREFIX} Art cache built — ${this._artCache.size} images indexed`);
    } catch (err) {
      // Folder may not exist yet — that's fine, just means no dead art available.
      console.warn(`${LOG_PREFIX} Could not build art cache (Assets/Dead folder may not exist):`, err.message ?? err);
    }
  }

  /**
   * Extract normalized file stem and add to cache.
   * @param {string} filePath - Full file path from FilePicker.
   * @private
   */
  _indexFile(filePath) {
    const fileName = filePath.split("/").pop();
    if (!fileName) return;

    const stem = fileName
      .replace(/\.(png|webp|jpg|jpeg|gif|svg|webm|mp4|m4v|ogv)$/i, "")
      .toLowerCase();

    // Don't overwrite — first match wins (root beats subfolder).
    if (!this._artCache.has(stem)) {
      this._artCache.set(stem, filePath);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loot Snapshot
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a plain-object snapshot of the actor's lootable items + currency.
   * Stored on the dead tile's flags so players (who typically lack permission
   * on NPC actors) can still open the loot dialog and see what dropped.
   *
   * Filter mirrors LootableTile._isLootableItem — kept inline because this
   * file is intentionally self-contained (no cross-module imports).
   *
   * @param {Actor} actor
   * @returns {{items: Array, currency: object}}
   */
  _buildLootSnapshot(actor) {
    const REJECT_TYPES = new Set([
      "feat", "spell", "class", "subclass", "background", "race",
      "species", "facility", "feature", "trait", "spelllist",
    ]);
    const ALLOW_TYPES = new Set([
      "weapon", "equipment", "consumable", "tool", "loot",
      "container", "treasure", "backpack",
    ]);
    const NATURAL_WEAPON_TYPES = new Set(["natural", "improv", "improvised", "siege"]);
    const NATURAL_NAME_RE = /^(bite|claws?|cat'?s\s+claws|fangs|gore|sting|talons?|trunk|fanged\s+bite|vampiric\s+bite|form\s+of\s+the\s+beast|natural\s+attack)\b/i;

    const items = [];
    for (const item of actor?.items?.contents ?? []) {
      const t = item.type;
      if (REJECT_TYPES.has(t)) continue;
      if (!ALLOW_TYPES.has(t)) continue;
      if (t === "weapon") {
        const wt = item.system?.weaponType ?? item.system?.type?.value ?? "";
        if (NATURAL_WEAPON_TYPES.has(wt)) continue;
        if (NATURAL_NAME_RE.test((item.name ?? "").trim())) continue;
      }
      items.push({
        id:     item.id,
        name:   item.name,
        img:    item.img,
        uuid:   item.uuid,
        type:   item.type,
        rarity: item.system?.rarity ?? "common",
      });
    }

    const c = actor?.system?.currency ?? {};
    const currency = {
      pp: c.pp ?? 0,
      gp: c.gp ?? 0,
      ep: c.ep ?? 0,
      sp: c.sp ?? 0,
      cp: c.cp ?? 0,
    };

    return { items, currency };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main Entry Point — Process NPC Death
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert a dead NPC token into a tile with matching dead art.
   *
   * Call this when an NPC actor reaches 0 HP. Only processes NPCs that are
   * not player-owned. Checks the `enableDeathPipeline` setting first.
   *
   * @param {Actor} actor    - The Foundry Actor document.
   * @param {TokenDocument} tokenDoc - The TokenDocument on the current scene.
   * @returns {Promise<void>}
   */
  async processNPCDeath(actor, tokenDoc) {
    const name = actor?.name ?? "unknown";
    console.log(`${LOG_PREFIX} ▶ processNPCDeath("${name}") starting`);
    try {
      // ── Guard: setting enabled? — auto-recover if disabled ──
      if (!game.settings.get(MODULE_ID, "enableDeathPipeline")) {
        console.warn(`${LOG_PREFIX}   ✗ enableDeathPipeline is OFF — auto-enabling`);
        try { await game.settings.set(MODULE_ID, "enableDeathPipeline", true); } catch (_) {}
        // Retry: the setting may have been intentionally off this session
        if (!game.settings.get(MODULE_ID, "enableDeathPipeline")) {
          console.warn(`${LOG_PREFIX}   ✗ Could not enable — aborting`);
          return;
        }
      }

      // ── Polymorph defer guard (RAW: polymorphed creature reverts at 0 HP) ──
      // Multi-signal check matches the primary guard in ace-qol.mjs's
      // npcDeath hook. Defensive layer in case anything else calls
      // processNPCDeath directly while the actor is polymorphed.
      try {
        const flagState = actor?.getFlag?.(MODULE_ID, "transformState");
        const rawFlag   = actor?.flags?.[MODULE_ID]?.transformState;
        const polyEff   = actor.effects?.contents?.some?.(e =>
                            e?.flags?.[MODULE_ID]?.polymorphEffect === true && !e.disabled);
        const isPolymorphed = (flagState && flagState.revertOnZeroHP !== false)
                           || (rawFlag   && rawFlag.revertOnZeroHP   !== false)
                           || polyEff;
        if (isPolymorphed) {
          console.log(`${LOG_PREFIX}   ⏭ Deferring — ${name} is polymorphed (flag=${!!flagState}, raw=${!!rawFlag}, eff=${polyEff})`);
          return;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX}   polymorph-defer guard threw — falling through:`, err);
      }

      // ── Guard: NPC only, not player-owned ──
      if (!actor || actor.type !== "npc" || actor.hasPlayerOwner) {
        console.log(`${LOG_PREFIX}   ✗ Not an NPC or is player-owned — skipping`);
        return;
      }

      // ── Guard: must have a valid scene and token ──
      if (!tokenDoc) { console.warn(`${LOG_PREFIX}   ✗ No tokenDoc — skipping`); return; }
      if (!canvas.scene) { console.warn(`${LOG_PREFIX}   ✗ No canvas.scene — skipping`); return; }

      // ── Resolve dead art (with hard fallback chain — tile ALWAYS created) ──
      let deadArtPath = this._resolveDeadArt(actor);
      let fallbackUsed = null;

      if (!deadArtPath) {
        // Fallback 1: the actor's own token image (shows the creature as-is)
        deadArtPath = actor.prototypeToken?.texture?.src
                   ?? tokenDoc.texture?.src
                   ?? actor.img;
        if (deadArtPath) fallbackUsed = "token-image";
      }
      if (!deadArtPath) {
        // Fallback 2: Foundry stock skull icon — absolute last resort
        deadArtPath = "icons/svg/skull.svg";
        fallbackUsed = "skull-icon";
      }

      if (fallbackUsed) {
        const creatureType = actor.system?.details?.type?.value ?? "(none)";
        const availableKeys = [...this._artCache.keys()].filter(k => k.startsWith("dead-")).sort();
        console.log(`${LOG_PREFIX}   • Using fallback "${fallbackUsed}" (no matching dead-art for type="${creatureType}")`);

        // Informational chat notice — NOT an error. Tile IS being created.
        try {
          const availableHtml = availableKeys.length
            ? `<details style="margin-top:4px;"><summary style="cursor:pointer;font-weight:700;font-size:11px;">${availableKeys.length} available dead-art keys</summary><div style="font-family:monospace;font-size:10px;max-height:180px;overflow-y:auto;padding:4px 8px;background:rgba(0,0,0,0.3);border-radius:3px;margin-top:3px;">${availableKeys.join("<br>")}</div></details>`
            : "";
          await ChatMessage.create({
            content: `<div style="background:#1a1a1f;border:1px solid #555;padding:6px 10px;border-radius:4px;color:#aaa;font-size:11px;">
              <div style="color:#d4af37;font-weight:700;margin-bottom:2px;">ℹ ACE QOL — dead-art fallback used</div>
              <div><strong>${foundry.utils.escapeHTML(name)}</strong> (type: ${foundry.utils.escapeHTML(creatureType)}) — using ${fallbackUsed === "token-image" ? "actor's token image" : "generic skull icon"}. Tile created normally.</div>
              <div style="margin-top:3px;">Add <code>Assets/Dead/dead-${foundry.utils.escapeHTML(creatureType)}.png</code> for a proper corpse image.</div>
              ${availableHtml}
            </div>`,
            whisper: [game.user.id],
          });
        } catch (_) {}
      } else {
        console.log(`${LOG_PREFIX}   ✓ Resolved art: ${deadArtPath}`);
      }

      // ── Find an unoccupied grid position (don't stack on existing dead tiles) ──
      const gridSize = canvas.grid?.size ?? 100;
      const tileWidth  = (tokenDoc.width ?? 1) * gridSize;
      const tileHeight = (tokenDoc.height ?? 1) * gridSize;
      const placement = this._findUnoccupiedPosition(tokenDoc.x, tokenDoc.y, tileWidth, tileHeight);
      console.log(`${LOG_PREFIX}   ✓ Placement: (${placement.x},${placement.y})${placement.shifted ? " [shifted to avoid overlap]" : ""}`);

      // ── Step 1: Create the dead tile BEFORE deleting the token ──
      const isVideo = /\.(webm|mp4|m4v|ogv)$/i.test(deadArtPath);

      // Snapshot the actor's lootable items + currency at time of death.
      // Lets players open the loot dialog without needing actor permission
      // (most NPCs are owner-locked to the GM). Snapshot is updated as the
      // GM transfers items / splits gold from the dialog.
      const lootSnapshot = this._buildLootSnapshot(actor);

      const tileData = {
        texture: { src: deadArtPath },
        x:        placement.x,
        y:        placement.y,
        width:    tileWidth,
        height:   tileHeight,
        overhead: false,
        roof:     false,
        hidden:   false,
        locked:   false,
        // Video config — autoplay + loop for .webm/.mp4/.ogv; harmless for images
        video: isVideo ? { loop: true, autoplay: true, volume: 0 } : undefined,
        flags: {
          [MODULE_ID]: {
            isDeadToken:     true,
            originalActorId: actor.id,
            originalTokenId: tokenDoc.id,
            originalName:    actor.name,
            creatureType:    actor.system?.details?.type?.value || "",
            lootable:        true,
            combatLocked:    !!game.combat?.started,
            createdAt:       Date.now(),
            lootSnapshot,
          },
        },
      };

      let created;
      try {
        created = await canvas.scene.createEmbeddedDocuments("Tile", [tileData]);
      } catch (createErr) {
        console.error(`${LOG_PREFIX}   ✗ Tile creation threw:`, createErr);
        try {
          await ChatMessage.create({
            content: `<div style="background:#2a1a0a;border:1px solid #ff6b6b;padding:6px 10px;border-radius:4px;color:#ffa0a0;font-size:12px;">⚠ ACE QOL: Tile creation FAILED for <strong>${name}</strong>: ${createErr?.message ?? createErr}</div>`,
            whisper: [game.user.id],
          });
        } catch (_) {}
        return;
      }

      if (!created?.length) {
        console.warn(`${LOG_PREFIX}   ✗ Failed to create dead tile for "${name}" (no document returned)`);
        return;
      }

      console.log(`${LOG_PREFIX}   ✓ Tile created: ${created[0].id}`);

      // ── Step 2: Remove original token (if setting enabled) ──
      if (game.settings.get(MODULE_ID, "deleteTokenOnDeath")) {
        try {
          await tokenDoc.delete();
          console.log(`${LOG_PREFIX}   ✓ Original token deleted`);
        } catch (delErr) {
          console.warn(`${LOG_PREFIX}   ✗ Token deletion failed:`, delErr);
        }
      } else {
        console.log(`${LOG_PREFIX}   • deleteTokenOnDeath OFF — original token left in place`);
      }

      console.log(`${LOG_PREFIX} ✓ processNPCDeath("${name}") complete`);
    } catch (err) {
      // Death pipeline must NEVER crash the combat flow.
      console.error(`${LOG_PREFIX} ✗ processNPCDeath failed for "${name}":`, err);
    }
  }

  /**
   * Find a grid position near (originX, originY) that's not already occupied by
   * another ace-qol dead tile. Spirals outward up to 5 squares looking for empty.
   * Returns { x, y, shifted } where shifted indicates whether we moved.
   */
  _findUnoccupiedPosition(originX, originY, width, height) {
    if (!canvas.scene) return { x: originX, y: originY, shifted: false };
    const gridSize = canvas.grid?.size ?? 100;
    const existingTiles = canvas.scene.tiles.contents.filter(t =>
      t.flags?.[MODULE_ID]?.isDeadToken);

    const isOccupied = (tx, ty) => {
      for (const t of existingTiles) {
        // Overlap check via bounding boxes
        if (tx + width  <= t.x)         continue;
        if (tx          >= t.x + t.width) continue;
        if (ty + height <= t.y)         continue;
        if (ty          >= t.y + t.height) continue;
        return true; // overlaps
      }
      return false;
    };

    if (!isOccupied(originX, originY)) {
      return { x: originX, y: originY, shifted: false };
    }

    // Spiral search outward (max 5 squares)
    for (let radius = 1; radius <= 5; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const tryX = originX + dx * gridSize;
          const tryY = originY + dy * gridSize;
          if (!isOccupied(tryX, tryY)) {
            return { x: tryX, y: tryY, shifted: true };
          }
        }
      }
    }
    // Couldn't find empty — just stack at origin
    return { x: originX, y: originY, shifted: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Art Resolution — 3-tier matching (synchronous cache lookup)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Synchronous lookup from the art cache. Returns the full file path or null.
   *
   * Matching order:
   *   1. dead-{exactName}          (e.g., dead-goblin-boss)
   *   2. dead-{creatureSubtype}    (e.g., dead-mongrelfolk)
   *   3. dead-{baseName}           ("Goblin (3)" -> dead-goblin)
   *   4. Incorporeal/elemental remnants
   *   5. Type-specific remnants    (ooze, plant)
   *   6. dead-{creatureType}       (e.g., dead-humanoid, dead-beast)
   *   7. dead-generic
   *   8. null (no conversion)
   *
   * @param {Actor} actor - The Foundry Actor document.
   * @returns {string|null} Full file path to dead art image, or null.
   */
  _resolveDeadArt(actor) {
    if (!this._cacheReady || this._artCache.size === 0) return null;

    // ── Normalize the actor name ──
    const rawName = (actor.name ?? "").toLowerCase();
    const normalizedName = rawName
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const creatureType    = (actor.system?.details?.type?.value ?? "").toLowerCase();
    const creatureSubtype = (actor.system?.details?.type?.subtype ?? "").toLowerCase();

    // ── Tier 1: Exact creature name ──
    const exactKey = `dead-${normalizedName}`;
    if (this._artCache.has(exactKey)) {
      return this._artCache.get(exactKey);
    }

    // ── Tier 2a: Creature subtype (check before generic type) ──
    if (creatureSubtype) {
      const subtypeKey = `dead-${creatureSubtype.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
      if (this._artCache.has(subtypeKey)) {
        return this._artCache.get(subtypeKey);
      }
    }

    // ── Tier 2b: Base creature name (strip numbers, parentheses, suffixes) ──
    // "Goblin (3)" → "goblin", "Fire Elemental 2" → "fire-elemental-2" → "fire-elemental"
    const baseName = rawName
      .replace(/\s*\(.*?\)\s*/g, "")   // remove parenthetical like " (3)"
      .replace(/\s*\d+\s*$/g, "")      // remove trailing numbers
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    if (baseName && baseName !== normalizedName) {
      const baseKey = `dead-${baseName}`;
      if (this._artCache.has(baseKey)) {
        return this._artCache.get(baseKey);
      }
    }

    // ── Tier 3a: Incorporeal detection ──
    const isIncorporeal = INCORPOREAL.has(normalizedName)
      || INCORPOREAL.has(baseName)
      || actor.system?.traits?.ci?.value?.has?.("incorporeal")
      || creatureSubtype.includes("incorporeal");

    if (isIncorporeal) {
      const remnantKey = "dead-remnant-ash-pile";
      if (this._artCache.has(remnantKey)) {
        return this._artCache.get(remnantKey);
      }
    }

    // ── Tier 3b: Elemental remnant — check full name first, then subtype ──
    for (const [pattern, remnantStem] of Object.entries(ELEMENTAL_REMNANTS)) {
      if (normalizedName.includes(pattern.replace(/\s+/g, "-")) || rawName.includes(pattern)) {
        if (this._artCache.has(remnantStem)) {
          return this._artCache.get(remnantStem);
        }
      }
    }

    // Also check creature subtype for elemental keywords
    if (creatureSubtype) {
      for (const [pattern, remnantStem] of Object.entries(ELEMENTAL_REMNANTS)) {
        if (creatureSubtype.includes(pattern)) {
          if (this._artCache.has(remnantStem)) {
            return this._artCache.get(remnantStem);
          }
        }
      }
    }

    // ── Tier 3c: Type-specific remnants (ooze, plant) ──
    if (TYPE_REMNANTS[creatureType]) {
      const typeRemnantKey = TYPE_REMNANTS[creatureType];
      if (this._artCache.has(typeRemnantKey)) {
        return this._artCache.get(typeRemnantKey);
      }
    }

    // ── Tier 4: Generic creature type (humanoid, beast, undead, etc.) ──
    if (creatureType) {
      const cleanType = creatureType.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const typeKey = `dead-${cleanType}`;
      if (this._artCache.has(typeKey)) {
        return this._artCache.get(typeKey);
      }

      // ── Tier 4b: Typo-tolerant lookup for common misspellings ──
      // Users frequently save files with spelling variants (abberation vs aberration,
      // monstrosoity vs monstrosity, etc.). Try a few mutations:
      const variants = this._generateTypeVariants(cleanType);
      for (const variant of variants) {
        const variantKey = `dead-${variant}`;
        if (this._artCache.has(variantKey)) {
          console.log(`${LOG_PREFIX}   Typo-match: ${typeKey} → ${variantKey}`);
          return this._artCache.get(variantKey);
        }
      }
    }

    // ── Tier 5: Generic fallback ──
    if (this._artCache.has("dead-generic")) {
      return this._artCache.get("dead-generic");
    }

    // ── Nothing found — skip conversion (log available keys for debugging) ──
    const availableKeys = [...this._artCache.keys()].filter(k => k.startsWith("dead-"));
    console.warn(`${LOG_PREFIX} No match for actor "${actor.name}" (type="${creatureType}"). Available dead-* keys (${availableKeys.length}):`, availableKeys);
    return null;
  }

  /**
   * Generate common typo/variant spellings for a creature type.
   * Example: "aberration" -> ["abberation", "aberation"]
   * Covers letter doubling, letter dropping, and known D&D typos.
   */
  _generateTypeVariants(type) {
    const variants = new Set();

    // Known common typos in D&D creature types
    const knownTypos = {
      "aberration":  ["abberation", "aberation"],
      "abberation":  ["aberration"],
      "monstrosity": ["monstrosoity"],
      "undead":      ["un-dead"],
      "humanoid":    ["human"],
      "celestial":   ["celestrial"],
    };
    if (knownTypos[type]) {
      for (const v of knownTypos[type]) variants.add(v);
    }

    // Letter-doubling: "aberration" -> "abberation"
    for (let i = 1; i < type.length; i++) {
      const doubled = type.slice(0, i) + type[i] + type.slice(i);
      variants.add(doubled);
    }

    // Letter-dropping: "abberation" -> "aberation"
    for (let i = 1; i < type.length - 1; i++) {
      if (type[i] === type[i - 1]) {
        // Dropping one of two consecutive same letters
        variants.add(type.slice(0, i) + type.slice(i + 1));
      }
    }

    variants.delete(type); // don't retry exact
    return [...variants];
  }
}
