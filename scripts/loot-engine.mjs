// ─── ACE: QOL — Loot Generation Engine ─────────────────────────────────────────
// Generates real D&D 5e items from compendiums and adds them to NPC inventories.
// Picks items based on CR tier, creature type, and rarity filters.
// Posts draggable loot cards to GM chat.
//
// Self-contained — no imports from other ace-qol files to avoid circular deps.
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const LOG_PREFIX = `${MODULE_ID} | Loot:`;

// ─── CR Tier Definitions ────────────────────────────────────────────────────
// Each tier defines: gold dice formula, allowed rarities, and item count range.
const CR_TIERS = [
  { maxCR: 4,   gold: "1d6*10",  rarities: ["common", "uncommon"],       items: [1, 2] },
  { maxCR: 10,  gold: "2d6*10",  rarities: ["uncommon", "rare"],         items: [1, 3] },
  { maxCR: 16,  gold: "4d6*10",  rarities: ["rare", "veryRare"],         items: [2, 3] },
  { maxCR: Infinity, gold: "10d6*10", rarities: ["veryRare", "legendary"], items: [2, 4] },
];

// ─── Item types allowed per creature type ───────────────────────────────────
// Beasts carry mundane scraps; undead favor cursed/magic; humanoids get anything.
const CREATURE_TYPE_FILTERS = {
  beast: {
    allowedTypes: ["loot", "tool", "consumable"],
    blockedTypes: ["scroll", "wand", "armor", "rod", "staff"],
    // Beasts might have swallowed gems or herbs — keep mundane items
    description:  "mundane items, herbs, gems",
  },
  undead: {
    allowedTypes: null, // no type whitelist — use blockedTypes instead
    blockedTypes: ["consumable"], // no food/supplies
    description:  "cursed items, scrolls, equipment",
  },
  humanoid: {
    allowedTypes: null,
    blockedTypes: [],
    description:  "any rarity-appropriate gear",
  },
  construct: {
    allowedTypes: ["loot", "tool"],
    blockedTypes: ["consumable", "scroll", "potion"],
    description:  "crafting materials, gems",
  },
};

// ─── Compendium Index Cache ─────────────────────────────────────────────────
// Cache pack indexes for 60 seconds to avoid re-indexing on rapid NPC deaths.
const _indexCache = new Map();
const INDEX_CACHE_TTL = 60_000; // 60 seconds
const INDEX_LOAD_TIMEOUT = 5_000; // 5 seconds per pack

// ──────────────────────────────────────────────────────────────────────────────

