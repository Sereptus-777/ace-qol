// ============================================================
// ACE QOL — AutoAnimations Autorec Helpers
//
// AA 6.x stores its records SPLIT across multiple settings, one per
// category (melee, range, ontoken, templatefx, aefx, aura, preset).
// The legacy single-setting `aaAutorec` is deprecated.
//
// This store reads/writes the per-category settings transparently.
// Calling code asks for a record by spell name; we search across all
// categories. Calling code saves fields; we write to the correct
// category (or create a new templatefx record if no existing one).
// ============================================================

const AA_MODULE = "autoanimations";

/** AA's data is split across these per-category world settings. */
const AA_CATEGORIES = ["aefx", "aura", "melee", "preset", "range", "ontoken", "templatefx"];

export class AAStore {

  /** Whether the AutoAnimations module is installed and active. */
  static isInstalled() {
    return !!game.modules.get(AA_MODULE)?.active;
  }

  /**
   * Is AA's automatic recognition switched OFF?
   *
   * ⚠️🔴 THIS ONE SETTING SILENTLY KILLS EVERY ANIMATION. When it is on,
   * AA skips its library search completely, so its whole autorec catalogue is
   * ignored and only items carrying an explicit per-item AA flag animate. AA
   * then reports the failure as "No Item or Source Token", which reads like a
   * broken token or a broken item and sends you looking in the wrong place.
   *
   * Johnny's world on 2026-08-25: recognition disabled, with 563 on-token, 219
   * template, 160 ranged and 121 melee entries sitting there unreachable.
   * Nothing animated for Rapier +3, Scimitar +2 or Magic Missile, and the
   * console blamed the token.
   *
   * ⚠️ ACE WRITES INTO THAT LIBRARY. `saveRecord` below adds entries to the
   * very catalogue this setting switches off, so ACE has a duty to notice and
   * say so. Writing to a disabled store and reporting success is the same lie
   * as a log that announces an intention.
   */
  static autorecDisabled() {
    try { return !!game.settings.get(AA_MODULE, "disableAutoRec"); }
    catch (_) { return false; }     // setting unavailable on this AA version
  }

  /** Turn AA's automatic recognition back on. */
  static async enableAutorec() {
    await game.settings.set(AA_MODULE, "disableAutoRec", false);
    ui.notifications?.info("Automated Animations: automatic recognition is back on.");
  }

  /**
   * Say something if the animation library is switched off at the wall.
   *
   * ⚠️ IT COUNTS WHAT IS BEING LOST. "Recognition is disabled" is abstract;
   * "1,063 animation entries are being ignored" is a fact a GM can act on.
   */
  static reportAutorecState() {
    if (!AAStore.isInstalled() || !AAStore.autorecDisabled()) return false;

    let entries = 0;
    for (const cat of AA_CATEGORIES) {
      try {
        const v = game.settings.get(AA_MODULE, `aaAutorec-${cat}`);
        entries += Array.isArray(v) ? v.length : 0;
      } catch (_) { /* category missing on this AA version */ }
    }

    console.warn(
      `ACE: QOL | Automated Animations has AUTOMATIC RECOGNITION TURNED OFF.
`
      + `ACE: QOL | ${entries} animation entries are installed and every one of them `
      + `is being ignored, so weapons and spells will not animate.
`
      + `ACE: QOL | AA reports this as "No Item or Source Token", which is misleading `
      + `- the token and the item are both fine.
`
      + `ACE: QOL | Turn it back on in Automated Animations' module settings, or run:
`
      + `ACE: QOL |     game.aceQol.enableAnimationRecognition()`);

    ui.notifications?.warn(
      `Automated Animations has automatic recognition switched off, so ${entries} `
      + `installed animations are being ignored and nothing will animate. See the console.`,
      { permanent: true });
    return true;
  }

  /**
   * Read all records from all categories and merge into a single object
   * shaped like the legacy `aaAutorec` setting:
   *   { melee: {...}, range: {...}, templatefx: {...}, ... }
   * Most calling code expects this shape — keeping it for compatibility.
   */
  static getAll() {
    if (!AAStore.isInstalled()) return null;
    const out = {};
    for (const cat of AA_CATEGORIES) {
      try { out[cat] = game.settings.get(AA_MODULE, `aaAutorec-${cat}`) ?? {}; }
      catch (_) { out[cat] = {}; }
    }
    return out;
  }

  /** Get the records for ONE category. */
  static getCategory(category) {
    if (!AAStore.isInstalled()) return {};
    try { return game.settings.get(AA_MODULE, `aaAutorec-${category}`) ?? {}; }
    catch (_) { return {}; }
  }

