// ─── ACE: QOL — Loot Generation Engine ─────────────────────────────────────────
// Generates real D&D 5e items from compendiums and adds them to NPC inventories.
// Picks items based on CR tier, creature type, and rarity filters.
// Posts draggable loot cards to GM chat.
//
// Near-self-contained — the ONLY import is loot-framing.mjs, a leaf module
// that imports nothing itself, so there is no cycle to create.
// ──────────────────────────────────────────────────────────────────────────────

import { lootFraming, readCreatureType } from "./loot-framing.mjs";

const MODULE_ID = "ace-qol";
const LOG_PREFIX = `${MODULE_ID} | Loot:`;

// Split-gold re-entry guard (punch-list #3: the same monster's gold split 3×).
// The flag write lands AFTER the slow per-PC currency updates; a card
// re-render in that window (an item gets looted → message.update → fresh
// button reading stale flags) allowed a second click. Message ids in here
// are mid-split — every entry path checks it.
const _splitsInFlight = new Set();

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
        config:  false,
        type:    Boolean,
        default: true,
      });

      s("lootOnBio", {
        name:    "Loot on Bio Generation",
        hint:    "Add loot to NPC inventory when AI generates their bio/description.",
        scope:   "world",
        config:  false,
        type:    Boolean,
        default: true,
      });

      s("beastsCarryLoot", {
        name:    "Beasts Carry Loot",
        hint:    "OFF (default): beasts — wolves, goats, bears, etc. — drop NO loot (no coins, potions, or gear). ON: beasts can carry mundane 'swallowed' items. Off matches how animals actually work at the table.",
        scope:   "world",
        config:  false,   // surfaced via the ACE config panel (Loot tab), not native settings
        type:    Boolean,
        default: false,
      });

      s("lootOnDeath", {
        name:    "Loot on NPC Death",
        hint:    "Generate a loot card and add items to inventory when an NPC drops to 0 HP.",
        scope:   "world",
        config:  false,
        type:    Boolean,
        default: true,
      });

      s("minCRForLoot", {
        name:    "Minimum CR for Loot",
        hint:    "NPCs below this CR will not generate loot. Set to 0 to loot everything.",
        scope:   "world",
        config:  false,
        type:    Number,
        default: 0.25,
        range:   { min: 0, max: 5, step: 0.25 },
      });

      s("maxTotalLoot", {
        name:    "Max Total Loot Items per Creature",
        hint:    "Hard cap on the COMBINED loot a creature carries from BOTH systems — the AI 'pocket-loot' flavor items (bread rolls, letters, keepsakes) AND the real compendium items (potions, gear). The flavor loot fills first; the compendium engine only tops up to this cap, so you get a little flavor plus the occasional real item instead of a 4-item pile. Default 3.",
        scope:   "world",
        config:  false,
        type:    Number,
        default: 3,
        range:   { min: 1, max: 8, step: 1 },
      });

      s("lootCardPublic", {
        name:    "Show Loot Cards to All Players",
        hint:    "When enabled, loot cards are visible to all players (not just GM). Players can drag items from the card to their character sheets.",
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
   * Expose loot engine methods on `game.aceQol.LootEngine`.
   * Call this during the "ready" hook after game.aceQol is initialized.
   */
  /**
   * Expose loot engine methods on `game.aceQol.LootEngine`.
   * Call this during the "ready" hook after game.aceQol is initialized.
   * @param {LootEngine} [instance] - Optional pre-created instance to use
   */
  static registerAPI(instance) {
    try {
      if (!game.aceQol) game.aceQol = {};
      const engine = instance ?? new LootEngine();
      // NOTE on game.aceQol.LootEngine: ace-qol.mjs's main bulk-init
      // (`game.aceQol = { ..., LootEngine, lootEngine, ... }`) runs in the
      // same ready hook AFTER us and reassigns `game.aceQol.LootEngine` to
      // the CLASS itself (no instance methods). The bulk init also exposes
      // the instance as `game.aceQol.lootEngine` (lowercase). All internal
      // callers should use the instance — it carries every public method
      // natively and survives the bulk assignment. The convenience API
      // object below is published for backward-compat only; the keys it
      // exports may not survive the bulk init depending on call order.
      const api = {
        generateLoot:        engine.generateLoot.bind(engine),
        postLootCard:        engine.postLootCard.bind(engine),
        postPublicLootCard:  engine.postPublicLootCard.bind(engine),
        handleItemLooted:    engine.handleItemLooted.bind(engine),
        syncCardForActor:    engine.syncCardForActor.bind(engine),
        spawnTileFromCard:   engine.spawnTileFromCard.bind(engine),
        postCardFromTile:    engine.postCardFromTile.bind(engine),
      };
      game.aceQol.LootEngine = api;
      // Also publish under a stable name that the bulk init won't stomp,
      // so external callers have a reliable handle.
      game.aceQol.lootEngineAPI = api;
      console.log(`${LOG_PREFIX} API registered (game.aceQol.lootEngineAPI for stable access; instance methods at game.aceQol.lootEngine.*)`);
    } catch (err) {
      console.error(`${LOG_PREFIX} API registration failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat Card Sync — keep the "ACE Loot — <Creature>" card aligned with the
  //  state of the dead-body / container tile after the GM adds or removes
  //  items via the loot dialog.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find and update the public loot card matching an actorId, then rebuild
   * its content from the updated state. Used by the loot dialog (lootable-
   * tile.mjs) when the GM adds or removes items / changes currency on a
   * corpse, so the chat log doesn't show stale data.
   *
   * @param {string} actorId            - The original actor id (matches flags.actorId on the loot card)
   * @param {object} change             - What changed:
   * @param {object} [change.addItem]   - Append: { name, img, uuid, type, rarity }
   * @param {string} [change.removeByName] - Mark first un-removed entry with this name as "removed by GM"
   * @param {string} [change.removeByUuid] - Mark first un-removed entry with this UUID as "removed by GM"
   * @param {object} [change.currency]  - Patch currency: { pp, gp, ep, sp, cp } (any subset)
   * @returns {Promise<boolean>}  true if a card was found and updated
   */
  async syncCardForActor(actorId, change = {}) {
    try {
      if (!actorId || !change) return false;
      // Find the most recent (non-fully-looted) loot card for this actor.
      const msgs = game.messages?.contents ?? [];
      const msg = [...msgs].reverse().find(m =>
        m.flags?.[MODULE_ID]?.type === "lootCard" &&
        m.flags?.[MODULE_ID]?.actorId === actorId
      );
      if (!msg) return false;

      const flags = foundry.utils.deepClone(msg.flags[MODULE_ID]);
      flags.items = Array.isArray(flags.items) ? flags.items : [];
      let touched = false;

      // Removal — mark the matching entry as looted with a "removed by GM" tag.
      // The renderer already strikes through looted items, so this gives a
      // visible audit trail without destroying the original list ordering.
      if (change.removeByUuid || change.removeByName) {
        for (const it of flags.items) {
          if (it.looted) continue;
          const matches = (change.removeByUuid && it.uuid === change.removeByUuid)
                       || (change.removeByName && it.name === change.removeByName);
          if (matches) {
            it.looted   = true;
            it.lootedBy = "removed by GM";
            touched = true;
            break;
          }
        }
      }

      // Addition — append a fresh entry. Index = next array position.
      if (change.addItem) {
        flags.items.push({
          name:     change.addItem.name ?? "Unknown",
          img:      change.addItem.img ?? "icons/svg/item-bag.svg",
          uuid:     change.addItem.uuid ?? "",
          type:     change.addItem.type ?? "loot",
          rarity:   change.addItem.rarity ?? "common",
          index:    flags.items.length,
          looted:   false,
          lootedBy: null,
        });
        touched = true;
      }

      // Currency patch
      if (change.currency) {
        flags.currency = { ...(flags.currency ?? {}), ...change.currency };
        touched = true;
      }

      if (!touched) return false;

      // Rebuild the visible card content from the updated flags so the chat
      // log reflects reality. Strikethrough on removed items, new entries
      // appended, currency block regenerated.
      const newContent = this._buildLootCardContent(flags);

      await msg.update({
        [`flags.${MODULE_ID}.items`]:    flags.items,
        [`flags.${MODULE_ID}.currency`]: flags.currency,
        content: newContent,
      });

      // Re-evaluate fully-looted state (e.g. after a delete the card might
      // now be entirely struck through → collapse it).
      try { await this._checkFullyLooted(msg); } catch (_) {}

      return true;
    } catch (err) {
      console.error(`${LOG_PREFIX} syncCardForActor failed:`, err);
      return false;
    }
  }

  /**
   * Recreate a loot tile on the current scene from a chat card's flags.
   * Use case: the dead-body tile was accidentally deleted (or the corpse
   * never had one) but the ACE Loot card still exists in chat. GM clicks
   * the "Spawn Tile" button on the card; this rebuilds a container tile
   * at scene center carrying the same items + currency. The tile uses
   * the chest icon (we don't have the original dead-body art to restore).
   *
   * @param {ChatMessage} message  The lootCard ChatMessage
   * @returns {Promise<TileDocument|null>}
   */
  async spawnTileFromCard(message) {
    try {
      if (!message || !game.user.isGM) return null;
      const flags = message.flags?.[MODULE_ID];
      if (flags?.type !== "lootCard") {
        ui.notifications.warn("ACE QOL: Not a loot card.");
        return null;
      }
      const scene = canvas?.scene;
      if (!scene) {
        ui.notifications.error("ACE QOL: No active scene to spawn the tile on.");
        return null;
      }

      // Filter out items already marked looted — those are gone, no point
      // recreating them. Currency: respect currencySplit so we don't dump
      // gold the party already received.
      const liveItems = (flags.items ?? []).filter(it => !it.looted);
      const containerItems = liveItems.map(it => ({
        id:     foundry.utils.randomID(),
        name:   it.name,
        img:    it.img ?? "icons/svg/item-bag.svg",
        uuid:   it.uuid ?? null,
        type:   it.type ?? "loot",
        rarity: it.rarity ?? "common",
      }));
      const currency = flags.currencySplit
        ? { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }
        : (flags.currency ?? { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 });

      // Tile at scene center, 2 grid squares
      const gridSize = scene.grid?.size ?? 100;
      const tileSize = gridSize * 2;
      const cx = scene.width  / 2;
      const cy = scene.height / 2;
      const containerName = flags.actorName
        ? `${flags.actorName}'s Loot`
        : "Recovered Loot";

      // Chest texture: prefer our bundled dark-wood chest icon over the
      // default Foundry SVG (abstract line-art). URL-encoded for the
      // space in "Treasure Chest". File path is case-sensitive on web
      // serving even on Windows.
      const chestSrc = "modules/ace-qol/Assets/UI/CLOSED-Treasure%20Chest.webp";

      const [created] = await scene.createEmbeddedDocuments("Tile", [{
        x: Math.round(cx - tileSize / 2),
        y: Math.round(cy - tileSize / 2),
        width:  tileSize,
        height: tileSize,
        texture: { src: chestSrc },
        flags: {
          "ace-suite": {
            containerTile: true,
            containerName,
            containerLoot: { items: containerItems, currency },
          },
          [MODULE_ID]: {
            // Link the spawned tile back to the original actor so future
            // sync operations (add/delete) can still find this chat card.
            // We DON'T set isDeadToken — this is a recovered loot pile,
            // not a freshly-killed body — but originalActorId still lets
            // the sync helper match cards by actor id.
            originalActorId: flags.actorId ?? null,
            originalName: flags.actorName ?? "Recovered Loot",
          },
        },
      }]);

      ui.notifications.info(`ACE QOL: Spawned "${containerName}" tile at scene center. Drag to relocate.`);
      // Pan to the new tile so the GM can see where it landed
      try {
        await canvas.animatePan({ x: cx, y: cy, scale: 1.0, duration: 600 });
      } catch (_) {}
      return created;
    } catch (err) {
      console.error(`${LOG_PREFIX} spawnTileFromCard failed:`, err);
      ui.notifications.error("ACE QOL: Couldn't spawn tile from card — see console.");
      return null;
    }
  }

  /**
   * Repost a fresh "ACE Loot — <Name>" chat card from a tile's current
   * loot data. Use case: the original card was accidentally deleted but
   * the tile (corpse OR container) still has all the items. GM clicks
   * "Repost Loot Card" in the loot dialog.
   *
   * @param {object} src              Pre-resolved source payload from the loot dialog:
   *                                  { displayName, actorId, actorImg, items: [...], currency: {...} }
   * @returns {Promise<ChatMessage|null>}
   */
  async postCardFromTile(src) {
    try {
      if (!src || !game.user.isGM) return null;
      const itemsArray = (src.items ?? []).map((it, idx) => ({
        name:     it.name ?? "Unknown",
        img:      it.img ?? "icons/svg/item-bag.svg",
        uuid:     it.uuid ?? "",
        type:     it.type ?? "loot",
        rarity:   it.rarity ?? "common",
        index:    idx,
        looted:   false,
        lootedBy: null,
      }));
      const currency = {
        pp: src.currency?.pp ?? 0,
        gp: src.currency?.gp ?? 0,
        ep: src.currency?.ep ?? 0,
        sp: src.currency?.sp ?? 0,
        cp: src.currency?.cp ?? 0,
      };
      const flagsPayload = {
        type:          "lootCard",
        actorId:       src.actorId ?? null,
        actorName:     src.displayName ?? "Recovered Loot",
        actorImg:      src.actorImg ?? "icons/svg/skull.svg",
        creatureType:  src.creatureType ?? "",
        items:         itemsArray,
        currency,
        currencySplit: false,
        splitReceipt:  null,
        fullyLooted:   false,
      };

      const content = this._buildLootCardContent(flagsPayload);
      const messageData = {
        content,
        speaker: ChatMessage.getSpeaker({ alias: "ACE Loot" }),
        flags: { [MODULE_ID]: flagsPayload },
      };
      try {
        const isPublic = game.settings.get(MODULE_ID, "lootCardPublic") ?? true;
        if (!isPublic) messageData.whisper = [game.user.id];
      } catch (_) {}

      const message = await ChatMessage.create(messageData);
      ui.notifications.info(`ACE QOL: Posted loot card for "${flagsPayload.actorName}".`);
      return message;
    } catch (err) {
      console.error(`${LOG_PREFIX} postCardFromTile failed:`, err);
      ui.notifications.error("ACE QOL: Couldn't post loot card — see console.");
      return null;
    }
  }

  /**
   * Build the public loot card HTML from a flags payload. Mirrors the
   * structure produced inline by postPublicLootCard so sync edits look
   * identical to the original card. Items already flagged as looted get
   * the strikethrough class up-front.
   *
   * @param {object} flags  - The ace-qol flags payload (actorId, actorName, actorImg, items, currency)
   * @returns {string}      - Card HTML for ChatMessage content
   */
  _buildLootCardContent(flags) {
    const actorId   = flags.actorId ?? "";
    const actorName = flags.actorName ?? "Unknown";
    const actorImg  = flags.actorImg ?? "icons/svg/skull.svg";
    // Framing — a golem is salvaged, not looted. Falls back to the ordinary
    // "Loot" wording whenever the type is absent, so cards posted before this
    // shipped keep rendering exactly as they did. (2026-08-08)
    const framing   = lootFraming(flags.creatureType ?? "");
    const items     = flags.items ?? [];
    const currency  = flags.currency ?? {};
    const hasCurrency = ((currency.pp ?? 0) + (currency.gp ?? 0) + (currency.ep ?? 0)
                       + (currency.sp ?? 0) + (currency.cp ?? 0)) > 0;

    let currencyHTML = "";
    if (hasCurrency) {
      const coins = [];
      if (currency.pp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-pp">${currency.pp} pp</span>`);
      if (currency.gp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-gp">${currency.gp} gp</span>`);
      if (currency.ep > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-ep">${currency.ep} ep</span>`);
      if (currency.sp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-sp">${currency.sp} sp</span>`);
      if (currency.cp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-cp">${currency.cp} cp</span>`);
      currencyHTML = `<div class="ace-qol-loot-currency">${coins.join(" ")}</div>`;
    }

    let itemListHTML = "";
    if (items.length > 0) {
      const lines = items.map((item, idx) => {
        const rarityLabel = this._formatRarity(item.rarity);
        const lootedCls = item.looted ? " ace-qol-loot-item-looted" : "";
        const lootedTag = item.looted
          ? `<span class="ace-qol-loot-looted-by"> → ${item.lootedBy ?? "looted"}</span>`
          : "";
        const linkOrName = item.uuid
          ? `@UUID[${item.uuid}]{${item.name}}`
          : foundry.utils.escapeHTML(item.name);
        return `<li class="ace-qol-loot-item${lootedCls}" data-item-uuid="${item.uuid ?? ""}" data-item-index="${idx}">` +
          `<img src="${item.img}" class="ace-qol-loot-item-img" style="width:24px;height:24px;border:0;" ` +
          `onerror="this.onerror=null;this.src='icons/svg/item-bag.svg';">` +
          ` ${linkOrName}` +
          ` <span class="ace-qol-loot-rarity">(${rarityLabel})</span>` +
          lootedTag +
          `</li>`;
      });
      itemListHTML = `<ul class="ace-qol-loot-items">${lines.join("\n")}</ul>`;
    } else {
      itemListHTML = `<p class="ace-qol-loot-none"><em>No lootable items</em></p>`;
    }

    // Control buttons row — GM only via CSS handled in _wirePublicLootCard:
    //   - Split Gold Evenly (only when there's still currency to split)
    //   - Spawn Tile (always available so GM can recreate a lost tile)
    const ctrlButtons = [];
    if (hasCurrency && !flags.currencySplit) {
      ctrlButtons.push(`<button class="ace-qol-loot-split-btn" data-action="aceQolSplitGold">Split Gold Evenly</button>`);
    }
    ctrlButtons.push(`<button class="ace-qol-loot-spawn-tile-btn" data-action="aceQolSpawnTile" title="Spawn a loot tile on the current scene from this card's contents — use if the original tile was deleted">Spawn Tile</button>`);
    const controlsHTML = `<div class="ace-qol-loot-controls">${ctrlButtons.join("")}</div>`;

    const framingHTML = framing.note
      ? `<div class="ace-qol-loot-framing" style="margin:4px 0 6px;padding:6px 9px;border-radius:4px;background:#191b22;border-left:3px solid #d4af37;color:#cfc4a8;font-size:13px;line-height:1.4;">${foundry.utils.escapeHTML(framing.note)}</div>`
      : "";

    return `
<div class="ace-qol-loot-card" data-actor-id="${actorId}">
  <div class="ace-qol-loot-header">
    <img src="${actorImg}" class="ace-qol-loot-portrait">
    <span class="ace-qol-loot-name">${foundry.utils.escapeHTML(actorName)}</span>
    <span class="ace-qol-loot-verb" style="margin-left:auto;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8c7a4b;">${foundry.utils.escapeHTML(framing.verb)}</span>
  </div>
  ${framingHTML}
  ${currencyHTML}
  ${itemListHTML}
  ${controlsHTML}
</div>`.trim();
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

      // ── Beasts carry no loot (hard rule, Johnny 2026-07-11) ──
      // A wolf, goat, or bear isn't hauling coins, potions, or gear — the old
      // "mundane scraps" behavior had goats dropping trinkets. OFF by default;
      // a table that wants "swallowed gems" flavor can flip beastsCarryLoot ON.
      if (String(creatureType).toLowerCase() === "beast") {
        let beastsCarry = false;
        try { beastsCarry = game.settings.get(MODULE_ID, "beastsCarryLoot") === true; } catch { /* not registered yet */ }
        if (!beastsCarry) {
          console.log(`${LOG_PREFIX} ${actor.name} is a beast — no loot (beastsCarryLoot OFF)`);
          return null;
        }
      }

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
      const [minItems, maxItemsForTier] = tier.items;
      let itemCount = Math.floor(Math.random() * (maxItemsForTier - minItems + 1)) + minItems;
      // Shared loot budget (Option C, 2026-07-14): when the bio-generator's AI
      // pocket-loot already added items this drop, it passes the REMAINING budget
      // as options.maxItems so the two systems don't pile up. 0 → add gold only,
      // no items. Absent (the on-death path) → uncapped, unchanged.
      if (Number.isFinite(options.maxItems)) itemCount = Math.max(0, Math.min(itemCount, options.maxItems));
      const pickedEntries = itemCount > 0 ? this._pickRandom(candidateItems, itemCount) : [];

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
        creatureType,
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
      const framing = lootFraming(lootData.creatureType ?? "");

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
      const framingHTML = framing.note
        ? `<div class="ace-qol-loot-framing" style="margin:4px 0 6px;padding:6px 9px;border-radius:4px;background:#191b22;border-left:3px solid #d4af37;color:#cfc4a8;font-size:13px;line-height:1.4;">${foundry.utils.escapeHTML(framing.note)}</div>`
        : "";

      const content = `
<div class="ace-qol-loot-card">
  <h3>\u{1FA99} ${framing.verb} \u2014 ${creatureName}</h3>
  ${framingHTML}
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
  //  Public Loot Card (visible to all players)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Post a PUBLIC loot card visible to ALL players. Items use @UUID links
   * that Foundry makes natively draggable. Stores full item/currency data
   * in message flags so looting progress can be tracked.
   *
   * @param {Actor} actor      - The NPC that died
   * @param {object} [options] - Optional overrides
   * @param {object} [options.lootData] - Pre-built loot data (from generateLoot)
   * @returns {Promise<ChatMessage|null>}
   */
  async postPublicLootCard(actor, options = {}) {
    try {
      if (!actor) {
        console.warn(`${LOG_PREFIX} postPublicLootCard called with no actor`);
        return null;
      }

      const lootData = options.lootData ?? null;
      const actorId = actor.id;
      const actorName = actor.name ?? "Unknown Creature";
      const actorImg = actor.img ?? actor.prototypeToken?.texture?.src ?? "icons/svg/skull.svg";
      // Read the type from the ACTOR while it still exists — for an unlinked
      // token this synthetic copy is destroyed once the corpse settles.
      const creatureType = options.creatureType ?? lootData?.creatureType ?? readCreatureType(actor);
      const framing = lootFraming(creatureType);

      // ── Gather currency from the actor ──
      const curr = actor.system?.currency ?? {};
      const currency = {
        pp: curr.pp ?? 0,
        gp: curr.gp ?? 0,
        ep: curr.ep ?? 0,
        sp: curr.sp ?? 0,
        cp: curr.cp ?? 0,
      };
      const hasCurrency = currency.pp + currency.gp + currency.ep + currency.sp + currency.cp > 0;

      // ── Gather lootable items ──
      // Respect dnd5e identification: if an item is flagged unidentified
      // and has an obscured name set (by the biogenerator's unidentified
      // layer pass), show that obscured name on the public chat card so
      // players don't see "Cloak of Many Fashions" before they've cast
      // Identify. GM-side dialog will show the real name and a Reveal
      // button — that's the canonical path to disclose.
      const lootItems = this._getExistingLootItems(actor);
      const itemsArray = lootItems.map((item, idx) => {
        const isUnid = item.system?.identified === false;
        const obscName = item.system?.unidentified?.name;
        const publicName = (isUnid && obscName) ? obscName : item.name;
        return {
          name:     publicName,
          img:      item.img ?? "icons/svg/item-bag.svg",
          uuid:     item.uuid,
          type:     item.type,
          rarity:   item.system?.rarity ?? "common",
          index:    idx,
          looted:   false,
          lootedBy: null,
        };
      });

      // ── Build currency HTML ──
      let currencyHTML = "";
      if (hasCurrency) {
        const coins = [];
        if (currency.pp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-pp">${currency.pp} pp</span>`);
        if (currency.gp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-gp">${currency.gp} gp</span>`);
        if (currency.ep > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-ep">${currency.ep} ep</span>`);
        if (currency.sp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-sp">${currency.sp} sp</span>`);
        if (currency.cp > 0) coins.push(`<span class="ace-qol-loot-coin ace-qol-loot-cp">${currency.cp} cp</span>`);
        currencyHTML = `<div class="ace-qol-loot-currency">${coins.join(" ")}</div>`;
      }

      // ── Build item list HTML ──
      let itemListHTML = "";
      if (itemsArray.length > 0) {
        const lines = itemsArray.map((item, idx) => {
          const rarityLabel = this._formatRarity(item.rarity);
          // Defensive onerror: if the item.img path 404s (e.g. AI-generated icon
          // hint refers to a Foundry icon path that doesn't exist on this host),
          // swap in the always-present item-bag svg so the user never sees a
          // broken-image placeholder. onerror=null prevents an infinite loop.
          return `<li class="ace-qol-loot-item" data-item-uuid="${item.uuid}" data-item-index="${idx}">` +
            `<img src="${item.img}" class="ace-qol-loot-item-img" style="width:24px;height:24px;border:0;" ` +
            `onerror="this.onerror=null;this.src='icons/svg/item-bag.svg';">` +
            ` @UUID[${item.uuid}]{${item.name}}` +
            ` <span class="ace-qol-loot-rarity">(${rarityLabel})</span>` +
            `</li>`;
        });
        itemListHTML = `<ul class="ace-qol-loot-items">${lines.join("\n")}</ul>`;
      } else {
        itemListHTML = `<p class="ace-qol-loot-none"><em>No lootable items</em></p>`;
      }

      // ── Build GM controls ──
      // Split Gold (only when there's currency) + Spawn Tile (always — lets
      // the GM recreate a loot tile on the canvas if the original was lost).
      const ctrlButtons = [];
      if (hasCurrency) {
        ctrlButtons.push(`<button class="ace-qol-loot-split-btn" data-action="aceQolSplitGold">Split Gold Evenly</button>`);
      }
      ctrlButtons.push(`<button class="ace-qol-loot-spawn-tile-btn" data-action="aceQolSpawnTile" title="Spawn a loot tile on the current scene from this card's contents — use if the original tile was deleted">Spawn Tile</button>`);
      const controlsHTML = `<div class="ace-qol-loot-controls">${ctrlButtons.join("")}</div>`;

      // ── Assemble the full card ──
      const framingHTML = framing.note
        ? `<div class="ace-qol-loot-framing" style="margin:4px 0 6px;padding:6px 9px;border-radius:4px;background:#191b22;border-left:3px solid #d4af37;color:#cfc4a8;font-size:13px;line-height:1.4;">${foundry.utils.escapeHTML(framing.note)}</div>`
        : "";

      const content = `
<div class="ace-qol-loot-card" data-actor-id="${actorId}">
  <div class="ace-qol-loot-header">
    <img src="${actorImg}" class="ace-qol-loot-portrait">
    <span class="ace-qol-loot-name">${actorName}</span>
    <span class="ace-qol-loot-verb" style="margin-left:auto;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8c7a4b;">${foundry.utils.escapeHTML(framing.verb)}</span>
  </div>
  ${framingHTML}
  ${currencyHTML}
  ${itemListHTML}
  ${controlsHTML}
</div>`.trim();

      // ── Create the public chat message with flags ──
      const messageData = {
        content,
        speaker: ChatMessage.getSpeaker({ alias: "ACE Loot" }),
        flags: {
          [MODULE_ID]: {
            type:          "lootCard",
            actorId,
            actorName,
            actorImg,
            creatureType,
            items:         itemsArray,
            currency,
            currencySplit: false,
            splitReceipt:  null,
            fullyLooted:   false,
          },
        },
      };

      // Loot card is GM-only (Johnny 2026-06-24: "just have it in the GM chat card as
      // a backup — I don't want it on the players' chat"). Whisper to every active GM
      // so players never see loot contents in chat. Drag-to-sheet still works from the
      // loot dialog/tile, so nothing is lost. (Guard the empty case — Foundry treats
      // an empty whisper array as PUBLIC.)
      const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
      messageData.whisper = gmIds.length ? gmIds : [game.user.id];

      const message = await ChatMessage.create(messageData);
      console.log(`${LOG_PREFIX} Public loot card posted for ${actorName} ` +
        `(${itemsArray.length} items, ${hasCurrency ? "has currency" : "no currency"})`);

      return message;

    } catch (err) {
      console.error(`${LOG_PREFIX} postPublicLootCard failed:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Wire Public Loot Card Interactivity (renderChatMessage)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wire up interactivity on a rendered loot card.
   * Called from the renderChatMessage hook.
   *
   * @param {HTMLElement} el       - The chat message DOM element
   * @param {ChatMessage} message  - The Foundry ChatMessage document
   * @param {object} flags         - The ace-qol flags from the message
   */
  _wirePublicLootCard(el, message, flags) {
    try {
      if (!el?.querySelector) return;

      const card = el.querySelector(".ace-qol-loot-card");
      if (!card) return;

      // ── Hide GM controls for non-GM users ──
      const controls = card.querySelector(".ace-qol-loot-controls");
      if (controls && !game.user.isGM) {
        controls.style.display = "none";
      }

      // ── If fully looted, show collapsed view ──
      if (flags.fullyLooted) {
        this._renderCollapsedLootCard(card, flags);
        return;
      }

      // ── Mark already-looted items with strikethrough ──
      this._renderLootedItems(card, flags);

      // ── Wire Split Gold button ──
      const splitBtn = card.querySelector('[data-action="aceQolSplitGold"]');
      if (splitBtn && game.user.isGM) {
        if (flags.currencySplit) {
          // Already split — disable the button and show checkmark
          splitBtn.textContent = "Gold Split \u2713";
          splitBtn.disabled = true;
          splitBtn.classList.add("ace-qol-loot-split-done");
          // Show split receipt if available
          if (flags.splitReceipt) {
            this._renderSplitReceipt(card, flags.splitReceipt);
          }
        } else {
          splitBtn.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            await this._handleSplitGold(message, flags, splitBtn);
          }, { once: true });
        }
      }

      // \u2500\u2500 Wire Spawn Tile button (GM only) \u2014 recreate a loot tile on the
      //    current scene from this card's contents. Used to recover when
      //    the original dead-body / container tile was deleted. \u2500\u2500
      const spawnBtn = card.querySelector('[data-action="aceQolSpawnTile"]');
      if (spawnBtn && game.user.isGM) {
        spawnBtn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Spawn Loot Tile" },
            content: `<p style="font-size:15px;line-height:1.5;">Spawn a loot tile for <strong>${foundry.utils.escapeHTML(flags.actorName ?? "this card")}</strong> on the current scene? It'll drop at scene center as a chest-style tile carrying the same loot. Items already taken won't be respawned.</p>`,
            modal:   true,
            yes:     { default: true, label: "Spawn", icon: "fa-solid fa-treasure-chest" },
            no:      { label: "Cancel" },
            rejectClose: false,
          }).catch(() => false);
          if (!confirmed) return;
          await this.spawnTileFromCard(message);
        });
      }

      // ── Wire the collapsed receipt toggle (if card was previously collapsed) ──
      const doneDiv = card.querySelector(".ace-qol-loot-done");
      if (doneDiv) {
        doneDiv.addEventListener("click", () => {
          const receipt = doneDiv.querySelector(".ace-qol-loot-receipt");
          if (receipt) {
            receipt.style.display = receipt.style.display === "none" ? "block" : "none";
          }
        });
      }

    } catch (err) {
      console.error(`${LOG_PREFIX} _wirePublicLootCard failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Split Gold Handler
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Split currency evenly among all active PCs.
   * Remainder goes to the first PC alphabetically.
   *
   * @param {ChatMessage} message - The loot card message
   * @param {object} flags        - ace-qol flags
   * @param {HTMLElement} btn     - The split button element
   */
  async _handleSplitGold(message, flags, btn) {
    // ── Re-entry guard (punch #3) ──
    // Re-read the LIVE flags — the captured `flags` object can be stale if a
    // re-render or another update landed since this button was wired. Then
    // hold the in-flight lock for the whole split so no parallel click (from
    // a re-rendered card, popped-out chat, or double-fire) can start a second
    // distribution of the same card's gold.
    const liveFlags = message.flags?.[MODULE_ID] ?? {};
    if (liveFlags.currencySplit || _splitsInFlight.has(message.id)) {
      btn.disabled = true;
      btn.textContent = "Gold Split ✓";
      console.log(`${LOG_PREFIX} split ignored — this card's gold is already split (or splitting right now)`);
      return;
    }
    _splitsInFlight.add(message.id);
    try {
      btn.disabled = true;
      btn.textContent = "Splitting...";

      const currency = flags.currency ?? {};

      // ── Find all connected PCs ──
      const pcs = game.actors.filter(a =>
        a.type === "character" &&
        a.hasPlayerOwner &&
        game.users.find(u => u.active && !u.isGM && a.ownership?.[u.id] >= 3)
      );

      if (pcs.length === 0) {
        // No active player-owned PCs found — try broader search
        const fallbackPCs = game.actors.filter(a =>
          a.type === "character" && a.hasPlayerOwner
        );
        if (fallbackPCs.length === 0) {
          ui.notifications.warn("ACE Loot: No player characters found to split gold.");
          btn.disabled = false;
          btn.textContent = "Split Gold Evenly";
          return;
        }
        pcs.push(...fallbackPCs);
      }

      // Sort alphabetically for deterministic remainder assignment
      pcs.sort((a, b) => a.name.localeCompare(b.name));

      const count = pcs.length;
      const receiptLines = [];

      // ── Split each denomination ──
      const denominations = ["pp", "gp", "ep", "sp", "cp"];
      const denomLabels = { pp: "pp", gp: "gp", ep: "ep", sp: "sp", cp: "cp" };

      for (const denom of denominations) {
        const total = currency[denom] ?? 0;
        if (total <= 0) continue;

        const share = Math.floor(total / count);
        const remainder = total % count;

        for (let i = 0; i < pcs.length; i++) {
          const pc = pcs[i];
          const extra = (i === 0) ? remainder : 0;  // Remainder to first alphabetically
          const amount = share + extra;
          if (amount <= 0) continue;

          try {
            const currentVal = pc.system?.currency?.[denom] ?? 0;
            await pc.update({ [`system.currency.${denom}`]: currentVal + amount });
          } catch (err) {
            console.error(`${LOG_PREFIX} Failed to update ${pc.name} currency:`, err);
          }
        }

        // Build receipt line
        if (remainder > 0) {
          receiptLines.push(`${total} ${denomLabels[denom]} split: ${share + remainder} to ${pcs[0].name}, ${share} each to ${pcs.slice(1).map(p => p.name).join(", ")}`);
        } else {
          receiptLines.push(`${total} ${denomLabels[denom]} split: ${share} each to ${pcs.map(p => p.name).join(", ")}`);
        }
      }

      // ── Update message flags ──
      const splitReceipt = {
        pcNames: pcs.map(p => p.name),
        lines: receiptLines,
      };

      await message.update({
        [`flags.${MODULE_ID}.currencySplit`]: true,
        [`flags.${MODULE_ID}.splitReceipt`]: splitReceipt,
      });

      // ── Update button immediately ──
      btn.textContent = "Gold Split \u2713";
      btn.classList.add("ace-qol-loot-split-done");

      // ── Check if fully looted now ──
      await this._checkFullyLooted(message);

      console.log(`${LOG_PREFIX} Gold split among ${count} PCs: ${receiptLines.join("; ")}`);
      ui.notifications.info(`ACE Loot: Gold split among ${pcs.map(p => p.name).join(", ")}.`);

    } catch (err) {
      console.error(`${LOG_PREFIX} _handleSplitGold failed:`, err);
      btn.disabled = false;
      btn.textContent = "Split Gold Evenly";
      ui.notifications.error("ACE Loot: Failed to split gold.");
    } finally {
      _splitsInFlight.delete(message.id);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item Loot Tracking (preCreateItem hook)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called from the preCreateItem hook. Checks if the item being created
   * on a PC matches one of the loot card items (by UUID or name + type).
   * If it matches, marks the item as looted in the loot card message flags.
   *
   * @param {Item} item       - The item being created
   * @param {object} data     - The item creation data
   * @param {object} context  - The creation context
   */
  async handleItemLooted(item, data, context) {
    try {
      // Only care about items created on player characters
      const parentActor = item.parent;
      if (!parentActor || parentActor.type !== "character" || !parentActor.hasPlayerOwner) return;

      // ── NO ARBITRARY WINDOW (2026-07-28) ──
      // This took the last 50 messages. A loot card that had scrolled past 50 —
      // trivial on a busy night — simply stopped being found, so items looted
      // from it were never marked and the card never closed out. Silent, and
      // worse the longer the session runs. Same failure the save card hit with
      // its 30-message window.
      //
      // A loot card is only a candidate while it is NOT fully looted, so filter
      // on the actual condition instead of on recency. That set is tiny — open
      // loot cards are a handful at most — and it cannot age out.
      const messages = game.messages.contents.filter(m => {
        const f = m.flags?.[MODULE_ID];
        return f?.type === "lootCard" && !f.fullyLooted;
      });

      for (const msg of messages) {
        const msgFlags = msg.flags?.[MODULE_ID];
        if (msgFlags?.type !== "lootCard") continue;
        if (msgFlags.fullyLooted) continue;

        const items = msgFlags.items;
        if (!items || items.length === 0) continue;

        // Try to match by source UUID in the creation context
        const sourceUuid = data?.flags?.core?.sourceId
          ?? context?.aceQolSourceUuid
          ?? item.flags?.core?.sourceId
          ?? null;

        let matchIndex = -1;

        if (sourceUuid) {
          // Match by UUID (most reliable — drag from @UUID link)
          matchIndex = items.findIndex(li => !li.looted && li.uuid === sourceUuid);
        }

        if (matchIndex === -1) {
          // Fallback: match by name + type (for manual creation or import)
          const itemName = item.name?.toLowerCase()?.trim();
          const itemType = item.type;
          matchIndex = items.findIndex(li =>
            !li.looted &&
            li.name?.toLowerCase()?.trim() === itemName &&
            li.type === itemType
          );
        }

        if (matchIndex === -1) continue;

        // ── Found a match — mark as looted ──
        const updatedItems = foundry.utils.deepClone(items);
        updatedItems[matchIndex].looted = true;
        updatedItems[matchIndex].lootedBy = parentActor.name;

        await msg.update({
          [`flags.${MODULE_ID}.items`]: updatedItems,
        });

        console.log(`${LOG_PREFIX} ${updatedItems[matchIndex].name} looted by ${parentActor.name}`);

        // ── Check if fully looted now ──
        await this._checkFullyLooted(msg);

        // Only match the first loot card containing this item
        break;
      }

    } catch (err) {
      console.error(`${LOG_PREFIX} handleItemLooted failed:`, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loot Card Rendering Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render already-looted items with strikethrough and "to PlayerName".
   * @param {HTMLElement} card - The .ace-qol-loot-card element
   * @param {object} flags     - ace-qol flags
   */
  _renderLootedItems(card, flags) {
    try {
      const items = flags.items ?? [];
      for (const item of items) {
        if (!item.looted) continue;

        const li = card.querySelector(`[data-item-index="${item.index}"]`);
        if (!li) continue;

        // Add strikethrough class
        li.classList.add("ace-qol-loot-item-looted");

        // Append looted-by label if not already present
        if (!li.querySelector(".ace-qol-loot-looted-by")) {
          const label = document.createElement("span");
          label.className = "ace-qol-loot-looted-by";
          label.textContent = ` \u2192 ${item.lootedBy ?? "Unknown"}`;
          li.appendChild(label);
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} _renderLootedItems failed:`, err);
    }
  }

  /**
   * Render the split receipt below the currency section.
   * @param {HTMLElement} card    - The .ace-qol-loot-card element
   * @param {object} splitReceipt - { pcNames, lines }
   */
  _renderSplitReceipt(card, splitReceipt) {
    try {
      if (!splitReceipt?.lines?.length) return;
      // Don't add duplicates
      if (card.querySelector(".ace-qol-loot-split-receipt")) return;

      const receiptDiv = document.createElement("div");
      receiptDiv.className = "ace-qol-loot-split-receipt";
      receiptDiv.innerHTML = splitReceipt.lines.map(line =>
        `<small>${line}</small>`
      ).join("");

      // Insert after currency div or after header
      const currencyDiv = card.querySelector(".ace-qol-loot-currency");
      const insertAfter = currencyDiv ?? card.querySelector(".ace-qol-loot-header");
      if (insertAfter?.nextSibling) {
        insertAfter.parentNode.insertBefore(receiptDiv, insertAfter.nextSibling);
      } else {
        card.appendChild(receiptDiv);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} _renderSplitReceipt failed:`, err);
    }
  }

  /**
   * Replace the loot card content with a collapsed "Looted" view.
   * Clicking expands the receipt.
   * @param {HTMLElement} card - The .ace-qol-loot-card element
   * @param {object} flags     - ace-qol flags
   */
  _renderCollapsedLootCard(card, flags) {
    try {
      const actorName = flags.actorName ?? "Unknown";

      // Build the receipt lines
      const receiptLines = [];

      // Currency receipt
      if (flags.splitReceipt?.lines?.length) {
        for (const line of flags.splitReceipt.lines) {
          receiptLines.push(`<small>${line}</small>`);
        }
      }

      // Item receipt
      const items = flags.items ?? [];
      for (const item of items) {
        if (item.looted && item.lootedBy) {
          receiptLines.push(`<small>${item.name} \u2192 ${item.lootedBy}</small>`);
        }
      }

      const receiptHTML = receiptLines.length > 0
        ? `<div class="ace-qol-loot-receipt" style="display:none;">${receiptLines.join("\n")}</div>`
        : "";

      card.innerHTML = `
<div class="ace-qol-loot-done">
  <span class="ace-qol-loot-done-label">\u{1FAA6} ${actorName} \u2014 Looted</span>
  ${receiptHTML}
</div>`.trim();

      // Wire toggle
      const doneDiv = card.querySelector(".ace-qol-loot-done");
      if (doneDiv) {
        doneDiv.style.cursor = "pointer";
        doneDiv.addEventListener("click", () => {
          const receipt = doneDiv.querySelector(".ace-qol-loot-receipt");
          if (receipt) {
            receipt.style.display = receipt.style.display === "none" ? "block" : "none";
          }
        });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} _renderCollapsedLootCard failed:`, err);
    }
  }

  /**
   * Check if a loot card is fully looted (all items + gold split).
   * If so, update flags to mark it as fullyLooted.
   * @param {ChatMessage} message - The loot card message
   */
  async _checkFullyLooted(message) {
    try {
      const flags = message.flags?.[MODULE_ID];
      if (!flags || flags.type !== "lootCard") return;
      if (flags.fullyLooted) return;

      const items = flags.items ?? [];
      const allItemsLooted = items.length === 0 || items.every(i => i.looted);
      const currencySplit = flags.currencySplit;

      // Determine if there was any currency to split
      const currency = flags.currency ?? {};
      const hasCurrency = (currency.pp + currency.gp + currency.ep + currency.sp + currency.cp) > 0;
      const currencyHandled = !hasCurrency || currencySplit;

      if (allItemsLooted && currencyHandled) {
        await message.update({
          [`flags.${MODULE_ID}.fullyLooted`]: true,
        });
        console.log(`${LOG_PREFIX} Loot card for ${flags.actorName} fully looted`);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} _checkFullyLooted failed:`, err);
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
        // Auto-fire loot card is OPT-IN — by default the lootable tile dialog
        // (double-right-click the dead-art tile) is the primary loot interface.
        // Preserve the card code for users who want it.
        let autoPost = false;
        try { autoPost = !!game.settings.get(MODULE_ID, "autoPostLootCard"); } catch (_) {}
        if (autoPost) {
          await this.postPublicLootCard(actor, { lootData });
        } else {
          console.log(`${LOG_PREFIX} autoPostLootCard=false — skipping chat card (tile dialog is primary UI)`);
        }
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

      // A weapon counts as loot only if a creature was actually CARRYING it (a Spear,
      // Sword, Bow you can pick up off the body) — NOT a natural body-part attack
      // (Tail, Claw, Bite, Slam). We can't trust the weapon CATEGORY: sloppy stat
      // blocks mis-type natural attacks (the Salamander's "Tail" is typed "Martial
      // Ranged," identical to a real longbow). So decide in three steps. (2026-06-24.)
      if (type === "weapon") {
        const rarity  = String(item.system?.rarity ?? "").toLowerCase();
        const priced  = Number(item.system?.price?.value ?? 0) > 0;
        const magical = item.system?.properties?.has?.("mgc") === true
                     || Number(item.system?.magicalBonus ?? 0) > 0;
        const valuable = (rarity && rarity !== "common") || priced || magical;

        // 1. Anything valuable is loot — even a magic item oddly named "Claw".
        if (!valuable) {
          // 2. A body-part NAME = natural attack, never loot. Catches the Tail even
          //    though its category is mislabelled "Martial Ranged".
          const name = String(item.name ?? "").toLowerCase();
          const NATURAL_NAME = /\b(tail|claws?|bites?|slams?|sting|stinger|tentacles?|gore|horns?|hoof|hooves|talons?|beak|wings?|tongue|tusks?|pincers?|pseudopod|fists?|stomp|trample|ram|constrict|fangs?|maw|rend|quills?|spikes?|tendrils?|proboscis|mandibles?|headbutt|spit|spittle|breath)\b/;
          // 3. A real manufactured weapon references a base-item key (spear, longbow,
          //    dagger…) and/or has weight. A natural body-part attack has neither.
          const baseItem   = String(item.system?.type?.baseItem ?? "").trim();
          const weight     = Number(item.system?.weight?.value ?? item.system?.weight ?? 0);
          const realWeapon = baseItem.length > 0 || weight > 0;
          if (NATURAL_NAME.test(name) || !realWeapon) return false;
        }
      }

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