export class LootEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  //  Settings Registration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register all loot-engine settings.
   * Call this from the main settings registration (QolSettings.register)
   * or from the init hook.
   */
  static registerSettings() {
    try {
      const s = (key, opts) => game.settings.register(MODULE_ID, key, opts);

      s("enableLootGeneration", {
        name:    "Enable Loot Generation",
        hint:    "Master toggle for automatic loot generation on NPC bio creation and death.",
        scope:   "world",
        config:  true,
        type:    Boolean,
        default: true,
      });

      s("lootOnBio", {
        name:    "Loot on Bio Generation",
        hint:    "Add loot to NPC inventory when AI generates their bio/description.",
        scope:   "world",
        config:  true,
        type:    Boolean,
        default: true,
      });

      s("lootOnDeath", {
        name:    "Loot on NPC Death",
        hint:    "Generate a loot card and add items to inventory when an NPC drops to 0 HP.",
        scope:   "world",
        config:  true,
        type:    Boolean,
        default: true,
      });

      s("minCRForLoot", {
        name:    "Minimum CR for Loot",
        hint:    "NPCs below this CR will not generate loot. Set to 0 to loot everything.",
        scope:   "world",
        config:  true,
        type:    Number,
        default: 0.25,
        range:   { min: 0, max: 5, step: 0.25 },
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
   * Expose loot engine methods on `game.aceQol.LootEngine`.
   * Call this during the "ready" hook after game.aceQol is initialized.
   */
  static registerAPI() {
    try {
      if (!game.aceQol) game.aceQol = {};
      const engine = new LootEngine();
      game.aceQol.LootEngine = {
        generateLoot:   engine.generateLoot.bind(engine),
        postLootCard:   engine.postLootCard.bind(engine),
      };
      console.log(`${LOG_PREFIX} API registered on game.aceQol.LootEngine`);
    } catch (err) {
      console.error(`${LOG_PREFIX} API registration failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Generate Loot
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate loot for an NPC actor: gold + compendium items, added to inventory.
   *
   * @param {Actor} actor - Foundry Actor document (should be type "npc")
   * @param {object} [options={}]
   * @param {number} [options.cr]           - Override CR (defaults to actor's CR)
   * @param {string} [options.creatureType] - Override creature type (defaults to actor's type)
   * @returns {Promise<{gold: number, items: Array<{name: string, img: string, uuid: string, type: string, rarity: string}>, actor: string}|null>}
   */
  async generateLoot(actor, options = {}) {
    try {
      if (!actor) {
        console.warn(`${LOG_PREFIX} generateLoot called with no actor`);
        return null;
      }

      // ── Resolve CR and creature type ──
      const cr = options.cr ?? actor.system?.details?.cr ?? 0;
      const creatureType = options.creatureType
        ?? actor.system?.details?.type?.value
        ?? "humanoid";

      // ── Check minimum CR setting ──
      try {
        const minCR = game.settings.get(MODULE_ID, "minCRForLoot") ?? 0;
        if (cr < minCR) {
          console.log(`${LOG_PREFIX} ${actor.name} CR ${cr} below minimum ${minCR}, skipping`);
          return null;
        }
      } catch { /* setting not registered yet — proceed */ }

      console.log(`${LOG_PREFIX} Generating loot for ${actor.name} (CR ${cr}, ${creatureType})`);

      // ── Determine tier from CR ──
      const tier = this._getTier(cr);

      // ── Roll gold ──
      const goldAmount = await this._rollGold(tier.gold);

      // ── Find compendium items matching tier + creature type ──
      const candidateItems = await this._searchCompendiums(tier.rarities, creatureType);

      // ── Pick random items from the pool ──
      const [minItems, maxItems] = tier.items;
      const itemCount = Math.floor(Math.random() * (maxItems - minItems + 1)) + minItems;
      const pickedEntries = this._pickRandom(candidateItems, itemCount);

      // ── Load full item documents from compendiums ──
      const fullItems = await this._loadFullItems(pickedEntries);

      // ── Add gold to actor's currency ──
      const existingGold = actor.system?.currency?.gp ?? 0;
      await actor.update({ "system.currency.gp": existingGold + goldAmount });
      console.log(`${LOG_PREFIX} Added ${goldAmount} gp to ${actor.name} (was ${existingGold})`);

      // ── Create items on the actor ──
      const itemDataArray = fullItems.map(item => item.toObject());
      let createdItems = [];
      if (itemDataArray.length > 0) {
        createdItems = await actor.createEmbeddedDocuments("Item", itemDataArray);
        console.log(`${LOG_PREFIX} Added ${createdItems.length} items to ${actor.name}`);
      }

      // ── Build result ──
      const result = {
        gold: goldAmount,
        items: createdItems.map(item => ({
          name:   item.name,
          img:    item.img,
          uuid:   item.uuid,
          type:   item.type,
          rarity: item.system?.rarity ?? "common",
        })),
        actor: actor.name,
      };

      console.log(`${LOG_PREFIX} Loot generated for ${actor.name}:`,
        `${goldAmount} gp, ${createdItems.length} items`);

      return result;

    } catch (err) {
      console.error(`${LOG_PREFIX} generateLoot failed for ${actor?.name}:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post Loot Card
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a chat card showing the loot breakdown. Items are @UUID links
   * that Foundry automatically makes draggable.
   *
   * @param {object} lootData - Output from generateLoot()
   * @param {object} [options={}]
   * @param {boolean} [options.whisper=true] - Whisper to GM only
   * @returns {Promise<ChatMessage|null>}
   */
  async postLootCard(lootData, options = {}) {
    try {
      if (!lootData) {
        console.warn(`${LOG_PREFIX} postLootCard called with no data`);
        return null;
      }

      const whisper = options.whisper !== false;
      const creatureName = lootData.actor ?? "Unknown";
      const goldAmount = lootData.gold ?? 0;
      const items = lootData.items ?? [];

      // ── Build item list HTML ──
      let itemListHTML = "";
      if (items.length > 0) {
        const itemLines = items.map(item => {
          const rarityLabel = this._formatRarity(item.rarity);
          // @UUID links are automatically drag-and-drop in Foundry
          return `<li>@UUID[${item.uuid}]{${item.name}} <span class="ace-qol-loot-rarity">(${rarityLabel})</span></li>`;
        });
        itemListHTML = `<ul class="ace-qol-loot-items">${itemLines.join("\n")}</ul>`;
      } else {
        itemListHTML = `<p class="ace-qol-loot-none"><em>No items found</em></p>`;
      }

      // ── Assemble the card ──
      const content = `
<div class="ace-qol-loot-card">
  <h3>\u{1FA99} Loot \u2014 ${creatureName}</h3>
  <p class="ace-qol-loot-gold">${goldAmount} gp</p>
  ${itemListHTML}
</div>`.trim();

      // ── Create the chat message ──
      const messageData = {
        content,
        speaker: ChatMessage.getSpeaker({ alias: "ACE Loot" }),
      };

      if (whisper) {
        messageData.whisper = [game.user.id];
      }

      const message = await ChatMessage.create(messageData);
      console.log(`${LOG_PREFIX} Loot card posted for ${creatureName}`);
      return message;

    } catch (err) {
      console.error(`${LOG_PREFIX} postLootCard failed:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Check and Generate on Death
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called when an NPC drops to 0 HP. Checks if the actor already has
   * real loot items (beyond natural weapons/features). If not, generates
   * new loot and posts a card. If loot exists, just posts a card.
   *
   * @param {Actor} actor - The NPC actor that just died
   * @returns {Promise<object|null>} The loot data
   */
  async checkAndGenerateOnDeath(actor) {
    try {
      if (!actor) return null;

      // ── Check master toggle ──
      try {
        if (!game.settings.get(MODULE_ID, "enableLootGeneration")) return null;
        if (!game.settings.get(MODULE_ID, "lootOnDeath")) return null;
      } catch { /* settings not registered — proceed */ }

      console.log(`${LOG_PREFIX} Checking loot for dead NPC: ${actor.name}`);

      // ── Check if actor already has real loot items ──
      const existingLoot = this._getExistingLootItems(actor);

      let lootData;

      if (existingLoot.length > 0) {
        // Actor already has loot — build card from existing inventory
        console.log(`${LOG_PREFIX} ${actor.name} already has ${existingLoot.length} loot items`);
        lootData = {
          gold:  actor.system?.currency?.gp ?? 0,
          items: existingLoot.map(item => ({
            name:   item.name,
            img:    item.img,
            uuid:   item.uuid,
            type:   item.type,
            rarity: item.system?.rarity ?? "common",
          })),
          actor: actor.name,
        };
      } else {
        // No loot — generate fresh
        lootData = await this.generateLoot(actor);
      }

      if (lootData) {
        await this.postLootCard(lootData);
      }

      return lootData;

    } catch (err) {
      console.error(`${LOG_PREFIX} checkAndGenerateOnDeath failed for ${actor?.name}:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Determine which CR tier applies.
   * @param {number} cr
   * @returns {object} Tier definition { maxCR, gold, rarities, items }
   */
  _getTier(cr) {
    for (const tier of CR_TIERS) {
      if (cr <= tier.maxCR) return tier;
    }
    // Fallback to highest tier (shouldn't happen due to Infinity)
    return CR_TIERS[CR_TIERS.length - 1];
  }

  /**
   * Roll gold using Foundry's Roll API.
   * @param {string} formula - Dice formula (e.g., "2d6*10")
   * @returns {Promise<number>}
   */
  async _rollGold(formula) {
    try {
      const roll = new Roll(formula);
      await roll.evaluate();
      return roll.total ?? 0;
    } catch (err) {
      console.error(`${LOG_PREFIX} Gold roll failed for "${formula}":`, err);
      // Fallback: return a flat amount based on the formula string
      return 10;
    }
  }

  /**
   * Search all Item compendiums for entries matching the rarity filter
   * and creature type constraints. Prefers DDB (D&D Beyond) packs.
   *
   * @param {string[]} rarities       - Allowed rarity values (e.g., ["uncommon", "rare"])
   * @param {string}   creatureType   - Creature type for filtering (e.g., "beast")
   * @returns {Promise<Array<{pack: CompendiumCollection, entry: object}>>}
   */
  async _searchCompendiums(rarities, creatureType) {
    const candidates = [];

    // ── Get all Item compendiums, prefer DDB packs ──
    const allPacks = game.packs.filter(p => p.documentName === "Item");

    // Sort: DDB packs first (more likely to have well-tagged items)
    const sortedPacks = allPacks.sort((a, b) => {
      const aDDB = a.metadata.id?.includes("ddb") || a.metadata.label?.toLowerCase().includes("ddb") ? 0 : 1;
      const bDDB = b.metadata.id?.includes("ddb") || b.metadata.label?.toLowerCase().includes("ddb") ? 0 : 1;
      return aDDB - bDDB;
    });

    // ── Normalize rarity strings ──
    // Foundry/DDB may store rarity as "common", "uncommon", "rare", "veryRare", "legendary"
    // or as "Very Rare" etc. Build a flexible match set.
    const raritySet = new Set();
    for (const r of rarities) {
      raritySet.add(r);
      raritySet.add(r.toLowerCase());
      // Handle "veryRare" vs "very rare" vs "Very Rare"
      if (r === "veryRare") {
        raritySet.add("very rare");
        raritySet.add("Very Rare");
        raritySet.add("veryrare");
      }
    }

    // ── Get creature type filter rules ──
    const typeFilter = CREATURE_TYPE_FILTERS[creatureType] ?? CREATURE_TYPE_FILTERS.humanoid;

    // ── Search each pack ──
    for (const pack of sortedPacks) {
      try {
        const index = await this._getCachedIndex(pack);
        if (!index) continue;

        for (const entry of index) {
          // ── Rarity check ──
          const entryRarity = entry.system?.rarity ?? entry.rarity ?? "";
          const normalizedRarity = String(entryRarity).toLowerCase().replace(/\s+/g, "");
          const matchesRarity = raritySet.has(entryRarity)
            || raritySet.has(normalizedRarity)
            || raritySet.has(entryRarity.toLowerCase());

          if (!matchesRarity) continue;

          // ── Type filter (creature type constraints) ──
          const itemType = entry.type ?? "";

          if (typeFilter.allowedTypes) {
            // Whitelist mode: only these types
            if (!typeFilter.allowedTypes.includes(itemType)) continue;
          }

          if (typeFilter.blockedTypes && typeFilter.blockedTypes.length > 0) {
            // Blacklist mode: skip these types
            if (typeFilter.blockedTypes.includes(itemType)) continue;
          }

          // ── Skip items with no name (bad data) ──
          if (!entry.name || entry.name.startsWith("#")) continue;

          candidates.push({ pack, entry });
        }

      } catch (err) {
        console.warn(`${LOG_PREFIX} Error indexing pack ${pack.metadata.label}:`, err);
        continue;
      }
    }

    console.log(`${LOG_PREFIX} Found ${candidates.length} candidate items ` +
      `(rarities: [${rarities.join(", ")}], type: ${creatureType})`);

    return candidates;
  }

  /**
   * Get a compendium pack's index, using the cache if fresh.
   * Times out after INDEX_LOAD_TIMEOUT ms to avoid hanging on slow packs.
   *
   * @param {CompendiumCollection} pack
   * @returns {Promise<Collection|null>}
   */
  async _getCachedIndex(pack) {
    const cacheKey = pack.metadata.id ?? pack.collection;
    const cached = _indexCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < INDEX_CACHE_TTL)) {
      return cached.index;
    }

    // ── Load with timeout ──
    try {
      const indexPromise = pack.getIndex({
        fields: ["system.rarity", "type", "system.price", "img"],
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Index load timeout")), INDEX_LOAD_TIMEOUT)
      );

      const index = await Promise.race([indexPromise, timeoutPromise]);

      _indexCache.set(cacheKey, { index, timestamp: Date.now() });
      return index;

    } catch (err) {
      console.warn(`${LOG_PREFIX} Index load failed/timed out for ${pack.metadata.label}:`, err.message);
      return null;
    }
  }

  /**
   * Pick N random unique entries from a candidate array.
   * Uses Fisher-Yates partial shuffle for efficiency.
   *
   * @param {Array} candidates - Array of { pack, entry } objects
   * @param {number} count     - How many to pick
   * @returns {Array}
   */
  _pickRandom(candidates, count) {
    if (candidates.length === 0) return [];
    const n = Math.min(count, candidates.length);

    // Partial Fisher-Yates shuffle (only shuffle the last n elements)
    const arr = [...candidates];
    for (let i = arr.length - 1; i >= arr.length - n && i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    return arr.slice(arr.length - n);
  }

  /**
   * Load full Item documents from compendium packs.
   *
   * @param {Array<{pack: CompendiumCollection, entry: object}>} pickedEntries
   * @returns {Promise<Item[]>}
   */
  async _loadFullItems(pickedEntries) {
    const items = [];

    for (const { pack, entry } of pickedEntries) {
      try {
        const doc = await pack.getDocument(entry._id);
        if (doc) items.push(doc);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to load item "${entry.name}" from ${pack.metadata.label}:`, err);
      }
    }

    return items;
  }

  /**
   * Get existing loot-worthy items from an actor's inventory.
   * Filters out natural weapons, racial features, and class features
   * which are not "real" loot.
   *
   * @param {Actor} actor
   * @returns {Item[]}
   */
  _getExistingLootItems(actor) {
    if (!actor?.items) return [];

    // Item types that count as real loot
    const lootTypes = new Set([
      "weapon", "equipment", "consumable", "tool",
      "loot", "backpack", "scroll", "wand", "rod", "staff",
    ]);

    // Item types that are never loot
    const ignoredTypes = new Set([
      "feat", "class", "subclass", "race", "background", "spell",
    ]);

    return actor.items.filter(item => {
      const type = item.type ?? "";

      // Skip class/racial features
      if (ignoredTypes.has(type)) return false;

      // Must be a loot-like type
      if (!lootTypes.has(type)) return false;

      // Skip "Natural Weapon" style items (e.g., Bite, Claw, Slam)
      const weaponType = item.system?.type?.value ?? item.system?.weaponType ?? "";
      if (weaponType === "natural") return false;

      // Skip items flagged as part of the creature's body
      const attunement = item.system?.attunement;
      const isNaturalAction = item.system?.activation?.type === "action"
        && !item.system?.price?.value
        && item.system?.type?.value === "natural";
      if (isNaturalAction) return false;

      return true;
    });
  }

  /**
   * Format a rarity value for display.
   * Turns "veryRare" into "Very Rare", etc.
   *
   * @param {string} rarity
   * @returns {string}
   */
  _formatRarity(rarity) {
    if (!rarity) return "Common";

    // Handle camelCase like "veryRare"
    const spaced = rarity.replace(/([a-z])([A-Z])/g, "$1 $2");

    // Capitalize first letter of each word
    return spaced
      .split(" ")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Cache Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Clear the compendium index cache. Useful if packs are updated mid-session.
   */
  static clearCache() {
    _indexCache.clear();
    console.log(`${LOG_PREFIX} Compendium index cache cleared`);
  }
}