  /** Save records for ONE category. */
  static async saveCategory(category, updated) {
    if (!AAStore.isInstalled()) return false;
    if (!AA_CATEGORIES.includes(category)) {
      console.warn(`[ace-qol/AAStore] unknown category: ${category}`);
      return false;
    }
    try {
      await game.settings.set(AA_MODULE, `aaAutorec-${category}`, updated);
      return true;
    } catch (err) {
      console.error(`[ace-qol/AAStore] saveCategory(${category}) failed:`, err);
      return false;
    }
  }

  /**
   * Find a record whose label matches the given spell/item.
   * Case-insensitive. Strips bracket prefixes like "[ACE-OFF] ".
   * Searches every category since AA splits by category.
   *
   * Backwards-compatible signature: accepts either a string (name) or an
   * Item document. When passed an Item, also tries a second-pass fallback
   * to `item.system.type.baseItem` — the dnd5e base weapon type like
   * "longsword". This is what AA does at playback time for magical
   * weapons whose proper name ("Longsword of Sharpness", "Dawnbringer")
   * doesn't exactly match AA's autorec entries.
   *
   * @param {string|Item} spellNameOrItem
   * @returns {{category:string, recId:string, record:object, matchedBy:string} | null}
   */
  static findRecord(spellNameOrItem) {
    if (!AAStore.isInstalled()) return null;

    // Accept either a string OR an item document
    let itemRef = null;
    let target;
    if (spellNameOrItem && typeof spellNameOrItem === "object" && spellNameOrItem.name !== undefined) {
      itemRef = spellNameOrItem;
      target = String(itemRef.name ?? "").toLowerCase().trim();
    } else {
      target = String(spellNameOrItem ?? "").toLowerCase().trim();
    }
    if (!target) return null;

    const _searchAllCategories = (needle) => {
      for (const cat of AA_CATEGORIES) {
        const records = AAStore.getCategory(cat);
        for (const [recId, rec] of Object.entries(records)) {
          const label = String(rec?.label ?? "").toLowerCase().trim()
            .replace(/^\[[^\]]*\]\s*/, "");
          if (label === needle) return { category: cat, recId, record: rec };
        }
      }
      return null;
    };

    // ── Pass 1: exact match on the item name ──
    const exact = _searchAllCategories(target);
    if (exact) return { ...exact, matchedBy: "name" };

    // ── Pass 2 (item-aware): fall back to baseItem ──
    // "Longsword of Sharpness" → baseItem "longsword" → matches AA's
    // built-in "Longsword" entry. Same path covers Dawnbringer (baseItem
    // "longsword"), Mace of Disruption (baseItem "mace"), etc.
    if (itemRef) {
      const baseItem = String(itemRef.system?.type?.baseItem ?? "").toLowerCase().trim();
      if (baseItem && baseItem !== target) {
        const byBase = _searchAllCategories(baseItem);
        if (byBase) return { ...byBase, matchedBy: "baseItem" };
      }

      // ── Pass 3 (item-aware): fall back to weapon type ──
      // For weapons missing both name and baseItem matches, try the
      // weapon's `system.type.value` ("simpleM", "martialM", "simpleR",
      // "martialR") — AA sometimes has generic entries keyed by these.
      const typeValue = String(itemRef.system?.type?.value ?? "").toLowerCase().trim();
      if (typeValue && typeValue !== target && typeValue !== baseItem) {
        const byType = _searchAllCategories(typeValue);
        if (byType) return { ...byType, matchedBy: "weaponType" };
      }
    }

