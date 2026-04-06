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
        config:  true,
        type:    Boolean,
        default: true,
      });

      s("deleteTokenOnDeath", {
        name:    "Remove Token After Creating Dead Tile",
        hint:    "Delete the original token once the dead-art tile has been placed. Disable to keep both.",
        scope:   "world",
        config:  true,
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
      .replace(/\.(png|webp|jpg|jpeg|gif|svg)$/i, "")
      .toLowerCase();

    // Don't overwrite — first match wins (root beats subfolder).
    if (!this._artCache.has(stem)) {
      this._artCache.set(stem, filePath);
    }
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
    try {
      // ── Guard: setting enabled? ──
      if (!game.settings.get(MODULE_ID, "enableDeathPipeline")) return;

      // ── Guard: NPC only, not player-owned ──
      if (!actor || actor.type !== "npc" || actor.hasPlayerOwner) return;

      // ── Guard: must have a valid scene and token ──
      if (!tokenDoc || !canvas.scene) return;

      // ── Resolve dead art ──
      const deadArtPath = this._resolveDeadArt(actor);
      if (!deadArtPath) {
        console.log(`${LOG_PREFIX} No dead art found for "${actor.name}" — skipping tile conversion`);
        return;
      }

      // ── Step 1: Create the dead tile BEFORE deleting the token ──
      const gridSize = canvas.grid?.size ?? 100;
      const tileData = {
        texture: { src: deadArtPath },
        x:        tokenDoc.x,
        y:        tokenDoc.y,
        width:    (tokenDoc.width ?? 1) * gridSize,
        height:   (tokenDoc.height ?? 1) * gridSize,
        overhead: false,
        roof:     false,
        hidden:   false,
        locked:   false,
        flags: {
          [MODULE_ID]: {
            isDeadToken:     true,
            originalActorId: actor.id,
            originalTokenId: tokenDoc.id,
            originalName:    actor.name,
            creatureType:    actor.system?.details?.type?.value || "",
            lootable:        true,
          },
        },
      };

      const created = await canvas.scene.createEmbeddedDocuments("Tile", [tileData]);
      if (!created?.length) {
        console.warn(`${LOG_PREFIX} Failed to create dead tile for "${actor.name}"`);
        return;
      }

      console.log(`${LOG_PREFIX} ${actor.name} -> tile (${deadArtPath})`);

      // ── Step 2: Remove original token (if setting enabled) ──
      if (game.settings.get(MODULE_ID, "deleteTokenOnDeath")) {
        try {
          await tokenDoc.delete();
          console.log(`${LOG_PREFIX} Token deleted for "${actor.name}"`);
        } catch (delErr) {
          console.warn(`${LOG_PREFIX} Token deletion failed for "${actor.name}":`, delErr);
        }
      }

    } catch (err) {
      // Death pipeline must NEVER crash the combat flow.
      console.error(`${LOG_PREFIX} processNPCDeath failed for "${actor?.name ?? "unknown"}":`, err);
    }
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
      const typeKey = `dead-${creatureType.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
      if (this._artCache.has(typeKey)) {
        return this._artCache.get(typeKey);
      }
    }

    // ── Tier 5: Generic fallback ──
    if (this._artCache.has("dead-generic")) {
      return this._artCache.get("dead-generic");
    }

    // ── Nothing found — skip conversion ──
    return null;
  }
}