    return null;
  }

  /**
   * Extract editable fields from a record. Returns sensible defaults if
   * the record is null or missing keys. Handles BOTH structures:
   *
   * - Simple categories (melee/range/templatefx/aefx/aura/ontoken):
   *     record.animation.primary.video.* + record.animation.primary.options.*
   *
   * - Preset category (multi-phase like Fireball, Eldritch Blast):
   *     record.data.{projectile,explosion,beam,...}.{customPath,animation,color,variant,options}
   *   For these, we read from the "main visible effect" — usually `explosion`
   *   for proToTemp types, `projectile` for proTo* types, etc.
   */
  static getEditableFields(record) {
    if (!record) return AAStore._emptyFields();

    // Preset category — multi-phase animations
    if (record.menu === "preset" && record.data && typeof record.data === "object") {
      // Pick the "main" block — explosion (template impact) takes priority,
      // then projectile (the beam/missile), then any other block we recognize.
      const block = record.data.explosion
                 ?? record.data.projectile
                 ?? record.data.beam
                 ?? record.data.primary
                 ?? Object.values(record.data).find(b => b && typeof b === "object" && (b.animation || b.customPath));
      if (block) return AAStore._fieldsFromBlock(block);
    }

    // Simple categories — animation.primary.video shape
    const primary = record.animation?.primary;
    if (primary) return AAStore._fieldsFromBlock(primary.video, primary);

    return AAStore._emptyFields();
  }

  /** Empty field defaults — same shape as a populated record. */
  static _emptyFields() {
    return {
      customPath: "", presetName: "", menuType: "",
      currentRef: "", color: "", variant: "",
      scale: 1.0, opacity: 1.0, belowTokens: false,
    };
  }

  /**
   * Read fields out of one "animation block" — either a preset sub-block
   * (record.data.explosion / data.projectile) or a primary.video block.
   * `parent` is the parent object (primary) so we can fall back to its
   * options.* for scale/opacity if the block itself doesn't have them.
   */
  static _fieldsFromBlock(block, parent = null) {
    if (!block) return AAStore._emptyFields();
    const options = block.options ?? parent?.options ?? {};
    const customPath = block.customPath ?? "";
    const presetName = block.animation ?? "";
    return {
      customPath,
      presetName,
      menuType:    block.menuType ?? "",
      currentRef:  customPath || presetName || "",
      color:       block.color ?? "",
      variant:     block.variant ?? "",
      scale:       Number(options.scale ?? options.size ?? 1.0),
      opacity:     Number(options.opacity ?? 1.0),
      belowTokens: !!(options.below ?? false),
    };
  }

  /**
   * Upsert fields onto the spell's AA record. If an existing record is
   * found (in any category), modify it in place. If no record exists,
   * create a new templatefx record (covers spell-cast template effects,
   * the most common case for ace-qol use).
   *
   * @param {string} spellName
   * @param {{customPath?:string, color?:string, variant?:string,
   *          scale?:number, opacity?:number, belowTokens?:boolean}} fields
   */
  static async upsertFields(spellName, fields) {
    if (!AAStore.isInstalled()) {
      ui.notifications.error("AutoAnimations not installed.");
      return false;
    }

    const entry = AAStore.findRecord(spellName);
    let category, recId, record;

    if (entry) {
      category = entry.category;
      recId    = entry.recId;
      record   = foundry.utils.deepClone(entry.record);
    } else {
      // No record exists — create new in templatefx
      category = "templatefx";
      recId    = foundry.utils.randomID(16);
      record   = {
        label: spellName,
        menu:  category,
        animation: { primary: { video: {} } },
      };
    }

    record.animation ??= {};
    record.animation.primary ??= {};
    record.animation.primary.video   ??= {};
    record.animation.primary.options ??= {};

    const video   = record.animation.primary.video;
    const primary = record.animation.primary;

    if (fields.customPath !== undefined) {
      video.customPath = fields.customPath;
      if (fields.customPath) {
        video.dbSection ??= "static";
        video.menuType    = "static";
      }
    }
    if (fields.color       !== undefined) video.color   = fields.color;
    if (fields.variant     !== undefined) video.variant = fields.variant;
    if (fields.scale       !== undefined) primary.options.scale   = Number(fields.scale);
    if (fields.opacity     !== undefined) primary.options.opacity = Number(fields.opacity);
    if (fields.belowTokens !== undefined) primary.options.below   = !!fields.belowTokens;

    // Read current category data, set the record, write back
    const categoryData = foundry.utils.deepClone(AAStore.getCategory(category));
    categoryData[recId] = record;
    return await AAStore.saveCategory(category, categoryData);
  }

  /**
   * Delete the spell's AA record entirely. AA's compiled-in fallback may
   * still play for known spells, but the user's autorec entry is gone.
   */
  static async deleteRecord(spellName) {
    if (!AAStore.isInstalled()) return false;
    const entry = AAStore.findRecord(spellName);
    if (!entry) return true; // already absent
    const categoryData = foundry.utils.deepClone(AAStore.getCategory(entry.category));
    delete categoryData[entry.recId];
    return await AAStore.saveCategory(entry.category, categoryData);
  }

  /**
   * Probe AA's exposed `globalThis.AutomatedAnimations` API to see if it
   * provides a way to query compiled-in defaults for a spell that isn't
   * yet in autorec. Returns null if no API path works — caller falls back
   * to a blank dialog. NEVER throws.
   */
  static async getCompiledDefault(item) {
    if (!AAStore.isInstalled() || !item) return null;
    try {
      const candidates = [
        globalThis.AutomatedAnimations,
        game.modules.get(AA_MODULE)?.api,
        globalThis.aa,
      ].filter(Boolean);

      for (const api of candidates) {
        if (typeof api.findAnimation === "function") {
          try {
            const result = await api.findAnimation(item);
            if (result) return AAStore._extractFromAAResult(result);
          } catch (_) {}
        }
        if (typeof api.getPreset === "function") {
          try {
            const found = await api.getPreset(item.name);
            if (found) return AAStore.getEditableFields(found);
          } catch (_) {}
        }
      }
      return null;
    } catch (err) {
      console.warn("[ace-qol/AAStore] getCompiledDefault failed:", err);
      return null;
    }
  }

  static _extractFromAAResult(result) {
    if (!result) return null;
    const candidate = result.animation && result.animation.primary
      ? result
      : result.record ?? result.preset ?? result;
    return AAStore.getEditableFields(candidate);
  }
}
